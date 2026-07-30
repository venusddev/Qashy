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
  /** Survives `closeAsync`, the way a file on disk survives closing a connection. */
  userVersion = mockStartVersion;

  private pendingVersion: number | null = null;
  private inTransaction = false;

  async execAsync(sql: string) {
    this.statements.push(sql);
    if (mockFailOnExec && sql.includes(mockFailOnExec)) throw new Error('migration failed');

    const trimmed = sql.trim();
    if (trimmed === 'BEGIN IMMEDIATE') {
      this.inTransaction = true;
      this.pendingVersion = null;
      return;
    }
    if (trimmed === 'COMMIT') {
      // `user_version` lives in the database header and is transactional, so it only becomes
      // visible on commit. Modelling that is the whole point of this double — a ladder that
      // set it outside the transaction would pass a mock that applied it eagerly.
      if (this.pendingVersion !== null) this.userVersion = this.pendingVersion;
      this.pendingVersion = null;
      this.inTransaction = false;
      return;
    }
    if (trimmed === 'ROLLBACK') {
      this.pendingVersion = null;
      this.inTransaction = false;
      return;
    }
    const version = /PRAGMA user_version\s*=\s*(\d+)/.exec(trimmed);
    if (version) {
      const next = Number(version[1]);
      if (this.inTransaction) this.pendingVersion = next;
      else this.userVersion = next;
    }
  }

  async getFirstAsync<T>(sql: string) {
    if (sql.includes('user_version')) return { user_version: this.userVersion } as T;
    return null as T;
  }

  async getAllAsync<T>() {
    return [...this.rows.values()] as T[];
  }

  async runAsync() {}

  async closeAsync() {
    this.closed = true;
  }
}

const mockOpened: MockDatabase[] = [];
let mockFailOnExec: string | null = null;
let mockStartVersion = 0;

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(async () => {
    const database = new MockDatabase();
    mockOpened.push(database);
    return database;
  }),
}));

// eslint-disable-next-line import/first -- must be required after `jest.mock` above.
import { DATABASE_VERSION, PlatformStorageAdapter } from '@/data/storage.native';

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
    mockStartVersion = 0;
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

describe('native storage migrations', () => {
  beforeEach(() => {
    mockOpened.length = 0;
    mockFailOnExec = null;
    mockStartVersion = 0;
  });

  const versionBumps = (database: MockDatabase) =>
    database.statements
      .map((sql) => /PRAGMA user_version\s*=\s*(\d+)/.exec(sql.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));

  /**
   * `[1, 2, … DATABASE_VERSION]`, derived rather than written out.
   *
   * Every added step would otherwise fail these two tests for the wrong reason — a literal
   * here asserts the ladder's *length*, which is not a property anyone cares about, and the
   * fix is to bump a number, which teaches you nothing. What matters is that the steps run
   * in order, none is skipped, and none repeats.
   */
  const ladder = Array.from({ length: DATABASE_VERSION }, (_, index) => index + 1);

  it('walks a fresh database up the whole ladder', async () => {
    await new PlatformStorageAdapter().initialize();

    expect(versionBumps(mockOpened[0])).toEqual(ladder);
    expect(mockOpened[0].userVersion).toBe(DATABASE_VERSION);
  });

  it('runs only the steps a database has not already seen', async () => {
    mockStartVersion = 1;
    await new PlatformStorageAdapter().initialize();

    // Re-running step 1 would be harmless (every statement is `IF NOT EXISTS`), but a ladder
    // that cannot skip is a ladder that gets slower with every release.
    expect(versionBumps(mockOpened[0])).toEqual(ladder.slice(1));
    expect(mockOpened[0].statements.some((sql) => sql.includes('sync_ops'))).toBe(true);
  });

  it('adds the revocation cutoff column and fails closed for existing revoked peers', async () => {
    mockStartVersion = 3;
    await new PlatformStorageAdapter().initialize();

    const migration = mockOpened[0].statements.find((sql) => sql.includes('revoked_seq'));
    expect(migration).toContain('ALTER TABLE sync_peers ADD COLUMN revoked_seq INTEGER');
    expect(migration).toContain(
      'UPDATE sync_peers SET revoked_seq = 0 WHERE revoked_at IS NOT NULL',
    );
    expect(mockOpened[0].userVersion).toBe(DATABASE_VERSION);
  });

  it('does nothing at all once the database is current', async () => {
    mockStartVersion = DATABASE_VERSION;
    await new PlatformStorageAdapter().initialize();

    expect(versionBumps(mockOpened[0])).toEqual([]);
    expect(mockOpened[0].statements.some((sql) => sql.trim() === 'BEGIN IMMEDIATE')).toBe(false);
  });

  it('leaves the version where it was when a step fails, and retries cleanly', async () => {
    mockStartVersion = 1;
    mockFailOnExec = 'sync_ops';

    await expect(new PlatformStorageAdapter().initialize()).rejects.toThrow('migration failed');
    const failed = mockOpened[0];
    // The bump was issued inside the transaction that rolled back, so it never landed. A
    // database that reported version 2 with no `sync_ops` table would never repair itself.
    expect(failed.userVersion).toBe(1);
    expect(failed.statements.some((sql) => sql.trim() === 'ROLLBACK')).toBe(true);
    expect(failed.closed).toBe(true);

    mockFailOnExec = null;
    await new PlatformStorageAdapter().initialize();
    expect(mockOpened[1].userVersion).toBe(DATABASE_VERSION);
  });

  it('sets the connection pragmas before touching the schema', async () => {
    await new PlatformStorageAdapter().initialize();

    // All three are per-connection, and this adapter deliberately keeps one connection so a
    // transaction inherits them. `busy_timeout` is what stops a lock contended by the WAL
    // checkpointer from failing outright.
    const [pragmas] = mockOpened[0].statements;
    expect(pragmas).toContain('journal_mode = WAL');
    expect(pragmas).toContain('foreign_keys = ON');
    expect(pragmas).toContain('busy_timeout = 5000');
  });
});

