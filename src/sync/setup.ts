/**
 * Turning sync on, off, and inside out.
 *
 * `SyncRuntime` answers "how do I reach my peers"; this file answers "am I in a vault at all,
 * and who else is". Those are different questions with different lifetimes — the runtime is
 * rebuilt whenever an address changes, whereas the things here happen a handful of times in a
 * device's life — so they are deliberately separate objects with separate tests.
 *
 * Every function here is a *whole* state transition. There is no `createIdentity` for a caller
 * to compose with `writeMeta`, because the intermediate states are all wrong: a device with an
 * identity but no key is unpaired, a device with a key but no roster rejects every batch it
 * receives, and a device whose `records` were never converted to ops is one that will silently
 * fail to tell anybody about the data it already has. So each function takes what it needs and
 * leaves the device in exactly one of the states `readSyncStatus` can describe.
 *
 * The ordering rule that shows up in `enable` and `adopt` alike: **the keystore is written
 * before the transaction, never after.** A key nobody references is inert and is overwritten by
 * the next attempt; a `sync_meta` claiming a `deviceId` whose key was never stored is a device
 * that says it is paired and cannot prove it.
 */

import type { StorageAdapter, StorageTx } from '@/data/storage-adapter';
import { runGenesisMigration } from '@/data/sync-genesis';
import {
  SYNC_META,
  appendActivity,
  readActivity,
  readHeldChains,
  readMeta,
  writeMeta,
  type SyncActivityInput,
} from '@/data/sync-store';
import type { SyncActivityRow } from '@/data/sync-tables';
import {
  createDeviceIdentity,
  createVaultRootKey,
  type DeviceIdentity,
  type VaultRootKey,
} from '@/sync/crypto';
import { activityEntry, hasUnsealed, quarantineCount, readRoster, writePeers, type Peer } from '@/sync/engine';
import { KeystoreError, type KeystoreStatus, type SyncKeystore } from '@/sync/keystore';
import {
  readEndpoints,
  writeEndpoints,
  type EndpointPatch,
  type SyncEndpoints,
} from '@/sync/transport/endpoints';
import { readRelayHealth, type RelayHealth } from '@/sync/transport/relay-health';
import { nowIso as defaultNowIso } from '@/utils/entity';

/**
 * The epoch a brand-new vault starts on.
 *
 * One, not zero, and `pairing.ts` depends on it: a pairing frame is sealed under epoch 0
 * because the joiner cannot know the real one until the frame carrying it opens, so a live
 * vault has to start above that or the two contexts could collide.
 */
export const INITIAL_EPOCH = 1;

/** How many activity lines the sync screen shows. The table keeps more; nobody reads them. */
export const ACTIVITY_VIEW_LIMIT = 50;

export interface SyncSetupDeps {
  readonly storage: StorageAdapter;
  readonly keystore: SyncKeystore;
  readonly nowIso?: () => string;
}

/** How this device introduces itself. Both fields are display-only; nothing keys off them. */
export interface DeviceProfile {
  readonly name: string;
  readonly platform: string;
}

/**
 * Everything the sync screens render, in one read.
 *
 * One object rather than a dozen hooks because these values are only meaningful together: a
 * roster of three devices means something different when `enabled` is false, and a relay
 * verdict of `unreachable` means nothing at all when `keystore` is `empty`. Assembling them in
 * one transaction also means the screen can never show a peer list from before a revocation
 * beside an activity log from after it.
 */
export interface SyncStatus {
  readonly enabled: boolean;
  readonly keystore: KeystoreStatus;
  /** Empty strings until this device has been enrolled in a vault. */
  readonly deviceId: string;
  readonly deviceName: string;
  readonly epoch: number;
  /** The vault's base currency, which every incoming batch is checked against. */
  readonly baseCurrency: string;
  /** Peers only — this device is never in its own roster. Includes revoked ones. */
  readonly peers: readonly Peer[];
  readonly endpoints: SyncEndpoints;
  /** Cached, never measured here. Measuring is `SyncRuntime.checkRelay`. */
  readonly relay: RelayHealth;
  readonly activity: readonly SyncActivityRow[];
  readonly quarantined: number;
  /** Local edits written but not yet signed, so not yet sendable. Cleared by the next pass. */
  readonly pending: boolean;
  /** When ops last moved in either direction, from the activity log. */
  readonly lastSyncedAt: string | null;
}

