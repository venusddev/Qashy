/**
 * The session handshake — a PSK-authenticated ephemeral ECDH with a signed transcript.
 *
 * This is the only hand-written cryptographic *construction* in Qashy (the primitives it
 * is built from are all audited), so it carries the heaviest test burden: known-answer
 * vectors, a simulated MITM, a wrong PSK, a replay, and a downgrade attempt.
 *
 * The shape is Noise_KKpsk0 semantics, written out explicitly rather than pulled from a
 * framework, so that every step is visible to a reviewer:
 *
 *   1. Each side sends `{ version, deviceId, signingPublicKey, ephemeralPublicKey, nonce }`.
 *   2. `ss = X25519(ownEphemeralSecret, peerEphemeralPublic)`
 *   3. `transcript = SHA-256(label ‖ version ‖ helloLow ‖ helloHigh)`, ordered by device id
 *      so both sides compute the same value without needing to agree on who spoke first.
 *   4. `HKDF(ikm = ss ‖ psk, salt = transcript, info = session) → two directional keys`
 *   5. Each side signs the transcript with its identity key; the other verifies it.
 *   6. The SAS is derived from the same transcript.
 *
 * Each ingredient does one job. The ephemeral ECDH gives forward secrecy. Mixing the PSK
 * into the HKDF gives confidentiality against anyone who did not scan the QR. The signed
 * transcript is what defeats a man in the middle: an attacker who relays the handshake
 * sits in two different sessions with two different transcripts and cannot produce a
 * signature that verifies in both. Binding `version` into the transcript defeats
 * downgrade, because rewriting it invalidates both signatures.
 *
 * The directional keys matter more than they look. A single shared key with both sides
 * choosing nonces independently is a nonce-collision waiting to happen; two keys make a
 * collision structurally impossible rather than merely unlikely.
 */

import { LABELS, PROTOCOL_VERSION } from '@/sync/crypto/labels';
import { deriveDeviceId, type DeviceIdentity } from '@/sync/crypto/keys';
import {
  KEY_LENGTH,
  SIGNATURE_LENGTH,
  agreementKeygen,
  concatBytes,
  hkdf,
  lengthPrefixed,
  lengthPrefixedText,
  randomBytes,
  sha256,
  sharedSecret,
  sign,
  u8,
  utf8Bytes,
  verify,
  zeroize,
} from '@/sync/crypto/primitives';
import { deriveSas } from '@/sync/crypto/sas';
import {
  SyncCryptoError,
  brand,
  type AgreementSecretKey,
  type PairingSecret,
  type SessionKey,
  type TranscriptHash,
  type VaultRootKey,
} from '@/sync/crypto/types';

const HELLO_NONCE_LENGTH = 32;

export interface HandshakeHello {
  readonly version: number;
  readonly deviceId: string;
  readonly signingPublicKey: Uint8Array;
  readonly ephemeralPublicKey: Uint8Array;
  readonly nonce: Uint8Array;
}

export interface PendingHandshake {
  readonly hello: HandshakeHello;
  readonly ephemeralSecret: AgreementSecretKey;
  readonly identity: DeviceIdentity;
}

export interface HandshakeSession {
  readonly peerDeviceId: string;
  readonly peerSigningPublicKey: Uint8Array;
  readonly transcript: TranscriptHash;
  /** Key for frames this device sends. Never equal to `receiveKey`. */
  readonly sendKey: SessionKey;
  /** Key for frames this device receives. */
  readonly receiveKey: SessionKey;
  /** The six words to show the user. Identical on both sides of an honest handshake. */
  readonly sas: string[];
  /** This device's proof of identity, to be sent to the peer. */
  readonly auth: Uint8Array;
}

// ---------------------------------------------------------------------------
// Wire encoding
// ---------------------------------------------------------------------------

export const encodeHello = (hello: HandshakeHello) =>
  concatBytes(
    u8(hello.version),
    lengthPrefixedText(hello.deviceId),
    lengthPrefixed(hello.signingPublicKey),
    lengthPrefixed(hello.ephemeralPublicKey),
    lengthPrefixed(hello.nonce),
  );

const readField = (bytes: Uint8Array, offset: number) => {
  if (offset + 4 > bytes.length) throw new SyncCryptoError('Hello is truncated.', 'badFormat');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(offset, false);
  const start = offset + 4;
  if (start + length > bytes.length) throw new SyncCryptoError('Hello is truncated.', 'badFormat');
  return { value: bytes.slice(start, start + length), next: start + length };
};

export const decodeHello = (bytes: Uint8Array): HandshakeHello => {
  if (bytes.length < 1) throw new SyncCryptoError('Hello is empty.', 'badFormat');
  const version = bytes[0];
  const deviceIdField = readField(bytes, 1);
  const signingField = readField(bytes, deviceIdField.next);
  const ephemeralField = readField(bytes, signingField.next);
  const nonceField = readField(bytes, ephemeralField.next);
  if (nonceField.next !== bytes.length) {
    throw new SyncCryptoError('Hello has trailing bytes.', 'badFormat');
  }
  return {
    version,
    deviceId: new TextDecoder().decode(deviceIdField.value),
    signingPublicKey: signingField.value,
    ephemeralPublicKey: ephemeralField.value,
    nonce: nonceField.value,
  };
};

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * Orders the two hellos by device id before hashing.
 *
 * Both sides must derive the same transcript, and neither knows reliably whether it
 * "went first" — over a relay, messages cross. Sorting by device id is a total order both
 * sides can compute from data they already hold.
 */
