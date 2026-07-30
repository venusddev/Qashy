/**
 * The one file that stands between a user and losing everything.
 *
 * The recovery phrase recovers the *key*, and this archive is the only thing that recovers the
 * *data* — every frame in the drop-box is sealed to a specific recipient device, so twenty-four
 * words and no surviving device is twenty-four words and no data. That makes this module the
 * single point where a bug is unrecoverable rather than inconvenient: a backup that silently
 * omits a table is discovered at the exact moment nothing else is left to compare it against.
 *
 * So the assertions here are mostly about *completeness* and *refusal*, in that order:
 *
 * - Everything a device needs to be that device again survives the round trip — key, identity,
 *   roster, op log, causal state, records, **and tombstones**, which carry recurrence
 *   suppression and whose absence would resurrect deleted transactions forever.
 * - Everything that describes this device's relationship with a *server* is dropped, so the
 *   restored device re-collects the drop-box from slot zero instead of skipping it.
 * - A restore never runs over a device that still holds a vault, and a keystore it cannot read
 *   counts as holding one.
 *
 * The keystore and the storage are real. There is no network in this file — none of these
 * functions has one.
 */

import { MemoryStorageAdapter } from '@/data/memory-storage';
import type { StoredEntity } from '@/data/storage-adapter';
import { SYNC_META, readActivity, writeMeta } from '@/data/sync-store';
import type { EntityType, FinanceEntity } from '@/domain/models';
import {
  BackupError,
  backupFileName,
  exportVaultBackup,
  readBackupLock,
  readVaultBackup,
  restoreVaultBackup,
  summarizeArchive,
  type VaultArchive,
} from '@/sync/backup';
import { createDeviceIdentity, createVaultKeyBackup, utf8Bytes, vaultKeyToRecoveryPhrase } from '@/sync/crypto';
import { readRoster, writePeers, type Peer } from '@/sync/engine';
import { KeystoreError, MemoryKeystore, type MemoryKeystoreCell } from '@/sync/keystore';
import { INITIAL_EPOCH, enableSync, type SyncSetupDeps } from '@/sync/setup';
import { account, settings, transaction } from '@/sync/oplog/__tests__/helpers';

const NOW_ISO = '2026-06-01T12:00:00.000Z';
const LATER_ISO = '2026-09-14T09:30:00.000Z';

const PROFILE = { name: 'Phone', platform: 'ios' } as const;
const PASSPHRASE = 'correct horse battery staple';

/**
 * scrypt at the shipped parameters is ~64 MiB of deliberate work, and the passphrase path pays
 * it once to seal and once to open. Slower than the rest of this suite by two orders of
 * magnitude, and that slowness is the feature.
 */
const SCRYPT_TIMEOUT = 60_000;

const stored = (type: EntityType, entity: FinanceEntity): StoredEntity => ({ type, entity });

/**
 * A vault with something in it, including a tombstone.
 *
 * The tombstone is not decoration. `hydrateFromStorage` rebuilds `deletedOccurrenceKeys` from
 * tombstones on every load, so an archive that drops them restores a device that regenerates
 * every recurrence its owner has ever deleted.
 */
const populated = (): StoredEntity[] => [
  stored('settings', settings({ baseCurrency: 'ILS' })),
  stored('accounts', account({ id: 'acc-1' })),
  stored('transactions', transaction({ id: 'txn-1', accountId: 'acc-1', title: 'Coffee' })),
  stored(
    'transactions',
    transaction({ id: 'txn-gone', accountId: 'acc-1', deletedAt: '2026-05-02T08:00:00.000Z' }),
  ),
];

interface Rig {
  readonly deps: SyncSetupDeps;
  readonly storage: MemoryStorageAdapter;
  readonly keystore: MemoryKeystore;
  readonly cell: MemoryKeystoreCell;
  readonly meta: () => Promise<Map<string, string>>;
  readonly roster: () => Promise<readonly Peer[]>;
  readonly activity: () => Promise<readonly string[]>;
}

const rig = async (records: readonly StoredEntity[] = [], nowIso = () => NOW_ISO): Promise<Rig> => {
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
    meta: async () =>
      storage.transact(async (tx) => {
        const rows = await tx.table('syncMeta').all();
        return new Map(rows.map((row) => [row.key, row.value]));
      }),
    roster: async () => [...(await storage.transact((tx) => readRoster(tx))).values()],
    activity: async () =>
      (await storage.transact((tx) => readActivity(tx))).map((row) => row.kind),
  };
};

/** A roster entry whose `deviceId` really is the fingerprint of its own signing key. */
const peerNamed = (name: string): Peer => {
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
    acked: {},
    known: {},
    lastSeenAt: null,
  };
};

