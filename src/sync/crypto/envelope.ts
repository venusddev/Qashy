/**
 * The sealed frame — the only shape in which vault data is ever allowed to leave a device.
 *
 * Two properties matter here beyond "it is encrypted":
 *
 * 1. **Context binding.** Sender, recipient, epoch, sequence, purpose, and protocol
 *    version go into the AEAD's associated data. They are not secret, but they are
 *    authenticated, so a frame lifted out of its context — replayed to a different
 *    device, re-presented under a different epoch, relabelled as a different purpose —
 *    fails to open instead of decrypting into something plausible.
 *
 * 2. **Length hiding.** Plaintext is padded to a size bucket before sealing. Without it,
 *    the relay learns the exact size of every batch, and batch size is a direct readout
 *    of activity: "three transactions were added today" is a meaningful leak even when
 *    the contents stay sealed.
 */

import { PROTOCOL_VERSION } from '@/sync/crypto/labels';
import {
  NONCE_LENGTH,
  TAG_LENGTH,
  aeadOpen,
  aeadSeal,
  concatBytes,
  lengthPrefixedText,
  randomBytes,
  u32be,
  u64be,
  u8,
} from '@/sync/crypto/primitives';
import { SyncCryptoError, type SealingKey } from '@/sync/crypto/types';

/** Frame magic. Present so a truncated or foreign blob is rejected before any key is used. */
const MAGIC = new Uint8Array([0x51, 0x53, 0x59]); // 'QSY'
const HEADER_LENGTH = MAGIC.length + 1 + 1 + NONCE_LENGTH; // magic ‖ version ‖ purpose ‖ nonce

/**
 * Refuse anything larger than this before allocating for it. A relay that is hostile or
 * merely broken should not be able to make a phone allocate a gigabyte.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const ENVELOPE_PURPOSES = {
  /** A batch of signed ops. */
  batch: 1,
  /** Handshake payloads relayed through signaling before a session key exists. */
  handshake: 2,
  /** The signed device roster. */
  roster: 3,
  /** The passphrase-protected backup file. */
  backup: 4,
  /** A hand-carried `.qashysync` bundle. */
  file: 5,
  /** The vault root key, handed over exactly once during pairing. */
  vault: 6,
} as const;

export type EnvelopePurpose = keyof typeof ENVELOPE_PURPOSES;

const PURPOSE_BY_CODE = new Map<number, EnvelopePurpose>(
  Object.entries(ENVELOPE_PURPOSES).map(([name, code]) => [code, name as EnvelopePurpose]),
);

export interface EnvelopeContext {
  readonly purpose: EnvelopePurpose;
  /** Device id of the author. */
  readonly senderDeviceId: string;
  /** Device id of the intended reader, or `''` for anything addressed to the whole vault. */
  readonly recipientDeviceId: string;
  /** Vault epoch. Bumped by a key rotation or a reset, so pre-rotation frames stop opening. */
  readonly epoch: number;
  /** Monotonic per-sender counter. Makes each frame's AAD unique, which defeats replay. */
  readonly seq: number;
}

/**
 * Injective encoding of the context. Length prefixes are what make it injective: without
 * them, `sender="ab", recipient="c"` and `sender="a", recipient="bc"` would produce the
 * same bytes, and an attacker could move a character across the boundary.
 */
const associatedData = (context: EnvelopeContext) =>
  concatBytes(
    MAGIC,
    u8(PROTOCOL_VERSION),
    u8(ENVELOPE_PURPOSES[context.purpose]),
    lengthPrefixedText(context.senderDeviceId),
    lengthPrefixedText(context.recipientDeviceId),
    u32be(context.epoch),
    u64be(context.seq),
  );

// ---------------------------------------------------------------------------
// Padding
// ---------------------------------------------------------------------------

/** Below this, every frame looks the same size. Covers the overwhelming majority of batches. */
const MIN_BUCKET = 1024;
/** Above this, padding to the next power of two would waste megabytes; step linearly instead. */
const MAX_POWER_BUCKET = 262144;