const computeTranscript = (a: HandshakeHello, b: HandshakeHello) => {
  const [low, high] = a.deviceId < b.deviceId ? [a, b] : [b, a];
  return brand<TranscriptHash>(
    sha256(
      utf8Bytes(LABELS.transcript),
      u8(PROTOCOL_VERSION),
      lengthPrefixed(encodeHello(low)),
      lengthPrefixed(encodeHello(high)),
    ),
  );
};

const authMessage = (transcript: TranscriptHash) => concatBytes(utf8Bytes(LABELS.auth), transcript);

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/** Step 1. Produces this device's hello and the ephemeral secret that must survive until step 2. */
export const startHandshake = (identity: DeviceIdentity): PendingHandshake => {
  const ephemeral = agreementKeygen();
  return {
    identity,
    ephemeralSecret: brand<AgreementSecretKey>(ephemeral.secretKey),
    hello: {
      version: PROTOCOL_VERSION,
      deviceId: identity.deviceId,
      signingPublicKey: identity.signing.publicKey,
      ephemeralPublicKey: ephemeral.publicKey,
      nonce: randomBytes(HELLO_NONCE_LENGTH),
    },
  };
};

export interface CompleteHandshakeInput {
  readonly pending: PendingHandshake;
  readonly peerHello: HandshakeHello;
  /**
   * The pairing secret during pairing, the vault root key on every reconnect. Both are 32
   * bytes and both are secrets only vault members hold; the difference is lifetime.
   */
  readonly psk: PairingSecret | VaultRootKey;
  /**
   * On a reconnect the caller knows which device it expects. Supplying it turns a peer
   * substitution into a failure here rather than a roster miss three steps later.
   */
  readonly expectedPeerDeviceId?: string;
}

/**
 * Step 2. Derives the session.
 *
 * Every check in here rejects rather than degrades. There is no path that continues with
 * a weaker guarantee than the caller asked for.
 */
export const completeHandshake = ({
  pending,
  peerHello,
  psk,
  expectedPeerDeviceId,
}: CompleteHandshakeInput): HandshakeSession => {
  if (peerHello.version !== PROTOCOL_VERSION) {
    throw new SyncCryptoError(
      `The other device speaks sync protocol v${peerHello.version}; this one speaks v${PROTOCOL_VERSION}. Update whichever is older.`,
      'badVersion',
    );
  }
  if (peerHello.signingPublicKey.length !== KEY_LENGTH || peerHello.ephemeralPublicKey.length !== KEY_LENGTH) {
    throw new SyncCryptoError('The other device sent a malformed key.', 'badLength');
  }
  if (peerHello.nonce.length !== HELLO_NONCE_LENGTH) {
    throw new SyncCryptoError('The other device sent a malformed nonce.', 'badLength');
  }
  // The device id is a hash of the signing key, so this catches a peer claiming an
  // identity it does not hold the private key for — before the roster is consulted.
  if (deriveDeviceId(peerHello.signingPublicKey) !== peerHello.deviceId) {
    throw new SyncCryptoError('The other device presented an identity that does not match its key.', 'badIdentity');
  }
  if (peerHello.deviceId === pending.identity.deviceId) {
    throw new SyncCryptoError('That device has the same identity as this one.', 'badIdentity');
  }
  if (expectedPeerDeviceId && expectedPeerDeviceId !== peerHello.deviceId) {
    throw new SyncCryptoError('A different device answered than the one expected.', 'badIdentity');
  }

  const transcript = computeTranscript(pending.hello, peerHello);
  const secret = sharedSecret(pending.ephemeralSecret, peerHello.ephemeralPublicKey);
  const material = hkdf(concatBytes(secret, psk), transcript, LABELS.session, KEY_LENGTH * 2);
  zeroize(secret);

  // The device with the lexicographically lower id owns the first half as its send key.
  // Both sides compute the same split from data both already have.
  const selfIsLow = pending.identity.deviceId < peerHello.deviceId;
  const lowToHigh = brand<SessionKey>(material.slice(0, KEY_LENGTH));
  const highToLow = brand<SessionKey>(material.slice(KEY_LENGTH));
  zeroize(material);

  return {
    peerDeviceId: peerHello.deviceId,
    peerSigningPublicKey: peerHello.signingPublicKey,
    transcript,
    sendKey: selfIsLow ? lowToHigh : highToLow,
    receiveKey: selfIsLow ? highToLow : lowToHigh,
    sas: deriveSas(transcript),
    auth: sign(authMessage(transcript), pending.identity.signing.secretKey),
  };
};

/**
 * Step 3. Verifies the peer's proof that it holds the private key behind the identity it claimed.
 *
 * Throws on failure. It never returns `false`, because there is no caller for whom a
 * failed handshake is a recoverable condition — the only correct response is to abandon
 * the session.
 */
export const acceptPeerAuth = (session: HandshakeSession, peerAuth: Uint8Array) => {
  if (peerAuth.length !== SIGNATURE_LENGTH) {
    throw new SyncCryptoError('The other device sent a malformed proof of identity.', 'badLength');
  }
  if (!verify(peerAuth, authMessage(session.transcript), session.peerSigningPublicKey)) {
    throw new SyncCryptoError(
      'The other device could not prove its identity. Something is intercepting this connection.',
      'badSignature',
    );
  }
};
