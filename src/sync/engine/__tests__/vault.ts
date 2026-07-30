/**
 * Whole devices: a real finance repository, a real op log, and a real sync engine, wired
 * together the way the app wires them.
 *
 * `helpers.ts` fakes the repository because those suites are about what the engine accepts.
 * This one fakes nothing but the network, because the question here is different and much
 * harder: after two people edit the same vault on two devices, is what they end up looking at
 * the *same thing*, and can they both still use it?
 *
 * That second half is why the assertions run through the public `FinanceRepository` API rather
 * than poking at merged rows. A merge can converge perfectly and still produce a budget whose
 * `categoryLimits` reference a category its `filters` no longer include — every device agrees,
 * every byte matches, and `saveBudget` throws on all of them forever. Deep-equality alone
 * calls that a pass. Writing to the converged state is what calls it what it is.
 */

import { LocalFinanceRepository } from '@/data/local-finance-repository';
import { MemoryStorageAdapter } from '@/data/memory-storage';
import { SyncingStorageAdapter } from '@/data/syncing-storage-adapter';
import { SYNC_META, writeMeta } from '@/data/sync-store';
import type { FinanceState } from '@/domain/models';
import {
  createDeviceIdentity,
  createVaultRootKey,
  deriveContentKey,
  type ContentKey,
  type DeviceIdentity,
} from '@/sync/crypto';
import { SyncSession } from '@/sync/engine/session';
import { toPeerRow, type Peer } from '@/sync/engine/roster';
import { LoopbackChannel, LoopbackTransport } from '@/sync/engine/transport';

export const EPOCH = 1;
export const BASE_CURRENCY = 'USD';

/**
 * One device, whole.
 *
 * The repository sits on top of `SyncingStorageAdapter`, so every `saveAccount` and every
 * `deleteEntities` produces ops through the same diff the app uses — nothing in these tests
 * hand-authors an op. The session sits on the *inner* adapter deliberately: a merge is not a
 * local edit, and routing it through the decorator would make every applied batch emit a fresh
 * op describing what a peer already told us, forever.
 */
export class VaultDevice {
  readonly storage = new MemoryStorageAdapter();
  readonly transport = new LoopbackTransport();
  readonly adapter: SyncingStorageAdapter;
  readonly repository: LocalFinanceRepository;
  readonly session: SyncSession;
  /** Anything the session refused to swallow. Assert it is empty unless a test expects it. */
  readonly errors: unknown[] = [];
  /** The link to each peer, by device id, so a test can cut one without cutting the rest. */
  readonly wires = new Map<string, Wire>();

  /**
   * This device's clock, offset from the real one.
   *
   * Tests run sequentially, so two "concurrent" edits are really one after the other and the
   * later one always wins on HLC — which quietly turns every conflict test into a test of
   * whichever line happened to be written second. A skew makes the intended winner explicit.
   */
  skewMs = 0;

  constructor(
    readonly identity: DeviceIdentity,
    readonly contentKey: ContentKey,
  ) {
    this.adapter = new SyncingStorageAdapter(this.storage, this.deviceId, () => this.now());
    this.repository = new LocalFinanceRepository(this.adapter);
    this.session = new SyncSession({
      storage: this.storage,
      repository: this.repository,
      deviceId: this.deviceId,
      signingKey: this.identity.signing.secretKey,
      frame: { key: this.contentKey, deviceId: this.deviceId, epoch: EPOCH },
      transports: [this.transport],
      now: () => this.now(),
      nowIso: () => new Date(this.now()).toISOString(),
      onError: (error) => {
        this.errors.push(error);
      },
    });
  }

  get deviceId() {
    return this.identity.deviceId;
  }

  now() {
    return Date.now() + this.skewMs;
  }

  /** The link to a peer. Both devices see the same `Wire`, so either end can cut it. */
  wireTo(peer: VaultDevice): Wire {
    const wire = this.wires.get(peer.deviceId);
    if (!wire) throw new Error(`No wire between ${this.deviceId} and ${peer.deviceId}.`);
    return wire;
  }

  get state(): FinanceState {
    return this.repository.getSnapshot();
  }

  async setUp(peers: readonly Peer[], baseCurrency: string) {
    await this.storage.initialize();
    // Before the repository, because every repository write from this point on is a local edit
    // that authors an op, and an op needs a device id and a chain to author onto.
    await this.storage.transact(async (tx) => {
      await writeMeta(tx, {
        [SYNC_META.deviceId]: this.deviceId,
        [SYNC_META.epoch]: String(EPOCH),
        [SYNC_META.baseCurrency]: baseCurrency,
        [SYNC_META.enabled]: '1',
      });
      if (peers.length) await tx.table('syncPeers').put(peers.map(toPeerRow));
    });
    await this.repository.initialize();
    return this;
  }

