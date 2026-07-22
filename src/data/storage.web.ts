import { Dexie, liveQuery, type EntityTable, type Subscription } from 'dexie';

import type { EntityType, FinanceEntity } from '@/domain/models';
import {
  compareStoredEntities,
  type StorageAdapter,
  type StoredEntity,
} from '@/data/storage-adapter';

interface DbRecord {
  key: string;
  type: EntityType;
  entityId: string;
  payload: FinanceEntity;
  updatedAt: string;
  deletedAt: string | null;
}

const STORAGE_CHANGE_KEY = 'qashy:storage-change';

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
  private listeners = new Set<(source?: object) => void>();
  private observation: Subscription | null = null;
  private receivedInitialObservation = false;

  constructor() {
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('storage', (event: StorageEvent) => {
        if (event.key === STORAGE_CHANGE_KEY) this.notifyLocalListeners();
      });
    }
  }

  async initialize() {
    await this.database.open();
    if (!this.observation) {
      this.observation = liveQuery(async () => {
        const rows = await this.database.records.toArray();
        return rows.map((row) => `${row.key}:${row.updatedAt}:${row.deletedAt ?? ''}`).sort();
      }).subscribe({
        next: () => {
          if (!this.receivedInitialObservation) {
            this.receivedInitialObservation = true;
            return;
          }
          this.notifyLocalListeners();
        },
        error: () => undefined,
      });
    }
  }

  async readAll(type: EntityType) {
    const rows = await this.database.records.where('type').equals(type).toArray();
    rows.sort((a, b) => compareStoredEntities(a.payload, b.payload));
    return rows.map((row) => row.payload);
  }

  async putMany(records: StoredEntity[], source?: object) {
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
    this.notifyChange(source);
  }

  async clear(source?: object) {
    await this.database.records.clear();
    this.notifyChange(source);
  }

  subscribe(listener: (source?: object) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
