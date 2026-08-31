import { PAIRING_TTL_SECONDS, PROTOCOL_VERSION } from '@/sync/crypto/labels';
import { createDeviceIdentity, createPairingSecret } from '@/sync/crypto/keys';
import {
  decodePairingCode,
  encodePairingCode,
  formatPairingCodeForTyping,
  normalizeTypedPairingCode,
  type PairingCode,
} from '@/sync/crypto/pairing-code';
import { toBase32, toHex } from '@/sync/crypto/primitives';
import { SyncCryptoError } from '@/sync/crypto/types';

const NOW = 1_800_000_000;

const identity = createDeviceIdentity();
const ephemeral = createDeviceIdentity();

const code = (overrides: Partial<PairingCode> = {}): PairingCode => ({
  version: PROTOCOL_VERSION,
  deviceId: identity.deviceId,
  signingPublicKey: identity.signing.publicKey,
  ephemeralPublicKey: ephemeral.agreement.publicKey,
  pairingSecret: createPairingSecret(),
  expiresAt: NOW + PAIRING_TTL_SECONDS,
  relayUrl: 'https://relay.example.com',
  ...overrides,
});

describe('a pairing code', () => {
  it('round-trips every field', () => {
    const original = code();
    const decoded = decodePairingCode(encodePairingCode(original), NOW);
    expect(decoded.version).toBe(original.version);
    expect(decoded.deviceId).toBe(original.deviceId);
    expect(toHex(decoded.signingPublicKey)).toBe(toHex(original.signingPublicKey));
    expect(toHex(decoded.ephemeralPublicKey)).toBe(toHex(original.ephemeralPublicKey));
    expect(toHex(decoded.pairingSecret)).toBe(toHex(original.pairingSecret));
    expect(decoded.expiresAt).toBe(original.expiresAt);
    expect(decoded.relayUrl).toBe(original.relayUrl);
  });

  it('carries an empty relay URL for a LAN-only pairing', () => {
    // Not a degenerate case — it is the private default. Two devices on the same Wi-Fi
    // contact no server at all, and the code must be able to say so.
    expect(decodePairingCode(encodePairingCode(code({ relayUrl: '' })), NOW).relayUrl).toBe('');
  });

  it('stays in QR alphanumeric mode apart from the separators and the relay URL', () => {
    const encoded = encodePairingCode(code({ relayUrl: '' }));
    expect(encoded.startsWith('qashy-pair:1:')).toBe(true);
    expect(encoded.split(':')).toHaveLength(8);
    expect(encoded.split(':').slice(2, 6).join('')).toMatch(/^[A-Z2-7]+$/);
  });

  it('survives being typed out by hand', () => {
    const encoded = encodePairingCode(code());
    const typed = formatPairingCodeForTyping(encoded);
    expect(typed).toContain(' ');
    expect(normalizeTypedPairingCode(typed)).toBe(encoded);
    expect(decodePairingCode(normalizeTypedPairingCode(typed), NOW).deviceId).toBe(identity.deviceId);
  });
});

describe('a pairing code that should be refused', () => {
  it('is expired', () => {
    const encoded = encodePairingCode(code({ expiresAt: NOW - 1 }));
    expect(() => decodePairingCode(encoded, NOW)).toThrow(/expired/);
  });

  it('expires exactly at its stated second, not a moment later', () => {
    const encoded = encodePairingCode(code({ expiresAt: NOW }));
    expect(() => decodePairingCode(encoded, NOW)).toThrow(/expired/);
  });

  it('claims a window wider than the protocol allows', () => {
    // A 90-second life is what makes a photographed code survivable. A code that grants
    // itself a day is either a tampered build or an attacker widening their own window.
    const encoded = encodePairingCode(code({ expiresAt: NOW + 86_400 }));
    expect(() => decodePairingCode(encoded, NOW)).toThrow(/implausible expiry/);
  });

  it('claims an identity it cannot back', () => {
    const encoded = encodePairingCode(code({ deviceId: createDeviceIdentity().deviceId }));
    expect(() => decodePairingCode(encoded, NOW)).toThrow(/does not match the device that made it/);
  });

  it('was made by a different protocol version', () => {
    const encoded = encodePairingCode(code()).replace('qashy-pair:1:', 'qashy-pair:2:');
    expect(() => decodePairingCode(encoded, NOW)).toThrow(/Update whichever is older/);
  });

  it('rejects oversized input before decoding any encoded key material', () => {
    expect(() => decodePairingCode(`qashy-pair:${'A'.repeat(4_096)}`, NOW)).toThrow(/too large/);
  });

  it('is not a pairing code at all', () => {
    for (const value of ['', 'hello', 'qashy-pair', 'https://example.com', 'qashy-pair:1:a:b:c']) {
      expect(() => decodePairingCode(value, NOW)).toThrow(SyncCryptoError);
    }
  });

  it('carries a key of the wrong size', () => {
    const parts = encodePairingCode(code()).split(':');
    parts[3] = toBase32(identity.signing.publicKey.slice(0, 31));
    expect(() => decodePairingCode(parts.join(':'), NOW)).toThrow(/damaged/);
  });

  it('carries a pairing secret of the wrong size', () => {
    const parts = encodePairingCode(code()).split(':');
    parts[5] = toBase32(new Uint8Array(16));
    expect(() => decodePairingCode(parts.join(':'), NOW)).toThrow(/damaged/);
  });

  it('carries an expiry that is not a number', () => {
    const parts = encodePairingCode(code()).split(':');
    parts[6] = 'soon';
    expect(() => decodePairingCode(parts.join(':'), NOW)).toThrow(/damaged/);
  });

  it('carries base32 that does not decode', () => {
    const parts = encodePairingCode(code()).split(':');
    parts[5] = '1180!!';
    expect(() => decodePairingCode(parts.join(':'), NOW)).toThrow(/valid pairing code/);
  });
});
