/**
 * A two-device vault, with real keys and real storage.
 *
 * Not a `.test.ts` file, so Jest's `testMatch` leaves it alone.
 *
 * Nothing here is stubbed except the repository and the network. The device identities are
 * genuine Ed25519 keypairs, the ops are genuinely signed and hash-chained, and the frames are
 * genuinely sealed under a content key derived from a real vault root key — because an
 * adversarial suite that fakes its own signatures proves that the fake signatures were
 * checked, which is not the claim anyone cares about.
 *
 * The repository *is* faked, and deliberately: these tests are about what the engine accepts,
 * not about what the finance core does with it afterwards. That is what the convergence suite
 * covers, with real repositories on both ends.
 */

import { MemoryStorageAdapter } from '@/data/memory-storage';
import type { StorageAdapter, StorageTx } from '@/data/storage-adapter';
import { SYNC_META, readStates, storeOps, writeMeta, writeStates } from '@/data/sync-store';
import type { ApplyResult } from '@/data/repository';
import type { EntityType } from '@/domain/models';
import {
  createDeviceIdentity,
  createVaultRootKey,
  deriveContentKey,
  type ContentKey,
  type DeviceIdentity,
} from '@/sync/crypto';
import {
  GENESIS_HASH,
  buildOp,
  emptyMeta,
  formatHlc,
  isEntityType,
  metaKey,
  sealOp,
  type CausalMeta,
  type SyncOp,
  type SyncOpBody,
} from '@/sync/oplog';
import type { FrameContext } from '@/sync/engine/frame';
import { toPeerRow, type Peer } from '@/sync/engine/roster';
import { SyncSession } from '@/sync/engine/session';
import { LoopbackChannel, LoopbackTransport } from '@/sync/engine/transport';
import type { SyncBatch } from '@/sync/engine/types';

export const BASE_CURRENCY = 'USD';
export const EPOCH = 1;

/** A fixed clock. Every HLC and every `recordedAt` in these suites is reproducible. */
export const NOW = Date.parse('2026-06-01T12:00:00.000Z');
export const NOW_ISO = new Date(NOW).toISOString();

/**
 * Advances `sync_state` to say "these ops are on screen".
 *
 * This is the one piece of repository bookkeeping the doubles cannot skip. `findUnprojected`
 * asks a single question — is this entity's newest op newer than its `sync_state.maxHlc` — and
 * both the write path and the merge path answer it by writing that row inside the same
 * transaction as the ops. Leave it out and every op ever stored looks permanently unprojected:
 * a device hands its *own* writes back to itself through `applyRemoteOps` on every foreground,
 * and quarantine never appears to heal. A suite built on that would be pinning a bug.
 *
 * The registers are left empty because nothing under test reads them. What matters is `maxHlc`,
 * and it moves monotonically — a later op must never be able to rewind an entity's projection.
 */
async function project(tx: StorageTx, ops: readonly SyncOpBody[]): Promise<void> {
  const newest = new Map<string, SyncOpBody>();
  for (const op of ops) {
    if (!isEntityType(op.entityType)) continue;
    const current = newest.get(metaKey(op.entityType, op.entityId));
    if (!current || op.hlc > current.hlc) newest.set(metaKey(op.entityType, op.entityId), op);
  }
  if (!newest.size) return;

  const held = await readStates(tx, [...newest.keys()]);
  const metas: CausalMeta[] = [];
  for (const [key, op] of newest) {
    const previous = held.get(key);
    metas.push(
      previous && previous.maxHlc > op.hlc
        ? previous
        : emptyMeta(op.entityType as EntityType, op.entityId, op.hlc),
    );
  }
  await writeStates(tx, metas);
}

/**
 * A repository double that records what it was asked to apply.
 *
 * It fakes the *merge*, not the bookkeeping. Advancing `sync_state.maxHlc` is what tells the
 * engine an entity is projected, and skipping it would make `findUnprojected` re-offer every
 * op on every foreground — the whole log would look permanently quarantined, and a suite
 * written against that would be asserting a bug rather than the behaviour.
 *
 * `fail` makes the *next* apply throw, which is how the quarantine paths are exercised. A
 * real money-invariant violation needs a whole populated ledger to provoke, and building one
 * would test the finance core rather than the engine's response to it.
 */
export class FakeRepository {
  readonly applied: SyncOpBody[][] = [];
  /** How many times a pass with nothing to project asked for a repair sweep. */
  sweeps = 0;
  fail: Error | null = null;

  constructor(private readonly storage: StorageAdapter) {}

  /**
   * Counted, not faked.
   *
   * The sweep exists to re-derive repairs from the op log, and there is no repair pass here to
   * re-derive — but "the engine asked" is the half this layer owns, and a suite that stubbed
   * it silently would not notice the day it stopped asking.
   */
  async repairProjection(): Promise<ApplyResult> {
    this.sweeps += 1;
    return { applied: 0, changedTypes: [], repairs: [] };
  }

