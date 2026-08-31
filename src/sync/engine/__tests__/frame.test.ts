/**
 * The bytes on the wire, and everything that must not survive the trip.
 *
 * Two layers meet here and both are gates. The envelope decides whether a frame is *for this
 * device, from that peer, in this session, under this protocol* — every one of which is bound
 * into the AEAD tag, so getting any of them wrong is indistinguishable from tampering, by
 * design. The codec then decides whether the plaintext is structurally a batch, and it runs
 * before a single signature is verified so that a malformed blob costs a JSON parse rather
 * than ten thousand Ed25519 operations.
 *
 * The tests are ordered the way an attacker would work: change the bytes, change who they
 * claim to be from, change how big they are, then change what is inside them.
 */

import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  SyncCryptoError,
  paddedSize,
  peekPurpose,
  utf8Bytes,
} from '@/sync/crypto';
import { MAX_BATCH_OPS, decodeBatch, encodeBatch } from '@/sync/engine/batch';
import { openBatch, sealBatch } from '@/sync/engine/frame';
import { SyncEngineError } from '@/sync/engine/types';
import { EPOCH, makeVault, type TestDevice } from '@/sync/engine/__tests__/helpers';

/** A sealed frame from Alice to Bob at a given channel position. */
const sealed = (alice: TestDevice, bob: TestDevice, seq = 0) =>
  sealBatch(alice.frame, alice.batch(alice.author([alice.body('accounts', 'a1')])), bob.deviceId, seq);

describe('frames — round trip', () => {
  it('carries a batch from one device to the other unchanged', async () => {
    const [alice, bob] = await makeVault();
    const batch = alice.batch(alice.author([alice.body('accounts', 'a1')]));

    const opened = openBatch(bob.frame, sealBatch(alice.frame, batch, bob.deviceId, 0), alice.deviceId, 0);

    expect(opened).toEqual(batch);
  });

  it('declares its purpose in the clear, so a relay bucket can be sorted without a key', async () => {
    const [alice, bob] = await makeVault();

    expect(peekPurpose(sealed(alice, bob))).toBe('batch');
  });

  it('quantizes its size, so the byte count says far less than the op count', async () => {
    const [alice, bob] = await makeVault();

    const sizes = new Set(
      Array.from({ length: 8 }, (_unused, index) =>
        sealBatch(
          alice.frame,
          alice.batch(
            alice.author(
              Array.from({ length: index + 1 }, (_ignored, op) => alice.body('accounts', `a${op}`)),
            ),
          ),
          bob.deviceId,
          index,
        ).length,
      ),
    );

    // Eight distinct batches collapse onto a power-of-two ladder. Padding does not hide *all*
    // of the length — nothing short of constant-size frames could — but it means a relay
    // watching an upload learns a bucket rather than "they added four transactions today".
    expect(sizes.size).toBeLessThan(8);
    // 29 bytes of header (magic, version, purpose, nonce) plus a 16-byte tag ride outside the
    // padded region, so every observable size is exactly a power of two plus that overhead.
    for (const size of sizes) expect(Number.isInteger(Math.log2(size - 45))).toBe(true);
    // Every bucket boundary is a power of two, and everything small is one size.
    expect(paddedSize(1)).toBe(paddedSize(1000));
    // The four-byte true-length prefix rides inside the padded region, so the last payload
    // that still fits the smallest bucket is 1020 bytes, not 1024.
    expect(paddedSize(1020)).toBe(1024);
    expect(paddedSize(1021)).toBe(2048);
  });
});

describe('frames — tampering', () => {
  it('refuses a frame with a single flipped bit, wherever it lands', async () => {
    const [alice, bob] = await makeVault();
    const frame = sealed(alice, bob);

    // Every byte, not a sampled few: the header, the nonce, and the ciphertext are three
    // different failure paths and a test that only flips one of them proves only one.
    for (let index = 0; index < frame.length; index += 1) {
      const mutated = Uint8Array.from(frame);
      mutated[index] ^= 0b0000_0001;
      expect(() => openBatch(bob.frame, mutated, alice.deviceId, 0)).toThrow(SyncCryptoError);
    }
  });

  it('refuses a frame that never was one', async () => {
    const [, bob] = await makeVault();

    expect(() => openBatch(bob.frame, utf8Bytes('x'.repeat(200)), 'nobody', 0)).toThrow(
      /not a qashy sync frame/i,
    );
  });

  it('refuses a truncated frame instead of reading past the end of it', async () => {
    const [alice, bob] = await makeVault();
    const frame = sealed(alice, bob);

    expect(() => openBatch(bob.frame, frame.slice(0, 20), alice.deviceId, 0)).toThrow(/truncated/i);
  });
});

