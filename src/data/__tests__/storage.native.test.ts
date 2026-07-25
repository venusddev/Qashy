import type { StoredEntity } from '@/data/storage-adapter';
import type { Account } from '@/domain/models';

/**
 * `openDatabaseAsync` builds a brand-new native handle on every call — there is no
 * connection cache — so these tests pin the lifecycle rules the adapter has to
 * enforce itself: open once, and never strand a handle when setup fails.
 *
 * Names are `mock`-prefixed because Jest hoists `jest.mock` above the imports and
 * only allows the factory to reach out-of-scope bindings that follow that convention.
 */
class MockDatabase {
  closed = false;
  statements: string[] = [];
  rows = new Map<string, Record<string, unknown>>();

  async execAsync(sql: string) {
    this.statements.push(sql);
    if (mockFailOnExec && sql.includes(mockFailOnExec)) throw new Error('migration failed');
  }

  async getFirstAsync<T>() {
    return { user_version: 0 } as T;
  }

  async getAllAsync<T>() {
    return [...this.rows.values()] as T[];
  }

  async runAsync() {}

  async withExclusiveTransactionAsync(callback: (tx: MockDatabase) => Promise<void>) {
    const snapshot = new Map(this.rows);
    try {
      await callback(this);
    } catch (reason) {
      this.rows = snapshot;
      throw reason;
    }
  }

  async closeAsync() {
    this.closed = true;
  }
}

const mockOpened: MockDatabase[] = [];
let mockFailOnExec: string | null = null;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    const database = new MockDatabase();
    mockOpened.push(database);
    return database;
  }),
}));

// eslint-disable-next-line import/first -- must be required after `jest.mock` above.
import { PlatformStorageAdapter } from '@/data/storage.native';

const account = (id: string): Account => ({
  id,
  name: id,
  type: 'checking',
  currency: 'USD',
  openingBalanceMinor: 0,
  icon: 'wallet.bifold',
  color: '#5966E9',
  archived: false,
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
});

const stored = (id: string): StoredEntity => ({ type: 'accounts', entity: account(id) });

describe('native storage adapter lifecycle', () => {
  beforeEach(() => {
    mockOpened.length = 0;
    mockFailOnExec = null;
  });

  it('opens the database exactly once across repeated and concurrent calls', async () => {
    const adapter = new PlatformStorageAdapter();
    await Promise.all([adapter.initialize(), adapter.initialize()]);
    await adapter.initialize();

    expect(mockOpened).toHaveLength(1);
    expect(mockOpened[0].closed).toBe(false);
  });

  it('closes the handle it opened when setup fails, and leaves none stranded on retry', async () => {
    const adapter = new PlatformStorageAdapter();
    mockFailOnExec = 'CREATE TABLE';

    await expect(adapter.initialize()).rejects.toThrow('migration failed');
    expect(mockOpened).toHaveLength(1);
    // Without this the first connection leaks: the adapter used to assign
    // `this.database` before migrating and never called `closeAsync`.
    expect(mockOpened[0].closed).toBe(true);

    mockFailOnExec = null;
    await adapter.initialize();
    expect(mockOpened).toHaveLength(2);
    expect(mockOpened[1].closed).toBe(false);
  });

  it('enables WAL before running migrations', async () => {
    const adapter = new PlatformStorageAdapter();
    await adapter.initialize();

    expect(mockOpened[0].statements[0]).toContain('journal_mode = WAL');
  });

  it('refuses reads and writes before initialize()', async () => {
    const adapter = new PlatformStorageAdapter();
    await expect(adapter.readAll('accounts')).rejects.toThrow('has not been initialized');
  });

  it('skips the transaction entirely for an empty batch', async () => {
    const adapter = new PlatformStorageAdapter();
    await adapter.initialize();
    const listener = jest.fn();
    adapter.subscribe(listener);

    await adapter.putMany([]);
    expect(listener).not.toHaveBeenCalled();

    await adapter.putMany([stored('a')], {});
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