/** The state of a device that has never been near a vault. */
const UNPAIRED = { deviceId: '', deviceName: '', epoch: 0, baseCurrency: '' } as const;

const toInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
};

/** Ops moved, in either direction. What "last synced" honestly means. */
const MOVED = new Set(['sent', 'received']);

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The whole picture, with no network access.
 *
 * Safe to call on every foreground and after every mutation: it is one read-only transaction,
 * and a read-only transaction notifies nobody, so this cannot loop with the subscription that
 * triggers it.
 */
export async function readSyncStatus(deps: SyncSetupDeps): Promise<SyncStatus> {
  // Outside the transaction on purpose. The keystore is the Keychain or a WebCrypto unwrap,
  // and awaiting either inside `work` would leave Dexie's promise zone mid-transaction.
  const keystore = await readKeystoreStatus(deps.keystore);

  const status = await deps.storage.transact(async (tx) => {
    const meta = await readMeta(tx, [
      SYNC_META.enabled,
      SYNC_META.deviceId,
      SYNC_META.deviceName,
      SYNC_META.epoch,
      SYNC_META.baseCurrency,
    ]);
    const roster = await readRoster(tx);
    const activity = await readActivity(tx, ACTIVITY_VIEW_LIMIT);
    const moved = activity.find((row) => MOVED.has(row.kind) && row.count > 0);

    return {
      enabled: meta.get(SYNC_META.enabled) === '1',
      keystore,
      deviceId: meta.get(SYNC_META.deviceId) ?? UNPAIRED.deviceId,
      deviceName: meta.get(SYNC_META.deviceName) ?? UNPAIRED.deviceName,
      epoch: toInt(meta.get(SYNC_META.epoch), UNPAIRED.epoch),
      baseCurrency: meta.get(SYNC_META.baseCurrency) ?? UNPAIRED.baseCurrency,
      peers: [...roster.values()].sort((first, second) => first.addedAt.localeCompare(second.addedAt)),
      endpoints: await readEndpoints(tx),
      relay: await readRelayHealth(tx),
      activity,
      quarantined: await quarantineCount(tx),
      lastSyncedAt: moved?.recordedAt ?? null,
    };
  });

  // A second read-only transaction rather than a scan inlined above, because `hasUnsealed`
  // opens its own. Two reads can in principle straddle a write, which for a status display
  // is worth strictly less than having one definition of "not yet signed".
  return {
    ...status,
    pending: status.deviceId ? await hasUnsealed(deps.storage, status.deviceId) : false,
  };
}

/**
 * The keystore's state, with a corrupt store reported rather than thrown.
 *
 * `status()` is allowed to fail on a platform with no secure storage at all, and the sync
 * screen has to render on that platform too — saying "this device can't store a key safely" is
 * the entire point of the `unavailable` state, and it cannot say it from an error boundary.
 */
async function readKeystoreStatus(keystore: SyncKeystore): Promise<KeystoreStatus> {
  try {
    return await keystore.status();
  } catch (error) {
    if (error instanceof KeystoreError) return error.code === 'locked' ? 'locked' : 'unavailable';
    throw error;
  }
}

/**
 * This device's identity, for a flow that is about to speak for it.
 *
 * Returns null when the device holds no vault, which both pairing roles handle differently:
 * the host cannot proceed at all, and the joiner is *expected* to have none and makes a fresh
 * one. Never creates anything, so calling it has no side effects a cancelled flow must undo.
 */
export async function readIdentity(deps: SyncSetupDeps): Promise<DeviceIdentity | null> {
  const vault = await deps.keystore.read();
  return vault?.identity ?? null;
}

// ---------------------------------------------------------------------------
// Becoming a vault
// ---------------------------------------------------------------------------

export interface EnableResult {
  readonly deviceId: string;
  /** Ops written by the genesis conversion. Zero on a device with no data yet. */
  readonly opCount: number;
}

