import type { EntityType, FinanceEntity } from '@/domain/models';
import type { StorageAdapter, StoredEntity } from '@/data/storage-adapter';

export class MemoryStorageAdapter implements StorageAdapter {
  private records = new Map<string, StoredEntity>();

  async initialize() {}

  async readAll(type: EntityType) {
    return Array.from(this.records.values())
      .filter((record) => record.type === type)
      .map((record) => structuredClone(record.entity) as FinanceEntity);
  }

  async putMany(records: StoredEntity[]) {
    records.forEach((record) => {
      this.records.set(`${record.type}:${record.entity.id}`, structuredClone(record));
    });
  }

  async clear() {
    this.records.clear();
  }
}
