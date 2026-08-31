import {
  SYNC_TABLE_NAMES,
  syncRowKey,
  type SyncRow,
  type SyncTableName,
} from '@/data/sync-tables';
import type { EntityType, FinanceEntity } from '@/domain/models';

export interface StoredEntity {
  type: EntityType;
  entity: FinanceEntity;
}

/** The primary key of a `records` row, on every platform. */
export const recordKey = (type: EntityType, id: string) => `${type}:${id}`;

export function compareStoredEntities(first: FinanceEntity, second: FinanceEntity) {
  const createdOrder = first.createdAt.localeCompare(second.createdAt);
  if (createdOrder) return createdOrder;
  const firstName = 'name' in first && typeof first.name === 'string'
    ? first.name.trim().toLowerCase()
    : '';
  const secondName = 'name' in second && typeof second.name === 'string'
    ? second.name.trim().toLowerCase()
    : '';
  return firstName.localeCompare(secondName) || first.id.localeCompare(second.id);
}

/**
 * One of the five device-local sync tables, inside a transaction.
 *
 * Deliberately small. `all()` reads a whole table and the caller filters in JS, which is
 * only reasonable because compaction bounds `syncOps` and the other four are tiny — but it
 * means one implementation shape serves SQLite, IndexedDB, and the in-memory double, so the
 * three cannot drift in the way a per-adapter query builder would invite.
 */
export interface SyncTable<Row> {
  get(key: string): Promise<Row | undefined>;
  getMany(keys: readonly string[]): Promise<Row[]>;
  all(): Promise<Row[]>;
  put(rows: readonly Row[]): Promise<void>;
  delete(keys: readonly string[]): Promise<void>;
}

export interface StorageTx {
  readAll(type: EntityType): Promise<FinanceEntity[]>;
  /** Keys are `${type}:${id}`. Misses are omitted rather than returned as holes. */
  readKeys(keys: readonly string[]): Promise<StoredEntity[]>;
  putMany(records: readonly StoredEntity[]): Promise<void>;
  /** Compaction and `clear` only — finance entities are soft-deleted, never removed. */
  deleteKeys(keys: readonly string[]): Promise<void>;
  clearRecords(): Promise<void>;
  table<Name extends SyncTableName>(name: Name): SyncTable<SyncRow<Name>>;
}

export interface TransactOptions {
  /** Handed to subscribers so the writer can filter out its own change. */
  readonly source?: object;
  /**
   * Commits without notifying anyone. For writes nothing observable depends on — sealing an
   * op's signature, dropping compacted ops — where a notification would cost every open
   * screen a re-render for a change it cannot see.
   */
  readonly silent?: boolean;
}

export interface StorageAdapter {
  initialize(): Promise<void>;
  readAll(type: EntityType): Promise<FinanceEntity[]>;
  putMany(records: StoredEntity[], source?: object): Promise<void>;
  clear(source?: object): Promise<void>;
  /** Notifies repository instances after this local store changes. */
  subscribe?(listener: (source?: object) => void): () => void;

  /**
   * One atomic transaction across `records` and every sync table. Subscribers are notified
   * exactly once after commit; a throw rolls everything back and notifies nobody.
   *
   * This is what lets an op and the record it produced land together. If they could commit
   * separately, a crash between them would leave either a record no peer will ever hear
   * about, or an op claiming a change this device never made.
   *
   * CONTRACT: `work` must not await anything except methods on the `tx` it is handed.
   * Dexie tracks transaction membership through its own promise zone — awaiting a foreign
   * promise (WebCrypto, a timer, fetch) leaves that zone, IndexedDB auto-commits underneath,
   * and the next write either throws TransactionInactiveError or silently lands outside the
   * transaction. Do all async work before calling transact and pass the results in.
   */
  transact<T>(work: (tx: StorageTx) => Promise<T>, options?: TransactOptions): Promise<T>;
}

/**
 * Empties every sync table.
 *
 * Shared by `clear()` on all three adapters so a reset cannot leave one platform holding an
 * op log that describes entities no longer on disk — a state that would replicate deletions
 * this device never made. Expressed through `tx` rather than per-adapter SQL so the in-memory
 * double exercises the same path production does.
 */
export async function clearSyncTables(tx: StorageTx) {
  for (const name of SYNC_TABLE_NAMES) {
    const table = tx.table(name);
    const rows = await table.all();
    if (rows.length) await table.delete(rows.map((row) => syncRowKey(name, row)));
  }
}
