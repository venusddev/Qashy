import {
  MAX_FRAME_BYTES,
  open,
  paddedSize,
  peekPurpose,
  seal,
  type EnvelopeContext,
} from '@/sync/crypto/envelope';
import { createVaultRootKey, deriveContentKey } from '@/sync/crypto/keys';
import { randomBytes, utf8Bytes } from '@/sync/crypto/primitives';
import { SyncCryptoError } from '@/sync/crypto/types';

const key = deriveContentKey(createVaultRootKey());
const otherKey = deriveContentKey(createVaultRootKey());

const context = (overrides: Partial<EnvelopeContext> = {}): EnvelopeContext => ({
  purpose: 'batch',
  senderDeviceId: 'AAAAAAABBBBBBBCCCCCCCDDDDD',
  recipientDeviceId: 'EEEEEEEFFFFFFFGGGGGGGHHHHH',
  epoch: 3,
  seq: 42,
  ...overrides,
});

const payload = utf8Bytes(JSON.stringify({ ops: [{ entityId: 'x', amountMinor: 12345 }] }));

describe('sealed envelope', () => {
  it('round-trips a payload', () => {
    expect(open(key, context(), seal(key, context(), payload))).toEqual(payload);
  });

  it('round-trips an empty payload', () => {
    expect(open(key, context(), seal(key, context(), new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it('produces a different frame every time, so identical batches are not recognisable', () => {
    const a = seal(key, context(), payload);
    const b = seal(key, context(), payload);
    expect(a).not.toEqual(b);
  });

  it('does not open under a different vault key', () => {
    expect(() => open(otherKey, context(), seal(key, context(), payload))).toThrow(SyncCryptoError);
  });

  describe('context binding', () => {
    // Each of these is a frame lifted out of the situation it was authenticated for. The
    // AEAD tag covers all of them, so every one must fail rather than decrypt.
    const cases: [string, Partial<EnvelopeContext>][] = [
      ['a different sender', { senderDeviceId: 'ZZZZZZZBBBBBBBCCCCCCCDDDDD' }],
      ['a different recipient', { recipientDeviceId: 'ZZZZZZZFFFFFFFGGGGGGGHHHHH' }],
      ['a stale epoch', { epoch: 2 }],
      ['a replayed sequence number', { seq: 41 }],
    ];

    it.each(cases)('refuses to open a frame presented under %s', (_label, overrides) => {
      const frame = seal(key, context(), payload);
      expect(() => open(key, context(overrides), frame)).toThrow(/tampered|not for this vault/i);
    });

    it('refuses a frame relabelled as a different purpose', () => {
      const frame = seal(key, context({ purpose: 'batch' }), payload);
      expect(() => open(key, context({ purpose: 'roster' }), frame)).toThrow(/not the kind of frame/i);
    });

    it('does not confuse a sender/recipient boundary shift', () => {
      // Length prefixes are what prevent this: without them, ("ab","c") and ("a","bc")
      // would authenticate the same bytes.
      const frame = seal(key, context({ senderDeviceId: 'ab', recipientDeviceId: 'c' }), payload);
      expect(() =>
        open(key, context({ senderDeviceId: 'a', recipientDeviceId: 'bc' }), frame),
      ).toThrow(SyncCryptoError);
    });
  });

  describe('tampering', () => {
    it('rejects a flipped bit anywhere in the frame', () => {
      const frame = seal(key, context(), payload);
      for (const index of [3, 4, 10, 40, frame.length - 1]) {
        const tampered = frame.slice();
        tampered[index] ^= 0x01;
        expect(() => open(key, context(), tampered)).toThrow(SyncCryptoError);
      }
    });

    it('rejects a truncated frame', () => {
      const frame = seal(key, context(), payload);
      expect(() => open(key, context(), frame.slice(0, frame.length - 1))).toThrow(SyncCryptoError);
      expect(() => open(key, context(), frame.slice(0, 10))).toThrow(/truncated/i);
    });

    it('rejects a frame with appended bytes', () => {
      const frame = seal(key, context(), payload);
      const extended = new Uint8Array(frame.length + 1);
      extended.set(frame);
      expect(() => open(key, context(), extended)).toThrow(SyncCryptoError);
    });

    it('rejects a blob that is not a Qashy frame at all', () => {
      expect(() => open(key, context(), randomBytes(200))).toThrow(SyncCryptoError);
    });

    it('rejects an oversized frame before allocating for it', () => {
      const huge = new Uint8Array(MAX_FRAME_BYTES + 1);
      expect(() => open(key, context(), huge)).toThrow(/maximum accepted size/i);
    });

    it('rejects a frame claiming a future protocol version', () => {
      const frame = seal(key, context(), payload);
      frame[3] = 99;
      expect(() => open(key, context(), frame)).toThrow(/Update the other device/);
    });
  });

  describe('length hiding', () => {
    it('pads everything small to one indistinguishable size', () => {
      const short = seal(key, context(), utf8Bytes('a'));
      const longer = seal(key, context(), utf8Bytes('a'.repeat(500)));
      expect(short.length).toBe(longer.length);
    });

    it('steps in powers of two, then linearly once that would waste megabytes', () => {
      expect(paddedSize(0)).toBe(1024);
      expect(paddedSize(1019)).toBe(1024);
      expect(paddedSize(1021)).toBe(2048);
      expect(paddedSize(262140)).toBe(262144);
      expect(paddedSize(262145)).toBe(524288);
      expect(paddedSize(600000)).toBe(786432);
    });

    it('never reveals the payload length through the frame length', () => {
      // Two batches that differ by a single transaction must be the same size on the wire.
      const one = seal(key, context(), utf8Bytes(JSON.stringify([{ a: 1 }])));
      const two = seal(key, context(), utf8Bytes(JSON.stringify([{ a: 1 }, { a: 2 }])));
      expect(one.length).toBe(two.length);
    });
  });

  describe('peekPurpose', () => {
    it('reads the purpose without a key', () => {
      expect(peekPurpose(seal(key, context({ purpose: 'roster' }), payload))).toBe('roster');
    });

    it('returns null for anything that is not a current-version frame', () => {
      expect(peekPurpose(new Uint8Array(5))).toBeNull();
      expect(peekPurpose(randomBytes(100))).toBeNull();
      const frame = seal(key, context(), payload);
      frame[3] = 99;
      expect(peekPurpose(frame)).toBeNull();
    });
  });
});
