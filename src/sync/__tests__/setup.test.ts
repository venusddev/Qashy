/**
 * The handful of transitions a device makes in its whole life as a vault member.
 *
 * `runtime.test.ts` covers what happens on every foreground; this covers the things that
 * happen once and are very hard to undo. That is the reason each of these gets a test even
 * though none of them is algorithmically interesting — the cost of getting one wrong is not a
 * wrong pixel, it is a device that says it is paired and cannot prove it, or a rotation that
 * leaves a lost phone still holding a working key.
 *
 * Three properties recur, and they are the ones worth stating up front because most of the
 * assertions below are one of them wearing different clothes:
 *
 * - **The keystore is written before `sync_meta`, never after.** A key nobody references is
 *   inert and the next attempt overwrites it. A `sync_meta` naming a `deviceId` whose key was
 *   never stored is a device that has to be repaired by hand.
 * - **Nothing here deletes finance data, and nothing here deletes the op log.** `records` is a
 *   projection of `sync_state`, and the op log is the only record of what this device has
 *   already told its peers. `forget` erases the key, which is the only thing that was ever a
 *   secret.
 * - **Roster rows are marked, never removed.** A revoked peer's past ops must stay
 *   attributable, or history this vault already accepted becomes unverifiable.
 *
 * The keystore and the storage are real. There is no network in this file at all — none of
 * these functions has one.
 */

import { MemoryStorageAdapter } from '@/data/memory-storage';
import type { StoredEntity } from '@/data/storage-adapter';
import { SYNC_META, readActivity, readMeta, writeMeta, type SyncMetaKey } from '@/data/sync-store';
import type { EntityType, FinanceEntity } from '@/domain/models';
import {
  createDeviceIdentity,
  createVaultRootKey,
  type DeviceIdentity,
  type VaultRootKey,
} from '@/sync/crypto';
import { readRoster, writePeers, type Peer } from '@/sync/engine';
import { KeystoreError, MemoryKeystore, type MemoryKeystoreCell } from '@/sync/keystore';
import {
  INITIAL_EPOCH,
  adoptVault,
  disableSync,
  enableSync,
  readIdentity,
  readSyncStatus,
  recordPairedPeer,
  renameDevice,
  resumeSync,
  revokePeer,
  rotateVaultKey,
  setEndpoints,
  type SyncSetupDeps,
} from '@/sync/setup';
import { account, settings, transaction } from '@/sync/oplog/__tests__/helpers';

const NOW_ISO = '2026-06-01T12:00:00.000Z';
const LATER_ISO = '2026-06-02T12:00:00.000Z';

const PROFILE = { name: 'Phone', platform: 'ios' } as const;

const stored = (type: EntityType, entity: FinanceEntity): StoredEntity => ({ type, entity });

/** Enough of a vault that genesis has something to convert and a base currency to read. */
const populated = (): StoredEntity[] => [
  stored('settings', settings({ baseCurrency: 'ILS' })),
  stored('accounts', account({ id: 'acc-1' })),
  stored('transactions', transaction({ id: 'txn-1', accountId: 'acc-1' })),
];

interface Rig {
  readonly deps: SyncSetupDeps;
  readonly storage: MemoryStorageAdapter;
  readonly keystore: MemoryKeystore;
  /** The bytes behind the keystore, so a test can prove `forget` really cleared them. */
  readonly cell: MemoryKeystoreCell;
  readonly meta: (...keys: readonly string[]) => Promise<Map<string, string>>;
  readonly roster: () => Promise<readonly Peer[]>;
  readonly activity: () => Promise<readonly { kind: string; peerId: string | null }[]>;
  readonly addPeers: (...peers: readonly Peer[]) => Promise<void>;
  /** Seeds the cached state the sync screen would otherwise have to run a pass to produce. */
  readonly setMeta: (entries: Partial<Record<SyncMetaKey, string>>) => Promise<void>;
}

