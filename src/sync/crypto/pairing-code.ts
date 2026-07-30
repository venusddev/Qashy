/**
 * The pairing code — what the QR encodes, and what the manual-paste fallback accepts.
 *
 * This string **is a secret**: it carries the pairing secret that authenticates the
 * handshake. It must never be logged, put in a URL, written to the clipboard for longer
 * than the paste, or persisted. It expires 90 seconds after it is created and is
 * single-use, so even a photographed code has a short window — and the SAS comparison in
 * `sas.ts` is what covers that window.
 *
 * The format is deliberately flat text rather than JSON: a QR encoding uppercase base32
 * and a handful of separators stays in alphanumeric mode, which is roughly 40% denser
 * than the byte mode JSON would force. On a phone screen at arm's length that is the
 * difference between a code that scans instantly and one that does not.
 */

import { PAIRING_TTL_SECONDS, PROTOCOL_VERSION } from '@/sync/crypto/labels';
import { deriveDeviceId } from '@/sync/crypto/keys';
import { KEY_LENGTH, fromBase32, fromBase64Url, toBase32, toBase64Url, utf8Bytes } from '@/sync/crypto/primitives';
import { SyncCryptoError, brand, type PairingSecret } from '@/sync/crypto/types';

const SCHEME = 'qashy-pair';
const SEPARATOR = ':';

export interface PairingCode {
  readonly version: number;
  /** The device that already holds the vault. */
  readonly deviceId: string;
  readonly signingPublicKey: Uint8Array;
  readonly ephemeralPublicKey: Uint8Array;
  readonly pairingSecret: PairingSecret;
  /** Unix seconds. Past this the code is refused without a network round trip. */
  readonly expiresAt: number;
  /** Where to meet. Empty when the devices will find each other on the local network. */
  readonly relayUrl: string;
}

export const encodePairingCode = (code: PairingCode) =>
  [
    SCHEME,
    String(code.version),
    code.deviceId,
    toBase32(code.signingPublicKey),
    toBase32(code.ephemeralPublicKey),
    toBase32(code.pairingSecret),
    String(code.expiresAt),
    code.relayUrl ? toBase64Url(utf8Bytes(code.relayUrl)) : '',
  ].join(SEPARATOR);

/**
 * Parses a scanned or pasted code.
 *
 * Every field is validated before anything is returned, including the consistency between
 * the claimed device id and the signing key it is supposed to be derived from. A code
 * that fails any check is rejected whole — there is no partially-usable pairing code.
 */
export const decodePairingCode = (value: string, nowSeconds: number): PairingCode => {
  const parts = value.trim().split(SEPARATOR);
  if (parts.length !== 8 || parts[0] !== SCHEME) {
    throw new SyncCryptoError('That is not a Qashy pairing code.', 'badFormat');
  }
  const version = Number(parts[1]);
  if (!Number.isInteger(version) || version < 1) {
    throw new SyncCryptoError('That is not a Qashy pairing code.', 'badFormat');
  }
  if (version !== PROTOCOL_VERSION) {
    throw new SyncCryptoError(
      `That code was made by a device using sync protocol v${version}; this one speaks v${PROTOCOL_VERSION}. Update whichever is older.`,
      'badVersion',
    );
  }

  const deviceId = parts[2];
  const signingPublicKey = fromBase32(parts[3]);
  const ephemeralPublicKey = fromBase32(parts[4]);
  const pairingSecret = fromBase32(parts[5]);
  const expiresAt = Number(parts[6]);

  if (signingPublicKey.length !== KEY_LENGTH || ephemeralPublicKey.length !== KEY_LENGTH) {
    throw new SyncCryptoError('That pairing code is damaged.', 'badLength');
  }
  if (pairingSecret.length !== KEY_LENGTH) {
    throw new SyncCryptoError('That pairing code is damaged.', 'badLength');
  }
  if (deriveDeviceId(signingPublicKey) !== deviceId) {
    throw new SyncCryptoError('That pairing code does not match the device that made it.', 'badIdentity');
  }
  if (!Number.isFinite(expiresAt)) {
    throw new SyncCryptoError('That pairing code is damaged.', 'badFormat');
  }
  if (expiresAt <= nowSeconds) {
    throw new SyncCryptoError('That pairing code has expired. Generate a new one on the other device.', 'badFormat');
  }
  // A code claiming to be valid for longer than the protocol allows is either from a
  // tampered build or an attacker widening their own window. Neither is acceptable.
  if (expiresAt > nowSeconds + PAIRING_TTL_SECONDS * 2) {
    throw new SyncCryptoError('That pairing code claims an implausible expiry.', 'badFormat');
  }

  return {
    version,
    deviceId,
    signingPublicKey,
    ephemeralPublicKey,
    pairingSecret: brand<PairingSecret>(pairingSecret),
    expiresAt,
    relayUrl: parts[7] ? new TextDecoder().decode(fromBase64Url(parts[7])) : '',
  };
};

/**
 * Renders the code for someone typing it into another device.
 *
 * Grouped into blocks of five, because an unbroken run of ~180 characters is transcribed
 * wrong essentially every time. The parser strips whitespace, so the grouping is purely
 * for the human.
 */
export const formatPairingCodeForTyping = (encoded: string) =>
  (encoded.match(/.{1,5}/g) ?? [encoded]).join(' ');

export const normalizeTypedPairingCode = (typed: string) => typed.replace(/\s+/g, '');
