/**
 * The only file in Qashy that touches a cryptographic library directly.
 *
 * Everything here is a thin, typed, fail-closed wrapper over an audited implementation.
 * There is no hand-written cryptography in this file — the point of it is that the
 * *shape* of every call is fixed in one reviewable place, so a later change cannot
 * quietly swap an algorithm, drop an authentication tag, or reuse a nonce.
 *
 * Deliberate choices, with reasons, because they are load-bearing:
 *
 * - **XChaCha20-Poly1305, not AES-GCM.** The 24-byte nonce makes random nonces safe by
 *   construction. AES-GCM's 12-byte nonce is not safe to generate randomly when several
 *   devices produce nonces independently and cannot coordinate a counter, and GCM nonce
 *   reuse is both catastrophic and silent.
 * - **Synchronous SHA-256 from `@noble/hashes`, not `crypto.subtle.digest`.** The op
 *   chain hash has to be computed inside a database transaction, and awaiting a foreign
 *   promise there commits the transaction underneath you (see `StorageAdapter.transact`).
 * - **`expo-crypto.getRandomBytes` as the single entropy source.** It is native-backed on
 *   iOS and Android and `crypto.getRandomValues` on web, so there is one path to audit
 *   rather than three that can diverge — and it does not depend on `globalThis.crypto`
 *   existing on Hermes.
 */

import { getRandomBytes } from 'expo-crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { scrypt as nobleScrypt } from '@noble/hashes/scrypt.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { base32nopad, base64urlnopad, hex } from '@scure/base';

import { SyncCryptoError } from '@/sync/crypto/types';

export const KEY_LENGTH = 32;
export const NONCE_LENGTH = 24;
export const TAG_LENGTH = 16;
export const SIGNATURE_LENGTH = 64;
export const HASH_LENGTH = 32;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export const utf8Bytes = (value: string) => textEncoder.encode(value);

export const bytesToUtf8 = (bytes: Uint8Array) => {
  try {
    return textDecoder.decode(bytes);
  } catch {
    throw new SyncCryptoError('Decrypted payload is not valid UTF-8.', 'badFormat');
  }
};

export const concatBytes = (...parts: readonly Uint8Array[]) => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Random bytes from the platform CSPRNG. The single entropy source for the whole protocol. */
export const randomBytes = (length: number) => {
  const bytes = getRandomBytes(length);
  // `getRandomBytes` is typed as returning a Uint8Array on every platform, but the web
  // implementation has historically returned a subclass-free view over a larger buffer.
  // Copying makes `.buffer` safe to hand to anything downstream.
  return bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes as ArrayLike<number>);
};

/**
 * Constant-time comparison. Used wherever a mismatch would otherwise be observable
 * through timing — tags, tokens, transcripts.
 */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
};

/**
 * Best-effort overwrite of key material.
 *
 * JavaScript cannot guarantee this: the engine may have copied the buffer during a GC
 * compaction, and there is no way to reach those copies. It still meaningfully shortens
 * the window in which a heap snapshot contains the key, which is worth having.
 */
export const zeroize = (...buffers: readonly (Uint8Array | undefined)[]) => {
  for (const buffer of buffers) buffer?.fill(0);
};

export const assertLength = (bytes: Uint8Array, length: number, what: string) => {
  if (bytes.length !== length) {
    throw new SyncCryptoError(`${what} must be ${length} bytes, got ${bytes.length}.`, 'badLength');
  }
  return bytes;
};

// ---------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------

/** Unpadded RFC 4648 base32. Chosen for QR density and for being unambiguous when read aloud. */
export const toBase32 = (bytes: Uint8Array) => base32nopad.encode(bytes);

export const fromBase32 = (value: string) => {
  try {
    return base32nopad.decode(value.trim().toUpperCase());
  } catch {
    throw new SyncCryptoError('Not a valid pairing code.', 'badFormat');
  }
};

export const toBase64Url = (bytes: Uint8Array) => base64urlnopad.encode(bytes);