/** A roster entry whose `deviceId` really is the fingerprint of its own signing key. */
const peerNamed = (name: string, over: Partial<Peer> = {}): Peer => {
  const identity = createDeviceIdentity();
  return {
    deviceId: identity.deviceId,
    name,
    platform: 'test',
    signingKey: identity.signing.publicKey,
    agreementKey: identity.agreement.publicKey,
    epoch: INITIAL_EPOCH,
    addedAt: NOW_ISO,
    revokedAt: null,
    revokedSeq: null,
    acked: {},
    known: {},
    lastSeenAt: null,
    ...over,
  };
};

interface RigOptions {
  readonly records?: readonly StoredEntity[];
  readonly nowIso?: () => string;
}

const rig = async ({ records = [], nowIso = () => NOW_ISO }: RigOptions = {}): Promise<Rig> => {
  const storage = new MemoryStorageAdapter();
  await storage.initialize();
  if (records.length) await storage.putMany([...records]);

  const cell: MemoryKeystoreCell = { bytes: null };
  const keystore = new MemoryKeystore(cell);

  return {
    deps: { storage, keystore, nowIso },
    storage,
    keystore,
    cell,
    meta: (...keys) => storage.transact((tx) => readMeta(tx, keys as never)),
    roster: async () => {
      const roster = await storage.transact((tx) => readRoster(tx));
      return [...roster.values()];
    },
    activity: async () => {
      const rows = await storage.transact((tx) => readActivity(tx));
      return rows.map((row) => ({ kind: row.kind, peerId: row.peerId }));
    },
    addPeers: (...peers) => storage.transact((tx) => writePeers(tx, peers)),
    setMeta: (entries) => storage.transact((tx) => writeMeta(tx, entries)),
  };
};

/** Every op currently on disk, for the tests that care that the log was left alone. */
const opCount = (storage: MemoryStorageAdapter) =>
  storage.transact(async (tx) => (await tx.table('syncOps').all()).length);

const recordCount = (storage: MemoryStorageAdapter) =>
  storage.transact(async (tx) => (await tx.readAll('transactions')).length);

// ---------------------------------------------------------------------------

describe('a device that has never synced', () => {
  it('reports itself unpaired without inventing a vault', async () => {
    const target = await rig();

    const status = await readSyncStatus(target.deps);

    expect(status).toMatchObject({
      enabled: false,
      keystore: 'empty',
      deviceId: '',
      deviceName: '',
      epoch: 0,
      baseCurrency: '',
      peers: [],
      quarantined: 0,
      pending: false,
      lastSyncedAt: null,
    });
    // Reading the screen must not be what creates the thing the screen describes.
    expect(target.cell.bytes).toBeNull();
  });

  it('has no identity to offer a pairing flow', async () => {
    const target = await rig();
    await expect(readIdentity(target.deps)).resolves.toBeNull();
  });

  it('refuses to resume a vault it does not have', async () => {
    const target = await rig();

    await expect(resumeSync(target.deps)).rejects.toThrow(KeystoreError);
    // Refusing must not half-enable it. A device switched on with no key would report "Up to
    // date" forever while nothing had ever left it.
    expect((await target.meta(SYNC_META.enabled)).get(SYNC_META.enabled)).toBeUndefined();
  });

  it('refuses to rotate a key it does not have', async () => {
    const target = await rig();
    await expect(rotateVaultKey(target.deps)).rejects.toThrow(KeystoreError);
  });
});

