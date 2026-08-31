import { OP_SCHEMA_VERSION, createDeviceIdentity } from '@/sync/crypto';
import {
  GENESIS_HASH,
  buildOp,
  hashOp,
  opIdFor,
  pendingByDevice,
  sealOp,
  verifyChain,
  verifyOpSignature,
  type ChainHead,
} from '@/sync/oplog/chain';
import { OpLogError, type SyncOp, type SyncOpBody } from '@/sync/oplog/types';
import { DEVICE_A, DEVICE_B, at } from '@/sync/oplog/__tests__/helpers';

const bodyAt = (wall: number, deviceId = DEVICE_A, title = 'Coffee'): SyncOpBody => ({
  hlc: at(wall, deviceId),
  entityType: 'transactions',
  entityId: 'txn-1',
  kind: 'set',
  payload: { registers: { title: { title } } },
  schema: OP_SCHEMA_VERSION,
});

const GENESIS: ChainHead = { seq: 0, headHash: GENESIS_HASH };

const chainOf = (count: number, deviceId = DEVICE_A) =>
  buildOp(
    Array.from({ length: count }, (_, index) => bodyAt(index + 1, deviceId)),
    deviceId,
    0,
    GENESIS_HASH,
  );

describe('hashOp', () => {
  it('is stable across key insertion order', () => {
    const first = hashOp('', {
      hlc: at(1),
      entityType: 'tags',
      entityId: 'tag-1',
      kind: 'set',
      payload: { registers: { name: { name: 'A' }, color: { color: '#fff' } } },
      schema: 1,
    });
    const second = hashOp('', {
      hlc: at(1),
      entityType: 'tags',
      entityId: 'tag-1',
      kind: 'set',
      payload: { registers: { color: { color: '#fff' }, name: { name: 'A' } } },
      schema: 1,
    });
    expect(first).toBe(second);
  });

  it('changes when any covered field changes', () => {
    const base = bodyAt(1);
    const hash = hashOp('', base);
    expect(hashOp('', { ...base, hlc: at(2) })).not.toBe(hash);
    expect(hashOp('', { ...base, entityId: 'txn-2' })).not.toBe(hash);
    expect(hashOp('', { ...base, kind: 'delete' })).not.toBe(hash);
    expect(hashOp('', { ...base, schema: 2 })).not.toBe(hash);
    expect(hashOp('', bodyAt(1, DEVICE_A, 'Tea'))).not.toBe(hash);
    // The predecessor is covered too — that is the whole point of a chain.
    expect(hashOp('deadbeef', base)).not.toBe(hash);
  });

  it('is synchronous, so it can run inside a storage transaction', () => {
    // Not a stylistic assertion. Awaiting `crypto.subtle.digest` inside a Dexie transaction
    // leaves its promise zone and lets IndexedDB commit underneath the write.
    expect(typeof hashOp('', bodyAt(1))).toBe('string');
  });
});

describe('buildOp', () => {
  it('numbers ops from the previous head and links each to the last', () => {
    const { ops, seq, headHash } = chainOf(3);
    expect(ops.map((op) => op.seq)).toEqual([1, 2, 3]);
    expect(ops[0].prevHash).toBe(GENESIS_HASH);
    expect(ops[1].prevHash).toBe(ops[0].opHash);
    expect(ops[2].prevHash).toBe(ops[1].opHash);
    expect(seq).toBe(3);
    expect(headHash).toBe(ops[2].opHash);
  });

  it('continues an existing chain', () => {
    const first = chainOf(2);
    const second = buildOp([bodyAt(3)], DEVICE_A, first.seq, first.headHash);
    expect(second.ops[0].seq).toBe(3);
    expect(second.ops[0].prevHash).toBe(first.headHash);
  });

  it('leaves ops unsigned for the background sealer', () => {
    expect(chainOf(1).ops[0].signature).toBe('');
  });

  it('builds opIds that identify a chain position', () => {
    expect(chainOf(1).ops[0].opId).toBe(opIdFor(DEVICE_A, 1));
  });
});

