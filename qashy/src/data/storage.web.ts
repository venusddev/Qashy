import { Dexie, type EntityTable } from 'dexie';

import type { EntityType, FinanceEntity } from '@/domain/models';
import type { StorageAdapter, StoredEntity } from '@/data/storage-adapter';

interface DbRecord {
  key: string;
  type: EntityType;
  entityId: string;
  payload: FinanceEntity;
  updatedAt: string;
  deletedAt: string | null;
}

class QashyDatabase extends Dexie {
  records!: EntityTable<DbRecord, 'key'>;

  constructor() {
    super('qashy');
    this.version(1).stores({
      records: '&key, type, entityId, updatedAt, deletedAt',
    });
  }
}

export class PlatformStorageAdapter implements StorageAdapter {
  private database = new QashyDatabase();

  async initialize() {
    await this.database.open();
  }

  async readAll(type: EntityType) {
    const rows = await this.database.records.where('type').equals(type).sortBy('updatedAt');
    return rows.map((row) => row.payload);
  }

  async putMany(records: StoredEntity[]) {
    if (!records.length) return;
    await this.database.transaction('rw', this.database.records, async () => {
      await this.database.records.bulkPut(
        records.map(({ type, entity }) => ({
          key: `${type}:${entity.id}`,
          type,
          entityId: entity.id,
          payload: entity,
          updatedAt: entity.updatedAt,
          deletedAt: entity.deletedAt,
        })),
      );
    });
  }

  async clear() {
    await this.database.records.clear();
  }
}