  async applyRemoteOps(ops: readonly SyncOpBody[]): Promise<ApplyResult> {
    if (this.fail) {
      const error = this.fail;
      this.fail = null;
      // Nothing is recorded, exactly as a refused merge records nothing: the ops stay in the
      // log and keep being forwarded, but this device's projection does not move.
      throw error;
    }
    this.applied.push([...ops]);
    await this.storage.transact((tx) => project(tx, ops), { silent: true });

    const changed = [...new Set(ops.map((op) => op.entityType))] as EntityType[];
    return { applied: ops.length, changedTypes: changed, repairs: [] };
  }

  /** Every op ever handed over, flattened — the "what actually landed" assertion. */
  get flat(): SyncOpBody[] {
    return this.applied.flat();
  }
}

/**
 * One device: an identity, a storage adapter, a repository double, and a chain cursor.
 *
 * The cursor lives here rather than in `sync_meta` because these tests author ops directly
 * instead of going through `SyncingStorageAdapter`. That is the point — the engine has to be
 * provable against arbitrary op sequences, including ones no correct writer would produce.
 */
export class TestDevice {
  readonly storage: StorageAdapter = new MemoryStorageAdapter();
  readonly repository = new FakeRepository(this.storage);
  readonly transport = new LoopbackTransport();
  /** Everything the session refused to throw. Assert on it — nothing should be swallowed. */
  /** `peerId` is absent when the failure was not about reaching anyone — a local repair sweep. */
  readonly errors: { readonly error: unknown; readonly peerId?: string }[] = [];
  /**
   * This device's wall clock, movable.
   *
   * Two devices disagreeing about the time is the normal case rather than the exotic one —
   * a phone that has been in a drawer, a laptop that resumed from sleep — and the deferral
   * path only becomes observable when a test can let one of them catch up.
   */
  clockMs = NOW;
  private cachedSession: SyncSession | null = null;
  private seq = 0;
  private head = GENESIS_HASH;
  private counter = 0;

  constructor(
    readonly identity: DeviceIdentity,
    readonly contentKey: ContentKey,
  ) {}

  get deviceId() {
    return this.identity.deviceId;
  }

  get frame(): FrameContext {
    return { key: this.contentKey, deviceId: this.deviceId, epoch: EPOCH };
  }

  get deps() {
    return {
      storage: this.storage,
      repository: this.repository,
      now: () => this.clockMs,
      nowIso: () => new Date(this.clockMs).toISOString(),
    };
  }

  /** One session per device, because `SyncSession` holds the per-channel AEAD counters. */
  get session(): SyncSession {
    this.cachedSession ??= new SyncSession({
      ...this.deps,
      deviceId: this.deviceId,
      signingKey: this.identity.signing.secretKey,
      frame: this.frame,
      transports: [this.transport],
      onError: (error, peerId) => {
        this.errors.push({ error, peerId });
      },
    });
    return this.cachedSession;
  }

  async setUp(peers: readonly Peer[] = []) {
    await this.storage.initialize();
    await this.storage.transact(async (tx) => {
      await writeMeta(tx, {
        [SYNC_META.deviceId]: this.deviceId,
        [SYNC_META.epoch]: String(EPOCH),
        [SYNC_META.baseCurrency]: BASE_CURRENCY,
        [SYNC_META.enabled]: '1',
      });
      if (peers.length) await tx.table('syncPeers').put(peers.map(toPeerRow));
    });
    return this;
  }

  /** Signs and numbers ops on this device's own chain, continuing from wherever it left off. */
  author(bodies: readonly SyncOpBody[]): SyncOp[] {
    return this.number(bodies).map((op) => sealOp(op, this.identity.signing.secretKey));
  }

  /** Authors, signs, and stores ops — this device's state after a local edit and a seal. */
  commit(bodies: readonly SyncOpBody[]): Promise<SyncOp[]> {
    return this.record(this.author(bodies));
  }

  /** Stores ops *unsigned*, exactly as the write path leaves them for the sealer. */
  stage(bodies: readonly SyncOpBody[]): Promise<SyncOp[]> {
    return this.record(this.number(bodies));
  }

  /**
   * Writes ops and their projection together, the way `SyncingStorageAdapter` does.
   *
   * One transaction for both, because a device that recorded the ops but not the projection
   * would re-offer its own edits to its own repository forever. Splitting them models a crash
   * between the two writes — a real state, worth its own test, but not the default.
   */
  private async record(ops: readonly SyncOp[]): Promise<SyncOp[]> {
    await this.storage.transact(
      async (tx) => {
        await storeOps(tx, ops, 0);
        await project(tx, ops);
      },
      { silent: true },
    );
    return [...ops];
  }

