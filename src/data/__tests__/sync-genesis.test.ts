/**
 * Turning a pre-sync vault into an op log.
 *
 * The load-bearing assertion is the round trip: the ops genesis produces must fold back into
 * exactly the records they came from. Genesis is a re-description of the vault, and a
 * re-description that drifts by one field is a field this device would push to a peer as an
 * edit the user never made.
 *
 * Byte-identity is not the right shape for that assertion, because `revision` and `updatedAt`
 * are derived locally and deliberately never travel. Running the real apply pipeline —
 * project, repair, finalize — and asserting `changed === false` for every entity is the same
 * claim stated correctly, and it exercises the path that will actually run rather than a
 * simplified stand-in for it.
 */

import { MemoryStorageAdapter } from '@/data/memory-storage';
import type { StorageAdapter, StoredEntity } from '@/data/storage-adapter';
import { runGenesisMigration } from '@/data/sync-genesis';
import { SYNC_META, fromOpRow } from '@/data/sync-store';
import { SyncingStorageAdapter } from '@/data/syncing-storage-adapter';
import type {
  Account,
  AppSettings,
  Budget,
  BudgetPeriodSnapshot,
  Category,
  EntityType,
  ExchangeRate,
  FinanceEntity,
  Goal,
  GoalContribution,
  RecurringRule,
  Tag,
  TransactionRecord,
} from '@/domain/models';
import {
  GENESIS_HASH,
  applyOps,
  finalize,
  materialize,
  metaKey,
  parseHlc,
  repairMergedState,
  verifyChain,
  type CausalMeta,
} from '@/sync/oplog';
import {
  DEVICE_A,
  account,
  budget,
  budgetPeriod,
  category,
  contribution,
  exchangeRate,
  goal,
  recurringRule,
  settings,
  tag,
  transaction,
} from '@/sync/oplog/__tests__/helpers';

const NOW_ISO = '2026-06-01T12:00:00.000Z';

const stored = (type: EntityType, entity: FinanceEntity): StoredEntity => ({ type, entity });

/** One row of every type genesis walks, including the `settings` singleton. */
const wholeVault = (): StoredEntity[] => [
  stored('settings', settings()),
  stored('accounts', account({ id: 'acc-1', createdAt: '2026-01-02T00:00:00.000Z' })),
  stored('accounts', account({ id: 'acc-2', name: 'Savings', currency: 'ILS' })),
  stored('categories', category({ id: 'cat-1' })),
  stored('tags', tag({ id: 'tag-1' })),
  stored(
    'transactions',
    transaction({ id: 'txn-1', accountId: 'acc-1', categoryId: 'cat-1', tagIds: ['tag-1'] }),
  ),
  stored('budgets', budget({ id: 'bud-1', filters: { accountIds: ['acc-1'], categoryIds: ['cat-1'], tagIds: [] }, categoryLimits: [{ categoryId: 'cat-1', limitMinor: 20_000 }] })),
  stored('budgetPeriods', budgetPeriod({ id: 'bud-1:2026-01-01', budgetId: 'bud-1' })),
  stored('goals', goal({ id: 'goal-1', linkedAccountId: 'acc-2' })),
  stored('contributions', contribution({ id: 'con-1', goalId: 'goal-1' })),
  stored('recurringRules', recurringRule({ id: 'rec-1' })),
  stored('exchangeRates', exchangeRate({ id: 'rate-1' })),
];

const readOps = async (adapter: StorageAdapter) => {
  const rows = await adapter.transact((tx) => tx.table('syncOps').all());
  return [...rows].sort((first, second) => first.seq - second.seq).map(fromOpRow);
};

/**
 * The apply pipeline, in the order `applyRemoteOpsNow` runs it.
 *
 * Repair sits between projection and finalize for a reason: `pausedByDependency` is derived
 * rather than merged, so a projection on its own is legitimately incomplete. Comparing
 * before the repair has had its say would report a change on every recurring rule forever.
 */
function projectAndRepair(
  states: ReadonlyMap<string, CausalMeta>,
  vault: readonly StoredEntity[],
): Map<string, FinanceEntity> {
  const byKey = new Map(
    vault.map((record) => [metaKey(record.type, record.entity.id), record.entity]),
  );
  const projected = [...states].flatMap(([key, meta]) => {
    const entity = materialize(meta, byKey.get(key) ?? null);
    return entity ? [{ type: meta.entityType, entity }] : [];
  });
  const of = <T extends FinanceEntity>(type: EntityType): T[] =>
    projected.filter((record) => record.type === type).map((record) => record.entity as T);

  const repaired = repairMergedState({
    settings: of<AppSettings>('settings')[0] ?? null,
    accounts: of<Account>('accounts'),
    categories: of<Category>('categories'),
    tags: of<Tag>('tags'),
    transactions: of<TransactionRecord>('transactions'),
    budgets: of<Budget>('budgets'),
    budgetPeriods: of<BudgetPeriodSnapshot>('budgetPeriods'),
    goals: of<Goal>('goals'),
    contributions: of<GoalContribution>('contributions'),
    recurringRules: of<RecurringRule>('recurringRules'),
    exchangeRates: of<ExchangeRate>('exchangeRates'),
  });

  const settled = new Map<string, FinanceEntity>();
  const collect = (type: EntityType, entities: readonly FinanceEntity[]) => {
    for (const entity of entities) settled.set(metaKey(type, entity.id), entity);
  };
  if (repaired.settings) collect('settings', [repaired.settings]);
  collect('accounts', repaired.accounts);
  collect('categories', repaired.categories);
  collect('tags', repaired.tags);
  collect('transactions', repaired.transactions);
  collect('budgets', repaired.budgets);
  collect('budgetPeriods', repaired.budgetPeriods);
  collect('goals', repaired.goals);
  collect('contributions', repaired.contributions);
  collect('recurringRules', repaired.recurringRules);
  collect('exchangeRates', repaired.exchangeRates);
  return settled;
}

