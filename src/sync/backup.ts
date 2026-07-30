/**
 * The whole vault in one encrypted file, and the way back from it.
 *
 * This exists because of an uncomfortable fact about the recovery phrase: **it recovers the
 * key, not the data.** Every frame in the drop-box is sealed to a specific `recipientDeviceId`
 * through the envelope's associated data, so a replacement device with a fresh identity can
 * open nothing that is sitting there waiting; and the drop-box holds a fortnight of *deltas*
 * regardless, never the vault. Twenty-four words on paper and no surviving device is twenty-four
 * words and no data. Saying "keep a second device" is true and is not a backup story.
 *
 * So the archive carries everything a device needs to *be* that device again: the key, the
 * device identity including its private halves, the op log and its chain head, the roster, the
 * causal state, and the materialized records. Restoring it produces a device that is
 * byte-for-byte the one that made it, which has two consequences worth stating plainly.
 *
 * - **Peers already know it.** Its ops continue the same chain under the same signing key, so
 *   nothing has to be re-paired and no peer sees a batch from an unknown author. A restored
 *   device that had a fresh identity would be rejected by every peer it has, which is a
 *   recovery path that recovers nothing.
 * - **Restoring while the original is still running forks the chain**, and peers reject a fork
 *   — fail-closed, by design. This is a recovery tool for a device that is gone, and the UI has
 *   to say so rather than presenting it as a general-purpose copy.
 *
 * Two locks, one archive. A **passphrase** for a file that leaves the trust boundary, and the
 * **recovery phrase** for the case the phrase was always supposed to cover. Both seal the same
 * bytes, so there is one format to review and one restore path to test.
 *
 * What is deliberately *not* in the archive: `sync_quarantine`, which `findUnprojected` rebuilds
 * from the op log on the next pass, and `sync_activity`, which is this device's local diagnostic
 * log and means nothing on a machine that did not witness the events. Neither is state; both are
 * derived or disposable, and carrying them would be two more shapes to keep in step.
 */

import { clearSyncTables, type StorageTx, type StoredEntity } from '@/data/storage-adapter';
import { SYNC_META, appendActivity } from '@/data/sync-store';
import type {
  SyncMetaRow,
  SyncOpRow,
  SyncPeerRow,
  SyncRow,
  SyncStateRow,
  SyncTableName,
} from '@/data/sync-tables';
import { ENTITY_TYPES, type EntityType } from '@/domain/models';
import {
  bytesToUtf8,
  createPassphraseBackup,
  createVaultKeyBackup,
  fromBase64Url,
  openPassphraseBackup,
  openVaultKeyBackup,
  readBackupKind,
  recoveryPhraseToVaultKey,
  toBase64Url,
  utf8Bytes,
} from '@/sync/crypto';
import { activityEntry } from '@/sync/engine';
import {
  KeystoreError,
  decodeVaultRecord,
  encodeVaultRecord,
  type StoredVault,
  type SyncKeystore,
} from '@/sync/keystore';
import type { SyncSetupDeps } from '@/sync/setup';
import { nowIso as defaultNowIso } from '@/utils/entity';

/** Bumped only when the archive body's shape changes. An older build refuses a newer number. */
export const ARCHIVE_FORMAT = 1;

export const BACKUP_EXTENSION = '.qashyvault';
export const BACKUP_MIME = 'application/octet-stream';

/** The name to suggest when saving. Dated so a folder of them is orderable by eye. */
export const backupFileName = (isoDate: string) =>
  `qashy-vault-${isoDate.slice(0, 10)}${BACKUP_EXTENSION}`;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const DAMAGED = 'That backup file is damaged.';

/**
 * Meta keys the archive deliberately drops.
 *
 * Every one of them describes this device's relationship with a *server* at a moment in time,
 * not the vault. `relayCursor` is the load-bearing one: leaving it out resets the restored
 * device to slot zero, so it re-collects everything still in the drop-box — and because the
 * restored device carries the original's id, those frames are addressed to it and will open.
 * Carrying the cursor across would skip precisely the history the restore needs most.
 */
const TRANSIENT_META = new Set<string>([
  SYNC_META.lastWrite,
  SYNC_META.relayCursor,
  SYNC_META.relayStatus,
  SYNC_META.relayCheckedAt,
  SYNC_META.relayDetail,
  SYNC_META.relayFailures,
]);

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);

/**
 * How an archive is sealed when it is written.
 *
 * The recovery-phrase variant carries no phrase, and that is the point: it seals under the key
 * this device already holds, so the phrase that opens it is by construction the vault's own.
 * Asking the user to type their phrase in order to *export* would create a way to write a file
 * that nothing can open, which is the worst possible failure for a backup.
 */