describe('native storage transactions', () => {
  beforeEach(() => {
    mockOpened.length = 0;
    mockFailOnExec = null;
    mockStartVersion = DATABASE_VERSION;
  });

  const ready = async () => {
    const adapter = new PlatformStorageAdapter();
    await adapter.initialize();
    mockOpened[0].statements.length = 0;
    return adapter;
  };

  it('brackets the work in BEGIN IMMEDIATE and COMMIT', async () => {
    const adapter = await ready();
    await adapter.transact(async (tx) => {
      await tx.putMany([stored('a')]);
    });

    const bookends = mockOpened[0].statements.map((sql) => sql.trim());
    expect(bookends[0]).toBe('BEGIN IMMEDIATE');
    expect(bookends.at(-1)).toBe('COMMIT');
  });

  it('rolls back and notifies nobody when the work throws', async () => {
    const adapter = await ready();
    const listener = jest.fn();
    adapter.subscribe(listener);

    await expect(
      adapter.transact(async (tx) => {
        await tx.putMany([stored('a')]);
        throw new Error('batch rejected');
      }),
    ).rejects.toThrow('batch rejected');

    expect(mockOpened[0].statements.map((sql) => sql.trim())).toContain('ROLLBACK');
    expect(listener).not.toHaveBeenCalled();
  });

  it('commits silently when asked', async () => {
    const adapter = await ready();
    const listener = jest.fn();
    adapter.subscribe(listener);

    await adapter.transact(async (tx) => {
      await tx.putMany([stored('a')]);
    }, { silent: true });

    expect(mockOpened[0].statements.map((sql) => sql.trim())).toContain('COMMIT');
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies nobody for a transaction that only read', async () => {
    const adapter = await ready();
    const listener = jest.fn();
    adapter.subscribe(listener);

    await adapter.transact((tx) => tx.readAll('accounts'));

    expect(mockOpened[0].statements.map((sql) => sql.trim())).toContain('COMMIT');
    expect(listener).not.toHaveBeenCalled();
  });

  it('serialises overlapping transactions rather than interleaving their statements', async () => {
    // One connection means an interleaved BEGIN would either error or silently join the
    // transaction already in flight, so both batches would commit or roll back together.
    const adapter = await ready();
    const order: string[] = [];

    await Promise.all([
      adapter.transact(async (tx) => {
        order.push('first:start');
        await tx.putMany([stored('a')]);
        order.push('first:end');
      }),
      adapter.transact(async (tx) => {
        order.push('second:start');
        await tx.putMany([stored('b')]);
        order.push('second:end');
      }),
    ]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });
});
