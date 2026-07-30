import { MemoryStorageAdapter } from '@/data/memory-storage';
import { recordKey, type StoredEntity } from '@/data/storage-adapter';
import type { Account } from '@/domain/models';

/**
 * The in-memory adapter is the double every repository test runs against, so a behaviour it
 * gets wrong is a behaviour the whole suite believes. These pin it to what SQLite and
 * IndexedDB actually do.
 */
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

describe('MemoryStorageAdapter transactions', () => {
  it('writes nothing and notifies nobody for an empty batch', async () => {
    const adapter = new MemoryStorageAdapter();
    const listener = jest.fn();
    adapter.subscribe(listener);

    await adapter.putMany([]);
    expect(listener).not.toHaveBeenCalled();

    await adapter.putMany([stored('a')], {});
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('commits records and sync rows together', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.transact(async (tx) => {
      await tx.putMany([stored('a')]);
      await tx.table('syncMeta').put([{ key: 'seq', value: '1' }]);
    });

    expect(await adapter.readAll('accounts')).toHaveLength(1);
    const seq = await adapter.transact((tx) => tx.table('syncMeta').get('seq'));
    expect(seq?.value).toBe('1');
  });

  it('rolls both back when the work throws, and notifies nobody', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.transact(async (tx) => {
      await tx.table('syncMeta').put([{ key: 'seq', value: '1' }]);
    });
    const listener = jest.fn();
    adapter.subscribe(listener);

    await expect(
      adapter.transact(async (tx) => {
        await tx.putMany([stored('a')]);
        await tx.table('syncMeta').put([{ key: 'seq', value: '2' }]);
        throw new Error('batch rejected');
      }),
    ).rejects.toThrow('batch rejected');

    // A record without its op, or an op without its record, is precisely the state the
    // transaction contract exists to make impossible.
    expect(await adapter.readAll('accounts')).toEqual([]);
    const seq = await adapter.transact((tx) => tx.table('syncMeta').get('seq'));
    expect(seq?.value).toBe('1');
    expect(listener).not.toHaveBeenCalled();
  });

  it('reads its own writes inside the same transaction', async () => {
    const adapter = new MemoryStorageAdapter();
    const seen = await adapter.transact(async (tx) => {
      await tx.putMany([stored('a')]);
      return tx.readKeys([recordKey('accounts', 'a')]);
    });
    expect(seen.map((record) => record.entity.id)).toEqual(['a']);
  });

  it('omits misses from readKeys rather than returning holes', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putMany([stored('a')]);

    const found = await adapter.transact((tx) =>
      tx.readKeys([recordKey('accounts', 'a'), recordKey('accounts', 'missing')]),
    );
    expect(found).toHaveLength(1);
  });

  it('commits silently when asked', async () => {
    const adapter = new MemoryStorageAdapter();
    const listener = jest.fn();
    adapter.subscribe(listener);

    await adapter.transact(
      async (tx) => {
        await tx.table('syncQuarantine').put([
          {
            key: 'accounts:a',
            reason: 'overflow',
            detail: 'balance',
            hlc: '000000000000-0000-D',
            recordedAt: '2026-01-01T00:00:00.000Z',
          },
        ]);
      },
      { silent: true },
    );

    expect(listener).not.toHaveBeenCalled();
    const rows = await adapter.transact((tx) => tx.table('syncQuarantine').all());
    expect(rows).toHaveLength(1);
  });

  it('notifies nobody for a transaction that only read', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.putMany([stored('a')]);
    const listener = jest.fn();
    adapter.subscribe(listener);

    await adapter.transact((tx) => tx.readAll('accounts'));
    await adapter.transact((tx) => tx.table('syncMeta').get('seq'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('serialises overlapping transactions', async () => {
    const adapter = new MemoryStorageAdapter();
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
    expect(await adapter.readAll('accounts')).toHaveLength(2);
  });

  it('hands out copies, so a caller cannot edit the store by holding a row', async () => {
    const adapter = new MemoryStorageAdapter();
    await adapter.transact(async (tx) => {
      await tx.table('syncMeta').put([{ key: 'seq', value: '1' }]);
    });

    const row = await adapter.transact((tx) => tx.table('syncMeta').get('seq'));
    (row as { value: string }).value = 'tampered';

    const again = await adapter.transact((tx) => tx.table('syncMeta').get('seq'));
    expect(again?.value).toBe('1');
  });

  it('empties the sync tables along with the records on clear', async () => {
    // `resetAllData` wipes locally and unpairs. An op log left behind would describe entities
    // that no longer exist and replicate deletions this device never made.
    const adapter = new MemoryStorageAdapter();
    await adapter.transact(async (tx) => {
      await tx.putMany([stored('a')]);
      await tx.table('syncMeta').put([{ key: 'deviceId', value: 'D' }]);
      await tx.table('syncPeers').put([
        {
          peerId: 'P',
          name: 'Laptop',
          platform: 'web',
          signingKey: 'k',
          agreementKey: 'k',
          epoch: 1,
          addedAt: '2026-01-01T00:00:00.000Z',
          revokedAt: null,
          acked: '{}',
          known: '{}',
          lastSeenAt: null,
        },
      ]);
    });

    await adapter.clear();

    expect(await adapter.readAll('accounts')).toEqual([]);
    const [meta, peers] = await adapter.transact(async (tx) => [
      await tx.table('syncMeta').all(),
      await tx.table('syncPeers').all(),
    ]);
    expect(meta).toEqual([]);
    expect(peers).toEqual([]);
  });
});
