/**
 * Recovery: the 24-word phrase, and the passphrase-protected backup file.
 *
 * Both of these are, bluntly, **full access to the vault**. That is not a flaw to be
 * papered over in the UI — it is the honest consequence of a design where no server can
 * ever help you recover, and the interface has to say so in those words. A user who
 * believes the phrase is "just a backup code" will store it somewhere a password would
 * be fine but a vault key is not.
 *
 * Two distinct wrappings live here, and the difference matters:
 *
 * - **Passphrase backup** (`createPassphraseBackup`): protects a file that leaves the
 *   vault's trust boundary — email, a cloud drive, a USB stick. Its key comes from
 *   scrypt over a passphrase, because the recipient of that file is assumed *not* to
 *   already hold the vault key. This is the one users will hand around.
 * - **Vault-keyed bundle** (`createVaultBundle`): protects a file moving *between devices
 *   that already share the vault key*, which is the hand-carried `.qashysync` transport.
 *   No passphrase, because demanding one would add a secret without adding a boundary —
 *   anyone who can open the file already holds the key that would decrypt the vault.
 * - **Vault-keyed backup** (`createVaultKeyBackup`): the same archive as the passphrase
 *   backup, but unlocked by the 24-word phrase instead of a passphrase. It exists because
 *   the phrase alone cannot restore a vault — it recovers the *key*, and the key without
 *   the data is a key to nothing. Pairing this file with the phrase is what turns "I wrote
 *   down 24 words" into an actual recovery path.
 *
 * The last two share a key (`deriveBackupKey`) and are kept apart by the envelope purpose —
 * `'file'` for a bundle in flight, `'backup'` for an archive at rest — so a bundle can never
 * be opened as an archive by swapping a magic number.
 */

import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { ENVELOPE_PURPOSES, open, seal, type EnvelopeContext } from '@/sync/crypto/envelope';
import { deriveBackupKey } from '@/sync/crypto/keys';
import {
  KEY_LENGTH,
  SCRYPT_DEFAULTS,
  concatBytes,
  lengthPrefixed,
  randomBytes,
  scryptKey,
  u32be,
  u8,
  type ScryptParams,
} from '@/sync/crypto/primitives';
import { SyncCryptoError, brand, type BackupKey, type VaultRootKey } from '@/sync/crypto/types';

export const RECOVERY_WORD_COUNT = 24;

// ---------------------------------------------------------------------------
// Recovery phrase
// ---------------------------------------------------------------------------

/**
 * Encodes the vault root key as 24 BIP39 words.
 *
 * BIP39 rather than a bare hex dump for one reason that matters in practice: it carries a
 * checksum, so a phrase transcribed with one word wrong is *rejected* rather than
 * silently reconstructing a different, useless key. Someone restoring a vault years later
 * from handwriting deserves to be told they made a typo.
 */
export const vaultKeyToRecoveryPhrase = (vrk: VaultRootKey) => bip39.entropyToMnemonic(vrk, wordlist);

export const recoveryPhraseToVaultKey = (phrase: string) => {
  const normalized = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!bip39.validateMnemonic(normalized, wordlist)) {
    throw new SyncCryptoError(
      'That recovery phrase is not valid. Check for a mistyped or out-of-order word.',
      'badMnemonic',
    );
  }
  const entropy = bip39.mnemonicToEntropy(normalized, wordlist);
  if (entropy.length !== KEY_LENGTH) {
    throw new SyncCryptoError(`A Qashy recovery phrase is ${RECOVERY_WORD_COUNT} words.`, 'badMnemonic');
  }
  return brand<VaultRootKey>(entropy);
};

/** Validates without revealing anything, so the confirmation step can check as the user types. */
export const isValidRecoveryPhrase = (phrase: string) =>
  bip39.validateMnemonic(phrase.trim().toLowerCase().replace(/\s+/g, ' '), wordlist);

// ---------------------------------------------------------------------------
// Backup files
// ---------------------------------------------------------------------------

const BACKUP_MAGIC = new Uint8Array([0x51, 0x53, 0x59, 0x42]); // 'QSYB'
const VAULT_BACKUP_MAGIC = new Uint8Array([0x51, 0x53, 0x59, 0x56]); // 'QSYV'
const BACKUP_FORMAT = 1;
const SALT_LENGTH = 32;

/**
 * Which secret opens this file, read from its first bytes alone.
 *
 * The caller needs this *before* it can prompt: asking for a passphrase and then discovering
 * the file wanted a recovery phrase is a dead end the user cannot reason about. `null` for
 * anything that is not a Qashy backup at all.
 *
 * This is a routing hint, not a security check — the magic is unauthenticated, and a file
 * whose magic says one thing and whose ciphertext says another simply fails to open.
 */
export const readBackupKind = (file: Uint8Array): 'passphrase' | 'vaultKey' | null => {
  const matches = (magic: Uint8Array) => magic.every((byte, index) => file[index] === byte);
  if (file.length < 5) return null;
  if (matches(BACKUP_MAGIC)) return 'passphrase';
  if (matches(VAULT_BACKUP_MAGIC)) return 'vaultKey';
  return null;
};

const backupContext = (): EnvelopeContext => ({
  purpose: 'backup',
  senderDeviceId: '',
  recipientDeviceId: '',
  epoch: 0,
  seq: 0,
});

const bundleContext = (senderDeviceId: string, epoch: number, seq: number): EnvelopeContext => ({
  purpose: 'file',
  senderDeviceId,
  recipientDeviceId: '',
  epoch,
  seq,
});

