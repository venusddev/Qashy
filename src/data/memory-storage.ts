import type { EntityType, FinanceEntity } from '@/domain/models';
import {
  compareStoredEntities,
  type StorageAdapter,
  type StoredEntity,
} from '@/data/storage-adapter';

export class MemoryStorageAdapter implements StorageAdapter {
  private records = new Map<string, StoredEntity>();
  private listeners = new Set<(source?: object) => void>();

  async initialize() {}

  async readAll(type: EntityType) {
    return Array.from(this.records.values())
      .filter((record) => record.type === type)
      .sort((a, b) => compareStoredEntities(a.entity, b.entity))
      .map((record) => structuredClone(record.entity) as FinanceEntity);
  }

  async putMany(records: StoredEntity[], source?: object) {
    // Both real adapters return early on an empty batch, and callers do produce
    // one (`updateTransactionsCategory` with no matching ids). Without the same
    // guard the test double notifies where production would not, so behaviour
    // under test drifts from behaviour on device.
    if (!records.length) return;
    records.forEach((record) => {
      this.records.set(`${record.type}:${record.entity.id}`, structuredClone(record));
    });
    this.listeners.forEach((listener) => listener(source));
  }

  async clear(source?: object) {
    this.records.clear();
    this.listeners.forEach((listener) => listener(source));
  }

  subscribe(listener: (source?: object) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
