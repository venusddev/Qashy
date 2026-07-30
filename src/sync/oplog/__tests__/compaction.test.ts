/**
 * Compaction decides what history a device is allowed to forget.
 *
 * Every assertion here is really the same one asked from a different angle: dropping an op
 * must never turn into a *hole*. A peer that receives a delta with a gap in the chain has to
 * reject it — that is what makes truncation detectable in the first place — so a plan that
 * drops op 3 while keeping op 4 does not save space, it breaks sync for that chain until
 * somebody notices. The safe answer when in doubt is always "keep it and send full state
 * later", which is why so much of this file is about what compaction refuses to do.
 */

import { OP_SCHEMA_VERSION } from '@/sync/crypto';
import { GENESIS_HASH, buildOp } from '@/sync/oplog/chain';
import {
  RETENTION_MS,
  canServeDelta,
  chainHeads,
  highestHlc,
  planCompaction,
  safeSeq,
  type PeerAcks,
} from '@/sync/oplog/compaction';
import type { SyncOp, SyncOpBody } from '@/sync/oplog/types';
import { DEVICE_A, DEVICE_B, DEVICE_C, at, seededRandom, shuffled } from '@/sync/oplog/__tests__/helpers';

const body = (wall: number, deviceId: string): SyncOpBody => ({
  hlc: at(wall, deviceId),
  entityType: 'transactions',
  entityId: 'txn-1',
  kind: 'set',
  payload: { registers: { title: { title: `wall-${wall}` } } },
  schema: OP_SCHEMA_VERSION,
});

/**
 * A chain whose ops carry the given wall-clock readings, sealed.
 *
 * The signature is a placeholder rather than a real Ed25519 one: compaction only ever asks
 * whether an op *has* been sealed, so a real key would buy nothing but a slower test.
 */
const chain = (walls: readonly number[], deviceId: string = DEVICE_A): SyncOp[] =>
  buildOp(
    walls.map((wall) => body(wall, deviceId)),
    deviceId,
    0,
    GENESIS_HASH,
  ).ops.map((op) => ({ ...op, signature: 'sealed' }));

const peer = (
  deviceId: string,
  acked: Record<string, number> = {},
  revoked = false,
): PeerAcks => ({ deviceId, acked, revoked });

/** Far enough past the window that every op below is expired unless the test says otherwise. */
const LONG_AFTER = RETENTION_MS + 1_000_000;

// ---------------------------------------------------------------------------

describe('safeSeq', () => {
  it('is -1 when there are no peers at all', () => {
    // A solo device is not "fully acked" — it simply has nobody to have acked, and its ops
    // are still the only copy of its own history.
    expect(safeSeq(DEVICE_A, [])).toBe(-1);
  });

  it('takes the lowest ack across live peers', () => {
    const peers = [peer(DEVICE_B, { [DEVICE_A]: 7 }), peer(DEVICE_C, { [DEVICE_A]: 4 })];
    expect(safeSeq(DEVICE_A, peers)).toBe(4);
  });

  it('treats a peer with no entry for the chain as having acked nothing', () => {
    const peers = [peer(DEVICE_B, { [DEVICE_A]: 7 }), peer(DEVICE_C, {})];
    expect(safeSeq(DEVICE_A, peers)).toBe(-1);
  });

  it('ignores the chain owner, which cannot ack itself', () => {
    const peers = [peer(DEVICE_A, { [DEVICE_A]: 0 }), peer(DEVICE_B, { [DEVICE_A]: 9 })];
    expect(safeSeq(DEVICE_A, peers)).toBe(9);
  });

  it('ignores a revoked peer', () => {
    // Waiting for an ack from a device the user has thrown away would pin the log open
    // forever, which is the opposite of what revocation is for.
    const peers = [peer(DEVICE_B, { [DEVICE_A]: 9 }), peer(DEVICE_C, { [DEVICE_A]: 0 }, true)];
    expect(safeSeq(DEVICE_A, peers)).toBe(9);
  });

  it('is -1 when every peer is revoked', () => {
    expect(safeSeq(DEVICE_A, [peer(DEVICE_B, { [DEVICE_A]: 9 }, true)])).toBe(-1);
  });
});