describe('enabling sync', () => {
  it('creates a vault, converts existing data, and switches on', async () => {
    const target = await rig({ records: populated() });

    const result = await enableSync(target.deps, PROFILE);

    expect(result.deviceId).toHaveLength(26);
    // Three records in, so three creates out. Genesis is what lets a populated device pair
    // without its data appearing to the peer out of nowhere.
    expect(result.opCount).toBe(3);
    expect(await opCount(target.storage)).toBe(3);

    const status = await readSyncStatus(target.deps);
    expect(status).toMatchObject({
      enabled: true,
      keystore: 'unlocked',
      deviceId: result.deviceId,
      deviceName: 'Phone',
      epoch: INITIAL_EPOCH,
      // Read off the settings row, never from the caller — a device that recorded the wrong
      // one rejects every batch forever with a mismatch it cannot be talked out of.
      baseCurrency: 'ILS',
      peers: [],
    });
  });

  it('starts above the epoch a pairing frame is sealed under', async () => {
    // `pairing.ts` seals under epoch 0 because a joiner cannot know the real one until the
    // frame carrying it opens. A live vault starting at 0 would let the two contexts collide.
    expect(INITIAL_EPOCH).toBeGreaterThan(0);

    const target = await rig();
    await enableSync(target.deps, PROFILE);

    const vault = await target.keystore.read();
    expect(vault?.epoch).toBe(INITIAL_EPOCH);
  });

  it('produces no ops on a device with nothing on it yet', async () => {
    const target = await rig();

    const result = await enableSync(target.deps, PROFILE);

    expect(result.opCount).toBe(0);
    // Still a member, still switched on. An empty vault is a legitimate state, not a failure.
    expect((await readSyncStatus(target.deps)).enabled).toBe(true);
  });

  it('falls back to the platform when the device is left unnamed', async () => {
    const target = await rig();

    await enableSync(target.deps, { name: '   ', platform: 'android' });

    expect((await readSyncStatus(target.deps)).deviceName).toBe('android');
  });

  it('accepts an empty base currency from a device that has not onboarded', async () => {
    const target = await rig();

    await enableSync(target.deps, PROFILE);

    // Legitimate: it then adopts whatever it pairs with, rather than pinning '' as the
    // vault's answer and refusing every peer.
    expect((await readSyncStatus(target.deps)).baseCurrency).toBe('');
  });

  it('refuses a second time rather than minting a second root key', async () => {
    const target = await rig();
    await enableSync(target.deps, PROFILE);
    const first = await target.keystore.read();

    await expect(enableSync(target.deps, PROFILE)).rejects.toThrow(/already part of a vault/i);

    // The refusal is the whole point: a second key would orphan every peer paired under the
    // first, and the device would look fine until the next batch arrived.
    const second = await target.keystore.read();
    expect(second?.identity.deviceId).toBe(first?.identity.deviceId);
    expect(second?.vaultKey).toEqual(first?.vaultKey);
  });

  it('leaves the finance records exactly as it found them', async () => {
    const target = await rig({ records: populated() });
    const before = await target.storage.readAll('transactions');

    await enableSync(target.deps, PROFILE);

    // Genesis is a re-description of the vault, not a transformation of it.
    expect(await target.storage.readAll('transactions')).toEqual(before);
  });
});

