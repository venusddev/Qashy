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

    // A second adapter over the same database stands in for another tab — which is exactly
    // what one is. Echo suppression keys on the writer's instance id, so the other tab has to
    // be a real adapter rather than a bare Dexie connection: a foreign write that never
    // stamps `lastWrite` is, correctly, not something this tab can hear about.
    const other = newAdapter();
    await other.initialize();
    await other.putMany([stored(account('x', 'From another tab', '2026-04-01T00:00:00.000Z'))]);

    await waitFor(() => sources.includes(undefined));
    expect(sources).toContainEqual(undefined);
    expect(await adapter.readAll('accounts')).toHaveLength(1);
  });

  it('reports a foreign write once, not once per record in it', async () => {
    // The old mechanism projected every row in `records` on every change and diffed the
    // result. This one reads a single indexed row, so batch size stops mattering.
    const adapter = await freshAdapter();
    const sources: (object | undefined)[] = [];
    adapter.subscribe((source) => sources.push(source));
    await settle();

    const other = newAdapter();
    await other.initialize();
    await other.putMany(
      Array.from({ length: 25 }, (_, index) =>
        stored(account(`b${index}`, `B${index}`, '2026-05-01T00:00:00.000Z')),
      ),
    );

    await waitFor(() => sources.includes(undefined));
    await settle();
    expect(sources.filter((source) => source === undefined)).toHaveLength(1);
  });

  it('keeps records written before the sync tables existed', async () => {
    // The v1 → v2 upgrade adds stores and one compound index; no existing row changes shape,
    // so there is no `upgrade()` callback to get wrong. This asserts that.
    await Dexie.delete('qashy');
    const v1 = new Dexie('qashy');
    v1.version(1).stores({ records: '&key, type, entityId, updatedAt, deletedAt' });
    await v1.open();
    await v1.table('records').put({
      key: 'accounts:legacy',
      type: 'accounts',
      entityId: 'legacy',
      payload: account('legacy', 'From before sync', '2026-01-01T00:00:00.000Z'),
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
    });
    v1.close();

    const adapter = newAdapter();
    await adapter.initialize();

    const rows = await adapter.readAll('accounts');
    expect(rows.map((row) => row.id)).toEqual(['legacy']);
    // And the new tables are usable in the same breath.
    await adapter.transact(async (tx) => {
      await tx.table('syncMeta').put([{ key: 'deviceId', value: 'D' }]);
    });
    const meta = await adapter.transact((tx) => tx.table('syncMeta').get('deviceId'));
    expect(meta?.value).toBe('D');
  });

  it('rolls back records and sync rows together when a transaction throws', async () => {
    const adapter = await freshAdapter();
    await adapter.transact(async (tx) => {
      await tx.table('syncMeta').put([{ key: 'seq', value: '1' }]);
    });

    await expect(
      adapter.transact(async (tx) => {
        await tx.putMany([stored(account('a', 'A', '2026-01-01T00:00:00.000Z'))]);
        await tx.table('syncMeta').put([{ key: 'seq', value: '2' }]);
        throw new Error('batch rejected');
      }),
    ).rejects.toThrow('batch rejected');

    // An op that commits without its record — or a record without its op — is the state the
    // whole transaction contract exists to make impossible.
    expect(await adapter.readAll('accounts')).toEqual([]);
    const seq = await adapter.transact((tx) => tx.table('syncMeta').get('seq'));
    expect(seq?.value).toBe('1');
  });

  it('commits silently without waking subscribers', async () => {
    const adapter = await freshAdapter();
    const sources: (object | undefined)[] = [];
    adapter.subscribe((source) => sources.push(source));
    await settle();

    await adapter.transact(
      async (tx) => {
        await tx.table('syncOps').put([
          {
            opId: 'D:1',
            deviceId: 'D',
            seq: 1,
            prevHash: '',
            opHash: 'h',
            hlc: '000000000000-0000-D',
            entityType: 'accounts',
            entityId: 'a',
            kind: 'create',
            payload: '{}',
            schema: 0,
            signature: 'sig',
            sealed: 1,
            origin: 0,
          },
        ]);
      },
      { silent: true },
    );
    await settle();

    // Sealing an op changes nothing any screen can render; notifying would cost every open
    // screen a re-render for a change it cannot see.
    expect(sources).toEqual([]);
    const ops = await adapter.transact((tx) => tx.table('syncOps').all());
    expect(ops).toHaveLength(1);
  });

  it('neither stamps nor notifies for a transaction that only read', async () => {
    // The `lastWrite` stamp is itself a write, so a read-only transaction that stamped would
    // wake every *other* tab as well as every screen in this one — for a change that did not
    // happen. Read-your-own-state is the sync engine's most common transaction shape.
    const adapter = await freshAdapter();
    await adapter.putMany([stored(account('a', 'A', '2026-01-01T00:00:00.000Z'))]);

    const before = await adapter.transact((tx) => tx.table('syncMeta').get('lastWrite'));
    const sources: (object | undefined)[] = [];
    adapter.subscribe((source) => sources.push(source));
    await settle();

    await adapter.transact((tx) => tx.readAll('accounts'));
    await settle();

    expect(sources).toEqual([]);
    const after = await adapter.transact((tx) => tx.table('syncMeta').get('lastWrite'));
    expect(after?.value).toBe(before?.value);
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
