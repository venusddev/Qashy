/**
 * The decorator that turns a local write into ops.
 *
 * Two of these tests guard properties that are invisible in ordinary use and catastrophic
 * when broken: that a write made through `transact` emits *nothing* (otherwise a peer's
 * merged result comes back to it attributed to this device), and that two tabs sharing one
 * `deviceId` cannot fork the chain.
 */

import { MemoryStorageAdapter } from '@/data/memory-storage';
import type {
  StorageAdapter,
  StorageTx,
  StoredEntity,
  TransactOptions,
} from '@/data/storage-adapter';
import { SYNC_META, fromOpRow } from '@/data/sync-store';
import { SyncingStorageAdapter } from '@/data/syncing-storage-adapter';
import type { EntityType } from '@/domain/models';
import { GENESIS_HASH, verifyChain } from '@/sync/oplog';
import { DEVICE_A, account, category, transaction } from '@/sync/oplog/__tests__/helpers';

const stored = (type: EntityType, entity: StoredEntity['entity']): StoredEntity => ({ type, entity });

/** A fixed clock, so every HLC in this file is reproducible. */
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

const readOps = async (adapter: StorageAdapter) => {
  const rows = await adapter.transact((tx) => tx.table('syncOps').all());
  return [...rows].sort((first, second) => first.seq - second.seq);
};

const readMetaValue = (adapter: StorageAdapter, key: string) =>
  adapter.transact((tx) => tx.table('syncMeta').get(key));

/**
 * An adapter whose `records` write fails.
 *
 * The poisoned-entity trick the web suite uses would not work here: `canonicalJson` rejects a
 * function value, so the throw would land inside `diffRecords` — before anything was staged —
 * and prove nothing about rollback. Failing at `tx.putMany` is the one injection point that
 * lands *after* the ops are written, so it actually exercises the unwind.
 */
class RecordWritesFail implements StorageAdapter {
  constructor(private readonly inner: StorageAdapter) {}

  initialize() {
    return this.inner.initialize();
  }

  readAll(type: EntityType) {
    return this.inner.readAll(type);
  }

  putMany(records: StoredEntity[], source?: object) {
    return this.inner.putMany(records, source);
  }

  clear(source?: object) {
    return this.inner.clear(source);
  }

  subscribe(listener: (source?: object) => void) {
    return this.inner.subscribe?.(listener) ?? (() => undefined);
  }

  transact<T>(work: (tx: StorageTx) => Promise<T>, options?: TransactOptions): Promise<T> {
    return this.inner.transact(
      (tx) =>
        work({
          readAll: (type) => tx.readAll(type),
          readKeys: (keys) => tx.readKeys(keys),
          async putMany() {
            throw new Error('disk full');
          },
          deleteKeys: (keys) => tx.deleteKeys(keys),
          clearRecords: () => tx.clearRecords(),
          table(name) {
            return tx.table(name);
          },
        }),
      options,
    );
  }
}

