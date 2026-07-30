import { Dexie, liveQuery, type EntityTable, type Subscription, type Table } from 'dexie';

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
import type {
  SyncActivityRow,
  SyncMetaRow,
  SyncOpRow,
  SyncPeerRow,
  SyncQuarantineRow,
  SyncRow,
  SyncStateRow,
  SyncTableName,
} from '@/data/sync-tables';
import type { EntityType, FinanceEntity } from '@/domain/models';
import { makeId } from '@/utils/entity';

interface DbRecord {
  key: string;
  type: EntityType;
  entityId: string;
  payload: FinanceEntity;
  updatedAt: string;
  deletedAt: string | null;
}

const STORAGE_CHANGE_KEY = 'qashy:storage-change';

/** The single `syncMeta` row every commit stamps. See `PlatformStorageAdapter.transact`. */
const LAST_WRITE_KEY = 'lastWrite';

class QashyDatabase extends Dexie {
  records!: EntityTable<DbRecord, 'key'>;
  syncOps!: EntityTable<SyncOpRow, 'opId'>;
  syncState!: EntityTable<SyncStateRow, 'key'>;
  syncPeers!: EntityTable<SyncPeerRow, 'peerId'>;
  syncMeta!: EntityTable<SyncMetaRow, 'key'>;
  syncQuarantine!: EntityTable<SyncQuarantineRow, 'key'>;
  syncActivity!: EntityTable<SyncActivityRow, 'key'>;

  constructor(onBlocked: () => void) {
    super('qashy');
    this.version(1).stores({
      records: '&key, type, entityId, updatedAt, deletedAt',
    });
    // No `upgrade()` callback: no existing row changes shape, so Dexie adds the stores and
    // the compound index and leaves `records` exactly as it found it.
    //
    // IndexedDB cannot index `null` or a boolean, which is why `sealed` is `0 | 1` and an
    // absent `signature` is `''` — a nullable column simply drops out of its index, and
    // `[sealed+deviceId+seq]` is how the sealer finds its work.
    this.version(2).stores({
      records: '&key, type, entityId, updatedAt, deletedAt, [type+updatedAt]',
      syncOps: '&opId, [deviceId+seq], [entityType+entityId], hlc, [sealed+deviceId+seq]',
      syncState: '&key, type, maxHlc',
      syncPeers: '&peerId',
      syncMeta: '&key',
      syncQuarantine: '&key',
    });
    // Append-only, exactly like the SQLite ladder: a browser that already upgraded to v2 gets
    // the activity store from here, and editing v2 in place would leave it without one.
    this.version(3).stores({
      syncActivity: '&key',
    });
    // Structured-clone rows do not need a schema change for a non-indexed field, but existing
    // revoked rows need a fail-closed cutoff. Active rows keep null until revocation records
    // the chain head this device had accepted.
    this.version(4)
      .stores({ syncPeers: '&peerId' })
      .upgrade((transaction) =>
        transaction
          .table('syncPeers')
          .toCollection()
          .modify((row: { revokedAt?: unknown; revokedSeq?: number | null }) => {
            if (row.revokedSeq === undefined) row.revokedSeq = row.revokedAt ? 0 : null;
          }),
      );
    // Without this, shipping a new `version()` while a second tab holds the old one blocks
    // the upgrade *indefinitely* — and two open tabs is a routine PWA state, not an edge
    // case. Closing here lets the upgrading tab through; this tab's next query reopens at
    // the new version.
    this.on('versionchange', () => {
      this.close();
    });
    // The other side of the same coin: we are the one being blocked, by a tab too old to
    // have the handler above. Nothing can fix that from here, so tell the user.
    this.on('blocked', onBlocked);
  }
}

