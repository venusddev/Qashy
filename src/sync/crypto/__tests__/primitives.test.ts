/**
 * Known-answer tests against the published standards.
 *
 * These are not testing that `@noble` is correct — it is audited and has its own far more
 * exhaustive suites. They are testing that *Qashy calls it correctly*, and that the
 * package on disk is the one we think it is. A dependency swapped by a compromised
 * registry, a lockfile drift, a wrong argument order, or a build that silently substitutes
 * a different curve all fail here, loudly, before a single byte leaves a device.
 *
 * Vectors are transcribed from the sources named on each block. Do not "fix" a failing
 * vector by updating the expectation.
 */

import {
  aeadOpen,
  aeadSeal,
  agreementPublicKeyFrom,
  concatBytes,
  constantTimeEqual,
  fromHex,
  hkdf,
  lengthPrefixed,
  scryptKey,
  sha256,
  sharedSecret,
  sign,
  signingPublicKeyFrom,
  toHex,
  u32be,
  u64be,
  utf8Bytes,
  verify,
  zeroize,
} from '@/sync/crypto/primitives';
import { SyncCryptoError } from '@/sync/crypto/types';

describe('AEAD — draft-irtf-cfrg-xchacha-03 §A.3.1', () => {
  const key = fromHex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
  const nonce = fromHex('404142434445464748494a4b4c4d4e4f5051525354555657');
  const aad = fromHex('50515253c0c1c2c3c4c5c6c7');
  const plaintext = utf8Bytes(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  );
  const expected =
    'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
    '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
    '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
    '21f9664c97637da9768812f615c68b13b52e' +
    'c0875924c1c7987947deafd8780acf49';

  it('produces the published ciphertext and tag', () => {
    expect(toHex(aeadSeal(key, nonce, plaintext, aad))).toBe(expected);
  });

  it('round-trips', () => {
    expect(aeadOpen(key, nonce, fromHex(expected), aad)).toEqual(plaintext);
  });

  it('rejects a flipped bit anywhere in the ciphertext', () => {
    const sealed = fromHex(expected);
    for (const index of [0, 17, sealed.length - 20, sealed.length - 1]) {
      const tampered = sealed.slice();
      tampered[index] ^= 0x01;
      expect(() => aeadOpen(key, nonce, tampered, aad)).toThrow(SyncCryptoError);
    }
  });

  it('rejects modified associated data', () => {
    const wrongAad = aad.slice();
    wrongAad[0] ^= 0x01;
    expect(() => aeadOpen(key, nonce, fromHex(expected), wrongAad)).toThrow(/tampered/i);
  });

  it('rejects the wrong key without revealing which part was wrong', () => {
    const wrongKey = key.slice();
    wrongKey[31] ^= 0x01;
    // Same message as a tamper: distinguishing the two would be an oracle.
    expect(() => aeadOpen(wrongKey, nonce, fromHex(expected), aad)).toThrow(/tampered/i);
  });

  it('rejects a nonce or key of the wrong length rather than silently padding', () => {
    expect(() => aeadSeal(key.slice(0, 31), nonce, plaintext, aad)).toThrow(/32 bytes/);
    expect(() => aeadSeal(key, nonce.slice(0, 12), plaintext, aad)).toThrow(/24 bytes/);
  });
});