  private number(bodies: readonly SyncOpBody[]): SyncOp[] {
    const built = buildOp(bodies, this.deviceId, this.seq, this.head);
    this.seq = built.seq;
    this.head = built.headHash;
    return [...built.ops];
  }

  /** One `create` op for an entity, at a readable wall-clock offset from `NOW`. */
  body(entityType: EntityType, entityId: string, offsetMs = 0): SyncOpBody {
    this.counter += 1;
    return {
      hlc: formatHlc({ wall: NOW + offsetMs, counter: this.counter, deviceId: this.deviceId }),
      entityType,
      entityId,
      kind: 'create',
      payload: { name: `${entityType}-${entityId}` },
      schema: 1,
    };
  }

  batch(ops: readonly SyncOp[], over: Partial<SyncBatch> = {}): SyncBatch {
    const heads: Record<string, number> = {};
    for (const op of ops) heads[op.deviceId] = Math.max(heads[op.deviceId] ?? 0, op.seq);
    return {
      epoch: EPOCH,
      baseCurrency: BASE_CURRENCY,
      sender: this.deviceId,
      ops,
      heads,
      ...over,
    };
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
      addedAt: NOW_ISO,
      revokedAt: null,
      acked: {},
      known: {},
      lastSeenAt: null,
      ...over,
    };
  }
}

/** A vault of `count` devices sharing one root key, each rostered with all the others. */
export async function makeVault(count = 2): Promise<TestDevice[]> {
  const contentKey = deriveContentKey(createVaultRootKey());
  const devices = Array.from(
    { length: count },
    () => new TestDevice(createDeviceIdentity(), contentKey),
  );
  for (const device of devices) {
    await device.setUp(devices.filter((other) => other !== device).map((other) => other.asPeer()));
  }
  return devices;
}

export interface Link {
  readonly channels: readonly [LoopbackChannel, LoopbackChannel];
  /** Stops delivering in both directions, holding frames for `heal`. */
  partition(): void;
  /** Reconnects and redelivers everything withheld, in send order. */
  heal(): number;
}

/**
 * Wires two devices together and starts both receive pumps.
 *
 * The pumps go up front rather than on first `reconcile`, because that is what a live channel
 * is: something that is already listening. Attaching lazily would mean whichever device
 * reconciled first pushed into a channel with no handler on the far end, and the loopback
 * would drop those frames on the floor — a test artefact that looks exactly like data loss.
 */
export function link(first: TestDevice, second: TestDevice): Link {
  const channels = LoopbackChannel.pair(first.deviceId, second.deviceId);
  const [toSecond, toFirst] = channels;
  first.transport.register(second.deviceId, toSecond);
  second.transport.register(first.deviceId, toFirst);
  first.session.attach(toSecond);
  second.session.attach(toFirst);
  return {
    channels,
    partition() {
      for (const channel of channels) channel.partitioned = true;
    },
    heal() {
      for (const channel of channels) channel.partitioned = false;
      return channels.reduce((total, channel) => total + channel.heal(), 0);
    },
  };
}

/** Reads a device's roster row for a peer, so a test can assert acks and last-seen. */
export const peerRow = (device: TestDevice, peerId: string) =>
  device.storage.transact((tx) => tx.table('syncPeers').get(peerId));

export const opRows = (device: TestDevice) =>
  device.storage.transact(async (tx) =>
    (await tx.table('syncOps').all()).sort((first, second) => (first.opId < second.opId ? -1 : 1)),
  );

export const activityRows = (device: TestDevice) =>
  device.storage.transact(async (tx) =>
    (await tx.table('syncActivity').all()).sort((first, second) =>
      first.key < second.key ? -1 : 1,
    ),
  );

export const quarantineRowsOf = (device: TestDevice) =>
  device.storage.transact((tx) => tx.table('syncQuarantine').all());

/**
 * A whole other keypair, for rostering a device under a key it does not hold.
 *
 * Note that the impostor keeps the *victim's* `deviceId`: that is the interesting case. A
 * mismatched id would be caught by the roster lookup long before a signature was checked, so
 * it would prove nothing about the signature check itself.
 */
export const strangerKeys = () => {
  const identity = createDeviceIdentity();
  return { signingKey: identity.signing.publicKey, agreementKey: identity.agreement.publicKey };
};

/**
 * Lets pending work run.
 *
 * A macrotask turn rather than a microtask drain, because the loopback delivers through
 * `queueMicrotask` into a handler that then awaits several storage transactions — and a fixed
 * number of `await Promise.resolve()` turns is a guess about how many of those there are.
 */
export const settle = async (turns = 3) => {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
