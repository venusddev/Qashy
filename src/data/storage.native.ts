import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import {
  clearSyncTables,
  compareStoredEntities,
  type StorageAdapter,
  type StorageTx,
  type StoredEntity,
  type SyncTable,
  type TransactOptions,
} from '@/data/storage-adapter';
import type { SyncRow, SyncTableName } from '@/data/sync-tables';
import type { EntityType, FinanceEntity } from '@/domain/models';

/** Under SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` of 999, with room to spare. */
const MAX_PARAMETERS = 900;

const chunk = <T>(items: readonly T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

/**
 * Each step runs in its own transaction that also sets `user_version`, so a crash part-way
 * through the ladder is idempotent on retry: either the step and its version bump both
 * landed, or neither did. The one-off `if (user_version < 1)` branch this replaces set the
 * version *after* the DDL and outside any transaction, which left a window where the tables
 * existed but the database still called itself version 0.
 *
 * Steps are append-only. Editing one that has already shipped changes nothing on a device
 * that has run it.
 */
const MIGRATIONS: readonly { readonly version: number; readonly sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS records (
        record_key TEXT PRIMARY KEY NOT NULL,
        entity_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS records_entity_type ON records(entity_type);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS sync_ops (
        op_id       TEXT PRIMARY KEY NOT NULL,
        device_id   TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        prev_hash   TEXT NOT NULL,
        op_hash     TEXT NOT NULL,
        hlc         TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        schema      INTEGER NOT NULL DEFAULT 0,
        signature   TEXT NOT NULL DEFAULT '',
        sealed      INTEGER NOT NULL DEFAULT 0,
        origin      INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sync_ops_chain    ON sync_ops(device_id, seq);
      CREATE INDEX        IF NOT EXISTS sync_ops_entity   ON sync_ops(entity_type, entity_id, hlc);
      CREATE INDEX        IF NOT EXISTS sync_ops_unsealed ON sync_ops(sealed, device_id, seq);

      CREATE TABLE IF NOT EXISTS sync_state (
        record_key  TEXT PRIMARY KEY NOT NULL,
        entity_type TEXT NOT NULL,
        meta        TEXT NOT NULL,
        max_hlc     TEXT NOT NULL,
        deleted_hlc TEXT
      );
      CREATE INDEX IF NOT EXISTS sync_state_hlc ON sync_state(max_hlc);

      CREATE TABLE IF NOT EXISTS sync_peers (
        device_id    TEXT PRIMARY KEY NOT NULL,
        name         TEXT NOT NULL,
        platform     TEXT NOT NULL,
        ed25519_pub  TEXT NOT NULL,
        x25519_pub   TEXT NOT NULL,
        epoch        INTEGER NOT NULL,
        added_at     TEXT NOT NULL,
        revoked_at   TEXT,
        acked        TEXT NOT NULL,
        known        TEXT NOT NULL,
        last_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_meta (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_quarantine (
        record_key  TEXT PRIMARY KEY NOT NULL,
        reason      TEXT NOT NULL,
        detail      TEXT NOT NULL,
        hlc         TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS records_updated_at ON records(entity_type, updated_at);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS sync_activity (
        key         TEXT PRIMARY KEY NOT NULL,
        kind        TEXT NOT NULL,
        peer_id     TEXT NOT NULL,
        count       INTEGER NOT NULL,
        code        TEXT NOT NULL,
        detail      TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
    `,
  },
];

/** Derived from the ladder rather than declared beside it, so the two cannot drift apart. */
export const DATABASE_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

interface SqlTableSpec {
  readonly table: string;
  readonly key: string;
  /** `[column, field]`, in insert order. */
  readonly columns: readonly (readonly [string, string])[];
}

/**
 * The column mapping for each sync table.
 *
 * Public keys are `TEXT` rather than the `BLOB` a SQLite-only design would pick: the rows are
 * base64url on both platforms, because SQLite and IndexedDB disagree about how a
 * `Uint8Array` round-trips and a string is the one representation both store identically.
 *
 * No foreign keys anywhere here. `PRAGMA foreign_keys` is per-connection, and a constraint
 * that is enforced on some connections and not others is worse than no constraint at all.
 */
const SQL_TABLES = {
  syncOps: {
    table: 'sync_ops',
    key: 'op_id',
    columns: [
      ['op_id', 'opId'],
      ['device_id', 'deviceId'],
      ['seq', 'seq'],
      ['prev_hash', 'prevHash'],
      ['op_hash', 'opHash'],
      ['hlc', 'hlc'],
      ['entity_type', 'entityType'],
      ['entity_id', 'entityId'],
      ['kind', 'kind'],
      ['payload', 'payload'],
      ['schema', 'schema'],
      ['signature', 'signature'],
      ['sealed', 'sealed'],
      ['origin', 'origin'],
    ],
  },
  syncState: {
    table: 'sync_state',
    key: 'record_key',
    columns: [
      ['record_key', 'key'],
      ['entity_type', 'type'],
      ['meta', 'meta'],
      ['max_hlc', 'maxHlc'],
      ['deleted_hlc', 'deletedHlc'],
    ],
  },
  syncPeers: {
    table: 'sync_peers',
    key: 'device_id',
    columns: [
      ['device_id', 'peerId'],
      ['name', 'name'],
      ['platform', 'platform'],
      ['ed25519_pub', 'signingKey'],
      ['x25519_pub', 'agreementKey'],
      ['epoch', 'epoch'],
      ['added_at', 'addedAt'],
      ['revoked_at', 'revokedAt'],
      ['acked', 'acked'],
      ['known', 'known'],
      ['last_seen_at', 'lastSeenAt'],
    ],
  },
  syncMeta: {
    table: 'sync_meta',
    key: 'key',
    columns: [
      ['key', 'key'],
      ['value', 'value'],
    ],
  },
  syncActivity: {
    table: 'sync_activity',
    key: 'key',
    columns: [
      ['key', 'key'],
      ['kind', 'kind'],
      ['peer_id', 'peerId'],
      ['count', 'count'],
      ['code', 'code'],
      ['detail', 'detail'],
      ['recorded_at', 'recordedAt'],
    ],
  },
  syncQuarantine: {
    table: 'sync_quarantine',
    key: 'record_key',
    columns: [
      ['record_key', 'key'],
      ['reason', 'reason'],
      ['detail', 'detail'],
      ['hlc', 'hlc'],
      ['recorded_at', 'recordedAt'],
    ],
  },
} as const satisfies Record<SyncTableName, SqlTableSpec>;

type SqlValue = string | number | null;

class SqliteTx implements StorageTx {
  /**
   * Whether anything was actually written.
   *
   * A `transact` that only read has nothing for a subscriber to react to, and notifying would
   * cost every open screen a re-render for a change that did not happen.
   */
  dirty = false;

  constructor(private readonly database: SQLiteDatabase) {}

  async readAll(type: EntityType) {
    const rows = await this.database.getAllAsync<{ payload: string }>(
      'SELECT payload FROM records WHERE entity_type = ? ORDER BY updated_at ASC, record_key ASC',
      type,
    );
    return rows.map((row) => JSON.parse(row.payload) as FinanceEntity).sort(compareStoredEntities);
  }

  async readKeys(keys: readonly string[]) {
    const found: StoredEntity[] = [];
    for (const batch of chunk(keys, MAX_PARAMETERS)) {
      const rows = await this.database.getAllAsync<{ entity_type: string; payload: string }>(
        `SELECT entity_type, payload FROM records
         WHERE record_key IN (${batch.map(() => '?').join(', ')})`,
        ...batch,
      );
      for (const row of rows) {
        found.push({
          type: row.entity_type as EntityType,
          entity: JSON.parse(row.payload) as FinanceEntity,
        });
      }
    }
    return found;
  }

  async putMany(records: readonly StoredEntity[]) {
    if (records.length) this.dirty = true;
    for (const record of records) {
      await this.database.runAsync(
        `INSERT INTO records (record_key, entity_type, payload, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(record_key) DO UPDATE SET
           entity_type = excluded.entity_type,
           payload = excluded.payload,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at`,
        `${record.type}:${record.entity.id}`,
        record.type,
        JSON.stringify(record.entity),
        record.entity.updatedAt,
        record.entity.deletedAt,
      );
    }
  }

  async deleteKeys(keys: readonly string[]) {
    if (keys.length) this.dirty = true;
    for (const batch of chunk(keys, MAX_PARAMETERS)) {
      await this.database.runAsync(
        `DELETE FROM records WHERE record_key IN (${batch.map(() => '?').join(', ')})`,
        ...batch,
      );
    }
  }

  async clearRecords() {
    this.dirty = true;
    await this.database.runAsync('DELETE FROM records');
  }

  table<Name extends SyncTableName>(name: Name): SyncTable<SyncRow<Name>> {
    const spec: SqlTableSpec = SQL_TABLES[name];
    const database = this.database;
    const selection = spec.columns.map(([column]) => column).join(', ');
    const markDirty = () => {
      this.dirty = true;
    };

    const toRow = (raw: Record<string, SqlValue>) => {
      const row: Record<string, SqlValue> = {};
      for (const [column, field] of spec.columns) row[field] = raw[column];
      return row as unknown as SyncRow<Name>;
    };

    return {
      async get(key) {
        const raw = await database.getFirstAsync<Record<string, SqlValue>>(
          `SELECT ${selection} FROM ${spec.table} WHERE ${spec.key} = ?`,
          key,
        );
        return raw ? toRow(raw) : undefined;
      },
      async getMany(keys) {
        const found: SyncRow<Name>[] = [];
        for (const batch of chunk(keys, MAX_PARAMETERS)) {
          const raws = await database.getAllAsync<Record<string, SqlValue>>(
            `SELECT ${selection} FROM ${spec.table}
             WHERE ${spec.key} IN (${batch.map(() => '?').join(', ')})`,
            ...batch,
          );
          for (const raw of raws) found.push(toRow(raw));
        }
        return found;
      },
      async all() {
        const raws = await database.getAllAsync<Record<string, SqlValue>>(
          `SELECT ${selection} FROM ${spec.table}`,
        );
        return raws.map(toRow);
      },
      async put(rows) {
        if (rows.length) markDirty();
        const assignments = spec.columns
          .filter(([column]) => column !== spec.key)
          .map(([column]) => `${column} = excluded.${column}`)
          .join(', ');
        for (const row of rows) {
          const fields = row as unknown as Record<string, SqlValue>;
          const values = spec.columns.map(([, field]) => fields[field] ?? null);
          await database.runAsync(
            `INSERT INTO ${spec.table} (${selection})
             VALUES (${spec.columns.map(() => '?').join(', ')})
             ON CONFLICT(${spec.key}) DO UPDATE SET ${assignments}`,
            ...values,
          );
        }
      },
      async delete(keys) {
        if (keys.length) markDirty();
        for (const batch of chunk(keys, MAX_PARAMETERS)) {
          await database.runAsync(
            `DELETE FROM ${spec.table} WHERE ${spec.key} IN (${batch.map(() => '?').join(', ')})`,
            ...batch,
          );
        }
      },
    };
  }
}

export class PlatformStorageAdapter implements StorageAdapter {
  private database: SQLiteDatabase | null = null;
  private opening: Promise<SQLiteDatabase> | null = null;
  private listeners = new Set<(source?: object) => void>();
  private tail: Promise<unknown> = Promise.resolve();

  // `openDatabaseAsync` has no connection cache — every call builds a fresh native
  // handle. Re-entering this method (the error screen's "Try again", or two callers
  // racing on first launch) therefore used to strand the previous connection, since
  // nothing ever closed it. Opening once and sharing the in-flight promise makes the
  // call idempotent; a failure part-way through closes the handle it opened so the
  // retry starts clean.
  async initialize() {
    if (this.database) return;
    if (!this.opening) {
      this.opening = this.openDatabase().finally(() => {
        this.opening = null;
      });
    }
    this.database = await this.opening;
  }

  private async openDatabase() {
    const database = await openDatabaseAsync('qashy.db');
    try {
      // All three are per-connection, which is the reason this adapter keeps one connection
      // and manages transactions on it by hand. `busy_timeout` matters now that reads and
      // writes share a transaction: without it a lock contended by the OS's own WAL
      // checkpointer fails immediately instead of waiting.
      await database.execAsync(
        'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
      );
      const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      const current = row?.user_version ?? 0;
      if (current < DATABASE_VERSION) {
        for (const migration of MIGRATIONS) {
          if (migration.version <= current) continue;
          await this.runMigration(database, migration);
        }
      }
      return database;
    } catch (reason) {
      await database.closeAsync().catch(() => undefined);
      throw reason;
    }
  }

  private async runMigration(
    database: SQLiteDatabase,
    migration: { readonly version: number; readonly sql: string },
  ) {
    // `BEGIN IMMEDIATE`, not the deferred `BEGIN` that `withExclusiveTransactionAsync` issues
    // on a connection of its own: a deferred transaction that upgrades a read lock to a write
    // lock fails outright with SQLITE_BUSY_SNAPSHOT under WAL rather than waiting, and cannot
    // be retried in place.
    await database.execAsync('BEGIN IMMEDIATE');
    try {
      await database.execAsync(migration.sql);
      // Transactional, because `user_version` lives in the database header. That is what makes
      // a half-applied ladder impossible.
      await database.execAsync(`PRAGMA user_version = ${migration.version}`);
      await database.execAsync('COMMIT');
    } catch (reason) {
      await database.execAsync('ROLLBACK').catch(() => undefined);
      throw reason;
    }
  }

  async readAll(type: EntityType) {
    return this.enqueue(async () => new SqliteTx(this.getDatabase()).readAll(type));
  }

  async transact<T>(work: (tx: StorageTx) => Promise<T>, options?: TransactOptions): Promise<T> {
    const { result, dirty } = await this.enqueue(async () => {
      const database = this.getDatabase();
      const tx = new SqliteTx(database);
      await database.execAsync('BEGIN IMMEDIATE');
      try {
        const value = await work(tx);
        await database.execAsync('COMMIT');
        return { result: value, dirty: tx.dirty };
      } catch (reason) {
        await database.execAsync('ROLLBACK').catch(() => undefined);
        throw reason;
      }
    });
    // Outside the queue slot, so a listener that writes cannot deadlock behind the
    // transaction it is reacting to.
    if (dirty && !options?.silent) {
      this.listeners.forEach((listener) => listener(options?.source));
    }
    return result;
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

  /**
   * The in-process write mutex.
   *
   * One connection means an uncommitted transaction is visible to every read on it, so a
   * `readAll` overlapping a `transact` would return dirty rows. Serialising both through one
   * queue removes the interleaving; there is only ever one process, so no CAS retry is needed.
   *
   * A re-entrant `transact` — one called from inside `work` rather than using the `tx` it was
   * handed — deadlocks here. That is the contract on `StorageAdapter.transact`, and SQLite
   * has no nested transaction on a single connection to offer instead.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private getDatabase() {
    if (!this.database) throw new Error('Qashy database has not been initialized.');
    return this.database;
  }
}