/**
 * Creates a vault on this device and switches sync on.
 *
 * The first device's side of pairing, and the only place a `VaultRootKey` is ever created. It
 * is also where this device's existing data becomes history: `runGenesisMigration` re-describes
 * every row already on disk as `create` ops, which is what lets a populated device pair with
 * another populated device without either one's data appearing out of nowhere.
 *
 * Idempotent by refusal rather than by re-running. A second call on a device that already holds
 * a vault would mint a second root key and orphan every peer paired under the first, so it
 * throws instead — "already set up" is a UI state, not an operation to repeat.
 */
export async function enableSync(
  deps: SyncSetupDeps,
  profile: DeviceProfile,
): Promise<EnableResult> {
  // A plain Error, not a `KeystoreError`: nothing is wrong with the keystore. Reaching here
  // means the caller skipped the status check, which is a bug rather than a state to render.
  if (await deps.keystore.read()) {
    throw new Error('This device is already part of a vault.');
  }

  const identity = createDeviceIdentity();
  const vaultKey = createVaultRootKey();
  await deps.keystore.write({ vaultKey, identity, epoch: INITIAL_EPOCH });

  const at = (deps.nowIso ?? defaultNowIso)();
  const opCount = await deps.storage.transact(async (tx) => {
    await enrol(tx, {
      deviceId: identity.deviceId,
      profile,
      epoch: INITIAL_EPOCH,
      baseCurrency: await readLocalBaseCurrency(tx),
    });
    const genesis = await runGenesisMigration(tx, identity.deviceId, at);
    await appendActivity(tx, [activityEntry({ kind: 'paired', recordedAt: at, count: 0 })]);
    return genesis.opCount;
  });

  return { deviceId: identity.deviceId, opCount };
}

/**
 * Joins a vault another device already holds.
 *
 * The joiner's half of pairing, called with what `PairingJoiner` returned and the identity it
 * used to earn it — the same identity, necessarily, because the host has already written that
 * device id and those public keys into its own roster.
 *
 * Key, roster, epoch, and base currency land together. A device that adopted the key but not
 * the roster would reject every batch its new peers send it as coming from an unknown device,
 * and would look, from both ends, exactly like a pairing that had silently failed.
 */
export async function adoptVault(
  deps: SyncSetupDeps,
  input: {
    readonly identity: DeviceIdentity;
    readonly vaultKey: VaultRootKey;
    readonly epoch: number;
    readonly baseCurrency: string;
    readonly peers: readonly Peer[];
    readonly profile: DeviceProfile;
  },
): Promise<EnableResult> {
  await deps.keystore.write({
    vaultKey: input.vaultKey,
    identity: input.identity,
    epoch: input.epoch,
  });

  const at = (deps.nowIso ?? defaultNowIso)();
  const opCount = await deps.storage.transact(async (tx) => {
    await enrol(tx, {
      deviceId: input.identity.deviceId,
      profile: input.profile,
      epoch: input.epoch,
      // The vault's value wins over this device's own. A joiner that had not been onboarded
      // has nothing to re-base and adopts it outright; one that had, only got this far because
      // `PairingJoiner` already checked the two agree.
      baseCurrency: input.baseCurrency || (await readLocalBaseCurrency(tx)),
    });
    await writePeers(tx, input.peers);
    // This device's own rows become ops too. Skipping it here is the mistake that makes a
    // two-populated-vault pairing look like it worked and then quietly sync in one direction.
    const genesis = await runGenesisMigration(tx, input.identity.deviceId, at);
    await appendActivity(
      tx,
      input.peers.map((peer) =>
        activityEntry({ kind: 'paired', recordedAt: at, peerId: peer.deviceId }),
      ),
    );
    return genesis.opCount;
  });

  return { deviceId: input.identity.deviceId, opCount };
}

/**
 * Records a device this one just let in. The host's half of pairing.
 *
 * Only a roster row: the host's key, epoch, and history all already exist, and this is the one
 * pairing outcome that changes nothing about the vault itself.
 */
export async function recordPairedPeer(deps: SyncSetupDeps, peer: Peer): Promise<void> {
  const at = (deps.nowIso ?? defaultNowIso)();
  await deps.storage.transact(async (tx) => {
    await writePeers(tx, [peer]);
    await appendActivity(tx, [
      activityEntry({ kind: 'paired', recordedAt: at, peerId: peer.deviceId }),
    ]);
  });
}