export const fromBase64Url = (value: string) => {
  try {
    return base64urlnopad.decode(value);
  } catch {
    throw new SyncCryptoError('Not valid base64url.', 'badFormat');
  }
};

export const toHex = (bytes: Uint8Array) => hex.encode(bytes);

export const fromHex = (value: string) => {
  try {
    return hex.decode(value.toLowerCase());
  } catch {
    throw new SyncCryptoError('Not valid hex.', 'badFormat');
  }
};

// ---------------------------------------------------------------------------
// Canonical binary encoding
// ---------------------------------------------------------------------------
//
// Used for transcripts and AAD, where the encoding must be injective: two different
// tuples must never produce the same bytes, or an attacker can move a value across a
// field boundary. Length prefixes give that for free, and unlike JSON there is no
// serializer variance across engines to worry about.

export const u8 = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new SyncCryptoError(`${value} is not a byte.`, 'badFormat');
  }
  return new Uint8Array([value]);
};

export const u32be = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new SyncCryptoError(`${value} is not a uint32.`, 'badFormat');
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
};

/** Big-endian uint64 from a safe integer. Sequence numbers outlive uint32 in principle, never in practice. */
export const u64be = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SyncCryptoError(`${value} is not a safe non-negative integer.`, 'badFormat');
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
};

/** Length-prefixed bytes. The prefix is what makes concatenation unambiguous. */
export const lengthPrefixed = (bytes: Uint8Array) => {
  if (bytes.length > 0xffffffff) {
    throw new SyncCryptoError('Field is too long to encode.', 'badLength');
  }
  return concatBytes(u32be(bytes.length), bytes);
};

export const lengthPrefixedText = (value: string) => lengthPrefixed(utf8Bytes(value));

// ---------------------------------------------------------------------------
// Hashing and derivation
// ---------------------------------------------------------------------------

/** Synchronous by design — the op chain hash runs inside a database transaction. */
export const sha256 = (...parts: readonly Uint8Array[]) => nobleSha256(concatBytes(...parts));

/**
 * `info` is a string at every call site in this codebase, and it must come from the table
 * in `labels.ts`. The `Uint8Array` overload exists so the RFC 5869 known-answer vectors —
 * whose `info` is not valid UTF-8 — can exercise this exact function rather than a
 * parallel one that could drift from it.
 */
export const hkdf = (
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string | Uint8Array,
  length: number = KEY_LENGTH,
) => nobleHkdf(nobleSha256, ikm, salt, typeof info === 'string' ? utf8Bytes(info) : info, length);

/**
 * Memory-hard passphrase stretching for the encrypted backup file and the optional web
 * keystore gate.
 *
 * The parameters are carried in the file header rather than hard-coded at the call site,
 * so they can be raised later without making existing backups unreadable.
 *
 * The default is the mobile-safe OWASP-equivalent setting N=2^16, r=8, p=2: roughly 64 MiB
 * and twice the CPU work of p=1. A 1 GiB desktop setting would fail outright on many phones;
 * an unusable parameter provides no security at all.
 */
export const SCRYPT_DEFAULTS = { N: 65536, r: 8, p: 2 } as const;
export const SCRYPT_MAX_MEMORY_BYTES = 128 * 1024 * 1024;
export const SCRYPT_MAX_WORK = 2 ** 18;

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

export const assertScryptCost = (params: ScryptParams): void => {
  if (
    !Number.isSafeInteger(params.r) ||
    params.r < 1 ||
    !Number.isSafeInteger(params.p) ||
    params.p < 1
  ) {
    throw new SyncCryptoError('scrypt r and p must be positive integers.', 'badFormat');
  }
  const memory = 128 * params.r * (params.N + params.p + 1);
  const work = params.N * params.p;
  if (
    !Number.isSafeInteger(memory) ||
    !Number.isSafeInteger(work) ||
    memory > SCRYPT_MAX_MEMORY_BYTES ||
    work > SCRYPT_MAX_WORK
  ) {
    throw new SyncCryptoError(
      'That backup asks for an unreasonable amount of work to open.',
      'badFormat',
    );
  }
};