describe('joining a vault someone else holds', () => {
  const joinerInput = (identity: DeviceIdentity, vaultKey: VaultRootKey, peers: readonly Peer[]) => ({
    identity,
    vaultKey,
    epoch: 4,
    baseCurrency: 'USD',
    peers,
    profile: { name: 'Laptop', platform: 'web' },
  });

  it('lands the key, roster, epoch, and currency together', async () => {
    const target = await rig({ records: populated() });
    const identity = createDeviceIdentity();
    const host = peerNamed('Phone');

    const result = await adoptVault(target.deps, joinerInput(identity, createVaultRootKey(), [host]));

    expect(result.deviceId).toBe(identity.deviceId);
    const status = await readSyncStatus(target.deps);
    expect(status).toMatchObject({
      enabled: true,
      keystore: 'unlocked',
      deviceId: identity.deviceId,
      deviceName: 'Laptop',
      epoch: 4,
      // The vault's value wins over this device's own 'ILS'. Adopting the roster but not the
      // currency would reject every batch its brand-new peers send it.
      baseCurrency: 'USD',
    });
    expect(status.peers.map((peer) => peer.deviceId)).toEqual([host.deviceId]);
  });

  it('converts the joiner’s own rows to ops too', async () => {
    const target = await rig({ records: populated() });

    const result = await adoptVault(
      target.deps,
      joinerInput(createDeviceIdentity(), createVaultRootKey(), [peerNamed('Phone')]),
    );

    // Skipping this is the mistake that makes a two-populated-vault pairing look like it
    // worked and then quietly sync in one direction only.
    expect(result.opCount).toBe(3);
  });

  it('keeps its own base currency when the vault has none to give', async () => {
    const target = await rig({ records: populated() });

    await adoptVault(target.deps, {
      ...joinerInput(createDeviceIdentity(), createVaultRootKey(), []),
      baseCurrency: '',
    });

    expect((await readSyncStatus(target.deps)).baseCurrency).toBe('ILS');
  });

  it('records one pairing line per peer it was handed', async () => {
    const target = await rig();
    const peers = [peerNamed('Phone'), peerNamed('Tablet')];

    await adoptVault(target.deps, joinerInput(createDeviceIdentity(), createVaultRootKey(), peers));

    expect(await target.activity()).toEqual(
      expect.arrayContaining(peers.map((peer) => ({ kind: 'paired', peerId: peer.deviceId }))),
    );
  });

  it('hands the host a roster row and nothing else', async () => {
    const target = await rig();
    await enableSync(target.deps, PROFILE);
    const before = await target.keystore.read();
    const joiner = peerNamed('Laptop');

    await recordPairedPeer(target.deps, joiner);

    expect((await target.roster()).map((peer) => peer.deviceId)).toEqual([joiner.deviceId]);
    // The host's key, epoch, and history all already exist. This is the one pairing outcome
    // that changes nothing about the vault itself.
    const after = await target.keystore.read();
    expect(after?.vaultKey).toEqual(before?.vaultKey);
    expect(after?.epoch).toBe(before?.epoch);
  });
});

describe('changing the arrangement', () => {
  it('renames this device without touching anything else', async () => {
    const target = await rig();
    await enableSync(target.deps, PROFILE);

    await renameDevice(target.deps, '  Kitchen iPad  ');

    const status = await readSyncStatus(target.deps);
    expect(status.deviceName).toBe('Kitchen iPad');
    expect(status.epoch).toBe(INITIAL_EPOCH);
  });

  it('marks a revoked peer rather than removing it', async () => {
    const target = await rig({ nowIso: () => LATER_ISO });
    await enableSync(target.deps, PROFILE);
    const lost = peerNamed('Old phone');
    await target.addPeers(lost, peerNamed('Laptop'));

    await revokePeer(target.deps, lost.deviceId);

    const roster = await target.roster();
    // Still two rows. Deleting one would turn every op it ever sent into a batch from an
    // unknown author, which every peer must then reject.
    expect(roster).toHaveLength(2);
    expect(roster.find((peer) => peer.deviceId === lost.deviceId)).toMatchObject({
      revokedAt: LATER_ISO,
      revokedSeq: 0,
    });
    expect(await target.activity()).toContainEqual({ kind: 'revoked', peerId: lost.deviceId });
  });

  it('records the highest operation already accepted from the device as its cutoff', async () => {
    const target = await rig({ nowIso: () => LATER_ISO });
    await enableSync(target.deps, PROFILE);
    const lost = peerNamed('Old phone');
    await target.addPeers(lost);
    await target.storage.transact((tx) =>
      tx.table('syncOps').put([
        {
          opId: `${lost.deviceId}:7`,
          deviceId: lost.deviceId,
          seq: 7,
          prevHash: 'previous',
          opHash: 'head',
          hlc: `000000000007-0000-${lost.deviceId}`,
          entityType: 'accounts',
          entityId: 'account-1',
          kind: 'create',
          payload: '{}',
          schema: 1,
          signature: 'signature',
          sealed: 1,
          origin: 1,
        },
      ]),
    );

    await revokePeer(target.deps, lost.deviceId);

    expect((await target.roster())[0]).toMatchObject({
      revokedAt: LATER_ISO,
      revokedSeq: 7,
    });
  });

  it('ignores a second revocation and an unknown device', async () => {
    const target = await rig();
    await enableSync(target.deps, PROFILE);
    const lost = peerNamed('Old phone');
    await target.addPeers(lost);
    await revokePeer(target.deps, lost.deviceId);

    await revokePeer(target.deps, lost.deviceId);
    await revokePeer(target.deps, 'Z'.repeat(26));

    // One line, not three. A revocation log that grows every time the screen is opened is
    // one nobody reads.
    const revocations = (await target.activity()).filter((row) => row.kind === 'revoked');
    expect(revocations).toEqual([{ kind: 'revoked', peerId: lost.deviceId }]);
  });

  it('stores a validated relay address', async () => {
    const target = await rig();
    await enableSync(target.deps, PROFILE);

    await setEndpoints(target.deps, { relayUrl: 'https://relay.example.com/' });

    expect((await readSyncStatus(target.deps)).endpoints.relayUrl).toBe('https://relay.example.com');
  });
});