/** The `sync_meta` half of joining a vault, shared by both ways of doing it. */
async function enrol(
  tx: StorageTx,
  input: {
    readonly deviceId: string;
    readonly profile: DeviceProfile;
    readonly epoch: number;
    readonly baseCurrency: string;
  },
): Promise<void> {
  await writeMeta(tx, {
    [SYNC_META.deviceId]: input.deviceId,
    [SYNC_META.deviceName]: input.profile.name.trim() || input.profile.platform,
    [SYNC_META.epoch]: String(input.epoch),
    [SYNC_META.baseCurrency]: input.baseCurrency,
    [SYNC_META.enabled]: '1',
  });
}

/**
 * This device's own base currency, from the settings row rather than from a caller.
 *
 * Read here rather than passed in because getting it wrong is unrecoverable: it is the value
 * every peer's batch is checked against, and a device that recorded the wrong one refuses every
 * batch forever with a mismatch it cannot be talked out of. `''` on a device that has not
 * finished onboarding, which is a legitimate state — it then accepts whatever it pairs with.
 */
async function readLocalBaseCurrency(tx: StorageTx): Promise<string> {
  const [settings] = await tx.readAll('settings');
  return settings && 'baseCurrency' in settings ? settings.baseCurrency : '';
}

// ---------------------------------------------------------------------------
// Changing the arrangement
// ---------------------------------------------------------------------------

/** Renames this device. Peers keep the old name until they are next told one at pairing. */
export const renameDevice = (deps: SyncSetupDeps, name: string) =>
  deps.storage.transact(
    (tx) => writeMeta(tx, { [SYNC_META.deviceName]: name.trim() }),
    { silent: true },
  );

/**
 * Removes a device from the vault.
 *
 * The row is marked, never deleted, and the difference matters: its past ops stay attributable,
 * so history this vault already accepted from it remains verifiable rather than becoming a
 * batch from an unknown author that every peer must then reject.
 *
 * Revocation is forward-only. It stops that device's *future* ops from being accepted here, and
 * `rotateVaultKey` is what stops it reading the drop-box — it cannot take back the plaintext the
 * device already has, and the UI says so.
 */
export async function revokePeer(deps: SyncSetupDeps, peerId: string): Promise<void> {
  const at = (deps.nowIso ?? defaultNowIso)();
  await deps.storage.transact(async (tx) => {
    const roster = await readRoster(tx);
    const peer = roster.get(peerId);
    if (!peer || peer.revokedAt) return;
    const held = await readHeldChains(tx);
    await writePeers(tx, [
      { ...peer, revokedAt: at, revokedSeq: held.heads.get(peer.deviceId)?.seq ?? 0 },
    ]);
    await appendActivity(tx, [activityEntry({ kind: 'revoked', recordedAt: at, peerId })]);
  });
}

/** Validates and stores the transport configuration. Throws `EndpointError` on a bad address. */
export const setEndpoints = (deps: SyncSetupDeps, patch: EndpointPatch) =>
  deps.storage.transact((tx) => writeEndpoints(tx, patch));

/**
 * Switches sync back on for a device that already holds a vault.
 *
 * The other half of `disableSync` without `forget`, and the reason that option exists at all:
 * pausing is meant to be a switch rather than a decision, and a switch that only travels one
 * way would make "off for the afternoon" indistinguishable from leaving the vault.
 *
 * Refuses on a device with no key, because there is nothing to resume — that device has never
 * paired, and the screen should be offering it pairing rather than a switch. `enableSync` is
 * the function for that case and it refuses in the opposite direction, so between the two
 * there is no state where both would work and no state where neither does.
 */
export async function resumeSync(deps: SyncSetupDeps): Promise<void> {
  if (!(await deps.keystore.read())) {
    throw new KeystoreError('There is no vault on this device to resume.', 'empty');
  }
  await deps.storage.transact((tx) => writeMeta(tx, { [SYNC_META.enabled]: '1' }));
}

