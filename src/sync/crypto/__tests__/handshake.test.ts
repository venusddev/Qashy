/**
 * The handshake is the only hand-written cryptographic construction in Qashy, so it carries
 * the heaviest test burden in this directory. The happy path is one test; everything else
 * here is an attack.
 */

import {
  acceptPeerAuth,
  completeHandshake,
  decodeHello,
  encodeHello,
  startHandshake,
  type HandshakeHello,
} from '@/sync/crypto/handshake';
import { createDeviceIdentity, createPairingSecret, createVaultRootKey } from '@/sync/crypto/keys';
import { SAS_WORD_COUNT, sasMatches } from '@/sync/crypto/sas';
import { randomBytes, toHex } from '@/sync/crypto/primitives';
import { SyncCryptoError, brand, type PairingSecret } from '@/sync/crypto/types';

/** Runs both halves of a handshake and returns each side's session. */
const shake = (
  psk: PairingSecret,
  options: { peerPsk?: PairingSecret } = {},
) => {
  const alice = createDeviceIdentity();
  const bob = createDeviceIdentity();
  const pendingA = startHandshake(alice);
  const pendingB = startHandshake(bob);
  return {
    alice,
    bob,
    a: completeHandshake({ pending: pendingA, peerHello: pendingB.hello, psk }),
    b: completeHandshake({ pending: pendingB, peerHello: pendingA.hello, psk: options.peerPsk ?? psk }),
  };
};

describe('an honest handshake', () => {
  const psk = createPairingSecret();
  const { alice, bob, a, b } = shake(psk);

  it('derives the same transcript on both sides regardless of who spoke first', () => {
    expect(toHex(a.transcript)).toBe(toHex(b.transcript));
  });

  it('shows both people the same six words', () => {
    expect(a.sas).toHaveLength(SAS_WORD_COUNT);
    expect(sasMatches(a.sas, b.sas)).toBe(true);
  });

  it('crosses the directional keys so each side reads what the other wrote', () => {
    expect(toHex(a.sendKey)).toBe(toHex(b.receiveKey));
    expect(toHex(a.receiveKey)).toBe(toHex(b.sendKey));
  });

  it('never lets the two directions share a key', () => {
    // A single shared key with both sides picking nonces independently is a collision
    // waiting to happen. Two keys make the collision structurally impossible.
    expect(toHex(a.sendKey)).not.toBe(toHex(a.receiveKey));
  });

  it('identifies the peer correctly', () => {
    expect(a.peerDeviceId).toBe(bob.deviceId);
    expect(b.peerDeviceId).toBe(alice.deviceId);
  });

  it('accepts each side’s proof of identity', () => {
    expect(() => acceptPeerAuth(a, b.auth)).not.toThrow();
    expect(() => acceptPeerAuth(b, a.auth)).not.toThrow();
  });

  it('produces unrelated keys on a second handshake between the same devices', () => {
    // Forward secrecy: the ephemeral keys are fresh, so compromising today's session key
    // does not open yesterday's traffic.
    const again = shake(psk);
    expect(toHex(again.a.sendKey)).not.toBe(toHex(a.sendKey));
  });
});

describe('a man in the middle', () => {
  it('produces different words on the two screens, which is what the human catches', () => {
    // The attacker photographed the QR, so it holds the pairing secret and can complete a
    // handshake with each side. What it cannot do is make one transcript out of two.
    const psk = createPairingSecret();
    const alice = createDeviceIdentity();
    const bob = createDeviceIdentity();
    const mallory = createDeviceIdentity();

    const pendingA = startHandshake(alice);
    const pendingB = startHandshake(bob);
    const pendingMtoA = startHandshake(mallory);
    const pendingMtoB = startHandshake(mallory);

    const aliceSession = completeHandshake({ pending: pendingA, peerHello: pendingMtoA.hello, psk });
    const bobSession = completeHandshake({ pending: pendingB, peerHello: pendingMtoB.hello, psk });

    expect(sasMatches(aliceSession.sas, bobSession.sas)).toBe(false);
  });

  it('cannot forward the real peer’s proof of identity into its own session', () => {
    const psk = createPairingSecret();
    const alice = createDeviceIdentity();
    const bob = createDeviceIdentity();
    const mallory = createDeviceIdentity();

    const pendingA = startHandshake(alice);
    const pendingB = startHandshake(bob);
    const pendingM = startHandshake(mallory);

    // Alice believes she is talking to Mallory-as-Bob; Bob really did sign, but a different
    // transcript, so the signature does not carry across.
    const aliceSession = completeHandshake({ pending: pendingA, peerHello: pendingM.hello, psk });
    const bobSession = completeHandshake({ pending: pendingB, peerHello: pendingA.hello, psk });

    expect(() => acceptPeerAuth(aliceSession, bobSession.auth)).toThrow(/prove its identity/);
  });
});