describe('planCompaction', () => {
  const acked = (seq: number) => [peer(DEVICE_B, { [DEVICE_A]: seq })];

  it('plans nothing for an empty log', () => {
    expect(planCompaction([], acked(99), LONG_AFTER)).toEqual({
      dropOpIds: [],
      compactedBelow: {},
      waitingOn: [],
    });
  });

  it('drops everything acked below the head', () => {
    const ops = chain([1, 2, 3, 4, 5]);
    const plan = planCompaction(ops, acked(3), 0);
    expect(plan.dropOpIds).toEqual([`${DEVICE_A}:1`, `${DEVICE_A}:2`, `${DEVICE_A}:3`]);
    expect(plan.compactedBelow).toEqual({ [DEVICE_A]: 4 });
  });

  it('always keeps the head of a chain, however thoroughly acked', () => {
    // `prevHash` verification needs somewhere to anchor. A chain compacted to nothing makes
    // the next batch from that device look like a gap rather than a continuation.
    const ops = chain([1, 2, 3]);
    const plan = planCompaction(ops, acked(99), LONG_AFTER);
    expect(plan.dropOpIds).toEqual([`${DEVICE_A}:1`, `${DEVICE_A}:2`]);
    expect(plan.compactedBelow).toEqual({ [DEVICE_A]: 3 });
    expect(plan.waitingOn).toEqual([]);
  });

  it('never drops a single op from a one-op chain', () => {
    expect(planCompaction(chain([1]), acked(99), LONG_AFTER).dropOpIds).toEqual([]);
  });

  it('stops at the first op it may not drop, rather than leaving a hole', () => {
    // A delta missing op 3 but containing op 4 is exactly the shape a correct peer has to
    // reject, so the scan halts at the first blocker instead of taking what it can get.
    const ops = chain([1, 2, 3, 4, 5]);
    const plan = planCompaction(ops, acked(2), 0);
    expect(plan.dropOpIds).toEqual([`${DEVICE_A}:1`, `${DEVICE_A}:2`]);
    expect(plan.compactedBelow).toEqual({ [DEVICE_A]: 3 });
  });

  it('treats expiry and acks as independent reasons, either of which suffices', () => {
    // Nothing is acked here at all; the cutoff falls between op 2 and op 3, and that alone
    // is enough to release the first two.
    const plan = planCompaction(chain([1, 2, 3, 4, 5]), acked(-1), 1_003, 1_000);
    expect(plan.dropOpIds).toEqual([`${DEVICE_A}:1`, `${DEVICE_A}:2`]);
    expect(plan.compactedBelow).toEqual({ [DEVICE_A]: 3 });
  });

  it('drops an op past the retention window even with no ack', () => {
    // The bound that stops one peer which was lost, wiped, or never opened again from growing
    // the log without limit. It costs that peer a full-state resync, which is the right trade.
    const plan = planCompaction(chain([1, 2, 3]), acked(-1), LONG_AFTER);
    expect(plan.dropOpIds).toEqual([`${DEVICE_A}:1`, `${DEVICE_A}:2`]);
  });

  it('expires nothing when the window has not elapsed yet', () => {
    // `nowMs - retentionMs` is negative on a device whose history is younger than the window,
    // and a cutoff that wrapped below zero would expire the entire log on first launch.
    const plan = planCompaction(chain([1, 2, 3]), acked(-1), 1_000);
    expect(plan.dropOpIds).toEqual([]);
    expect(plan.compactedBelow).toEqual({ [DEVICE_A]: 1 });
  });

  it('refuses to drop an unsealed op, and everything after it', () => {
    // An unsealed op has never been transmitted, so no ack can cover it and expiry would
    // silently discard a local change that no peer has ever seen.
    const ops = chain([1, 2, 3, 4]).map((op) => (op.seq === 2 ? { ...op, signature: '' } : op));
    const plan = planCompaction(ops, acked(99), LONG_AFTER);
    expect(plan.dropOpIds).toEqual([`${DEVICE_A}:1`]);
    expect(plan.compactedBelow).toEqual({ [DEVICE_A]: 2 });
  });

  it('names a chain held back by a peer that has not caught up', () => {
    const plan = planCompaction(chain([1, 2, 3, 4, 5]), acked(1), 0);
    expect(plan.waitingOn).toEqual([DEVICE_A]);
  });

  it('waits on nobody once the log is acked up to the head', () => {
    const plan = planCompaction(chain([1, 2, 3, 4, 5]), acked(4), 0);
    expect(plan.waitingOn).toEqual([]);
    expect(plan.compactedBelow).toEqual({ [DEVICE_A]: 5 });
  });

  it('compacts each chain against its own ack', () => {
    const ops = [...chain([1, 2, 3], DEVICE_A), ...chain([1, 2, 3], DEVICE_B)];
    const peers = [peer(DEVICE_C, { [DEVICE_A]: 2, [DEVICE_B]: 0 })];
    const plan = planCompaction(ops, peers, 0);
    expect(plan.dropOpIds).toEqual([`${DEVICE_A}:1`, `${DEVICE_A}:2`]);
    expect(plan.compactedBelow).toEqual({ [DEVICE_A]: 3, [DEVICE_B]: 1 });
    expect(plan.waitingOn).toEqual([DEVICE_B]);
  });

  it('plans the same thing however the ops were handed to it', () => {
    // Compaction runs opportunistically on foreground, over whatever order storage returned.
    // Two devices producing different plans for the same log is a divergence that only shows
    // up much later, as a peer that inexplicably needs full state.
    const ops = [...chain([1, 2, 3, 4], DEVICE_A), ...chain([1, 2, 3], DEVICE_C), ...chain([1, 2], DEVICE_B)];
    const peers = [peer(DEVICE_B, { [DEVICE_A]: 2, [DEVICE_C]: 1 })];
    const expected = JSON.stringify(planCompaction(ops, peers, 0));
    const random = seededRandom(4_242);
    for (let round = 0; round < 25; round += 1) {
      expect(JSON.stringify(planCompaction(shuffled(ops, random), peers, 0))).toBe(expected);
    }
  });

  it('is idempotent — replanning after applying a plan drops nothing new', () => {
    const ops = chain([1, 2, 3, 4, 5]);
    const first = planCompaction(ops, acked(3), 0);
    const remaining = ops.filter((op) => !first.dropOpIds.includes(op.opId));
    const second = planCompaction(remaining, acked(3), 0);
    expect(second.dropOpIds).toEqual([]);
    expect(second.compactedBelow).toEqual(first.compactedBelow);
  });

  it('honours an explicit retention override', () => {
    const ops = chain([1_000, 2_000, 3_000]);
    expect(planCompaction(ops, acked(-1), 2_500, 1_000).dropOpIds).toEqual([`${DEVICE_A}:1`]);
    expect(planCompaction(ops, acked(-1), 2_500, 10_000).dropOpIds).toEqual([]);
  });
});