  /** This device as it appears in another device's roster. */
  asPeer(over: Partial<Peer> = {}): Peer {
    return {
      deviceId: this.deviceId,
      name: `device-${this.deviceId.slice(0, 4)}`,
      platform: 'test',
      signingKey: this.identity.signing.publicKey,
      agreementKey: this.identity.agreement.publicKey,
      epoch: EPOCH,
      addedAt: new Date(0).toISOString(),
      revokedAt: null,
      acked: {},
      known: {},
      lastSeenAt: null,
      ...over,
    };
  }
}

export interface VaultOptions {
  readonly count?: number;
  readonly baseCurrency?: string;
  /**
   * Per-device base currency, for the one case where the devices are *supposed* to disagree.
   *
   * Base currency is not a mergeable field — every transaction's `baseAmountMinor` is
   * snapshotted against it — so a mismatch is a precondition failure, not a conflict. Testing
   * that refusal needs two devices that share a vault key and disagree on the currency, which
   * is exactly what pairing a phone set up in USD with a laptop set up in ILS produces.
   */
  readonly currencies?: readonly string[];
}

/** `count` devices sharing one vault key, each rostered with every other, all wired together. */
export async function makeVault({
  count = 2,
  baseCurrency = BASE_CURRENCY,
  currencies,
}: VaultOptions = {}): Promise<VaultDevice[]> {
  const contentKey = deriveContentKey(createVaultRootKey());
  const devices = Array.from(
    { length: count },
    () => new VaultDevice(createDeviceIdentity(), contentKey),
  );
  for (const [index, device] of devices.entries()) {
    await device.setUp(
      devices.filter((other) => other !== device).map((other) => other.asPeer()),
      currencies?.[index] ?? baseCurrency,
    );
  }
  connect(devices);
  return devices;
}

export interface Wire {
  readonly channels: readonly [LoopbackChannel, LoopbackChannel];
  partition(): void;
  heal(): number;
}

/** Wires every pair of devices together and starts both receive pumps. */
export function connect(devices: readonly VaultDevice[]) {
  for (let first = 0; first < devices.length; first += 1) {
    for (let second = first + 1; second < devices.length; second += 1) {
      join(devices[first], devices[second]);
    }
  }
  return devices;
}

function join(first: VaultDevice, second: VaultDevice): Wire {
  const channels = LoopbackChannel.pair(first.deviceId, second.deviceId);
  const [toSecond, toFirst] = channels;
  first.transport.register(second.deviceId, toSecond);
  second.transport.register(first.deviceId, toFirst);
  first.session.attach(toSecond);
  second.session.attach(toFirst);
  const wire: Wire = {
    channels,
    partition() {
      for (const channel of channels) channel.partitioned = true;
    },
    heal() {
      for (const channel of channels) channel.partitioned = false;
      return channels.reduce((total, channel) => total + channel.heal(), 0);
    },
  };
  // Shared, not copied: a partition is a property of the link, and two devices holding
  // separate views of whether they can reach each other is a state no network produces.
  first.wires.set(second.deviceId, wire);
  second.wires.set(first.deviceId, wire);
  return wire;
}

/**
 * Lets delivery and every transaction it triggers finish.
 *
 * A macrotask turn rather than a microtask drain: a frame lands through `queueMicrotask`, is
 * decrypted, verified, stored, handed to the repository, merged, repaired, written, and
 * re-hydrated — and counting the awaits in that chain would be pinning an implementation
 * detail that changes every time the merge path gains a step.
 */