describe('syncing storage adapter', () => {
  let inner: MemoryStorageAdapter;
  let adapter: SyncingStorageAdapter;

  beforeEach(async () => {
    inner = new MemoryStorageAdapter();
    adapter = new SyncingStorageAdapter(inner, DEVICE_A, () => NOW);
    await adapter.initialize();
  });

  it('records a create beside the record it describes', async () => {
    await adapter.putMany([stored('accounts', account({ id: 'acc-1', name: 'Checking' }))]);

    expect(await adapter.readAll('accounts')).toHaveLength(1);

    const ops = await readOps(adapter);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      opId: `${DEVICE_A}:1`,
      deviceId: DEVICE_A,
      seq: 1,
      prevHash: GENESIS_HASH,
      entityType: 'accounts',
      entityId: 'acc-1',
      kind: 'create',
      origin: 0,
    });
  });

  it('leaves the op unsealed, for the background sealer to sign', async () => {
    await adapter.putMany([stored('accounts', account({ id: 'acc-1' }))]);

    const [op] = await readOps(adapter);
    // Signing inside the transaction is not merely slow — it is forbidden. Awaiting a
    // signature would leave Dexie's promise zone and let IndexedDB commit underneath.
    expect(op.signature).toBe('');
    expect(op.sealed).toBe(0);
  });

  it('emits a set rather than a second create when a record changes', async () => {
    const before = account({ id: 'acc-1', name: 'Checking' });
    await adapter.putMany([stored('accounts', before)]);
    await adapter.putMany([stored('accounts', { ...before, name: 'Everyday', revision: 2 })]);

    const ops = await readOps(adapter);
    expect(ops.map((op) => op.kind)).toEqual(['create', 'set']);
    expect(JSON.parse(ops[1].payload)).toEqual({ registers: { name: { name: 'Everyday' } } });
  });

  it('emits nothing when a write changes nothing that syncs', async () => {
    const entity = account({ id: 'acc-1' });
    await adapter.putMany([stored('accounts', entity)]);

    // `revision` and `updatedAt` are derived — they are recomputed locally on every device and
    // are deliberately not on the wire, so bumping them alone is not a change.
    await adapter.putMany([
      stored('accounts', { ...entity, revision: 7, updatedAt: '2026-09-09T00:00:00.000Z' }),
    ]);

    expect(await readOps(adapter)).toHaveLength(1);
    const seq = await readMetaValue(adapter, SYNC_META.seq);
    expect(seq?.value).toBe('1');
  });

  it('chains every op into a history a peer can verify', async () => {
    await adapter.putMany([
      stored('accounts', account({ id: 'acc-1' })),
      stored('categories', category({ id: 'cat-1' })),
    ]);
    await adapter.putMany([stored('accounts', account({ id: 'acc-1', name: 'Renamed' }))]);

    const ops = (await readOps(adapter)).map(fromOpRow);
    const head = verifyChain(ops, { seq: 0, headHash: GENESIS_HASH });

    expect(head.seq).toBe(ops.length);
    // `sync_meta` is what the *next* write chains onto, so it has to agree with the log
    // exactly — a disagreement is a fork that only a peer would ever notice.
    const seq = await readMetaValue(adapter, SYNC_META.seq);
    const headHash = await readMetaValue(adapter, SYNC_META.headHash);
    expect(seq?.value).toBe(String(head.seq));
    expect(headHash?.value).toBe(head.headHash);
  });

  it('records nothing for a write made through transact', async () => {
    // The regression test for `applyRemoteOpsNow`. Capturing here would re-diff a peer's
    // merged result and emit *local* ops attributing the peer's change to this device, which
    // would then replicate back as though this device had made them.
    await adapter.transact((tx) =>
      tx.putMany([stored('accounts', account({ id: 'acc-1', name: 'From a peer' }))]),
    );

    expect(await adapter.readAll('accounts')).toHaveLength(1);
    expect(await readOps(adapter)).toEqual([]);
  });

  it('lets two tabs sharing a device id write without forking the chain', async () => {
    // Two tabs are two adapters over one database with one `deviceId`. If either allocated
    // `seq` from memory they would both claim the same number with different `prevHash` —
    // a fork a correct peer must reject outright.
    const tabB = new SyncingStorageAdapter(inner, DEVICE_A, () => NOW);

    await Promise.all([
      adapter.putMany([stored('accounts', account({ id: 'acc-1' }))]),
      tabB.putMany([stored('accounts', account({ id: 'acc-2' }))]),
    ]);

    const ops = (await readOps(adapter)).map(fromOpRow);
    expect(ops.map((op) => op.seq)).toEqual([1, 2]);
    expect(new Set(ops.map((op) => op.hlc)).size).toBe(2);
    expect(() => verifyChain(ops, { seq: 0, headHash: GENESIS_HASH })).not.toThrow();
  });

  it('writes nothing at all for an empty batch', async () => {
    const sources: (object | undefined)[] = [];
    adapter.subscribe((source) => sources.push(source));

    await adapter.putMany([]);

    expect(await readOps(adapter)).toEqual([]);
    expect(sources).toEqual([]);
  });

  it('warns about an immutable field instead of silently syncing it', async () => {
    const warnings: string[][] = [];
    adapter.onDiffWarning((next) => warnings.push([...next]));

    const before = transaction({ id: 'txn-1', occurrenceKey: 'rule-1:2026-01-01' });
    await adapter.putMany([stored('transactions', before)]);
    await adapter.putMany([
      stored('transactions', { ...before, occurrenceKey: 'rule-1:2026-02-01' }),
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toContain('occurrenceKey');
    // Peers keep the value they agreed on at create time; the local row is the one in the
    // wrong, so there is nothing to send.
    expect(await readOps(adapter)).toHaveLength(1);
  });

  it('records the base currency without waking any screen', async () => {
    const sources: (object | undefined)[] = [];
    adapter.subscribe((source) => sources.push(source));

    await adapter.setBaseCurrency('ILS');

    const value = await readMetaValue(adapter, SYNC_META.baseCurrency);
    expect(value?.value).toBe('ILS');
    expect(sources).toEqual([]);
  });

  it('emits no ops for a local wipe', async () => {
    await adapter.putMany([stored('accounts', account({ id: 'acc-1' }))]);
    await adapter.clear();

    // A "delete everything" op would be a weapon: one compromised paired device could destroy
    // every peer's data with a single message. Reset unpairs instead.
    expect(await adapter.readAll('accounts')).toEqual([]);
    expect(await readOps(adapter)).toEqual([]);
  });

  it('rolls the ops back with the records when the write fails', async () => {
    const failing = new SyncingStorageAdapter(new RecordWritesFail(inner), DEVICE_A, () => NOW);

    await expect(
      failing.putMany([stored('accounts', account({ id: 'acc-1' }))]),
    ).rejects.toThrow('disk full');

    // An op describing a record that was never written is a change this device would
    // broadcast but not itself hold — the exact divergence the transaction contract exists
    // to make impossible.
    expect(await inner.readAll('accounts')).toEqual([]);
    expect(await readOps(inner)).toEqual([]);
    expect(await readMetaValue(inner, SYNC_META.seq)).toBeUndefined();
  });
});