interface Source extends Rig {
  readonly deviceId: string;
  readonly phrase: string;
  readonly peer: Peer;
}

/**
 * A device mid-life: paired, with a peer, a history, and a relay it has been talking to.
 *
 * The relay meta is set deliberately — `relayCursor` is the one key whose survival would be a
 * bug, and a test that never wrote it could not tell "dropped correctly" from "never there".
 */
const source = async (): Promise<Source> => {
  const target = await rig(populated());
  const { deviceId } = await enableSync(target.deps, PROFILE);
  const peer = peerNamed('Laptop');

  await target.storage.transact(async (tx) => {
    await writePeers(tx, [peer]);
    await writeMeta(tx, {
      [SYNC_META.relayUrl]: 'https://relay.example.com',
      [SYNC_META.relayCursor]: '4096',
      [SYNC_META.relayStatus]: 'reachable',
      [SYNC_META.relayCheckedAt]: NOW_ISO,
      [SYNC_META.relayFailures]: '0',
    });
  });

  const vault = await target.keystore.read();
  if (!vault) throw new Error('the rig failed to create a vault');

  return { ...target, deviceId, peer, phrase: vaultKeyToRecoveryPhrase(vault.vaultKey) };
};

/** The archive as bytes, sealed under the vault key — the fast lock, so most tests use it. */
const sealed = async (from: Source) => exportVaultBackup(from.deps, { kind: 'recoveryPhrase' });

const opened = async (from: Source, file: Uint8Array) =>
  readVaultBackup(file, { kind: 'recoveryPhrase', phrase: from.phrase });

// ---------------------------------------------------------------------------

describe('exporting a vault', () => {
  it('refuses on a device that has no vault to export', async () => {
    const target = await rig(populated());

    await expect(exportVaultBackup(target.deps, { kind: 'recoveryPhrase' })).rejects.toThrow(
      KeystoreError,
    );
  });

  it('carries everything a device needs to be that device again', async () => {
    const from = await source();

    const archive = await opened(from, await sealed(from));

    expect(archive.deviceId).toBe(from.deviceId);
    expect(archive.deviceName).toBe('Phone');
    // Read off the settings row at enable time, not from the caller. A restored device that
    // recorded the wrong one rejects every batch forever with a mismatch it cannot be talked
    // out of.
    expect(archive.baseCurrency).toBe('ILS');
    expect(archive.createdAt).toBe(NOW_ISO);
    expect(archive.records).toHaveLength(4);
    expect(archive.peers.map((row) => row.peerId)).toEqual([from.peer.deviceId]);
    // Five ops for four rows: genesis describes the tombstone as a `create` followed by a
    // `delete`, because a peer that received only the delete would have nothing to apply it to.
    expect(archive.ops).toHaveLength(5);
    expect(archive.ops.filter((row) => row.kind === 'delete')).toHaveLength(1);
    // One causal-state row per entity, tombstone included — it is the row that remembers the
    // delete happened at all once the log is compacted out from under it.
    expect(archive.state).toHaveLength(4);
  });

  it('keeps tombstones, because recurrence suppression is stored in them', async () => {
    const from = await source();

    const archive = await opened(from, await sealed(from));

    const deleted = archive.records.filter((row) => row.entity.deletedAt !== null);
    expect(deleted.map((row) => row.entity.id)).toEqual(['txn-gone']);
  });

  it('drops what describes a relay and keeps what describes the vault', async () => {
    const from = await source();

    const archive = await opened(from, await sealed(from));
    const keys = new Set(archive.meta.map((row) => row.key));

    // Dropping the cursor is the load-bearing one: the restored device carries the original's
    // id, so frames still in the drop-box are addressed to it and *will* open — but only if it
    // starts collecting from slot zero rather than from where the dead device left off.
    expect(keys.has(SYNC_META.relayCursor)).toBe(false);
    expect(keys.has(SYNC_META.relayStatus)).toBe(false);
    expect(keys.has(SYNC_META.relayCheckedAt)).toBe(false);
    expect(keys.has(SYNC_META.relayFailures)).toBe(false);
    expect(keys.has(SYNC_META.lastWrite)).toBe(false);
    // Configuration, not status. A restore that forgot the self-hosted endpoint would silently
    // fall back to the default relay, which is a privacy decision the user already made.
    expect(keys.has(SYNC_META.relayUrl)).toBe(true);
    expect(keys.has(SYNC_META.headHash)).toBe(true);
    expect(keys.has(SYNC_META.seq)).toBe(true);
  });

  it('names the file by the day it was written', () => {
    expect(backupFileName(LATER_ISO)).toBe('qashy-vault-2026-09-14.qashyvault');
  });
});