export type BackupLock =
  | { readonly kind: 'passphrase'; readonly passphrase: string }
  | { readonly kind: 'recoveryPhrase' };

/** How an archive is opened when it is read. Here the phrase is the whole input. */
export type BackupKeySource =
  | { readonly kind: 'passphrase'; readonly passphrase: string }
  | { readonly kind: 'recoveryPhrase'; readonly phrase: string };

/**
 * The archive body, after decryption and before it is written anywhere.
 *
 * JSON rather than a hand-written binary framing, and the reason is narrow: injective encoding
 * matters for anything a signature or a transcript covers, and this is neither. It is a payload
 * that has *already* been authenticated by the AEAD before a single byte of it is parsed, so
 * the encoding only has to round-trip. A second bespoke binary format in this codebase would be
 * a second thing to review for a property that is not required here.
 */
export interface VaultArchive {
  readonly format: number;
  readonly createdAt: string;
  /** base64url of the 105-byte keystore record: vault key, signing secret, agreement secret. */
  readonly vault: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly baseCurrency: string;
  readonly meta: readonly SyncMetaRow[];
  readonly peers: readonly SyncPeerRow[];
  readonly ops: readonly SyncOpRow[];
  readonly state: readonly SyncStateRow[];
  readonly records: readonly StoredEntity[];
}

/** What the confirm step shows before anything is overwritten. */
export interface ArchiveSummary {
  readonly createdAt: string;
  readonly deviceName: string;
  readonly baseCurrency: string;
  /** Peers recorded in the archive. The restored device itself is not one of them. */
  readonly peerCount: number;
  readonly opCount: number;
  readonly recordCount: number;
  /** Live transactions, so the number on screen is one the user can recognise as theirs. */
  readonly transactionCount: number;
}

export interface RestoreResult {
  readonly deviceId: string;
  readonly recordCount: number;
  readonly opCount: number;
  readonly peerCount: number;
}

export const summarizeArchive = (archive: VaultArchive): ArchiveSummary => ({
  createdAt: archive.createdAt,
  deviceName: archive.deviceName,
  baseCurrency: archive.baseCurrency,
  peerCount: archive.peers.length,
  opCount: archive.ops.length,
  recordCount: archive.records.length,
  transactionCount: archive.records.filter(
    (row) => row.type === 'transactions' && !row.entity.deletedAt,
  ).length,
});

/**
 * Which secret a file wants, from its first bytes, before anything is typed.
 *
 * The restore screen cannot ask a sensible question until it knows this — "enter your
 * passphrase" in front of a recovery-phrase archive is a prompt the user cannot satisfy and
 * cannot diagnose. Stated in `BackupKeySource`'s vocabulary rather than the crypto layer's, so
 * the screen never has to translate between the two, and `null` for a file that is not a Qashy
 * backup at all.
 *
 * A routing hint, not a check. The magic bytes are unauthenticated; what actually decides
 * whether a file opens is the AEAD tag, several steps later.
 */
export const readBackupLock = (file: Uint8Array): BackupKeySource['kind'] | null => {
  const kind = readBackupKind(file);
  return kind === 'vaultKey' ? 'recoveryPhrase' : kind;
};

/**
 * Hands the UI thread back for one frame.
 *
 * scrypt at the default parameters is a deliberate few hundred milliseconds of synchronous
 * work, and JavaScript has one thread. Without this the "Working…" state is set and the block
 * begins in the same tick, so it never paints and the app looks hung at exactly the moment the
 * user is waiting on it. A macrotask, not `Promise.resolve()` — a microtask runs before paint.
 */
const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Seals this device's entire vault into one file.
 *
 * Read in a single transaction so the archive is a coherent instant rather than a smear across
 * a concurrent write: an op log read after a record write it does not describe would restore to
 * a device whose projection is ahead of its history, and nothing downstream expects that.
 */
