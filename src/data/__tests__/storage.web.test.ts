import 'fake-indexeddb/auto';

import { Dexie } from 'dexie';

import { PlatformStorageAdapter } from '@/data/storage.web';
import type { StoredEntity } from '@/data/storage-adapter';
import type { Account } from '@/domain/models';

// `liveQuery` notifications land asynchronously, so assertions about what the
// adapter did or did not report have to wait for the observable to settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

// Waiting a fixed slice is fine for "nothing should have happened" assertions, but
// a notification that *is* expected needs polling — the observable's latency varies
// with how loaded the run is.
async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the adapter to report a change.');
}

const account = (id: string, name: string, updatedAt: string): Account => ({
  id,
  name,
  type: 'checking',
  currency: 'USD',
  openingBalanceMinor: 0,
  icon: 'wallet.bifold',
  color: '#5966E9',
  archived: false,
  revision: 1,
  createdAt: updatedAt,
  updatedAt,
  deletedAt: null,
});

const stored = (entity: Account): StoredEntity => ({ type: 'accounts', entity });

const openAdapters: PlatformStorageAdapter[] = [];

function newAdapter() {
  const adapter = new PlatformStorageAdapter();
  openAdapters.push(adapter);
  return adapter;
}

async function freshAdapter() {
  await Dexie.delete('qashy');
  const adapter = newAdapter();
  await adapter.initialize();
  return adapter;
}

describe('web storage adapter', () => {
  afterEach(async () => {
    // Release each adapter's liveQuery subscription before dropping the database,
    // otherwise the observable keeps the process alive after the run.
    await Promise.all(openAdapters.splice(0).map((adapter) => adapter.dispose()));
    await Dexie.delete('qashy');
  });

  it('round-trips records and orders them by the shared comparator', async () => {
    const adapter = await freshAdapter();
    await adapter.putMany([
      stored(account('b', 'Later', '2026-02-01T00:00:00.000Z')),
      stored(account('a', 'Earlier', '2026-01-01T00:00:00.000Z')),
    ]);

    const rows = await adapter.readAll('accounts');
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
    expect(await adapter.readAll('categories')).toEqual([]);
  });

  it('refuses reads and writes before initialize(), matching the native adapter', async () => {
    await Dexie.delete('qashy');
    const adapter = newAdapter();

    // Dexie would otherwise `autoOpen` here and silently succeed against a
    // database whose change subscription was never wired up.
    await expect(adapter.readAll('accounts')).rejects.toThrow('has not been initialized');
    await expect(adapter.putMany([stored(account('a', 'A', '2026-01-01T00:00:00.000Z'))]))
      .rejects.toThrow('has not been initialized');
  });

  it('opens once even when initialize() is called repeatedly and concurrently', async () => {
    await Dexie.delete('qashy');
    const adapter = newAdapter();
    await Promise.all([adapter.initialize(), adapter.initialize(), adapter.initialize()]);
    await adapter.initialize();

    await adapter.putMany([stored(account('a', 'A', '2026-01-01T00:00:00.000Z'))]);
    expect(await adapter.readAll('accounts')).toHaveLength(1);
  });

  it('applies a batch atomically, leaving nothing behind when one record fails', async () => {
    const adapter = await freshAdapter();
    await adapter.putMany([stored(account('a', 'Committed', '2026-01-01T00:00:00.000Z'))]);

    const poisoned = {
      type: 'accounts' as const,
      // A function cannot be structured-cloned into IndexedDB, so this row makes
      // `bulkPut` throw part-way through the batch.
      entity: { ...account('c', 'Doomed', '2026-03-01T00:00:00.000Z'), color: () => '#fff' } as unknown as Account,
    };

    await expect(adapter.putMany([
      stored(account('b', 'Should roll back', '2026-02-01T00:00:00.000Z')),
      poisoned,
    ])).rejects.toThrow();

    const rows = await adapter.readAll('accounts');
    expect(rows.map((row) => row.id)).toEqual(['a']);
  });

  it('does not report the adapter’s own writes as external changes', async () => {
    const adapter = await freshAdapter();
    const sources: (object | undefined)[] = [];
    adapter.subscribe((source) => sources.push(source));
    await settle();

    const owner = {};
    await adapter.putMany([stored(account('a', 'A', '2026-01-01T00:00:00.000Z'))], owner);
    await settle();

    // Exactly one notification, carrying the source, so the repository's
    // `source === this` filter can drop it. The `liveQuery` echo of the same write
    // used to arrive sourceless and force a full re-hydrate after every mutation.
    expect(sources).toEqual([owner]);
  });

  it('still reports changes written by another tab', async () => {
    const adapter = await freshAdapter();
    const sources: (object | undefined)[] = [];
    adapter.subscribe((source) => sources.push(source));
    await settle();

    // A second connection to the same database stands in for another tab.
    const other = new Dexie('qashy');
    other.version(1).stores({ records: '&key, type, entityId, updatedAt, deletedAt' });
    await other.open();
    await other.table('records').put({
      key: 'accounts:x',
      type: 'accounts',
      entityId: 'x',
      payload: account('x', 'From another tab', '2026-04-01T00:00:00.000Z'),
      updatedAt: '2026-04-01T00:00:00.000Z',
      deletedAt: null,
    });
    await waitFor(() => sources.includes(undefined));
    other.close();

    expect(sources).toContainEqual(undefined);
    expect(await adapter.readAll('accounts')).toHaveLength(1);
  });

  it('clears every record', async () => {
    const adapter = await freshAdapter();
    await adapter.putMany([
      stored(account('a', 'A', '2026-01-01T00:00:00.000Z')),
      stored(account('b', 'B', '2026-02-01T00:00:00.000Z')),
    ]);

    await adapter.clear();
    expect(await adapter.readAll('accounts')).toEqual([]);
  });
});