describe('frames — who and when', () => {
  it('will not open on a device it was not addressed to', async () => {
    const [alice, bob, carol] = await makeVault(3);
    const frame = sealed(alice, bob);

    // Carol holds the same content key — every paired device does. Addressing is what stops
    // a relay handing a revoked device a blob meant for a live one.
    expect(() => openBatch(carol.frame, frame, alice.deviceId, 0)).toThrow(SyncCryptoError);
  });

  it('will not open when attributed to the wrong sender', async () => {
    const [alice, bob, carol] = await makeVault(3);

    expect(() => openBatch(bob.frame, sealed(alice, bob), carol.deviceId, 0)).toThrow(SyncCryptoError);
  });

  it('will not open at the wrong position in the stream', async () => {
    const [alice, bob] = await makeVault();
    const frame = sealed(alice, bob, 4);

    expect(() => openBatch(bob.frame, frame, alice.deviceId, 3)).toThrow(SyncCryptoError);
    expect(() => openBatch(bob.frame, frame, alice.deviceId, 5)).toThrow(SyncCryptoError);
    expect(openBatch(bob.frame, frame, alice.deviceId, 4)).toBeDefined();
  });

  it('will not open under a different vault epoch', async () => {
    const [alice, bob] = await makeVault();
    const rotated = { ...bob.frame, epoch: EPOCH + 1 };

    expect(() => openBatch(rotated, sealed(alice, bob), alice.deviceId, 0)).toThrow(SyncCryptoError);
  });

  it('refuses an unknown protocol version by name, so the message can say which device to update', async () => {
    const [alice, bob] = await makeVault();
    const frame = Uint8Array.from(sealed(alice, bob));
    frame[3] = PROTOCOL_VERSION + 1;

    expect(() => openBatch(bob.frame, frame, alice.deviceId, 0)).toThrow(
      new RegExp(`v${PROTOCOL_VERSION + 1}`),
    );
    try {
      openBatch(bob.frame, frame, alice.deviceId, 0);
    } catch (error) {
      expect((error as SyncCryptoError).code).toBe('badVersion');
    }
  });
});

describe('frames — size caps', () => {
  it('refuses an oversized frame before trying to decrypt it', async () => {
    const [, bob] = await makeVault();
    // Deliberately a valid header on a huge body: the cap has to fire on length alone, before
    // anything is allocated to decrypt it, or the cap is not a defence against exhaustion.
    const huge = new Uint8Array(MAX_FRAME_BYTES + 1);
    huge.set([0x51, 0x53, 0x59, PROTOCOL_VERSION, 1]);

    expect(() => openBatch(bob.frame, huge, 'sender', 0)).toThrow(SyncEngineError);
    try {
      openBatch(bob.frame, huge, 'sender', 0);
    } catch (error) {
      expect((error as SyncEngineError).code).toBe('tooLarge');
    }
  });

  it('refuses a batch carrying more ops than the cap, before validating any of them', () => {
    // The ops are empty objects. That is the point — a valid `ops.length` check must run
    // before `decodeOp`, or a zip bomb costs one validation per entry to reject.
    const bytes = encodeBatch({
      version: 2,
      epoch: 1,
      baseCurrency: 'USD',
      sender: 'device',
      heads: {},
      ops: Array.from({ length: MAX_BATCH_OPS + 1 }, () => ({})),
      roster: [],
      signature: 'signed',
    } as never);

    expect(() => decodeBatch(bytes)).toThrow(SyncEngineError);
    expect(() => decodeBatch(bytes)).toThrow(new RegExp(String(MAX_BATCH_OPS)));
  });
});