export const paddedSize = (length: number) => {
  const withPrefix = length + 4;
  if (withPrefix <= MIN_BUCKET) return MIN_BUCKET;
  if (withPrefix <= MAX_POWER_BUCKET) return 2 ** Math.ceil(Math.log2(withPrefix));
  return Math.ceil(withPrefix / MAX_POWER_BUCKET) * MAX_POWER_BUCKET;
};

const pad = (plaintext: Uint8Array) => {
  const out = new Uint8Array(paddedSize(plaintext.length));
  out.set(u32be(plaintext.length), 0);
  out.set(plaintext, 4);
  return out;
};

const unpad = (padded: Uint8Array) => {
  if (padded.length < 4) throw new SyncCryptoError('Padded payload is truncated.', 'badLength');
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (length > padded.length - 4) {
    throw new SyncCryptoError('Padded payload declares an impossible length.', 'badFormat');
  }
  return padded.slice(4, 4 + length);
};

// ---------------------------------------------------------------------------
// Seal / open
// ---------------------------------------------------------------------------

/**
 * Seals a payload under a content or session key.
 *
 * The nonce is 24 random bytes. That is safe without coordination precisely because this
 * is XChaCha20 and not AES-GCM — see the note in `primitives.ts`.
 */
export const seal = (key: SealingKey, context: EnvelopeContext, plaintext: Uint8Array) => {
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = aeadSeal(key, nonce, pad(plaintext), associatedData(context));
  return concatBytes(
    MAGIC,
    u8(PROTOCOL_VERSION),
    u8(ENVELOPE_PURPOSES[context.purpose]),
    nonce,
    ciphertext,
  );
};

/**
 * Opens a frame, or throws. There is no partial success and no "best effort" path: a
 * frame that does not authenticate is discarded whole.
 *
 * The caller supplies the context it *expects*. Every field of it is checked by the AEAD
 * tag, so a frame whose real context differs in any way — different sender, replayed
 * sequence, stale epoch — fails here rather than being applied.
 */
export const open = (key: SealingKey, context: EnvelopeContext, frame: Uint8Array) => {
  if (frame.length > MAX_FRAME_BYTES) {
    throw new SyncCryptoError('Frame exceeds the maximum accepted size.', 'badLength');
  }
  if (frame.length < HEADER_LENGTH + TAG_LENGTH) {
    throw new SyncCryptoError('Frame is truncated.', 'badLength');
  }
  if (frame[0] !== MAGIC[0] || frame[1] !== MAGIC[1] || frame[2] !== MAGIC[2]) {
    throw new SyncCryptoError('Not a Qashy sync frame.', 'badFormat');
  }
  const version = frame[3];
  if (version !== PROTOCOL_VERSION) {
    throw new SyncCryptoError(
      `This frame uses sync protocol v${version}; this device speaks v${PROTOCOL_VERSION}. Update the other device.`,
      'badVersion',
    );
  }
  const purpose = PURPOSE_BY_CODE.get(frame[4]);
  if (!purpose) throw new SyncCryptoError('Frame declares an unknown purpose.', 'badFormat');
  if (purpose !== context.purpose) {
    throw new SyncCryptoError('Frame is not the kind of frame that was expected here.', 'badFormat');
  }
  const nonce = frame.slice(MAGIC.length + 2, HEADER_LENGTH);
  const ciphertext = frame.slice(HEADER_LENGTH);
  return unpad(aeadOpen(key, nonce, ciphertext, associatedData(context)));
};

/**
 * Reads the purpose out of a frame without opening it.
 *
 * Needed because a relay bucket carries frames of several purposes and the reader has to
 * pick the right expected context before it can call `open`. It parses only the header,
 * touches no key, and any lie in it is caught by the tag a moment later.
 */
export const peekPurpose = (frame: Uint8Array): EnvelopePurpose | null => {
  if (frame.length < HEADER_LENGTH) return null;
  if (frame[0] !== MAGIC[0] || frame[1] !== MAGIC[1] || frame[2] !== MAGIC[2]) return null;
  if (frame[3] !== PROTOCOL_VERSION) return null;
  return PURPOSE_BY_CODE.get(frame[4]) ?? null;
};