export async function exportVaultBackup(
  deps: SyncSetupDeps,
  lock: BackupLock,
): Promise<Uint8Array> {
  // Outside the transaction: the keystore is the Keychain or a WebCrypto unwrap, and awaiting
  // either inside `work` would leave Dexie's promise zone mid-transaction.
  const vault = await deps.keystore.read();
  if (!vault) {
    throw new KeystoreError('There is no vault on this device to back up.', 'empty');
  }

  const at = (deps.nowIso ?? defaultNowIso)();
  const body = await deps.storage.transact(async (tx): Promise<VaultArchive> => {
    const meta = (await tx.table('syncMeta').all()).filter((row) => !TRANSIENT_META.has(row.key));
    const value = (key: string) => meta.find((row) => row.key === key)?.value ?? '';
    const loaded = await Promise.all(
      ENTITY_TYPES.map(async (type) => ({ type, entities: await tx.readAll(type) })),
    );

    return {
      format: ARCHIVE_FORMAT,
      createdAt: at,
      vault: toBase64Url(encodeVaultRecord(vault)),
      deviceId: vault.identity.deviceId,
      deviceName: value(SYNC_META.deviceName),
      baseCurrency: value(SYNC_META.baseCurrency),
      meta,
      peers: await tx.table('syncPeers').all(),
      ops: await tx.table('syncOps').all(),
      state: await tx.table('syncState').all(),
      // Tombstones included, and they are not optional: `hydrateFromStorage` rebuilds
      // `deletedOccurrenceKeys` from them, so an archive without them restores a device that
      // regenerates every recurrence the user has ever deleted, on every foreground.
      records: loaded.flatMap(({ type, entities }) =>
        entities.map((entity) => ({ type: type as EntityType, entity })),
      ),
    };
  });

  const payload = utf8Bytes(JSON.stringify(body));
  await yieldToUi();
  return lock.kind === 'passphrase'
    ? createPassphraseBackup(lock.passphrase, payload)
    : createVaultKeyBackup(vault.vaultKey, payload);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Opens and validates an archive without writing anything.
 *
 * Split from `restoreVaultBackup` so the user can be shown what they are about to overwrite
 * themselves with — a date, a device name, a count of transactions — and decide. A restore that
 * wipes the device first and reports what it found afterwards is not a decision anyone can make.
 */
export async function readVaultBackup(
  file: Uint8Array,
  secret: BackupKeySource,
): Promise<VaultArchive> {
  const kind = readBackupKind(file);
  if (!kind) throw new BackupError('That file is not a Qashy vault backup.');
  // Checked before the expensive part, so a user who picked the wrong file is told which secret
  // it wants rather than being asked to wait for a key derivation that was never going to work.
  if (kind === 'passphrase' && secret.kind !== 'passphrase') {
    throw new BackupError('That backup is protected by a passphrase, not a recovery phrase.');
  }
  if (kind === 'vaultKey' && secret.kind !== 'recoveryPhrase') {
    throw new BackupError('That backup is opened with a recovery phrase, not a passphrase.');
  }

  await yieldToUi();
  const payload =
    secret.kind === 'passphrase'
      ? openPassphraseBackup(secret.passphrase, file)
      : openVaultKeyBackup(recoveryPhraseToVaultKey(secret.phrase), file);
  return parseArchive(bytesToUtf8(payload));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks every row of one table, or refuses the whole file.
 *
 * Structural only. The payload is already authenticated — it can only have been written by
 * something holding the vault key or the passphrase — so this is not defending against a
 * crafted archive; it is defending against a truncated download and against a future format
 * change that slipped past `ARCHIVE_FORMAT`. Refusing whole rather than per-row for the reason
 * `decodeBundle` does: a half-restored vault leaves nobody able to say which half.
 */
function table<Row>(value: unknown, valid: (row: Record<string, unknown>) => boolean): Row[] {
  if (!Array.isArray(value)) throw new BackupError(DAMAGED);
  for (const row of value) {
    if (!isRecord(row) || !valid(row)) throw new BackupError(DAMAGED);
  }
  return value as Row[];
}

function parseArchive(text: string): VaultArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError(DAMAGED);
  }
  if (!isRecord(parsed)) throw new BackupError(DAMAGED);

  if (parsed.format !== ARCHIVE_FORMAT) {
    throw new BackupError(
      `That backup was written by a different version of Qashy (format v${String(parsed.format)}). Update this device before restoring it.`,
    );
  }
  if (typeof parsed.vault !== 'string' || typeof parsed.deviceId !== 'string') {
    throw new BackupError(DAMAGED);
  }
  // Decoded here purely to fail early. A key that will not decode is the one defect that must
  // not be discovered after `clearRecords` has run.
  readVault(parsed.vault);

  return {
    format: ARCHIVE_FORMAT,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    vault: parsed.vault,
    deviceId: parsed.deviceId,
    deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : '',
    baseCurrency: typeof parsed.baseCurrency === 'string' ? parsed.baseCurrency : '',
    meta: table<SyncMetaRow>(
      parsed.meta,
      (row) => typeof row.key === 'string' && typeof row.value === 'string',
    ),
    peers: table<SyncPeerRow>(
      parsed.peers,
      (row) =>
        typeof row.peerId === 'string' &&
        typeof row.signingKey === 'string' &&
        typeof row.agreementKey === 'string' &&
        typeof row.acked === 'string' &&
        typeof row.known === 'string',
    ),
    ops: table<SyncOpRow>(
      parsed.ops,
      (row) =>
        typeof row.opId === 'string' &&
        typeof row.deviceId === 'string' &&
        Number.isSafeInteger(row.seq) &&
        typeof row.opHash === 'string' &&
        typeof row.hlc === 'string' &&
        typeof row.payload === 'string' &&
        (row.sealed === 0 || row.sealed === 1),
    ),
    state: table<SyncStateRow>(
      parsed.state,
      (row) =>
        typeof row.key === 'string' && typeof row.meta === 'string' && typeof row.maxHlc === 'string',
    ),
    records: table<StoredEntity>(
      parsed.records,
      (row) =>
        typeof row.type === 'string' &&
        ENTITY_TYPE_SET.has(row.type) &&
        isRecord(row.entity) &&
        typeof row.entity.id === 'string',
    ),
  };
}

