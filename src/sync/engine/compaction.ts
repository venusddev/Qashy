/**
 * Applying the pure retention plan to the local outbox.
 *
 * Compaction belongs in the foreground sync pass, after exchange has had a chance to advance
 * peer acknowledgements. The transaction reads the authoritative op rows and roster together,
 * plans from those exact snapshots, and deletes only the rows the pure planner marked safe.
 */

import type { StorageAdapter } from '@/data/storage-adapter';
import { fromOpRow } from '@/data/sync-store';
import { planCompaction, type CompactionPlan } from '@/sync/oplog';
import { peerAcks, readRoster } from '@/sync/engine/roster';

export interface CompactionResult {
  readonly dropped: number;
  readonly plan: CompactionPlan;
}

/** Plans and atomically applies one retention pass over the local sync outbox. */
export async function compactSyncOps(storage: StorageAdapter, nowMs: number): Promise<CompactionResult> {
  return storage.transact(async (tx) => {
    const rows = await tx.table('syncOps').all();
    const roster = await readRoster(tx);
    const plan = planCompaction(rows.map(fromOpRow), peerAcks(roster), nowMs);
    if (plan.dropOpIds.length) await tx.table('syncOps').delete(plan.dropOpIds);
    return { dropped: plan.dropOpIds.length, plan };
  }, { silent: true });
}