describe('batch codec — structural gate', () => {
  /**
   * `JSON.stringify`, not `encodeBatch`.
   *
   * The canonical encoder rejects `undefined` and refuses several of the shapes under test
   * here, which is correct — nothing legitimate produces them. A hostile peer is under no
   * such obligation, so the malformed cases have to be built the way it would build them.
   */
  const bytesOf = (value: unknown) => utf8Bytes(JSON.stringify(value));

  it('rejects anything that is not an object', () => {
    expect(() => decodeBatch(utf8Bytes('[]'))).toThrow(SyncEngineError);
    expect(() => decodeBatch(utf8Bytes('"batch"'))).toThrow(SyncEngineError);
  });

  it('rejects legacy unsigned batches explicitly', () => {
    expect(() =>
      decodeBatch(
        bytesOf({
          epoch: 1,
          baseCurrency: 'USD',
          sender: 'device',
          heads: {},
          ops: [],
        }),
      ),
    ).toThrow(/signed device roster/i);
  });

  it('rejects unparseable bytes without repeating the parser error back', () => {
    // The message must not name a character offset. That tells a user nothing and tells
    // whoever is probing exactly where the parser gave up.
    expect(() => decodeBatch(utf8Bytes('{'))).toThrow('That batch is not readable.');
  });

  it('rejects a batch that does not say what the sender holds', async () => {
    const [alice] = await makeVault();
    const batch = alice.batch(alice.author([alice.body('accounts', 'a1')]));

    expect(() => decodeBatch(bytesOf({ ...batch, heads: undefined }))).toThrow(SyncEngineError);
    expect(() => decodeBatch(bytesOf({ ...batch, heads: { '': 1 } }))).toThrow(SyncEngineError);
    expect(() => decodeBatch(bytesOf({ ...batch, heads: { d: -1 } }))).toThrow(SyncEngineError);
  });

  it('rejects an op whose id disagrees with its chain position', async () => {
    const [alice] = await makeVault();
    const [op] = alice.author([alice.body('accounts', 'a1')]);

    expect(() => decodeBatch(bytesOf(alice.batch([{ ...op, opId: `${op.deviceId}:99` }])))).toThrow(
      /does not match its chain position/,
    );
  });

  it('rejects an op ordered as though it came from another device', async () => {
    const [alice, bob] = await makeVault();
    const [op] = alice.author([alice.body('accounts', 'a1')]);
    // A well-formed HLC — just one belonging to Bob, on an op attributed to Alice. Checking
    // the two against each other is what stops an op being authored by one device and
    // *ordered* as though it were another's.
    const [other] = bob.author([bob.body('accounts', 'a1')]);

    expect(() => decodeBatch(bytesOf(alice.batch([{ ...op, hlc: other.hlc }])))).toThrow(
      /belongs to a different device/,
    );
  });

  it('rejects an op with a malformed clock reading', async () => {
    const [alice] = await makeVault();
    const [op] = alice.author([alice.body('accounts', 'a1')]);

    expect(() => decodeBatch(bytesOf(alice.batch([{ ...op, hlc: 'not-a-clock' }])))).toThrow(
      /malformed clock reading/,
    );
  });

  it('rejects an unsigned op as malformed, rather than as unverifiable', async () => {
    const [alice] = await makeVault();
    const [op] = alice.author([alice.body('accounts', 'a1')]);

    // Only sealed ops are ever transmitted, so an empty signature is not "a signature that
    // failed to verify" — it is a batch nobody legitimate could have built.
    expect(() => decodeBatch(bytesOf(alice.batch([{ ...op, signature: '' }])))).toThrow(
      /signature is missing/,
    );
  });

  it('passes through an op naming a type and kind this build does not know', async () => {
    const [alice] = await makeVault();
    const [op] = alice.author([alice.body('accounts', 'a1')]);
    const exotic = { ...op, entityType: 'holdings', kind: 'increment', schema: 99 };

    // Not validated here on purpose. This op is part of a hash chain other peers depend on,
    // so it has to survive the trip byte-for-byte even though nothing here can interpret it.
    const decoded = decodeBatch(bytesOf(alice.batch([exotic as never])));

    expect(decoded.ops[0]).toMatchObject({ entityType: 'holdings', kind: 'increment', schema: 99 });
  });

  it('round-trips a batch through canonical JSON without reordering its meaning', async () => {
    const [alice] = await makeVault();
    const batch = alice.batch(
      alice.author([alice.body('accounts', 'a1'), alice.body('categories', 'c1')]),
    );

    expect(decodeBatch(encodeBatch(batch))).toEqual(batch);
  });
});