export const scryptKey = (passphrase: string, salt: Uint8Array, params: ScryptParams) => {
  if (!Number.isInteger(Math.log2(params.N)) || params.N < 2 ** 12) {
    throw new SyncCryptoError('scrypt N must be a power of two of at least 4096.', 'badFormat');
  }
  assertScryptCost(params);
  return nobleScrypt(utf8Bytes(passphrase.normalize('NFKC')), salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: KEY_LENGTH,
    maxmem: SCRYPT_MAX_MEMORY_BYTES,
  });
};

// ---------------------------------------------------------------------------
// AEAD
// ---------------------------------------------------------------------------

/**
 * Encrypt-then-authenticate with associated data. The AAD is never encrypted but is
 * covered by the tag, which is what binds a frame to its sender, recipient, epoch, and
 * sequence — a frame lifted into a different context fails to open rather than
 * decrypting into something plausible.
 */
export const aeadSeal = (
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
) => {
  assertLength(key, KEY_LENGTH, 'AEAD key');
  assertLength(nonce, NONCE_LENGTH, 'AEAD nonce');
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
};

export const aeadOpen = (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
) => {
  assertLength(key, KEY_LENGTH, 'AEAD key');
  assertLength(nonce, NONCE_LENGTH, 'AEAD nonce');
  if (ciphertext.length < TAG_LENGTH) {
    throw new SyncCryptoError('Ciphertext is shorter than its authentication tag.', 'badLength');
  }
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
  } catch {
    // Deliberately opaque: distinguishing "wrong key" from "tampered" would be an oracle.
    throw new SyncCryptoError('Authentication failed — the data was tampered with or is not for this vault.', 'badTag');
  }
};

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

export const signingKeygen = () => {
  const pair = ed25519.keygen();
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
};

export const signingPublicKeyFrom = (secretKey: Uint8Array) => {
  assertLength(secretKey, KEY_LENGTH, 'Signing secret key');
  return ed25519.getPublicKey(secretKey);
};

export const sign = (message: Uint8Array, secretKey: Uint8Array) => {
  assertLength(secretKey, KEY_LENGTH, 'Signing secret key');
  return ed25519.sign(message, secretKey);
};

/** Returns a boolean rather than throwing; callers decide what a failure means, and every caller rejects. */
export const verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => {
  if (signature.length !== SIGNATURE_LENGTH || publicKey.length !== KEY_LENGTH) return false;
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    // A malformed point is a verification failure, not a crash.
    return false;
  }
};

// ---------------------------------------------------------------------------
// Key agreement
// ---------------------------------------------------------------------------

export const agreementKeygen = () => {
  const pair = x25519.keygen();
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
};

export const agreementPublicKeyFrom = (secretKey: Uint8Array) => {
  assertLength(secretKey, KEY_LENGTH, 'Agreement secret key');
  return x25519.getPublicKey(secretKey);
};

/**
 * X25519. Rejects the all-zero shared secret, which is what a small-order peer public
 * key produces — accepting it would mean agreeing on a key the attacker also knows.
 */
export const sharedSecret = (secretKey: Uint8Array, peerPublicKey: Uint8Array) => {
  assertLength(secretKey, KEY_LENGTH, 'Agreement secret key');
  assertLength(peerPublicKey, KEY_LENGTH, 'Peer public key');
  let secret: Uint8Array;
  try {
    secret = x25519.getSharedSecret(secretKey, peerPublicKey);
  } catch {
    throw new SyncCryptoError('Peer offered an unusable public key.', 'weakKey');
  }
  if (constantTimeEqual(secret, new Uint8Array(KEY_LENGTH))) {
    throw new SyncCryptoError('Peer offered a small-order public key.', 'weakKey');
  }
  return secret;
};
