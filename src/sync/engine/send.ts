/**
 * Assembling a batch for a peer.
 *
 * The mirror of `receive.ts`, and much smaller, because sending is where nothing has to be
 * decided: the peer told us what it holds, we hold what we hold, and the difference is the
 * message. What little judgement there is lives in three rules.
 *
 * **Only sealed ops go out.** An unsealed op has never been signed, so a peer could not
 * verify it, and skipping over one to reach a later sibling would hand that peer a chain with
 * a hole — which arrives as a chain break rather than as "the rest is coming". `readOutbox`
 * enforces this by filtering rather than skipping, so the batch is always a prefix.
 *
 * **We forward everyone's ops, not just our own.** That is the entire reason three devices
 * converge without all three ever being awake at the same moment.
 *
 * **We send our own heads whether or not we have anything to say.** The header doubles as the
 * acknowledgement, and an idle device that never reports its position is a device compaction
 * can never advance past — the log would grow forever waiting for news that was never going
 * to arrive on its own.
 *
 * **Full state is sent in bounded chunks, never as one frame.** A peer that fell behind the
 * retention window is answered with state rather than a delta, and a vault's state is easily
 * larger than the frame cap — one all-or-nothing frame would be refused as `tooLarge` by
 * every transport, forever, with no smaller unit to fall back on. Chunks merge on the
 * receiver the same way a single batch does (`mergeMetaMaps` is per-register and idempotent),
 * so a pass that stops halfway merely restarts from the first chunk on the next foreground.
 */

import type { StorageAdapter, StorageTx } from '@/data/storage-adapter';
import {
  SYNC_META,
  deriveOutbox,
  readAllStates,
  readMeta,
} from '@/data/sync-store';
import type { SyncOpRow } from '@/data/sync-tables';
import type { SigningSecretKey } from '@/sync/crypto';
import { canServeDelta, type CausalMeta } from '@/sync/oplog';
import { authenticateBatch } from '@/sync/engine/batch';
import { headsRecord } from '@/sync/engine/receive';
import { readRoster, toRosterMember, type Peer, type Roster } from '@/sync/engine/roster';
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

/**
 * The most state entries one full-state chunk may carry.
 *
 * Well under `MAX_BATCH_STATE` (the receiver's hard refusal), so even an over-large chunk is
 * refused by the receiver as a *resumable* failure rather than as an impossible one.
 */
export const FULL_STATE_ENTRY_CAP = 2_500;

/**
 * The most encoded characters one full-state chunk may carry.
 *
 * The binding limit is the *relay's*, not the app's: the drop-box refuses any frame whose
 * base64url text exceeds 1 400 000 characters (`MAX_FRAME_CHARS` in `server/src/worker.ts`),
 * which is about 1 MiB of sealed frame. The other transports accept far more, but a chunk
 * sized for the relay works on all of them, and a chunk the relay refuses is a pass that
 * fails every time no matter how small the next one is.
 *
 * The budget is counted in characters, not bytes, with a deliberate pessimism: worst-case
 * UTF-8 expands a character to three bytes, and three times this budget plus the batch
 * overhead, the envelope's padding step, and base64 expansion still lands under both the
 * relay's frame cap and the app's 8 MiB ceiling.
 */
export const FULL_STATE_CHUNK_CHARS = 330_000;

export interface SendDeps {
  readonly storage: StorageAdapter;
  readonly deviceId: string;
  readonly signingKey: SigningSecretKey;
  readonly limit?: number;
}

/**
 * Everything `buildBatch` needs, read once per pass rather than once per batch.
 *
 * A first sync of a populated vault is tens of thousands of ops sent in bounded batches, and
 * re-scanning the op table for each batch turns a linear pass into a quadratic one. The
 * session loads this snapshot before its loop; `states` is filled in lazily, because reading
 * every entity's causal state is wasted work on a pass where nobody needs full state.
 *
 * `states` is deterministic: sorted by entity key, so a pass that restarts mid-state sends
 * the same chunks in the same order and the receiver's merge is exactly the same function of
 * what arrived.
 */
export interface SendSnapshot {
  readonly rows: readonly SyncOpRow[];
  readonly meta: ReadonlyMap<string, string>;
  readonly roster: Roster;
  states?: readonly CausalMeta[];
}