describe('signatures', () => {
  const identity = createDeviceIdentity();

  it('verifies an op it signed', () => {
    const sealed = sealOp(chainOf(1).ops[0], identity.signing.secretKey);
    expect(sealed.signature).not.toBe('');
    expect(verifyOpSignature(sealed, identity.signing.publicKey)).toBe(true);
  });

  it('rejects an unsigned op', () => {
    expect(verifyOpSignature(chainOf(1).ops[0], identity.signing.publicKey)).toBe(false);
  });

  it('rejects a signature from a different device', () => {
    const other = createDeviceIdentity();
    const sealed = sealOp(chainOf(1).ops[0], identity.signing.secretKey);
    expect(verifyOpSignature(sealed, other.signing.publicKey)).toBe(false);
  });

  it('binds the chain position, so a signature cannot be replayed elsewhere', () => {
    const sealed = sealOp(chainOf(1).ops[0], identity.signing.secretKey);
    expect(verifyOpSignature({ ...sealed, seq: 2 }, identity.signing.publicKey)).toBe(false);
    expect(verifyOpSignature({ ...sealed, deviceId: DEVICE_B }, identity.signing.publicKey)).toBe(
      false,
    );
  });

  it('rejects a tampered hash', () => {
    const sealed = sealOp(chainOf(1).ops[0], identity.signing.secretKey);
    const tampered = { ...sealed, opHash: hashOp('', bodyAt(1, DEVICE_A, 'Tea')) };
    expect(verifyOpSignature(tampered, identity.signing.publicKey)).toBe(false);
  });

  it('treats a malformed signature as a failure rather than a crash', () => {
    // Otherwise a peer could take the app down by sending one op with odd-length hex.
    const sealed = sealOp(chainOf(1).ops[0], identity.signing.secretKey);
    expect(verifyOpSignature({ ...sealed, signature: 'zz' }, identity.signing.publicKey)).toBe(false);
    expect(verifyOpSignature({ ...sealed, signature: 'abc' }, identity.signing.publicKey)).toBe(
      false,
    );
  });
});

describe('verifyChain', () => {
  it('accepts an unbroken continuation and returns the new head', () => {
    const { ops, seq, headHash } = chainOf(3);
    expect(verifyChain(ops, GENESIS)).toEqual({ seq, headHash });
  });

  it('accepts an empty batch as a no-op', () => {
    expect(verifyChain([], { seq: 7, headHash: 'abc' })).toEqual({ seq: 7, headHash: 'abc' });
  });

  it('rejects a gap rather than merging across it', () => {
    const { ops } = chainOf(3);
    expect(() => verifyChain([ops[0], ops[2]], GENESIS)).toThrow(OpLogError);
    try {
      verifyChain([ops[0], ops[2]], GENESIS);
    } catch (error) {
      expect((error as OpLogError).code).toBe('chainBreak');
    }
  });

  it('rejects a rewound sequence', () => {
    const { ops } = chainOf(2);
    try {
      verifyChain(ops, { seq: 5, headHash: 'whatever' });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as OpLogError).code).toBe('chainFork');
    }
  });

  it('rejects an op that does not follow the history we hold', () => {
    const { ops } = chainOf(2);
    const forked: SyncOp = { ...ops[1], prevHash: 'a'.repeat(64) };
    try {
      verifyChain([ops[0], forked], GENESIS);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as OpLogError).code).toBe('chainBreak');
    }
  });

  it('rejects an op whose payload no longer matches its own hash', () => {
    const { ops } = chainOf(1);
    const mutated: SyncOp = { ...ops[0], payload: { registers: { title: { title: 'Stolen' } } } };
    try {
      verifyChain([mutated], GENESIS);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as OpLogError).code).toBe('malformed');
    }
  });

  it('fails whole rather than applying up to the break', () => {
    // Partial application is how a truncation attack succeeds quietly.
    const { ops } = chainOf(4);
    const broken = [ops[0], ops[1], { ...ops[2], opHash: 'b'.repeat(64) }, ops[3]];
    expect(() => verifyChain(broken, GENESIS)).toThrow(OpLogError);
  });
});

describe('pendingByDevice', () => {
  it('drops ops already held, so a re-delivered batch is a no-op', () => {
    const { ops } = chainOf(3);
    const known = new Map([[DEVICE_A, { seq: 3, headHash: ops[2].opHash }]]);
    expect(pendingByDevice(ops, known).size).toBe(0);
  });

  it('keeps only what is genuinely new from an overlapping range', () => {
    const { ops } = chainOf(4);
    const known = new Map([[DEVICE_A, { seq: 2, headHash: ops[1].opHash }]]);
    const pending = pendingByDevice(ops, known);
    expect(pending.get(DEVICE_A)?.map((op) => op.seq)).toEqual([3, 4]);
  });

  it('separates chains and sorts each by seq', () => {
    const first = chainOf(2, DEVICE_A);
    const second = chainOf(2, DEVICE_B);
    const shuffled = [second.ops[1], first.ops[1], second.ops[0], first.ops[0]];
    const pending = pendingByDevice(shuffled, new Map());
    expect(pending.get(DEVICE_A)?.map((op) => op.seq)).toEqual([1, 2]);
    expect(pending.get(DEVICE_B)?.map((op) => op.seq)).toEqual([1, 2]);
  });

  it('accepts everything from a chain it has never seen', () => {
    const { ops } = chainOf(2, DEVICE_B);
    expect(pendingByDevice(ops, new Map()).get(DEVICE_B)).toHaveLength(2);
  });

  it('feeds verifyChain a batch that then verifies cleanly', () => {
    const { ops } = chainOf(5);
    const known = new Map([[DEVICE_A, { seq: 2, headHash: ops[1].opHash }]]);
    const pending = pendingByDevice(ops, known);
    expect(verifyChain(pending.get(DEVICE_A) ?? [], known.get(DEVICE_A)!)).toEqual({
      seq: 5,
      headHash: ops[4].opHash,
    });
  });
});