describe('rotating the vault key', () => {
  it('replaces the key, bumps the epoch, and revokes everyone', async () => {
    const target = await rig({ nowIso: () => LATER_ISO });
    await enableSync(target.deps, PROFILE);
    const before = await target.keystore.read();
    const peers = [peerNamed('Laptop'), peerNamed('Tablet')];
    await target.addPeers(...peers);

    const epoch = await rotateVaultKey(target.deps);

    expect(epoch).toBe(INITIAL_EPOCH + 1);
    const after = await target.keystore.read();
    expect(after?.vaultKey).not.toEqual(before?.vaultKey);
    // The identity survives. Rotating is about the *vault* key; minting a new device id here
    // would strand this device's own op chain.
    expect(after?.identity.deviceId).toBe(before?.identity.deviceId);

    const status = await readSyncStatus(target.deps);
    expect(status.epoch).toBe(epoch);
    // Every peer, not just the lost one. Handing the new key to the survivors over the old
    // one would let the lost device read the handover — precisely the thing being prevented.
    expect(status.peers.every((peer) => peer.revokedAt === LATER_ISO)).toBe(true);
    expect(status.peers.every((peer) => peer.revokedSeq === 0)).toBe(true);
  });

  it('resets the relay cursor, which counted slots in a bucket that no longer exists', async () => {
    const target = await rig();
    await enableSync(target.deps, PROFILE);
    await target.setMeta({ [SYNC_META.relayCursor]: '42' });

    await rotateVaultKey(target.deps);

    expect((await target.meta(SYNC_META.relayCursor)).get(SYNC_META.relayCursor)).toBe('0');
  });

  it('leaves an already-revoked peer’s revocation time alone', async () => {
    const target = await rig({ nowIso: () => LATER_ISO });
    await enableSync(target.deps, PROFILE);
    await target.addPeers(peerNamed('Old phone', { revokedAt: NOW_ISO, revokedSeq: 0 }));

    await rotateVaultKey(target.deps);

    // Re-stamping it would rewrite the record of when the device was actually let go.
    expect((await target.roster())[0]?.revokedAt).toBe(NOW_ISO);
  });
});

