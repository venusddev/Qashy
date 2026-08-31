/**
 * Entities this device holds ops for but cannot project.
 *
 * The situation is real and has to have an answer that is neither "lose the change" nor
 * "corrupt the ledger". Two devices can each make a legal edit that produces an illegal
 * *merge* — the classic one being two large opening balances that sum past a safe integer —
 * and the finance core will refuse the merged set, correctly. Discarding those ops would
 * silently lose a change the user made and can see on the other device. Applying them anyway
 * would write a state the repository has spent 2500 lines making impossible.
 *
 * So the ops are kept and forwarded, and only the local *projection* is held back:
 *
 * - `sync_ops` keeps them, so peers still receive them and the hash chain never truncates.
 * - `records` and `sync_state` are not written, so every existing invariant still holds.
 * - a row lands here naming the entity and why.
 *
 * The self-healing half lives in `findUnprojected`, not here, and that is the design: an
 * entity whose newest op is ahead of its `sync_state` is *by definition* unprojected, whether
 * because the money invariants refused it, because a clock was too far ahead to trust, or
 * because the app died between storing a batch and applying it. All three heal by re-offering
 * the ops on the next foreground, and none of them needs this table to remember anything. The
 * rows exist to be *shown*, not to drive the retry.
 *
 * **`detail` never carries finance data.** It is rendered on screen and it ends up in
 * screenshots people send for help, so it holds an error's class and code and nothing that
 * came out of a record — no entity name, no amount, no note.
 */

import type { StorageTx } from '@/data/storage-adapter';
import type { SyncQuarantineRow } from '@/data/sync-tables';
import { clearQuarantine, readQuarantine, writeQuarantine, type QuarantineReason } from '@/data/sync-store';
import { metaKey, type CausalMeta, type SyncOp } from '@/sync/oplog';
import type { RejectionCode } from '@/sync/engine/types';

/**
 * Which rejections are survivable.
 *
 * Only failures that are a property of *this device's* view get quarantined, because only
 * those can be undone by a later op. A bad signature or a broken chain is a property of the
 * batch itself and no future op will make it valid, so quarantining it would mean re-checking
 * forever. Those are rejected outright and recorded in the activity log instead.
 */
export const QUARANTINE_REASON_BY_CODE: Partial<Record<RejectionCode, QuarantineReason>> = {
  invariant: 'overflow',
  epochMismatch: 'epochMismatch',
  currencyMismatch: 'epochMismatch',
};

/**
 * A bounded, data-free description of a failure.
 *
 * The message is deliberately dropped. A finance invariant reports what it refused, which
 * means it names an account or an amount, and that string would then be persisted, rendered,
 * and screenshotted. The class and code are enough to tell a stuck merge from a stale clock,
 * and they cannot leak anything.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? `${error.name}:${code}` : error.name;
}

/**
 * One row per entity the failed batch touched.
 *
 * Keyed by entity rather than by batch, because that is the granularity the healing check
 * works at and the granularity the UI reports: "one budget is stuck" is actionable, "a batch
 * from Tuesday failed" is not.
 *
 * `hlc` records the newest reading the batch carried for that entity, so a later corrective
 * op is recognisably newer than what was refused.
 */
export function quarantineRows(
  ops: readonly SyncOp[],
  reason: QuarantineReason,
  detail: string,
  recordedAt: string,
): SyncQuarantineRow[] {
  const newest = new Map<string, string>();
  for (const op of ops) {
    const key = metaKey(op.entityType, op.entityId);
    const current = newest.get(key);
    // Raw string comparison: the HLC format is fixed-width precisely so that lexicographic
    // order equals causal order without parsing.
    if (current === undefined || op.hlc > current) newest.set(key, op.hlc);
  }
  return [...newest.entries()].map(([key, hlc]) => ({ key, reason, detail, hlc, recordedAt }));
}

/**
 * One row per entity a refused full-state snapshot touched.
 *
 * A full-state batch carries no ops, so `quarantineRows` has nothing to derive keys and
 * clock readings from — the entries themselves are the entities, and each one's `maxHlc` is
 * the reading the next corrective state has to beat.
 */
export function quarantineStateRows(
  states: readonly CausalMeta[],
  reason: QuarantineReason,
  detail: string,
  recordedAt: string,
): SyncQuarantineRow[] {
  return states.map((state) => ({
    key: metaKey(state.entityType, state.entityId),
    reason,
    detail,
    hlc: state.maxHlc,
    recordedAt,
  }));
}

export interface QuarantineChange {
  readonly added: number;
  readonly healed: number;
}

/**
 * Records a failed projection.
 *
 * Called from the engine *after* the repository has already refused and rolled back, so
 * there is nothing to undo — this only writes the note.
 */
export async function recordQuarantine(
  tx: StorageTx,
  ops: readonly SyncOp[],
  reason: QuarantineReason,
  detail: string,
  recordedAt: string,
): Promise<number> {
  const rows = quarantineRows(ops, reason, detail, recordedAt);
  await writeQuarantine(tx, rows);
  return rows.length;
}

/** The full-state twin of `recordQuarantine`: one row per refused state entry. */
export async function recordQuarantineStates(
  tx: StorageTx,
  states: readonly CausalMeta[],
  reason: QuarantineReason,
  detail: string,
  recordedAt: string,
): Promise<number> {
  const rows = quarantineStateRows(states, reason, detail, recordedAt);
  await writeQuarantine(tx, rows);
  return rows.length;
}

/**
 * Clears the rows for entities that have since projected successfully.
 *
 * Driven by what actually landed rather than by re-checking each row, because "this entity
 * was written to `records` in a transaction that committed" is the only evidence that the
 * merge which was refused is no longer the merge on disk.
 */
export async function healQuarantine(
  tx: StorageTx,
  projected: ReadonlySet<string>,
): Promise<number> {
  if (!projected.size) return 0;
  const existing = await readQuarantine(tx);
  const healed = existing.filter((row) => projected.has(row.key)).map((row) => row.key);
  await clearQuarantine(tx, healed);
  return healed.length;
}

/** How many entities are currently stuck, for the count the sync screen shows. */
export const quarantineCount = async (tx: StorageTx) => (await readQuarantine(tx)).length;