describe('what the confirm step is shown', () => {
  it('counts live transactions, not rows', async () => {
    const from = await source();

    const summary = summarizeArchive(await opened(from, await sealed(from)));

    expect(summary).toEqual({
      createdAt: NOW_ISO,
      deviceName: 'Phone',
      baseCurrency: 'ILS',
      peerCount: 1,
      opCount: 5,
      recordCount: 4,
      // One of the two transactions is a tombstone. Showing "2 transactions" in front of a
      // destructive confirm is how a user talks themselves into restoring the wrong file.
      transactionCount: 1,
    });
  });
});

describe('choosing which secret to ask for', () => {
  it('reads the lock off the file before anything is typed', async () => {
    const from = await source();

    expect(readBackupLock(await sealed(from))).toBe('recoveryPhrase');
    expect(readBackupLock(utf8Bytes('id,date,amount\n'))).toBeNull();
  });

  it('refuses the wrong kind of secret without spending a key derivation on it', async () => {
    const from = await source();
    const file = await sealed(from);

    // The refusal has to happen here rather than in the AEAD, because "wrong passphrase" in
    // front of a phrase-locked archive is a prompt the user cannot satisfy and cannot diagnose.
    await expect(readVaultBackup(file, { kind: 'passphrase', passphrase: PASSPHRASE })).rejects.toThrow(
      'That backup is opened with a recovery phrase, not a passphrase.',
    );
  });

  it('rejects a file that is not a Qashy backup at all', async () => {
    const from = await source();

    await expect(opened(from, utf8Bytes('id,date,amount\n1,2026-01-01,10'))).rejects.toThrow(
      BackupError,
    );
  });
});

describe('a damaged or foreign archive', () => {
  it('names the phrase as the likely cause rather than reporting damage', async () => {
    const from = await source();
    const other = await source();

    await expect(opened(other, await sealed(from))).rejects.toThrow(
      /recovery phrase does not match this backup/,
    );
  });

  it('refuses a file with a flipped bit instead of restoring part of it', async () => {
    const from = await source();
    const file = await sealed(from);
    file[file.length - 20] ^= 0x01;

    await expect(opened(from, file)).rejects.toThrow();
  });

  it('says which version wrote an archive this build cannot read', async () => {
    const from = await source();
    const vault = await from.keystore.read();
    const forged = createVaultKeyBackup(
      vault!.vaultKey,
      utf8Bytes(JSON.stringify({ format: 2, vault: '', deviceId: '' })),
    );

    // Naming the number matters: the remedy is "update this device", and a generic "damaged"
    // sends the user looking for a second copy of a file that was never damaged.
    await expect(opened(from, forged)).rejects.toThrow(/format v2/);
  });

  it('fails before writing anything when the key inside will not decode', async () => {
    const from = await source();
    const vault = await from.keystore.read();
    const forged = createVaultKeyBackup(
      vault!.vaultKey,
      utf8Bytes(JSON.stringify({ format: 1, vault: 'not-base64url-at-all!!', deviceId: 'x' })),
    );

    await expect(opened(from, forged)).rejects.toThrow(/usable vault key/);
  });
});