describe('X25519 — RFC 7748 §6.1', () => {
  const alicePrivate = fromHex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const bobPrivate = fromHex('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');

  it('derives the published public keys', () => {
    expect(toHex(agreementPublicKeyFrom(alicePrivate))).toBe(
      '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    );
    expect(toHex(agreementPublicKeyFrom(bobPrivate))).toBe(
      'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
    );
  });

  it('derives the published shared secret from either side', () => {
    const expected = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
    expect(toHex(sharedSecret(alicePrivate, agreementPublicKeyFrom(bobPrivate)))).toBe(expected);
    expect(toHex(sharedSecret(bobPrivate, agreementPublicKeyFrom(alicePrivate)))).toBe(expected);
  });

  it('refuses a small-order public key instead of agreeing on a key the attacker knows', () => {
    // The all-zero point is the canonical small-order input; it drives every private key
    // to the same all-zero shared secret.
    expect(() => sharedSecret(alicePrivate, new Uint8Array(32))).toThrow(/small-order|unusable/i);
  });
});

describe('Ed25519 — RFC 8032 §7.1 TEST 1', () => {
  const secret = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const publicKey = fromHex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const signature =
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc' +
    '61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

  it('derives the published public key', () => {
    expect(toHex(signingPublicKeyFrom(secret))).toBe(toHex(publicKey));
  });

  it('produces the published signature over the empty message', () => {
    expect(toHex(sign(new Uint8Array(0), secret))).toBe(signature);
  });

  it('verifies it', () => {
    expect(verify(fromHex(signature), new Uint8Array(0), publicKey)).toBe(true);
  });

  it('rejects a signature over a different message', () => {
    expect(verify(fromHex(signature), utf8Bytes('x'), publicKey)).toBe(false);
  });

  it('returns false rather than throwing on malformed input', () => {
    expect(verify(new Uint8Array(63), new Uint8Array(0), publicKey)).toBe(false);
    expect(verify(fromHex(signature), new Uint8Array(0), new Uint8Array(31))).toBe(false);
    expect(verify(fromHex(signature), new Uint8Array(0), new Uint8Array(32))).toBe(false);
  });
});

describe('HKDF-SHA256 — RFC 5869 §A.1', () => {
  it('produces the published output', () => {
    const okm = hkdf(
      fromHex('0b'.repeat(22)),
      fromHex('000102030405060708090a0b0c'),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('separates domains: the same input under two labels yields unrelated keys', () => {
    const ikm = fromHex('00'.repeat(32));
    const salt = new Uint8Array(0);
    expect(toHex(hkdf(ikm, salt, 'qashy/sync/v1/content'))).not.toBe(
      toHex(hkdf(ikm, salt, 'qashy/sync/v1/bucket')),
    );
  });
});

describe('scrypt — RFC 7914 §11 vector 3', () => {
  // Vector 3 rather than 1 or 2: those use N=16 and N=1024, which `scryptKey` refuses
  // outright as too weak. A known-answer test that had to bypass the guard to run would
  // be testing a function nothing calls.
  it('produces the published output', () => {
    const key = scryptKey('pleaseletmein', utf8Bytes('SodiumChloride'), { N: 16384, r: 8, p: 1 });
    // The published vector is 64 bytes; `scryptKey` is fixed at 32 for key material, and
    // scrypt's output is a prefix of the longer derivation.
    expect(toHex(key)).toBe('7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2');
  });

  it('refuses parameters weak enough to be brute-forced', () => {
    expect(() => scryptKey('password', utf8Bytes('NaCl'), { N: 1024, r: 8, p: 1 })).toThrow(/4096/);
    expect(() => scryptKey('password', utf8Bytes('NaCl'), { N: 5000, r: 8, p: 1 })).toThrow(/power of two/);
  });

  it('normalizes the passphrase so a composed and decomposed é agree', () => {
    const salt = utf8Bytes('salt');
    const params = { N: 4096, r: 8, p: 1 };
    expect(toHex(scryptKey('café', salt, params))).toBe(toHex(scryptKey('café', salt, params)));
  });
});

describe('canonical binary encoding', () => {
  it('is injective across field boundaries', () => {
    // Without length prefixes these two tuples would encode identically, which would let
    // an attacker move a character from one authenticated field into the next.
    const a = concatBytes(lengthPrefixed(utf8Bytes('ab')), lengthPrefixed(utf8Bytes('c')));
    const b = concatBytes(lengthPrefixed(utf8Bytes('a')), lengthPrefixed(utf8Bytes('bc')));
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('encodes integers big-endian at a fixed width', () => {
    expect(toHex(u32be(1))).toBe('00000001');
    expect(toHex(u64be(1))).toBe('0000000000000001');
    expect(toHex(u64be(Number.MAX_SAFE_INTEGER))).toBe('001fffffffffffff');
  });

  it('rejects values it cannot represent exactly', () => {
    expect(() => u32be(-1)).toThrow(SyncCryptoError);
    expect(() => u32be(2 ** 32)).toThrow(SyncCryptoError);
    expect(() => u64be(1.5)).toThrow(SyncCryptoError);
    expect(() => u64be(Number.MAX_SAFE_INTEGER + 2)).toThrow(SyncCryptoError);
  });
});

describe('byte helpers', () => {
  it('compares equal-length buffers without early exit', () => {
    expect(constantTimeEqual(fromHex('0011'), fromHex('0011'))).toBe(true);
    expect(constantTimeEqual(fromHex('0011'), fromHex('0012'))).toBe(false);
    expect(constantTimeEqual(fromHex('0011'), fromHex('001122'))).toBe(false);
  });

  it('zeroizes in place and tolerates undefined', () => {
    const secret = fromHex('deadbeef');
    zeroize(secret, undefined);
    expect(toHex(secret)).toBe('00000000');
  });

  it('hashes the concatenation, not the arguments separately', () => {
    expect(toHex(sha256(utf8Bytes('ab')))).toBe(toHex(sha256(utf8Bytes('a'), utf8Bytes('b'))));
  });
});
