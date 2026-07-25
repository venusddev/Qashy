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

type SignatureRow = Pick<DbRecord, 'key' | 'updatedAt' | 'deletedAt'>;

// The record key is `${type}:${id}` and `updatedAt` is an ISO timestamp, so a colon
// separator would leave the key unrecoverable from an entry. A pipe appears in
// neither, so it splits the two cleanly.
const SIGNATURE_SEPARATOR = '|';

const signatureOf = (row: SignatureRow) =>
  `${row.key}${SIGNATURE_SEPARATOR}${row.updatedAt}${SIGNATURE_SEPARATOR}${row.deletedAt ?? ''}`;

const signatureKey = (entry: string) => entry.slice(0, entry.indexOf(SIGNATURE_SEPARATOR));

const sameSignature = (a: string[], b: string[]) =>
  a.length === b.length && a.every((entry, index) => entry === b[index]);

export class PlatformStorageAdapter implements StorageAdapter {
  private db = new QashyDatabase();
  private listeners = new Set<(source?: object) => void>();
  private observation: Subscription | null = null;
  private opened = false;
  private opening: Promise<void> | null = null;
  // The row signature this adapter believes is on disk. `liveQuery` fires for every
  // write to `records`, including this adapter's own, and those emissions carry no
  // source — so they slipped past the repository's `source === this` filter and
  // forced a full re-hydrate after every single local mutation. Tracking the expected
  // signature lets a self-inflicted emission be recognised exactly, leaving only
  // genuine cross-tab changes to notify.
  private knownSignature: string[] | null = null;

  constructor() {
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
      this.observation = liveQuery(async () => {
        const rows = await this.db.records.toArray();
        return rows.map(signatureOf).sort();
      }).subscribe({
        next: (signature) => {
          const previous = this.knownSignature;
          this.knownSignature = signature;
          // The first emission is the initial read, and an emission matching what
          // this adapter just wrote is its own echo. Neither is a change to report.
          if (previous === null || sameSignature(previous, signature)) return;
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
    const rows = await this.database().records.where('type').equals(type).toArray();
    rows.sort((a, b) => compareStoredEntities(a.payload, b.payload));
    return rows.map((row) => row.payload);
  }

  async putMany(records: StoredEntity[], source?: object) {
    if (!records.length) return;
    const database = this.database();
    const rows = records.map(({ type, entity }) => ({
      key: `${type}:${entity.id}`,
      type,
      entityId: entity.id,
      payload: entity,
      updatedAt: entity.updatedAt,
      deletedAt: entity.deletedAt,
    }));
    await database.transaction('rw', database.records, async () => {
      await database.records.bulkPut(rows);
    });
    this.rememberWrites(rows);
    this.notifyChange(source);
  }

  async clear(source?: object) {
    await this.database().records.clear();
    this.knownSignature = [];
    this.notifyChange(source);
  }

  // Fold this adapter's own writes into the expected signature so the `liveQuery`
  // emission they trigger is recognised as an echo rather than a cross-tab change.
  private rememberWrites(rows: SignatureRow[]) {
    if (this.knownSignature === null) return;
    const next = new Map(this.knownSignature.map((entry) => [signatureKey(entry), entry]));
    rows.forEach((row) => next.set(row.key, signatureOf(row)));
    this.knownSignature = [...next.values()].sort();
  }

  subscribe(listener: (source?: object) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // The app holds a single adapter for its whole lifetime, so nothing releases the
  // `liveQuery` subscription in normal use. Tests create adapters per case and need
  // to hand the database back.
  async dispose() {
    this.observation?.unsubscribe();
    this.observation = null;
    this.knownSignature = null;
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