/**
 * Replaces the vault key and moves every remaining device to a new epoch.
 *
 * What it is for: a lost device. Revoking it stops this vault accepting its ops, but it still
 * holds the old root key, and that key is what addresses and decrypts the drop-box. Rotating
 * makes the bucket it knows about the wrong bucket, sealed under a key it does not have.
 *
 * The cost is stated plainly and cannot be engineered away here: **every device you keep has to
 * be paired again.** Handing the new key to the remaining peers over the old one would mean the
 * lost device could read the handover, which is precisely the thing being prevented. So every
 * peer is revoked, and re-pairing is a deliberate, in-person act — the same one that made them
 * peers in the first place.
 */
export async function rotateVaultKey(deps: SyncSetupDeps): Promise<number> {
  const vault = await deps.keystore.read();
  if (!vault) throw new KeystoreError('There is no vault on this device to rotate.', 'empty');

  const epoch = vault.epoch + 1;
  await deps.keystore.write({
    vaultKey: createVaultRootKey(),
    identity: vault.identity,
    epoch,
  });

  const at = (deps.nowIso ?? defaultNowIso)();
  await deps.storage.transact(async (tx) => {
    await writeMeta(tx, { [SYNC_META.epoch]: String(epoch) });
    const roster = await readRoster(tx);
    const held = await readHeldChains(tx);
    const live = [...roster.values()].filter((peer) => !peer.revokedAt);
    await writePeers(
      tx,
      live.map((peer) => ({
        ...peer,
        revokedAt: at,
        revokedSeq: held.heads.get(peer.deviceId)?.seq ?? 0,
      })),
    );
    await appendActivity(tx, [
      // The cursor counts slots in a bucket this vault no longer uses.
      ...live.map((peer) => activityEntry({ kind: 'revoked', recordedAt: at, peerId: peer.deviceId })),
    ]);
    await writeMeta(tx, { [SYNC_META.relayCursor]: '0' });
  });

  return epoch;
}

// ---------------------------------------------------------------------------
// Turning it off
// ---------------------------------------------------------------------------

export interface DisableOptions {
  /**
   * Also destroy the key and leave the vault, rather than merely pausing.
   *
   * Without it, sync stops and everything needed to resume it survives — the switch on the
   * screen. With it, this device is no longer a member: its peers keep syncing with each other
   * and this one has to be paired again from scratch.
   */
  readonly forget?: boolean;
}

/**
 * Stops syncing, optionally for good.
 *
 * **Finance data is never touched, and neither is the op log.** Those rows are this device's
 * own history in plaintext on its own disk; deleting them would destroy the only record of what
 * this device has already told its peers, and `records` is projected from `sync_state`, so
 * dropping either is data loss rather than a cleanup. What `forget` erases is the *key* — which
 * is the only thing that was ever a secret, and the only thing whose absence actually prevents
 * anything.
 *
 * The keystore is erased last. An erase that succeeded before a failed transaction would leave
 * a device still marked as a vault member with no key to act as one, which reads as `unpaired`
 * on a screen offering to revoke peers it can no longer talk to.
 */
export async function disableSync(
  deps: SyncSetupDeps,
  options: DisableOptions = {},
): Promise<void> {
  const at = (deps.nowIso ?? defaultNowIso)();

  await deps.storage.transact(async (tx) => {
    await writeMeta(tx, { [SYNC_META.enabled]: '0' });
    if (!options.forget) return;

    const roster = await readRoster(tx);
    const held = await readHeldChains(tx);
    const live = [...roster.values()].filter((peer) => !peer.revokedAt);
    await writePeers(
      tx,
      live.map((peer) => ({
        ...peer,
        revokedAt: at,
        revokedSeq: held.heads.get(peer.deviceId)?.seq ?? 0,
      })),
    );

    const entries: SyncActivityInput[] = live.map((peer) =>
      activityEntry({ kind: 'revoked', recordedAt: at, peerId: peer.deviceId }),
    );
    if (entries.length) await appendActivity(tx, entries);

    await writeMeta(tx, {
      [SYNC_META.epoch]: '0',
      [SYNC_META.relayCursor]: '0',
      [SYNC_META.relayStatus]: '',
      [SYNC_META.relayCheckedAt]: '',
      [SYNC_META.relayDetail]: '',
      [SYNC_META.relayFailures]: '0',
    });
  });

  if (options.forget) await deps.keystore.erase();
}
