import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import type { EntityType, FinanceEntity } from '@/domain/models';
import type { StorageAdapter, StoredEntity } from '@/data/storage-adapter';

const DATABASE_VERSION = 1;

export class PlatformStorageAdapter implements StorageAdapter {
  private database: SQLiteDatabase | null = null;

  async initialize() {
    this.database = await openDatabaseAsync('qashy.db');
    await this.database.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const row = await this.database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    if ((row?.user_version ?? 0) < 1) {
      await this.database.execAsync(`
        CREATE TABLE IF NOT EXISTS records (
          record_key TEXT PRIMARY KEY NOT NULL,
          entity_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );
        CREATE INDEX IF NOT EXISTS records_entity_type ON records(entity_type);
      `);
    }
    await this.database.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
  }

  async readAll(type: EntityType) {
    const rows = await this.getDatabase().getAllAsync<{ payload: string }>(
      'SELECT payload FROM records WHERE entity_type = ? ORDER BY updated_at ASC',
      type,
    );
    return rows.map((row) => JSON.parse(row.payload) as FinanceEntity);
  }

  async putMany(records: StoredEntity[]) {
    if (!records.length) return;
    const database = this.getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      for (const record of records) {
        await transaction.runAsync(
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
    });
  }

  async clear() {
    await this.getDatabase().runAsync('DELETE FROM records');
  }

  private getDatabase() {
    if (!this.database) throw new Error('Qashy database has not been initialized.');
    return this.database;
  }
}