describe('restoring onto a replacement device', () => {
  it('lands the key, the roster, the log, and the records together', async () => {
    const from = await source();
    const archive = await opened(from, await sealed(from));
    // Not empty: a reinstall where the user typed something in before remembering the backup.
    // If `clearRecords` did not run, that row would survive into a vault that never had it.
    const target = await rig([stored('accounts', account({ id: 'acc-stray', name: 'Stray' }))], () => LATER_ISO);

    const result = await restoreVaultBackup(target.deps, archive);

    expect(result).toEqual({
      deviceId: from.deviceId,
      recordCount: 4,
      opCount: 5,
      peerCount: 1,
    });

    // The same device, not a new one that happens to hold the same data. Its ops continue the
    // original chain under the original signing key, so peers accept them without re-pairing.
    const vault = await target.keystore.read();
    expect(vault?.identity.deviceId).toBe(from.deviceId);

    expect((await target.storage.readAll('accounts')).map((row) => row.id)).toEqual(['acc-1']);
    expect((await target.storage.readAll('transactions')).map((row) => row.id).sort()).toEqual([
      'txn-1',
      'txn-gone',
    ]);
    expect((await target.roster()).map((peer) => peer.deviceId)).toEqual([from.peer.deviceId]);

    const meta = await target.meta();
    expect(meta.get(SYNC_META.enabled)).toBe('1');
    expect(meta.get(SYNC_META.deviceId)).toBe(from.deviceId);
    expect(meta.get(SYNC_META.deviceName)).toBe('Phone');
    expect(meta.get(SYNC_META.baseCurrency)).toBe('ILS');
    expect(meta.has(SYNC_META.relayCursor)).toBe(false);

    // Recorded, because a restore is the single most consequential thing this app does and a
    // device that cannot say when it happened cannot explain a fork afterwards.
    expect(await target.activity()).toContain('recovered');
  });

  it('refuses a device that is already part of a vault', async () => {
    const from = await source();
    const archive = await opened(from, await sealed(from));
    const target = await rig();
    await enableSync(target.deps, { name: 'Tablet', platform: 'android' });
    const before = await target.keystore.read();

    await expect(restoreVaultBackup(target.deps, archive)).rejects.toThrow(
      /already part of a vault/,
    );

    // The refusal must leave the existing vault untouched, or "restore" becomes the thing that
    // loses the data it was reached for.
    const after = await target.keystore.read();
    expect(after?.identity.deviceId).toBe(before?.identity.deviceId);
    expect(after?.vaultKey).toEqual(before?.vaultKey);
  });

  it('treats a locked keystore as a vault it must not overwrite', async () => {
    const from = await source();
    const archive = await opened(from, await sealed(from));

    const target = await rig();
    await enableSync(target.deps, { name: 'Tablet', platform: 'android' });
    await target.keystore.setPassphrase('a passphrase on this browser');
    // A second keystore over the same bytes starts cold, which is what an app restart looks
    // like: the record is there and unreadable. "Cannot see" is not "is not there", and
    // reading it as empty would let a restore overwrite exactly the vault the gate protects.
    const restarted = new MemoryKeystore(target.cell);

    await expect(
      restoreVaultBackup({ ...target.deps, keystore: restarted }, archive),
    ).rejects.toThrow(/already part of a vault/);

    expect(target.cell.bytes).not.toBeNull();
  });

  it('leaves an empty archive restorable rather than throwing on empty tables', async () => {
    // A device that enabled sync before entering anything. Every table is empty, and a `put([])`
    // that reaches SQL builds a `VALUES` clause with nothing in it.
    const empty = await rig();
    const { deviceId } = await enableSync(empty.deps, PROFILE);
    const vault = await empty.keystore.read();
    const phrase = vaultKeyToRecoveryPhrase(vault!.vaultKey);
    const file = await exportVaultBackup(empty.deps, { kind: 'recoveryPhrase' });
    const archive = await readVaultBackup(file, { kind: 'recoveryPhrase', phrase });

    const target = await rig();
    await expect(restoreVaultBackup(target.deps, archive)).resolves.toEqual({
      deviceId,
      recordCount: 0,
      opCount: 0,
      peerCount: 0,
    });
  });
});

describe('a backup sealed with a passphrase', () => {
  let from: Source;
  let file: Uint8Array;

  beforeAll(async () => {
    from = await source();
    file = await exportVaultBackup(from.deps, { kind: 'passphrase', passphrase: PASSPHRASE });
  }, SCRYPT_TIMEOUT);

  it('advertises which secret it wants', () => {
    expect(readBackupLock(file)).toBe('passphrase');
  });

  it(
    'carries the same archive the phrase-locked file does',
    async () => {
      const archive = await readVaultBackup(file, { kind: 'passphrase', passphrase: PASSPHRASE });

      // One format, two locks. A second archive shape for the second lock would be a second
      // thing to review and a second restore path to get wrong.
      expect(summarizeArchive(archive)).toEqual(
        summarizeArchive(await opened(from, await sealed(from))),
      );
      expect(archive.deviceId).toBe(from.deviceId);
      expect(archive.records).toHaveLength(4);
    },
    SCRYPT_TIMEOUT,
  );

  it(
    'leads with the likely cause on a wrong passphrase',
    async () => {
      await expect(
        readVaultBackup(file, { kind: 'passphrase', passphrase: 'correct horse battery stapl' }),
      ).rejects.toThrow(/Wrong passphrase, or the backup file is damaged/);
    },
    SCRYPT_TIMEOUT,
  );

  it('refuses a recovery phrase in front of it, before the derivation', async () => {
    await expect(
      readVaultBackup(file, { kind: 'recoveryPhrase', phrase: from.phrase }),
    ).rejects.toThrow('That backup is protected by a passphrase, not a recovery phrase.');
  });

  it(
    'restores exactly what the phrase-locked one would',
    async () => {
      const archive: VaultArchive = await readVaultBackup(file, {
        kind: 'passphrase',
        passphrase: PASSPHRASE,
      });
      const target = await rig();

      const result = await restoreVaultBackup(target.deps, archive);

      expect(result.deviceId).toBe(from.deviceId);
      expect((await target.keystore.read())?.identity.deviceId).toBe(from.deviceId);
      expect((await target.storage.readAll('transactions'))).toHaveLength(2);
    },
    SCRYPT_TIMEOUT,
  );
});
