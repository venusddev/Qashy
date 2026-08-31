/**
 * Op-log retention.
 *
 * The op log is an **outbox, not the source of truth**. Materialization is eager — `records`
 * and `sync_state` are always current — so the local view never replays ops. `sync_ops`
 * exists only to hand to peers and to let them verify the hash chain. That collapses
 * compaction from "rewrite history without losing information" to a plain retention
 * question, and it is why no snapshot-op type is needed anywhere in this design.
 *
 * Dropping an op is only safe when every peer has it, or when the op is old enough that a
 * peer which still lacks it has to be re-synced from state anyway. Both cases end at the
 * same place: a peer asking for a `fromSeq` below `compactedBelow` gets full state instead
 * of a delta, and full state is state-based and per-register HLC-merged, so it converges
 * exactly like a delta would.
 *
 * Everything here is a pure function over acks and a cutoff — no clock reads, no I/O. The
 * caller supplies `nowMs`, which is what makes the retention window testable rather than
 * something you can only observe by waiting 90 days.
 */

import { MAX_WALL_MS, compareHlc, parseHlc } from '@/sync/oplog/hlc';
import type { ChainHead } from '@/sync/oplog/chain';
import type { SyncOp } from '@/sync/oplog/types';

/** How long an op survives when a peer never comes back to ack it. */
export const RETENTION_MS = 90 * 24 * 60 * 60_000;

export interface PeerAcks {
  readonly deviceId: string;
  /** The highest `seq` this peer has confirmed receiving, per originating chain. */
  readonly acked: Readonly<Record<string, number>>;
  readonly revoked: boolean;
}

export interface CompactionPlan {
  /** Ops safe to drop, by `opId`. */
  readonly dropOpIds: readonly string[];
  /** Per chain, the lowest `seq` still held afterwards. A peer below this needs full state. */
  readonly compactedBelow: Readonly<Record<string, number>>;
  /** Chains held back only because a peer has not acked; surfaced so the UI can name it. */
  readonly waitingOn: readonly string[];
}

const EMPTY_PLAN: CompactionPlan = { dropOpIds: [], compactedBelow: {}, waitingOn: [] };

/**
 * The highest `seq` of chain `deviceId` that every live peer has acknowledged.
 *
 * A revoked peer is skipped — waiting for an ack from a device the user has thrown away
 * would pin the log open forever, which is the opposite of what revocation is for. With no
 * live peers at all the answer is `-1`: a solo device is not "fully acked", it simply has
 * nobody to have acked, and its ops are still the only copy of its history.
 */
export function safeSeq(deviceId: string, peers: readonly PeerAcks[]): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const peer of peers) {
    if (peer.revoked || peer.deviceId === deviceId) continue;
    lowest = Math.min(lowest, peer.acked[deviceId] ?? -1);
  }
  return Number.isFinite(lowest) ? lowest : -1;
}

/**
 * Decides which ops can go.
 *
 * Two independent reasons to drop, and an op needs only one of them:
 *
 * - **Acked by every live peer.** Nobody will ever ask for it again, so it is pure weight.
 * - **Older than the retention window.** This is the bound that stops one peer which was
 *   lost, wiped, or simply never opened again from growing the log without limit. It costs
 *   that peer a full-state resync, which is the correct trade at 90 days.
 *
 * The head of every chain is always kept regardless. `prevHash` verification needs somewhere
 * to anchor, and a chain compacted down to nothing would make the next batch from that
 * device look like a gap rather than a continuation.
 */
export function planCompaction(
  ops: readonly SyncOp[],
  peers: readonly PeerAcks[],
  nowMs: number,
  retentionMs: number = RETENTION_MS,
): CompactionPlan {
  if (!ops.length) return EMPTY_PLAN;

  const cutoffWall = Math.max(0, Math.min(MAX_WALL_MS, nowMs - retentionMs));
  const byDevice = new Map<string, SyncOp[]>();
  for (const op of ops) {
    const list = byDevice.get(op.deviceId);
    if (list) list.push(op);
    else byDevice.set(op.deviceId, [op]);
  }

  const dropOpIds: string[] = [];
  const compactedBelow: Record<string, number> = {};
  const waitingOn: string[] = [];

  for (const [deviceId, chain] of [...byDevice.entries()].sort(([first], [second]) =>
    first < second ? -1 : 1,
  )) {
    chain.sort((first, second) => first.seq - second.seq);
    const head = chain[chain.length - 1];
    const acked = safeSeq(deviceId, peers);
    let held = chain[0].seq;
    let blocked = false;

    for (const op of chain) {
      if (op.seq >= head.seq) break;
      const expired = parseHlc(op.hlc).wall < cutoffWall;
      if (op.seq <= acked || expired) {
        // An unsealed op has never been transmitted, so an ack cannot possibly cover it and
        // expiry would silently discard a local change that no peer has ever seen.
        if (!op.signature) {
          blocked = true;
          break;
        }
        dropOpIds.push(op.opId);
        held = op.seq + 1;
        continue;
      }
      blocked = true;
      break;
    }

    compactedBelow[deviceId] = held;
    if (blocked && acked < head.seq - 1) waitingOn.push(deviceId);
  }

  return { dropOpIds, compactedBelow, waitingOn };
}

/**
 * Whether a peer asking for everything after `fromSeq` can be served from the log.
 *
 * `fromSeq` is what the peer already holds, so the next op it needs is `fromSeq + 1`. If we
 * compacted past that point the delta would arrive with a hole in the chain, which a correct
 * peer must reject — so the honest answer is to send full state instead.
 */
export const canServeDelta = (
  fromSeq: number,
  deviceId: string,
  compactedBelow: Readonly<Record<string, number>>,
): boolean => fromSeq + 1 >= (compactedBelow[deviceId] ?? 0);

/**
 * The chain heads a peer should be told about, so it can ask for exactly what it lacks.
 *
 * Derived from the ops themselves rather than tracked separately: one source of truth beats
 * two that can disagree, and the disagreement here would be a phantom gap that stalls sync.
 */
export function chainHeads(ops: readonly SyncOp[]): Map<string, ChainHead> {
  const heads = new Map<string, ChainHead>();
  for (const op of ops) {
    const current = heads.get(op.deviceId);
    if (!current || op.seq > current.seq) heads.set(op.deviceId, { seq: op.seq, headHash: op.opHash });
  }
  return heads;
}

/**
 * The highest HLC anywhere in a batch, for the watermark a peer sends back.
 *
 * Ordering ops by HLC rather than by `seq` is deliberate — `seq` is per-device and says
 * nothing across chains, while the HLC is the one total order every device agrees on.
 */
export function highestHlc(ops: readonly SyncOp[]): string | null {
  let highest: string | null = null;
  for (const op of ops) {
    if (highest === null || compareHlc(op.hlc, highest) > 0) highest = op.hlc;
  }
  return highest;
}