/**
 * Seals `payload` under a key stretched from `passphrase`.
 *
 * The scrypt parameters are written into the header rather than assumed by the reader, so
 * raising them later does not orphan every backup a user already made. A file that
 * declares parameters this build considers too weak is still rejected — the header is a
 * record of what was used, not a licence to use anything.
 */
export const createPassphraseBackup = (
  passphrase: string,
  payload: Uint8Array,
  params: ScryptParams = SCRYPT_DEFAULTS,
) => {
  if (passphrase.length < 8) {
    throw new SyncCryptoError('Use a passphrase of at least 8 characters.', 'badPassphrase');
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = brand<BackupKey>(scryptKey(passphrase, salt, params));
  return concatBytes(
    BACKUP_MAGIC,
    u8(BACKUP_FORMAT),
    u32be(params.N),
    u32be(params.r),
    u32be(params.p),
    lengthPrefixed(salt),
    seal(key, backupContext(), payload),
  );
};

export const openPassphraseBackup = (passphrase: string, file: Uint8Array) => {
  const header = 4 + 1 + 4 + 4 + 4 + 4;
  if (file.length < header + SALT_LENGTH) {
    throw new SyncCryptoError('That file is not a Qashy backup.', 'badFormat');
  }
  if (BACKUP_MAGIC.some((byte, index) => file[index] !== byte)) {
    throw new SyncCryptoError('That file is not a Qashy backup.', 'badFormat');
  }
  if (file[4] !== BACKUP_FORMAT) {
    throw new SyncCryptoError('That backup was written by a newer version of Qashy.', 'badVersion');
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const params: ScryptParams = { N: view.getUint32(5, false), r: view.getUint32(9, false), p: view.getUint32(13, false) };
  const saltLength = view.getUint32(17, false);
  if (saltLength !== SALT_LENGTH || file.length < header + saltLength) {
    throw new SyncCryptoError('That backup file is damaged.', 'badFormat');
  }
  // Bound the work an attacker-supplied header can demand. 2^22 with r=8 is 4 GiB; a file
  // asking for that is either corrupt or hostile, and either way should not be attempted.
  if (params.N > 2 ** 22 || params.r > 32 || params.p > 16) {
    throw new SyncCryptoError('That backup asks for an unreasonable amount of work to open.', 'badFormat');
  }
  const salt = file.slice(header, header + saltLength);
  const key = brand<BackupKey>(scryptKey(passphrase, salt, params));
  try {
    return open(key, backupContext(), file.slice(header + saltLength));
  } catch (reason) {
    // The AEAD cannot distinguish a wrong passphrase from a damaged file, but the user
    // almost always mistyped, so lead with that and mention the other.
    if (reason instanceof SyncCryptoError && reason.code === 'badTag') {
      throw new SyncCryptoError('Wrong passphrase, or the backup file is damaged.', 'badPassphrase');
    }
    throw reason;
  }
};

/**
 * Seals a payload under a key derived from the vault root key. Used by the hand-carried
 * file transport, where both devices are already vault members.
 */
export const createVaultBundle = (
  vrk: VaultRootKey,
  senderDeviceId: string,
  epoch: number,
  seq: number,
  payload: Uint8Array,
) => seal(deriveBackupKey(vrk), bundleContext(senderDeviceId, epoch, seq), payload);

export const openVaultBundle = (
  vrk: VaultRootKey,
  senderDeviceId: string,
  epoch: number,
  seq: number,
  file: Uint8Array,
) => open(deriveBackupKey(vrk), bundleContext(senderDeviceId, epoch, seq), file);

/**
 * Seals a backup archive under the vault root key, so the 24-word phrase opens it.
 *
 * No scrypt header, and that is not an oversight: the key is already 32 uniform random
 * bytes, and stretching a uniformly random key accomplishes nothing but making the restore
 * slow. Stretching exists to make a *low-entropy* secret expensive to guess.
 */
export const createVaultKeyBackup = (vrk: VaultRootKey, payload: Uint8Array) =>
  concatBytes(VAULT_BACKUP_MAGIC, u8(BACKUP_FORMAT), seal(deriveBackupKey(vrk), backupContext(), payload));

export const openVaultKeyBackup = (vrk: VaultRootKey, file: Uint8Array) => {
  const header = VAULT_BACKUP_MAGIC.length + 1;
  if (file.length < header || VAULT_BACKUP_MAGIC.some((byte, index) => file[index] !== byte)) {
    throw new SyncCryptoError('That file is not a Qashy backup.', 'badFormat');
  }
  if (file[4] !== BACKUP_FORMAT) {
    throw new SyncCryptoError('That backup was written by a newer version of Qashy.', 'badVersion');
  }
  try {
    return open(deriveBackupKey(vrk), backupContext(), file.slice(header));
  } catch (reason) {
    // Same reasoning as the passphrase path, different remedy: the phrase is far more
    // likely to be the wrong *vault's* phrase than mistyped, since a typo fails the BIP39
    // checksum long before it reaches here.
    if (reason instanceof SyncCryptoError && reason.code === 'badTag') {
      throw new SyncCryptoError(
        'That recovery phrase does not match this backup, or the file is damaged.',
        'badPassphrase',
      );
    }
    throw reason;
  }
};

/** Exported so the file transport can label bundles without importing the envelope module. */
export const VAULT_BUNDLE_PURPOSE = ENVELOPE_PURPOSES.file;