describe('canServeDelta', () => {
  it('serves a peer that is exactly at the compaction floor', () => {
    // `fromSeq` is what the peer already holds, so the next op it needs is `fromSeq + 1`.
    expect(canServeDelta(3, DEVICE_A, { [DEVICE_A]: 4 })).toBe(true);
  });

  it('refuses a peer that is one op behind the floor', () => {
    expect(canServeDelta(2, DEVICE_A, { [DEVICE_A]: 4 })).toBe(false);
  });

  it('serves a peer that is ahead of the floor', () => {
    expect(canServeDelta(9, DEVICE_A, { [DEVICE_A]: 4 })).toBe(true);
  });

  it('serves a brand-new peer on a chain that was never compacted', () => {
    // A peer that holds nothing is at seq 0, and `buildOp` numbers the first op 1 — so an
    // untouched chain (floor 1, or absent entirely) can still be replayed from the start.
    expect(canServeDelta(0, DEVICE_A, {})).toBe(true);
    expect(canServeDelta(0, DEVICE_A, { [DEVICE_A]: 1 })).toBe(true);
  });

  it('refuses a brand-new peer once the first op is gone', () => {
    expect(canServeDelta(0, DEVICE_A, { [DEVICE_A]: 2 })).toBe(false);
  });

  it('agrees with the plan it was derived from', () => {
    // The pairing that matters: everything the plan kept must be servable, and the first op
    // it dropped must not be.
    const ops = chain([1, 2, 3, 4, 5]);
    const plan = planCompaction(ops, [peer(DEVICE_B, { [DEVICE_A]: 3 })], 0);
    expect(canServeDelta(3, DEVICE_A, plan.compactedBelow)).toBe(true);
    expect(canServeDelta(2, DEVICE_A, plan.compactedBelow)).toBe(false);
  });
});

describe('chainHeads', () => {
  it('reports the highest seq per device with that op’s hash', () => {
    const first = chain([1, 2, 3], DEVICE_A);
    const second = chain([1, 2], DEVICE_B);
    const heads = chainHeads([...first, ...second]);
    expect(heads.get(DEVICE_A)).toEqual({ seq: 3, headHash: first[2].opHash });
    expect(heads.get(DEVICE_B)).toEqual({ seq: 2, headHash: second[1].opHash });
  });

  it('does not care what order the ops arrived in', () => {
    const ops = chain([1, 2, 3]);
    const random = seededRandom(77);
    const expected = chainHeads(ops).get(DEVICE_A);
    for (let round = 0; round < 20; round += 1) {
      expect(chainHeads(shuffled(ops, random)).get(DEVICE_A)).toEqual(expected);
    }
  });

  it('is empty for an empty log', () => {
    expect(chainHeads([]).size).toBe(0);
  });
});

describe('highestHlc', () => {
  it('is null for an empty batch', () => {
    expect(highestHlc([])).toBeNull();
  });

  it('finds the highest reading wherever it sits in the batch', () => {
    const ops = [...chain([10, 90, 40], DEVICE_A)];
    expect(highestHlc(ops)).toBe(at(90, DEVICE_A));
  });

  it('orders across chains rather than by seq, which means nothing between devices', () => {
    // `seq` is per-device. Two devices' op 1 are not comparable; their HLCs are.
    const ops = [...chain([5], DEVICE_C), ...chain([5, 6], DEVICE_A)];
    expect(highestHlc(ops)).toBe(at(6, DEVICE_A));
  });

  it('breaks a tied reading by deviceId, as the HLC itself does', () => {
    const ops = [...chain([5], DEVICE_A), ...chain([5], DEVICE_C)];
    expect(highestHlc(ops)).toBe(at(5, DEVICE_C));
  });
});