function readVault(encoded: string): StoredVault {
  try {
    return decodeVaultRecord(fromBase64Url(encoded));
  } catch {
    throw new BackupError('That backup does not contain a usable vault key.');
  }
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

/**
 * Replaces everything on this device with the archive.
 *
 * **Destructive, and not partially.** Finance records, the op log, the roster, and the chain
 * head are all replaced, because a restore that merged into whatever was already here would
 * produce a device holding two histories under one chain — which is the fork every peer is
 * built to reject. The caller must have confirmed this against `summarizeArchive`.
 *
 * Refuses outright when this device already holds a vault. That device has a key this archive
 * may not contain and peers this archive may not know, and overwriting it silently is how a
 * "restore" becomes the thing that loses the data. Leaving the vault first is one deliberate
 * tap and makes the intent unambiguous.
 *
 * The keystore is written **before** the transaction, following the rule the rest of setup
 * keeps: a key nobody references is inert and the next attempt overwrites it, whereas records
 * restored against a key that was never stored is a device that says it is paired and cannot
 * prove it.
 *
 * Safe to run through `deps.storage` even when that is the `SyncingStorageAdapter`: only its
 * `putMany` captures ops, and `transact` is a documented pass-through. Restoring through the
 * capturing path would emit a parallel chain of `create` ops for entities whose real history is
 * in the very log being restored.
 */
export async function restoreVaultBackup(
  deps: SyncSetupDeps,
  archive: VaultArchive,
): Promise<RestoreResult> {
  if (await vaultPresent(deps.keystore)) {
    throw new BackupError(
      'This device is already part of a vault. Leave it from Sync → Danger zone before restoring a backup.',
    );
  }

  const vault = readVault(archive.vault);
  await deps.keystore.write(vault);

  const at = (deps.nowIso ?? defaultNowIso)();
  await deps.storage.transact(async (tx) => {
    await clearSyncTables(tx);
    await tx.clearRecords();

    await put(tx, 'syncMeta', archive.meta);
    await put(tx, 'syncPeers', archive.peers);
    await put(tx, 'syncOps', archive.ops);
    await put(tx, 'syncState', archive.state);
    if (archive.records.length) await tx.putMany(archive.records);

    await appendActivity(tx, [
      activityEntry({ kind: 'recovered', recordedAt: at, count: archive.records.length }),
    ]);
  });

  return {
    deviceId: vault.identity.deviceId,
    recordCount: archive.records.length,
    opCount: archive.ops.length,
    peerCount: archive.peers.length,
  };
}

/**
 * Whether this device holds a vault, counting a locked one as yes.
 *
 * A keystore behind an unopened passphrase gate holds a key this function cannot see, and
 * "cannot see" is not "is not there". Reading it as empty would let a restore overwrite exactly
 * the vault a passphrase gate exists to protect.
 */
async function vaultPresent(keystore: SyncKeystore): Promise<boolean> {
  try {
    return Boolean(await keystore.read());
  } catch (error) {
    if (error instanceof KeystoreError) {
      if (error.code === 'locked') return true;
      if (error.code === 'empty') return false;
    }
    throw error;
  }
}

/** An empty table is ordinary, and a `put([])` that reaches SQL builds a `VALUES` clause with nothing in it. */
async function put<Name extends SyncTableName>(
  tx: StorageTx,
  name: Name,
  rows: readonly SyncRow<Name>[],
) {
  if (rows.length) await tx.table(name).put(rows);
}
