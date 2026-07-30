/**
 * The public surface of Qashy's cryptography.
 *
 * Everything outside `src/sync/crypto/` imports from here and nowhere else — ESLint
 * enforces that `@noble/*` and `@scure/*` cannot be reached directly. The point is that
 * "what cryptography does this app perform, and how?" has exactly one answer, in one
 * directory, rather than being distributed across whichever files happened to need a hash.
 *
 * Deliberately **not** re-exported: `primitives.ts`. Callers outside this directory should
 * never be choosing a nonce, picking an AEAD, or hashing something themselves — if a new
 * use case needs that, it belongs in here as a named construction with its own tests.
 */

export { LABELS, OP_SCHEMA_VERSION, PAIRING_TTL_SECONDS, PROTOCOL_VERSION, RENDEZVOUS_WINDOW_SECONDS } from '@/sync/crypto/labels';

export {
  ENVELOPE_PURPOSES,
  MAX_FRAME_BYTES,
  open,
  paddedSize,
  peekPurpose,
  seal,
  type EnvelopeContext,
  type EnvelopePurpose,
} from '@/sync/crypto/envelope';

export {
  DEVICE_ID_LENGTH,
  ROUTE_TAG_LENGTH,
  createDeviceIdentity,
  createPairingSecret,
  createVaultRootKey,
  deriveBackupKey,
  deriveBucketId,
  deriveBucketToken,
  deriveContentKey,
  deriveDeviceId,
  derivePairingRendezvousId,
  deriveRendezvousId,
  deriveRouteTag,
  deviceIdentityBytes,
  formatDeviceId,
  rendezvousIds,
  rendezvousWindow,
  restoreDeviceIdentity,
  restorePeerKeys,
  restoreVaultRootKey,
  type DeviceIdentity,
} from '@/sync/crypto/keys';

export {
  acceptPeerAuth,
  completeHandshake,
  decodeHello,
  encodeHello,
  startHandshake,
  type CompleteHandshakeInput,
  type HandshakeHello,
  type HandshakeSession,
  type PendingHandshake,
} from '@/sync/crypto/handshake';

export {
  decodePairingCode,
  encodePairingCode,
  formatPairingCodeForTyping,
  normalizeTypedPairingCode,
  type PairingCode,
} from '@/sync/crypto/pairing-code';

export { SAS_WORD_COUNT, deriveSas, sasMatches } from '@/sync/crypto/sas';

export {
  RECOVERY_WORD_COUNT,
  createPassphraseBackup,
  createVaultBundle,
  createVaultKeyBackup,
  isValidRecoveryPhrase,
  openPassphraseBackup,
  openVaultBundle,
  openVaultKeyBackup,
  readBackupKind,
  recoveryPhraseToVaultKey,
  vaultKeyToRecoveryPhrase,
} from '@/sync/crypto/recovery';

export {
  SyncCryptoError,
  type AgreementKeyPair,
  type AgreementPublicKey,
  type AgreementSecretKey,
  type BackupKey,
  type BucketToken,
  type ContentKey,
  type PairingSecret,
  type SealingKey,
  type SessionKey,
  type SigningKeyPair,
  type SigningPublicKey,
  type SigningSecretKey,
  type SyncCryptoErrorCode,
  type TranscriptHash,
  type VaultRootKey,
} from '@/sync/crypto/types';

/**
 * Byte helpers that legitimately cross the boundary: the op log hashes its own chain, and
 * transports encode identifiers. These are not cryptographic *choices*, so exposing them
 * does not widen the reviewable surface.
 */
export {
  bytesToUtf8,
  concatBytes,
  constantTimeEqual,
  fromBase32,
  fromBase64Url,
  fromHex,
  randomBytes,
  sha256,
  sign,
  toBase32,
  toBase64Url,
  toHex,
  utf8Bytes,
  verify,
  zeroize,
} from '@/sync/crypto/primitives';