/**
 * Whether anything was actually written inside a given Dexie transaction.
 *
 * A `transact` that only read has nothing for a subscriber to react to, and here the
 * post-commit `lastWrite` stamp is itself a write — so notifying for a read would wake every
 * other tab as well as every screen in this one.
 *
 * Keyed by the transaction object rather than held on the adapter or on one `DexieTx`, because
 * Dexie joins a nested `transact` into its parent: the two get separate `DexieTx` instances but
 * the same transaction, so a write through the inner one still has to make the outer commit
 * notify. Two *concurrent* transacts get different transactions, so they stay independent — the
 * distinction a flag on the adapter could not make.
 */
const txDirty = new WeakMap<object, { dirty: boolean }>();

class DexieTx implements StorageTx {
  constructor(
    private readonly db: QashyDatabase,
    private readonly state: { dirty: boolean },
  ) {}

  async readAll(type: EntityType) {
    const rows = await this.db.records.where('type').equals(type).toArray();
    rows.sort((a, b) => compareStoredEntities(a.payload, b.payload));
    return rows.map((row) => row.payload);
  }

  async readKeys(keys: readonly string[]) {
    const rows = await this.db.records.bulkGet([...keys]);
    return rows
      .filter((row): row is DbRecord => row !== undefined)
      .map((row) => ({ type: row.type, entity: row.payload }));
  }

  async putMany(records: readonly StoredEntity[]) {
    if (records.length) this.state.dirty = true;
    await this.db.records.bulkPut(
      records.map(({ type, entity }) => ({
        key: recordKey(type, entity.id),
        type,
        entityId: entity.id,
        payload: entity,
        updatedAt: entity.updatedAt,
        deletedAt: entity.deletedAt,
      })),
    );
  }

  async deleteKeys(keys: readonly string[]) {
    if (keys.length) this.state.dirty = true;
    await this.db.records.bulkDelete([...keys]);
  }

  async clearRecords() {
    this.state.dirty = true;
    await this.db.records.clear();
  }

  table<Name extends SyncTableName>(name: Name): SyncTable<SyncRow<Name>> {
    const table = this.db.table(name) as Table<SyncRow<Name>, string>;
    const markDirty = () => {
      this.state.dirty = true;
    };
    return {
      async get(key) {
        return table.get(key);
      },
      async getMany(keys) {
        const rows = await table.bulkGet([...keys]);
        return rows.filter((row): row is SyncRow<Name> => row !== undefined);
      },
      async all() {
        return table.toArray();
      },
      async put(rows) {
        if (rows.length) markDirty();
        await table.bulkPut([...rows]);
      },
      async delete(keys) {
        if (keys.length) markDirty();
        await table.bulkDelete([...keys]);
      },
    };
  }
}

export class PlatformStorageAdapter implements StorageAdapter {
  private db: QashyDatabase;
  private listeners = new Set<(source?: object) => void>();
  private blockedListeners = new Set<() => void>();
  private observation: Subscription | null = null;
  private opened = false;
  private opening: Promise<void> | null = null;
  /**
   * Identifies this adapter instance — really, this tab — inside the `lastWrite` token.
   *
   * This replaces the old row-signature echo suppression, which was subtly broken: it called
   * `rememberWrites` *after* awaiting the Dexie transaction, but `liveQuery` fires on commit
   * and the ordering between the observer callback and the `await` continuation is undefined.
   * When the observer won, the adapter reported its own write as a foreign change with no
   * `source`, the repository's `source === this` filter missed it, and every local mutation
   * cost a full 11-type re-hydrate. Stamping a token *inside* the transaction makes the
   * comparison exact and race-free, and it costs one indexed row read instead of projecting
   * every record in the database on every change.
   */
  private readonly instanceId = makeId();
  private writeCounter = 0;
  private lastSeenToken: string | null = null;