describe('a wrong pre-shared key', () => {
  it('yields incompatible session keys rather than a weaker session', () => {
    const { a, b } = shake(createPairingSecret(), { peerPsk: createPairingSecret() });
    expect(toHex(a.sendKey)).not.toBe(toHex(b.receiveKey));
  });

  it('still leaves the SAS matching, which is why the SAS alone is not the authentication', () => {
    // Documented deliberately: the transcript does not include the PSK, so a mismatched PSK
    // shows identical words and then fails to decrypt anything. The engine must treat the
    // first failed frame as a pairing failure, not as a transport glitch.
    const { a, b } = shake(createPairingSecret(), { peerPsk: createPairingSecret() });
    expect(sasMatches(a.sas, b.sas)).toBe(true);
  });
});

describe('a replayed handshake', () => {
  it('cannot reuse a recorded proof of identity in a fresh session', () => {
    const psk = createPairingSecret();
    const alice = createDeviceIdentity();
    const bob = createDeviceIdentity();

    const pendingA = startHandshake(alice);
    const firstB = startHandshake(bob);
    const recordedAuth = completeHandshake({ pending: pendingA, peerHello: firstB.hello, psk }).auth;

    // Bob reconnects; his ephemeral key and nonce are fresh, so the transcript moved.
    const secondB = startHandshake(bob);
    const bobSession = completeHandshake({ pending: secondB, peerHello: pendingA.hello, psk });

    expect(() => acceptPeerAuth(bobSession, recordedAuth)).toThrow(SyncCryptoError);
  });
});

describe('rejected peers', () => {
  const psk = createPairingSecret();
  const identity = createDeviceIdentity();
  const peer = createDeviceIdentity();

  const attempt = (mutate: (hello: HandshakeHello) => HandshakeHello, expectedPeerDeviceId?: string) => {
    const pending = startHandshake(identity);
    const peerHello = mutate(startHandshake(peer).hello);
    return () => completeHandshake({ pending, peerHello, psk, expectedPeerDeviceId });
  };

  it('refuses a peer speaking a different protocol version', () => {
    expect(attempt((hello) => ({ ...hello, version: 2 }))).toThrow(/Update whichever is older/);
  });

  it('refuses an identity that does not match the key behind it', () => {
    // This is the check that makes device ids self-authenticating: claiming someone else's
    // id requires their private key, so spoofing fails before the roster is consulted.
    expect(attempt((hello) => ({ ...hello, deviceId: 'AAAAAAAAAAAAAAAAAAAAAAAAAA' }))).toThrow(
      /does not match its key/,
    );
  });

  it('refuses a peer claiming to be this very device', () => {
    const pending = startHandshake(identity);
    expect(() =>
      completeHandshake({ pending, peerHello: startHandshake(identity).hello, psk }),
    ).toThrow(/same identity as this one/);
  });

  it('refuses a substituted peer when the caller named the one it expected', () => {
    expect(attempt((hello) => hello, 'CJ6MEFSHJRK2SNG44OYRYSEEX2')).toThrow(
      /different device answered/,
    );
  });

  it('accepts the named peer', () => {
    expect(attempt((hello) => hello, peer.deviceId)).not.toThrow();
  });

  it('refuses malformed keys and nonces instead of hashing them anyway', () => {
    expect(attempt((hello) => ({ ...hello, ephemeralPublicKey: randomBytes(31) }))).toThrow(
      /malformed key/,
    );
    expect(attempt((hello) => ({ ...hello, nonce: randomBytes(16) }))).toThrow(/malformed nonce/);
  });

  it('refuses a proof of identity of the wrong length', () => {
    const pending = startHandshake(identity);
    const session = completeHandshake({ pending, peerHello: startHandshake(peer).hello, psk });
    expect(() => acceptPeerAuth(session, randomBytes(63))).toThrow(/malformed proof/);
  });
});