export const settle = async (turns = 4) => {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

/** One reconcile per device, in order, letting each pass land before the next begins. */
export async function sync(devices: readonly VaultDevice[], rounds = 2) {
  for (let round = 0; round < rounds; round += 1) {
    for (const device of devices) {
      await device.session.reconcile();
      await settle();
    }
  }
}

// ---------------------------------------------------------------------------
// Driving a device
// ---------------------------------------------------------------------------

export interface OnboardOptions {
  readonly locale?: string;
  readonly accountName?: string;
  readonly baseCurrency?: string;
}

/** The first-run flow, which is what puts a settings row and an account in an empty vault. */
export const onboard = (device: VaultDevice, options: OnboardOptions = {}) =>
  device.repository.completeOnboarding({
    locale: options.locale ?? 'en-US',
    baseCurrency: options.baseCurrency ?? BASE_CURRENCY,
    accountName: options.accountName ?? 'Everyday',
    accountType: 'checking',
    openingBalanceMinor: 250_00,
    themeMode: 'system',
    accentSource: 'system',
    accentHex: '#5966E9',
  });

/**
 * The inputs a save takes, from an entity a device already holds.
 *
 * Re-saving an entity unchanged is how these suites ask "is this still valid?" — every
 * `save*` re-runs the full validation the form screens rely on, so a merged record that no
 * longer satisfies it throws here rather than the first time the user opens the edit sheet.
 */
export const inputOf = <
  T extends { id: string; revision: number; createdAt: string; updatedAt: string },
>(
  entity: T,
) => {
  const { id, revision, createdAt, updatedAt, ...rest } = entity;
  void id;
  void revision;
  void createdAt;
  void updatedAt;
  return rest as Omit<T, 'id' | 'revision' | 'createdAt' | 'updatedAt'>;
};

// ---------------------------------------------------------------------------
// Looking inside a device
// ---------------------------------------------------------------------------

/**
 * Every op this device holds, in chain order.
 *
 * Mostly used to assert a *count*, and that is not a lazy assertion — "the repair pass emits
 * no ops" is the property the whole repair design rests on. A repair that wrote even one op
 * would work perfectly on two devices and ping-pong forever on three, each device reacting to
 * the other's correction, and the only visible symptom would be a log that never stops
 * growing. Counting ops across a merge is how that gets caught here rather than in a week.
 */
export const opsOf = (device: VaultDevice) =>
  device.storage.transact(async (tx) =>
    (await tx.table('syncOps').all()).sort((first, second) =>
      first.opId < second.opId ? -1 : 1,
    ),
  );

export const quarantineOf = (device: VaultDevice) =>
  device.storage.transact((tx) => tx.table('syncQuarantine').all());

export const activityOf = (device: VaultDevice) =>
  device.storage.transact((tx) => tx.table('syncActivity').all());

// ---------------------------------------------------------------------------
// Comparing devices
// ---------------------------------------------------------------------------

/**
 * Fields that are *supposed* to differ between devices.
 *
 * `revision` is local optimistic-concurrency bookkeeping and is deliberately not a CRDT
 * register — it counts how many times *this* device wrote the row, so two devices agreeing on
 * it would be the surprising outcome. `updatedAt` is recomputed locally from the winning HLC's
 * wall clock. Comparing either would fail on a correctly converged vault.
 */
const DERIVED = ['revision', 'updatedAt'] as const;

const strip = <T extends object>(entity: T) => {
  const copy = { ...entity } as Record<string, unknown>;
  for (const field of DERIVED) delete copy[field];
  return copy;
};

const byId = (first: { id: string }, second: { id: string }) => (first.id < second.id ? -1 : 1);

/** A device's whole vault, in a shape two devices can be compared field by field. */
export function normalize(state: FinanceState) {
  const entry = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort(byId).map(strip);
  return {
    settings: strip(state.settings),
    accounts: entry(state.accounts),
    categories: entry(state.categories),
    tags: entry(state.tags),
    transactions: entry(state.transactions),
    budgets: entry(state.budgets),
    budgetPeriods: entry(state.budgetPeriods),
    goals: entry(state.goals),
    contributions: entry(state.contributions),
    recurringRules: entry(state.recurringRules),
    exchangeRates: entry(state.exchangeRates),
  };
}

/**
 * Asserts every device is looking at the same vault, and returns it.
 *
 * Lives here rather than in one suite because it is the definition of the property both
 * suites exist to check, and two copies of it would be two definitions of "converged".
 */
export function expectConverged(devices: readonly VaultDevice[]) {
  const snapshots = devices.map((device) => normalize(device.state));
  for (const snapshot of snapshots) expect(snapshot).toEqual(snapshots[0]);
  return snapshots[0];
}

/**
 * Proves a run had something to converge *from*.
 *
 * Without this, a bug that stopped every edit from being recorded would leave the devices
 * identically empty and pass the convergence assertion cleanly. "They agree" is only
 * interesting once they have disagreed.
 */
export function expectDiverged(devices: readonly VaultDevice[]) {
  const snapshots = devices.map((device) => JSON.stringify(normalize(device.state)));
  expect(new Set(snapshots).size).toBeGreaterThan(1);
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

/**
 * A seeded PRNG, because a property test that cannot be replayed is an anecdote.
 *
 * `Math.random()` would make a failure a one-off screenshot in CI rather than something anyone
 * can reproduce. mulberry32 is four lines and its quality is far beyond what picking one of
 * eight operations needs.
 */
export function randomSource(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** An integer in `[0, bound)`. */
    int: (bound: number) => Math.floor(next() * bound),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    /** Fisher-Yates, so "flush in a different order" is a real reordering. */
    shuffle: <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        [copy[index], copy[swap]] = [copy[swap], copy[index]];
      }
      return copy;
    },
  };
}
