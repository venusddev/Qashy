/**
 * Every domain-separation label in the sync protocol, in one place.
 *
 * Two keys derived from the same input with the same label are the same key. Labels
 * scattered as inline string literals are how that happens by accident — someone
 * copies a derivation, forgets to change the label, and two logically separate keys
 * silently become one. Adding a label here is a deliberate act with a diff.
 *
 * Labels are versioned with the protocol. Changing a label changes every key derived
 * from it, so it is a breaking wire change and requires a `PROTOCOL_VERSION` bump.
 */

/**
 * Wire-format major version. Bound into the handshake transcript that both sides sign,
 * which is what makes downgrade attacks fail: an attacker who rewrites this value
 * invalidates the signature.
 */
export const PROTOCOL_VERSION = 1;

/** Op-payload schema version. Bumped when the merge registry changes shape (see `oplog/registry.ts`). */
export const OP_SCHEMA_VERSION = 1;

export const LABELS = {
  /** HKDF info → the key that seals op batches. */
  content: 'qashy/sync/v1/content',
  /** HKDF info → the opaque relay bucket identifier. */
  bucket: 'qashy/sync/v1/bucket',
  /** HKDF info → the relay write-capability token. */
  bucketAuth: 'qashy/sync/v1/bucket-auth',
  /** HKDF info → the rotating signaling rendezvous id. Salted with the 5-minute window. */
  rendezvous: 'qashy/sync/v1/rendezvous',
  /** HKDF info → the one-shot rendezvous a pairing pair meets at, derived from the pairing secret. */
  pairingRendezvous: 'qashy/sync/v1/pairing-rendezvous',
  /** HKDF info → the per-vault tag a relay blob is addressed to. Salted with the device id. */
  route: 'qashy/sync/v1/route',
  /** HKDF info → the passphrase-independent half of the backup key. */
  backup: 'qashy/sync/v1/backup',
  /** HKDF info → the two directional session keys. */
  session: 'qashy/sync/v1/session',
  /** Prefix over the transcript that each side signs to prove identity. */
  auth: 'qashy/sync/v1/auth',
  /** Prefix over the transcript that both sides render as words for the human to compare. */
  sas: 'qashy/sync/v1/sas',
  /** Prefix over an Ed25519 public key that yields its stable device id. */
  device: 'qashy/sync/v1/device',
  /** Prefix over the hello messages that yields the transcript. */
  transcript: 'qashy/sync/v1/transcript',
  /** Prefix over an op's chain input that yields its hash — and the bytes each device signs. */
  op: 'qashy/sync/v1/op',
} as const;

export type LabelName = keyof typeof LABELS;

/** The rendezvous id rotates on this cadence, so sessions cannot be linked across time. */
export const RENDEZVOUS_WINDOW_SECONDS = 300;

/** A pairing QR is single-use and expires this long after it is rendered. */
export const PAIRING_TTL_SECONDS = 90;