export interface OutgoingBatch {
  readonly batch: SyncBatch;
  /**
   * Whether more work remains after this one.
   *
   * The caller loops on it rather than guessing from the op count, because "exactly `limit`
   * ops" and "exactly `limit` ops and that was all of them" are different situations that
   * look identical from the outside. The same flag carries a chunked full state: every chunk
   * but the last says `true`, so the caller keeps sending until the state is complete.
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
 * Slices the state list into one chunk at `stateOffset`.
 *
 * Both caps are respected — entries and encoded size — so a chunk is never refused by the
 * receiver's own limits. `done` is whether this chunk completes the state.
 */
const chunkStates = (
  states: readonly CausalMeta[],
  offset: number,
): { readonly entries: readonly CausalMeta[]; readonly done: boolean } => {
  const entries: CausalMeta[] = [];
  let chars = 0;
  for (let index = offset; index < states.length; index += 1) {
    const state = states[index];
    const size = JSON.stringify(state).length;
    if (
      entries.length &&
      (entries.length >= FULL_STATE_ENTRY_CAP || chars + size > FULL_STATE_CHUNK_CHARS)
    ) {
      break;
    }
    entries.push(state);
    chars += size;
  }
  return { entries, done: offset + entries.length >= states.length };
};

/**
 * Builds one batch for a peer from what that peer says it holds.
 *
 * The reads happen in the caller's snapshot rather than inside a transaction, so the batch
 * builder takes no lock a concurrent local edit would have to wait on. A batch that goes
 * slightly stale between assembly and transmission costs one redundant exchange, which is the
 * cheapest possible failure here.
 */
export async function buildBatch(
  deps: SendDeps,
  peer: Peer,
  snapshot: SendSnapshot,
  stateOffset = 0,
): Promise<OutgoingBatch> {
  const { storage, deviceId, signingKey, limit = SEND_BATCH_OPS } = deps;
  const { meta, roster } = snapshot;
  const outbox = deriveOutbox(snapshot.rows, peer.acked, limit);

  // A peer that has never heard of a chain sits at 0, which is servable unless retention has
  // already cut into that chain's history — in which case the ops that would bridge the gap
  // no longer exist and the honest answer is full state, not a delta with a hole in it.
  const needsFullState = [...outbox.heads.keys()].filter(
    (chain) => !canServeDelta(peer.acked[chain] ?? 0, chain, outbox.compactedBelow),
  );

  let fullState: readonly CausalMeta[] | undefined;
  let more = outbox.more;
  if (needsFullState.length) {
    // Read once, cached on the snapshot the session reuses across chunks. Deterministic order
    // (sorted by key) so a restart from the first chunk sends the same slices as before.
    if (!snapshot.states) {
      const states = await storage.transact((tx) => readAllStates(tx));
      snapshot.states = [...states.entries()]
        .sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
        .map(([, state]) => state);
    }
    const chunk = chunkStates(snapshot.states, stateOffset);
    fullState = chunk.entries;
    more = !chunk.done;
  }

  return {
    batch: authenticateBatch(
      {
        version: BATCH_FORMAT_VERSION,
        epoch: Number(meta.get(SYNC_META.epoch) ?? '1'),
        baseCurrency: meta.get(SYNC_META.baseCurrency) ?? '',
        sender: deviceId,
        // A state snapshot replaces the unusable suffix. Sending both would still make the
        // receiver verify a chain whose compacted prefix no longer exists.
        ops: fullState !== undefined ? [] : outbox.ops,
        ...(fullState !== undefined ? { fullState } : {}),
        heads: headsRecord(outbox.heads),
        roster: [...roster.values()]
          .filter((member) => member.deviceId !== peer.deviceId)
          .map(toRosterMember),
      },
      signingKey,
    ),
    more,
    needsFullState,
  };
}

/**
 * Loads the send snapshot: one scan of the op table plus the two preconditions and the
 * roster, in a single transaction.
 */
export async function loadSendSnapshot(storage: StorageAdapter): Promise<SendSnapshot> {
  return storage.transact(async (tx: StorageTx) => {
    const [rows, meta, roster] = await Promise.all([
      tx.table('syncOps').all(),
      readMeta(tx, [SYNC_META.epoch, SYNC_META.baseCurrency]),
      readRoster(tx),
    ]);
    return { rows, meta, roster };
  });
}