describe('turning it off', () => {
  it('pauses without losing anything needed to resume', async () => {
    const target = await rig({ records: populated() });
    await enableSync(target.deps, PROFILE);
    const peer = peerNamed('Laptop');
    await target.addPeers(peer);

    await disableSync(target.deps);

    const status = await readSyncStatus(target.deps);
    expect(status.enabled).toBe(false);
    // Still a member: key, epoch, roster, and history all intact. Pausing is meant to be a
    // switch rather than a decision.
    expect(status.keystore).toBe('unlocked');
    expect(status.epoch).toBe(INITIAL_EPOCH);
    expect(status.peers.map((entry) => entry.revokedAt)).toEqual([null]);
    expect(await opCount(target.storage)).toBe(3);
  });

  it('switches back on again', async () => {
    const target = await rig();
    await enableSync(target.deps, PROFILE);
    await disableSync(target.deps);

    await resumeSync(target.deps);

    expect((await readSyncStatus(target.deps)).enabled).toBe(true);
  });

  it('erases the key and leaves the vault when asked to forget', async () => {
    const target = await rig({ records: populated(), nowIso: () => LATER_ISO });
    await enableSync(target.deps, PROFILE);
    await target.addPeers(peerNamed('Laptop'));

    await disableSync(target.deps, { forget: true });

    const status = await readSyncStatus(target.deps);
    expect(status.enabled).toBe(false);
    expect(status.keystore).toBe('empty');
    expect(status.epoch).toBe(0);
    expect(status.peers.map((peer) => peer.revokedAt)).toEqual([LATER_ISO]);
    expect(status.peers.map((peer) => peer.revokedSeq)).toEqual([0]);
    // The key is the only thing that was ever a secret, and the only thing whose absence
    // actually prevents anything.
    expect(target.cell.bytes).toBeNull();
  });

  it('keeps the finance data and the op log even when forgetting', async () => {
    const target = await rig({ records: populated() });
    await enableSync(target.deps, PROFILE);

    await disableSync(target.deps, { forget: true });

    // `records` is projected from `sync_state`, and the op log is the only record of what
    // this device has already told its peers. Dropping either is data loss, not cleanup.
    expect(await recordCount(target.storage)).toBe(1);
    expect(await opCount(target.storage)).toBe(3);
  });

  it('clears the cached relay verdict, which described a bucket it can no longer address', async () => {
    const target = await rig();
    await enableSync(target.deps, PROFILE);
    // The address has to survive, or `readRelayHealth` short-circuits to `disabled` on the
    // missing endpoint and the cached verdict is never consulted — which would make this
    // test pass without the clearing it is about.
    await setEndpoints(target.deps, { relayUrl: 'https://relay.example.com', relayEnabled: true });
    await target.setMeta({
      [SYNC_META.relayStatus]: 'reachable',
      [SYNC_META.relayCheckedAt]: NOW_ISO,
      [SYNC_META.relayFailures]: '3',
    });

    await disableSync(target.deps, { forget: true });

    expect((await readSyncStatus(target.deps)).relay).toMatchObject({
      // A stale `reachable` is a claim about a bucket this device can no longer address.
      status: 'unknown',
      checkedAt: '',
      failures: 0,
      endpoint: 'https://relay.example.com',
    });
  });

  it('can be paired again from scratch afterwards', async () => {
    const target = await rig();
    await enableSync(target.deps, PROFILE);
    await disableSync(target.deps, { forget: true });

    // The refusal in `enableSync` keys off the keystore, so forgetting has to genuinely
    // release it — otherwise "leave the vault" is a one-way door.
    await expect(enableSync(target.deps, PROFILE)).resolves.toMatchObject({ opCount: 0 });
  });
});

describe('a keystore the platform will not give us', () => {
  it('reports the device as unable to hold a key rather than throwing', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.initialize();
    const deps: SyncSetupDeps = {
      storage,
      keystore: new MemoryKeystore({ bytes: null }, false),
      nowIso: () => NOW_ISO,
    };

    // The sync screen has to render on this platform too — saying "this device can't store a
    // key safely" is the entire point of the state, and it cannot say it from inside an
    // error boundary.
    await expect(readSyncStatus(deps)).resolves.toMatchObject({ keystore: 'unavailable' });
  });
});
