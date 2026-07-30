/**
 * Turning a pre-sync vault into an op log.
 *
 * Every device that installs sync already has `records` and no history — including, in the
 * common case, *both* devices of a first pairing. The op log has to be reconstructed from
 * what is on disk before either side can say anything meaningful to the other.
 *
 * Two properties make this safe, and both are asserted in the tests:
 *
 * 1. **Materialization is a round trip.** The ops produced here fold back into exactly the
 *    records they came from, byte for byte. Genesis is a re-description of the vault, not a
 *    transformation of it, so nothing in `records` is written or reordered.
 * 2. **The clock comes from the data, not from now.** Each op's HLC wall reading is seeded
 *    from the entity's own `createdAt`. Stamping everything "now" would be correct but
 *    useless: two paired vaults would arrive as one flat wall of simultaneous creates, and
 *    every LWW tie would be decided by device id instead of by when things actually
 *    happened. Seeding from `createdAt` makes the merged history interleave the way the user
 *    remembers it.
 *
 * The counter, not the wall clock, is what orders ops within this batch, so entities sharing
 * a `createdAt` — a seeded starter category set, a CSV import — still get distinct, stable
 * HLCs. Ordering is by `compareStoredEntities`, the same total order `readAll` returns, so
 * two runs over the same vault produce identical ops.
 */

import type { StorageTx } from '@/data/storage-adapter';
import { compareStoredEntities } from '@/data/storage-adapter';
import { recordOps, readChainState, writeChainState, writeMeta, SYNC_META } from '@/data/sync-store';
import { ENTITY_TYPES, type EntityType, type FinanceEntity } from '@/domain/models';
import {
  MAX_COUNTER,
  buildOp,
  diffEntity,
  hlcFromTimestamp,
  parseHlc,
  type SyncOpBody,
} from '@/sync/oplog';

/**
 * Every type a `records` row can hold, settings included.
 *
 * The repository's own walk omits `settings` because that singleton is read and seeded
 * separately; genesis has no such special case, and omitting it would leave the vault's
 * `baseCurrency`, locale, and onboarding state invisible to every peer — which is why this
 * points at the canonical list in the domain rather than keeping a copy.
 */
const GENESIS_TYPES: readonly EntityType[] = ENTITY_TYPES;

export interface GenesisResult {
  /** False when the vault had already been seeded, or held nothing to seed. */
  readonly ran: boolean;
  readonly opCount: number;
  readonly entityCount: number;
}

const SKIPPED: GenesisResult = { ran: false, opCount: 0, entityCount: 0 };

/**
 * The ops one existing row implies.
 *
 * `diffEntity(type, null, entity, hlc)` is reused rather than hand-building a `create`
 * payload, so genesis and an ordinary first save produce the *same* op for the same entity.
 * Hand-rolling it would be a second definition of "create" to keep in step with the registry.
 *
 * A tombstone becomes create-then-delete, at two consecutive readings. Dropping the delete
 * would resurrect every transaction the user has ever deleted, because
 * `hydrateFromStorage` rebuilds `deletedOccurrenceKeys` from tombstones — a deleted
 * recurrence occurrence would regenerate on the next foreground, forever.
 */
function genesisOps(type: EntityType, entity: FinanceEntity, deviceId: string, counter: number) {
  const created = hlcFromTimestamp(entity.createdAt, counter, deviceId);
  const live: FinanceEntity = entity.deletedAt ? { ...entity, deletedAt: null } : entity;
  const ops: SyncOpBody[] = [...diffEntity(type, null, live, created).ops];
  if (entity.deletedAt) {
    // The deletion is a later event than the creation, and the counter is what says so —
    // `deletedAt` is often the same millisecond as `createdAt` for a row created and removed
    // in one session.
    const deleted = hlcFromTimestamp(entity.createdAt, counter + 1, deviceId);
    ops.push(...diffEntity(type, live, entity, deleted).ops);
  }
  return ops;
}

/**
 * Converts this device's existing rows into a complete op log, once.
 *
 * Runs inside the caller's transaction so the whole conversion is atomic with the marker
 * that records it: a crash part-way through leaves a vault with no op log rather than half
 * of one, and the retry starts clean.
 *
 * Guarded on `genesisAt` *and* on the chain being empty. Either alone would be enough in
 * theory; together they mean a marker lost to a partial restore cannot make this run a
 * second time and issue a parallel set of creates for entities that already have them.
 */
export async function runGenesisMigration(
  tx: StorageTx,
  deviceId: string,
  nowIso: string,
): Promise<GenesisResult> {
  const existing = await tx.table('syncMeta').get(SYNC_META.genesisAt);
  if (existing) return SKIPPED;

  const { head } = await readChainState(tx);
  if (head.seq > 0) return SKIPPED;

  const loaded = await Promise.all(
    GENESIS_TYPES.map(async (type) => ({ type, entities: await tx.readAll(type) })),
  );

  const bodies: SyncOpBody[] = [];
  let entityCount = 0;
  // One counter across the whole vault rather than per type. Entities from different types
  // can share a `createdAt` just as easily as two of the same type, and a per-type counter
  // would hand them identical HLCs.
  let counter = 0;

  for (const { type, entities } of loaded) {
    for (const entity of [...entities].sort(compareStoredEntities)) {
      const ops = genesisOps(type, entity, deviceId, counter);
      if (!ops.length) continue;
      bodies.push(...ops);
      entityCount += 1;
      // Two readings per entity, whether or not the second was used, so a tombstone never
      // collides with the entity that follows it.
      counter += 2;
      if (counter > MAX_COUNTER - 2) {
        // The counter is 16 bits. A vault large enough to exhaust it within one millisecond
        // bucket rolls into the next; ordering is preserved because the wall reading rises.
        counter = 0;
      }
    }
  }

  if (!bodies.length) {
    // Nothing to describe — a fresh install. Mark it anyway, so the guard does not re-walk
    // every table on every launch for a vault that will fill up through the normal path.
    await writeMeta(tx, { [SYNC_META.genesisAt]: nowIso });
    return SKIPPED;
  }

  // Sorted by HLC so the chain's `seq` order matches causal order. Not required for
  // correctness — the merge sorts by HLC itself — but a log whose two orders agree is one a
  // peer can verify and replay without buffering, and one a human can read.
  const ordered = [...bodies].sort((first, second) => first.hlc.localeCompare(second.hlc));

  const built = buildOp(ordered, deviceId, head.seq, head.headHash);
  await recordOps(tx, built.ops, 0);

  const last = parseHlc(ordered[ordered.length - 1].hlc);
  await writeChainState(tx, {
    // The clock resumes from the newest genesis reading, so the first real local edit sorts
    // after everything genesis described rather than in the middle of it.
    clock: { wall: last.wall, counter: last.counter },
    head: { seq: built.seq, headHash: built.headHash },
  });
  await writeMeta(tx, { [SYNC_META.genesisAt]: nowIso });

  return { ran: true, opCount: built.ops.length, entityCount };
}
