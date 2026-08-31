import {
  clearSyncTables,
  compareStoredEntities,
  recordKey,
  type StorageAdapter,
  type StorageTx,
  type StoredEntity,
  type SyncTable,
  type TransactOptions,
} from '@/data/storage-adapter';
import {
  SYNC_TABLE_NAMES,
  syncRowKey,
  type SyncRow,
  type SyncTableName,
} from '@/data/sync-tables';
import type { EntityType, FinanceEntity } from '@/domain/models';

type SyncTables = Map<SyncTableName, Map<string, unknown>>;

const emptySyncTables = (): SyncTables =>
  new Map(SYNC_TABLE_NAMES.map((name) => [name, new Map<string, unknown>()]));

const sortedEntities = (records: Map<string, StoredEntity>, type: EntityType) =>
  Array.from(records.values())
    .filter((record) => record.type === type)
    .sort((a, b) => compareStoredEntities(a.entity, b.entity))
    .map((record) => structuredClone(record.entity) as FinanceEntity);

class MemoryTx implements StorageTx {
  /**
   * Whether anything was actually written.
   *
   * A `transact` that only read has nothing for a subscriber to react to, and on web the
   * post-commit stamp is itself a write — so notifying for a read would wake every other tab
   * as well as every screen in this one.
   */
  dirty = false;

  constructor(
    private readonly records: Map<string, StoredEntity>,
    private readonly sync: SyncTables,
  ) {}

  async readAll(type: EntityType) {
    return sortedEntities(this.records, type);
  }

  async readKeys(keys: readonly string[]) {
    return keys
      .map((key) => this.records.get(key))
      .filter((record): record is StoredEntity => record !== undefined)
      .map((record) => structuredClone(record));
  }

  async putMany(records: readonly StoredEntity[]) {
    if (records.length) this.dirty = true;
    for (const record of records) {
      this.records.set(recordKey(record.type, record.entity.id), structuredClone(record));
    }
  }

  async deleteKeys(keys: readonly string[]) {
    if (keys.length) this.dirty = true;
    for (const key of keys) this.records.delete(key);
  }

  async clearRecords() {
    this.dirty = true;
    this.records.clear();
  }

  table<Name extends SyncTableName>(name: Name): SyncTable<SyncRow<Name>> {
    const rows = this.sync.get(name)!;
    const clone = (row: unknown) => structuredClone(row) as SyncRow<Name>;
    const markDirty = () => {
      this.dirty = true;
    };
    return {
      async get(key) {
        const row = rows.get(key);
        return row === undefined ? undefined : clone(row);
      },
      async getMany(keys) {
        return keys
          .map((key) => rows.get(key))
          .filter((row) => row !== undefined)
          .map(clone);
      },
      async all() {
        return Array.from(rows.values(), clone);
      },
      async put(next) {
        if (next.length) markDirty();
        for (const row of next) rows.set(syncRowKey(name, row), structuredClone(row));
      },
      async delete(keys) {
        if (keys.length) markDirty();
        for (const key of keys) rows.delete(key);
      },
    };
  }
}

export class MemoryStorageAdapter implements StorageAdapter {
  private records = new Map<string, StoredEntity>();
  private sync = emptySyncTables();
  private listeners = new Set<(source?: object) => void>();
  private tail: Promise<unknown> = Promise.resolve();

  async initialize() {}

  async readAll(type: EntityType) {
    return this.enqueue(async () => sortedEntities(this.records, type));
  }

  async transact<T>(work: (tx: StorageTx) => Promise<T>, options?: TransactOptions): Promise<T> {
    const { result, dirty } = await this.enqueue(async () => {
      // A shallow copy is a sufficient rollback because every write below *replaces* an entry
      // with a fresh clone rather than mutating one in place, so no restored value can have
      // been edited underneath.
      const records = new Map(this.records);
      const sync: SyncTables = new Map(
        Array.from(this.sync, ([name, rows]) => [name, new Map(rows)] as const),
      );
      const tx = new MemoryTx(this.records, this.sync);
      try {
        return { result: await work(tx), dirty: tx.dirty };
      } catch (error) {
        this.records = records;
        this.sync = sync;
        throw error;
      }
    });
    // Outside the queue slot, so a listener that writes in response cannot deadlock behind
    // the transaction it is reacting to.
    if (dirty && !options?.silent) {
      this.listeners.forEach((listener) => listener(options?.source));
    }
    return result;
  }

  /**
   * Serialises transactions, and reads against them.
   *
   * Writes land in the live maps as `work` runs, so an overlapping read would see
   * uncommitted rows — exactly what SQLite does on a single shared connection, and exactly
   * what the native adapter's own queue exists to prevent. Matching it here keeps the double
   * honest.
   *
   * A re-entrant `transact` — one called from inside `work` rather than using the `tx` it was
   * handed — deadlocks here, as it would on device. That is the contract on
   * `StorageAdapter.transact`, not an accident.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async putMany(records: StoredEntity[], source?: object) {
    // Both real adapters return early on an empty batch, and callers do produce
    // one (`updateTransactionsCategory` with no matching ids). Without the same
    // guard the test double notifies where production would not, so behaviour
    // under test drifts from behaviour on device.
    if (!records.length) return;
    await this.transact((tx) => tx.putMany(records), { source });
  }

  async clear(source?: object) {
    await this.transact(async (tx) => {
      await tx.clearRecords();
      await clearSyncTables(tx);
    }, { source });
  }

  subscribe(listener: (source?: object) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
