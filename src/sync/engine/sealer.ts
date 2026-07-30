/**
 * The background signer.
 *
 * Ops are written unsigned. That is not a shortcut — it is what the storage contract
 * requires. A local mutation records its ops inside the same transaction that writes the
 * records, and signing inside a transaction would mean awaiting work that is not a `tx`
 * method, which leaves Dexie's promise zone and lets IndexedDB commit underneath the write.
 * So the write path stays synchronous and pure, and this runs afterwards.
 *
 * The consequence is the rule that makes it safe: **only sealed ops are ever transmitted.**
 * An unsealed op is a local record of a local change that no peer has heard of yet. It is
 * skipped when building a batch, and `planCompaction` refuses to drop one for the same
 * reason — an ack cannot possibly cover something that was never sent.
 *
 * Sealing is idempotent, which is what makes two browser tabs sharing one device identity a
 * non-event here. Ed25519 is deterministic, so two tabs signing the same op produce the same
 * signature and the second write is a no-op rather than a conflict.
 */

import type { StorageAdapter } from '@/data/storage-adapter';
import { fromOpRow, toOpRow } from '@/data/sync-store';
import type { SigningSecretKey } from '@/sync/crypto';
import { sealOp } from '@/sync/oplog';

/**
 * How many ops one pass signs.
 *
 * Bounded because the genesis migration converts an entire existing vault into ops in one
 * transaction, and signing tens of thousands of them in a single synchronous run would block
 * the JS thread long enough to drop frames on the screen the user is looking at. Passes are
 * cheap to repeat and each one commits, so a partially sealed log is a valid resting state
 * rather than a half-finished job.
 */
export const SEAL_BATCH_SIZE = 500;

export interface SealerInput {
  readonly storage: StorageAdapter;
  /** This device. Only its own ops can be signed here; a peer's arrive already sealed. */
  readonly deviceId: string;
  readonly signingKey: SigningSecretKey;
  readonly limit?: number;
}

/**
 * Signs up to `limit` of this device's unsealed ops, oldest first.
 *
 * In `seq` order rather than arbitrary order, so that a log which is only partially sealed is
 * still a *prefix* — everything up to some point is sendable and nothing after it is. Sealing
 * out of order would produce a log with holes, and a batch built from it would arrive at a
 * peer as a chain break rather than as "the rest is coming".
 *
 * The read and the write are separate transactions on purpose. Between them the op rows
 * cannot meaningfully change: an op is immutable except for its signature, and the only
 * writer of that is this function.
 */
export async function sealPending({
  storage,
  deviceId,
  signingKey,
  limit = SEAL_BATCH_SIZE,
}: SealerInput): Promise<number> {
  const pending = await storage.transact(async (tx) => {
    const rows = await tx.table('syncOps').all();
    return rows
      .filter((row) => row.sealed === 0 && row.deviceId === deviceId)
      .sort((first, second) => first.seq - second.seq)
      .slice(0, limit);
  });
  if (!pending.length) return 0;

  // Outside any transaction, which is the whole point of this module.
  const sealed = pending.map((row) => sealOp(fromOpRow(row), signingKey));

  await storage.transact(
    // `origin` is read back off the row rather than assumed: these are this device's own ops
    // so it is always 0, but re-deriving it from the row keeps the round-trip total and
    // stops a future caller from quietly relabelling a forwarded op as locally authored.
    (tx) => tx.table('syncOps').put(sealed.map((op, index) => toOpRow(op, pending[index].origin))),
    // Nothing a subscriber can observe has changed: `records` is untouched and the entity a
    // signature belongs to looks identical before and after. Notifying would re-hydrate all
    // eleven entity types to redraw exactly the same screen.
    { silent: true },
  );
  return sealed.length;
}

/**
 * Whether anything is waiting to be signed.
 *
 * Exists so the session loop can skip a pass without opening a write transaction, which on
 * SQLite means not taking the write lock at all — this runs on every foreground and is a
 * no-op the overwhelming majority of the time.
 */
export async function hasUnsealed(storage: StorageAdapter, deviceId: string): Promise<boolean> {
  return storage.transact(async (tx) => {
    const rows = await tx.table('syncOps').all();
    return rows.some((row) => row.sealed === 0 && row.deviceId === deviceId);
  });
}