describe('transcript binding', () => {
  const psk = createPairingSecret();

  const sasFor = (mutate: (hello: HandshakeHello) => HandshakeHello) => {
    const identity = createDeviceIdentity();
    const pending = startHandshake(identity);
    const peerPending = startHandshake(createDeviceIdentity());
    const clean = completeHandshake({ pending, peerHello: peerPending.hello, psk });
    const tampered = completeHandshake({ pending, peerHello: mutate(peerPending.hello), psk });
    return [clean.sas, tampered.sas] as const;
  };

  it('changes the words when any byte of the peer’s hello is altered', () => {
    // The nonce carries no other function — it exists so that the transcript, and therefore
    // the SAS, cannot be steered by an attacker who controls the other fields.
    const [clean, tampered] = sasFor((hello) => ({ ...hello, nonce: randomBytes(32) }));
    expect(sasMatches(clean, tampered)).toBe(false);
  });
});

describe('hello encoding', () => {
  it('round-trips', () => {
    const hello = startHandshake(createDeviceIdentity()).hello;
    const decoded = decodeHello(encodeHello(hello));
    expect(decoded.version).toBe(hello.version);
    expect(decoded.deviceId).toBe(hello.deviceId);
    expect(toHex(decoded.signingPublicKey)).toBe(toHex(hello.signingPublicKey));
    expect(toHex(decoded.ephemeralPublicKey)).toBe(toHex(hello.ephemeralPublicKey));
    expect(toHex(decoded.nonce)).toBe(toHex(hello.nonce));
  });

  it('rejects a truncated hello rather than reading past the end', () => {
    const encoded = encodeHello(startHandshake(createDeviceIdentity()).hello);
    expect(() => decodeHello(encoded.slice(0, encoded.length - 1))).toThrow(/truncated/);
    expect(() => decodeHello(new Uint8Array(0))).toThrow(/empty/);
  });

  it('rejects trailing bytes, so two encodings never mean the same hello', () => {
    const encoded = encodeHello(startHandshake(createDeviceIdentity()).hello);
    const extended = new Uint8Array(encoded.length + 1);
    extended.set(encoded);
    expect(() => decodeHello(extended)).toThrow(/trailing bytes/);
  });
});

describe('the vault key as the reconnect PSK', () => {
  it('works identically to a pairing secret, because both are 32-byte vault secrets', () => {
    const vault = createVaultRootKey();
    const alice = createDeviceIdentity();
    const bob = createDeviceIdentity();
    const pendingA = startHandshake(alice);
    const pendingB = startHandshake(bob);
    const a = completeHandshake({ pending: pendingA, peerHello: pendingB.hello, psk: vault });
    const b = completeHandshake({
      pending: pendingB,
      peerHello: pendingA.hello,
      psk: vault,
      expectedPeerDeviceId: alice.deviceId,
    });
    expect(toHex(a.sendKey)).toBe(toHex(b.receiveKey));
  });

  it('fails when one side still thinks it is pairing', () => {
    const vault = createVaultRootKey();
    const stalePsk = brand<PairingSecret>(new Uint8Array(32));
    const { a, b } = shake(brand<PairingSecret>(vault), { peerPsk: stalePsk });
    expect(toHex(a.sendKey)).not.toBe(toHex(b.receiveKey));
  });
});