  constructor() {
    this.db = new QashyDatabase(() => this.blockedListeners.forEach((listener) => listener()));
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('storage', (event: StorageEvent) => {
        if (event.key === STORAGE_CHANGE_KEY) this.notifyLocalListeners();
      });
    }
  }

  async initialize() {
    if (this.opened) return;
    if (!this.opening) {
      this.opening = this.openDatabase().finally(() => {
        this.opening = null;
      });
    }
    await this.opening;
  }

  private async openDatabase() {
    await this.db.open();
    if (!this.observation) {
      this.observation = liveQuery(() => this.db.syncMeta.get(LAST_WRITE_KEY)).subscribe({
        next: (row) => {
          const token = row?.value ?? '';
          // The first emission is the initial read — it may carry a token left by a previous
          // session, which is history rather than news.
          if (this.lastSeenToken === null) {
            this.lastSeenToken = token;
            return;
          }
          if (token === this.lastSeenToken) return;
          this.lastSeenToken = token;
          // Our own commit already notified with its `source`; notifying again here is the
          // double-hydrate this whole mechanism exists to prevent.
          if (token.startsWith(`${this.instanceId}:`)) return;
          this.notifyLocalListeners();
        },
        error: () => undefined,
      });
    }
    this.opened = true;
  }

  // Dexie defaults to `autoOpen`, so reads and writes before `initialize()` used to
  // quietly succeed against a database whose change subscription was never wired —
  // change notifications then silently never fired. The native adapter throws for
  // the same misuse; match it so the mistake surfaces on both platforms.
  private database() {
    if (!this.opened) throw new Error('Qashy database has not been initialized.');
    return this.db;
  }

  async readAll(type: EntityType) {
    return new DexieTx(this.database(), { dirty: false }).readAll(type);
  }

  async transact<T>(work: (tx: StorageTx) => Promise<T>, options?: TransactOptions): Promise<T> {
    const database = this.database();
    // Dexie joins a nested transaction into its parent rather than starting a second one, so
    // the inner call must not stamp or notify — the outer commit is the only real one.
    // `Dexie.currentTransaction` is zone-aware, which a depth counter here would not be: two
    // *concurrent* transacts would both read a raised counter and each think it was nested.
    const nested = Boolean(Dexie.currentTransaction);
    // Every table is in scope even for a records-only write. Dexie scopes a transaction to
    // exactly the tables named, so `tx.table('syncOps')` inside one opened over `records`
    // alone throws NotFoundError — and this transaction always writes the `lastWrite` row.
    const { value, dirty } = await database.transaction('rw', database.tables, async () => {
      const current = Dexie.currentTransaction as object;
      const state = txDirty.get(current) ?? { dirty: false };
      txDirty.set(current, state);

      const tx = new DexieTx(database, state);
      const result = await work(tx);
      // Read before stamping, because the stamp is itself a write and would set the flag.
      const wrote = state.dirty;
      if (wrote && !nested && !options?.silent) {
        this.writeCounter += 1;
        await tx
          .table('syncMeta')
          .put([{ key: LAST_WRITE_KEY, value: `${this.instanceId}:${this.writeCounter}` }]);
      }
      return { value: result, dirty: wrote };
    });
    if (dirty && !nested && !options?.silent) this.notifyChange(options?.source);
    return value;
  }

  async putMany(records: StoredEntity[], source?: object) {
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

  /** Fires when another tab is holding this database at an older version. */
  subscribeBlocked(listener: () => void) {
    this.blockedListeners.add(listener);
    return () => this.blockedListeners.delete(listener);
  }

  // The app holds a single adapter for its whole lifetime, so nothing releases the
  // `liveQuery` subscription in normal use. Tests create adapters per case and need
  // to hand the database back.
  async dispose() {
    this.observation?.unsubscribe();
    this.observation = null;
    this.lastSeenToken = null;
    this.opened = false;
    this.db.close();
  }

  private notifyChange(source?: object) {
    this.notifyLocalListeners(source);
    try {
      globalThis.localStorage?.setItem(STORAGE_CHANGE_KEY, `${Date.now()}:${Math.random()}`);
    } catch {
      // IndexedDB remains usable when localStorage is blocked; visibility
      // reconciliation still refreshes the repository when the app resumes.
    }
  }

  private notifyLocalListeners(source?: object) {
    this.listeners.forEach((listener) => listener(source));
  }
}