const runGenesis = (adapter: StorageAdapter, deviceId = DEVICE_A) =>
  adapter.transact((tx) => runGenesisMigration(tx, deviceId, NOW_ISO), { silent: true });

async function seeded(records: StoredEntity[]) {
  const adapter = new MemoryStorageAdapter();
  await adapter.initialize();
  if (records.length) await adapter.putMany(records);
  return adapter;
}

describe('genesis migration', () => {
  it('re-describes the whole vault, losing nothing', async () => {
    const records = wholeVault();
    const adapter = await seeded(records);

    const result = await runGenesis(adapter);
    expect(result.ran).toBe(true);
    expect(result.entityCount).toBe(records.length);

    const settled = projectAndRepair(applyOps(new Map(), await readOps(adapter)), records);
    expect(settled.size).toBe(records.length);

    for (const { type, entity } of records) {
      const next = settled.get(metaKey(type, entity.id));
      expect(next).toBeDefined();
      // `changed: false` is the round trip: every field came back identical, so applying
      // genesis' own ops writes nothing at all.
      expect(finalize(next!, entity)).toEqual({ entity, changed: false });
    }
  });

  it('seeds each op from the entity’s own createdAt, not from now', async () => {
    const created = '2025-03-04T05:06:07.000Z';
    const adapter = await seeded([stored('accounts', account({ id: 'acc-1', createdAt: created }))]);

    await runGenesis(adapter);

    const [op] = await readOps(adapter);
    // Stamping everything "now" would be correct but useless: two paired vaults would arrive
    // as one flat wall of simultaneous creates and every tie would fall to device id.
    expect(parseHlc(op.hlc).wall).toBe(Date.parse(created));
  });

  it('gives entities sharing a createdAt distinct clock readings', async () => {
    // A seeded starter category set, or a CSV import, writes many rows in one millisecond.
    const adapter = await seeded([
      stored('categories', category({ id: 'cat-1', name: 'Groceries' })),
      stored('categories', category({ id: 'cat-2', name: 'Rent' })),
      stored('accounts', account({ id: 'acc-1' })),
    ]);

    await runGenesis(adapter);

    const ops = await readOps(adapter);
    expect(new Set(ops.map((op) => op.hlc)).size).toBe(ops.length);
  });

  it('converts a tombstone to create-then-delete', async () => {
    const deleted = {
      ...transaction({ id: 'txn-1', occurrenceKey: 'rec-1:2026-01-01' }),
      deletedAt: '2026-02-01T00:00:00.000Z',
    };
    const adapter = await seeded([stored('transactions', deleted)]);

    await runGenesis(adapter);

    const ops = await readOps(adapter);
    expect(ops.map((op) => op.kind)).toEqual(['create', 'delete']);
    // Dropping the delete would resurrect every transaction the user ever deleted:
    // `hydrateFromStorage` rebuilds `deletedOccurrenceKeys` from tombstones, so a lost
    // tombstone means the recurrence regenerates on the next foreground, forever.
    const meta = applyOps(new Map(), ops).get(metaKey('transactions', 'txn-1'));
    expect(materialize(meta!, deleted)?.deletedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('runs once, even if the marker is the only thing that survived', async () => {
    const adapter = await seeded(wholeVault());

    const first = await runGenesis(adapter);
    const before = await readOps(adapter);

    const second = await runGenesis(adapter);
    expect(second).toEqual({ ran: false, opCount: 0, entityCount: 0 });
    expect(await readOps(adapter)).toEqual(before);

    // And the guard still holds with the marker gone — a partial restore must not be able to
    // issue a second, parallel set of creates for entities that already have them.
    await adapter.transact((tx) => tx.table('syncMeta').delete([SYNC_META.genesisAt]), {
      silent: true,
    });
    expect(await runGenesis(adapter)).toEqual({ ran: false, opCount: 0, entityCount: 0 });
    expect(await readOps(adapter)).toHaveLength(first.opCount);
  });

  it('marks a fresh install without walking every table again', async () => {
    const adapter = await seeded([]);

    expect(await runGenesis(adapter)).toEqual({ ran: false, opCount: 0, entityCount: 0 });

    const marker = await adapter.transact((tx) => tx.table('syncMeta').get(SYNC_META.genesisAt));
    expect(marker?.value).toBe(NOW_ISO);
  });

  it('leaves a chain the first local write continues rather than restarts', async () => {
    const adapter = await seeded(wholeVault());
    const genesis = await runGenesis(adapter);

    const syncing = new SyncingStorageAdapter(adapter, DEVICE_A, () => Date.parse(NOW_ISO));
    await syncing.putMany([stored('accounts', account({ id: 'acc-3', name: 'Cash tin' }))]);

    const ops = await readOps(adapter);
    expect(ops).toHaveLength(genesis.opCount + 1);
    // One unbroken history from the first genesis op through the first real edit — a peer
    // verifies the whole thing in one pass, and a restart here would read as a fork.
    expect(verifyChain(ops, { seq: 0, headHash: GENESIS_HASH }).seq).toBe(ops.length);

    const last = ops[ops.length - 1];
    // The clock resumed from the newest genesis reading, so the edit sorts after everything
    // genesis described instead of into the middle of it.
    expect(last.hlc > ops[ops.length - 2].hlc).toBe(true);
  });
});
