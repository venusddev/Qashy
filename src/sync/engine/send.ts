/**
 * Assembling a batch for a peer.
 *
 * The mirror of `receive.ts`, and much smaller, because sending is where nothing has to be
 * decided: the peer told us what it holds, we hold what we hold, and the difference is the
 * message. What little judgement there is lives in three rules.
 *
 * **Only sealed ops go out.** An unsealed op has never been signed, so a peer could not
 * verify it, and skipping over one to reach a later sibling would hand that peer a chain with
 * a hole — which arrives as a chain break rather than as "the rest is coming". `readOpsAfter`
 * enforces this by filtering rather than skipping, so the batch is always a prefix.
 *
 * **We forward everyone's ops, not just our own.** That is the entire reason three devices
 * converge without all three ever being awake at the same moment.
 *
 * **We send our own heads whether or not we have anything to say.** The header doubles as the
 * acknowledgement, and an idle device that never reports its position is a device compaction
 * can never advance past — the log would grow forever waiting for news that was never going
 * to arrive on its own.
 */

import type { StorageAdapter, StorageTx } from '@/data/storage-adapter';
import { SYNC_META, readAllStates, readMeta, readOutbox } from '@/data/sync-store';
import type { SigningSecretKey } from '@/sync/crypto';
import { canServeDelta } from '@/sync/oplog';
import { authenticateBatch } from '@/sync/engine/batch';
import { headsRecord } from '@/sync/engine/receive';
import { readRoster, toRosterMember, type Peer } from '@/sync/engine/roster';
import { BATCH_FORMAT_VERSION } from '@/sync/engine/types';
import type { SyncBatch } from '@/sync/engine/types';

/**
 * How many ops one batch carries.
 *
 * Well under `MAX_BATCH_OPS`, which is the receiver's hard refusal rather than a target. This
 * is the *sender's* comfortable size: a first sync of a populated vault is tens of thousands
 * of ops, and pushing them as one frame would mean a multi-megabyte upload that either
 * succeeds entirely or is retried entirely. Smaller batches each commit on arrival, so a
 * connection that drops halfway has still made permanent progress.
 */
export const SEND_BATCH_OPS = 1_000;

export interface SendDeps {
  readonly storage: StorageAdapter;
  readonly deviceId: string;
  readonly signingKey: SigningSecretKey;
  readonly limit?: number;
}

export interface OutgoingBatch {
  readonly batch: SyncBatch;
  /**
   * Whether more ops remain after this one.
   *
   * The caller loops on it rather than guessing from the op count, because "exactly `limit`
   * ops" and "exactly `limit` ops and that was all of them" are different situations that
   * look identical from the outside.
   */
  readonly more: boolean;
  /**
   * Chains where the peer's position has already been compacted away.
   *
   * A delta cannot be built for these — the ops that would bridge the gap are gone — so the
   * caller has to answer with full state instead. Reported rather than thrown because the
   * rest of the batch is still perfectly good and should still be sent.
   */
  readonly needsFullState: readonly string[];
}

/**
 * Builds one batch for a peer from what that peer says it holds.
 *
 * Reads inside a transaction it never writes to, so it takes no lock a concurrent local edit
 * would have to wait on. A batch that goes slightly stale between assembly and transmission
 * costs one redundant exchange, which is the cheapest possible failure here.
 */
export async function buildBatch(deps: SendDeps, peer: Peer): Promise<OutgoingBatch> {
  const { storage, deviceId, signingKey, limit = SEND_BATCH_OPS } = deps;
  return storage.transact((tx) => assemble(tx, deviceId, signingKey, peer, limit));
}

async function assemble(
  tx: StorageTx,
  deviceId: string,
  signingKey: SigningSecretKey,
  peer: Peer,
  limit: number,
): Promise<OutgoingBatch> {
  const meta = await readMeta(tx, [SYNC_META.epoch, SYNC_META.baseCurrency]);
  const outbox = await readOutbox(tx, peer.acked, limit);
  const roster = await readRoster(tx);

  // A peer that has never heard of a chain sits at 0, which is servable unless retention has
  // already cut into that chain's history — in which case the ops that would bridge the gap
  // no longer exist and the honest answer is full state, not a delta with a hole in it.
  const needsFullState = [...outbox.heads.keys()].filter(
    (chain) => !canServeDelta(peer.acked[chain] ?? 0, chain, outbox.compactedBelow),
  );
  const fullState = needsFullState.length
    ? [...(await readAllStates(tx)).values()]
    : undefined;

  return {
    batch: authenticateBatch(
      {
        version: BATCH_FORMAT_VERSION,
        epoch: Number(meta.get(SYNC_META.epoch) ?? '1'),
        baseCurrency: meta.get(SYNC_META.baseCurrency) ?? '',
        sender: deviceId,
        // A state snapshot replaces the unusable suffix. Sending both would still make the
        // receiver verify a chain whose compacted prefix no longer exists.
        ops: fullState ? [] : outbox.ops,
        ...(fullState !== undefined ? { fullState } : {}),
        heads: headsRecord(outbox.heads),
        roster: [...roster.values()]
          .filter((member) => member.deviceId !== peer.deviceId)
          .map(toRosterMember),
      },
      signingKey,
    ),
    more: fullState ? false : outbox.more,
    needsFullState,
  };
}
