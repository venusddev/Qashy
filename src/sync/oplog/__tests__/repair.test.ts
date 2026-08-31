/**
 * The repair pass has one requirement above every individual rule: two devices holding the
 * same merged set must compute the *identical* repair, because repair emits no ops and
 * nothing propagates its result. A pass that depended on iteration order, a clock, or a
 * locale would leave two converged devices writing different records with nothing left to
 * reconcile them — permanent divergence produced by the very thing meant to prevent it.
 *
 * So determinism is asserted first, and the per-rule suites exist to pin what the
 * deterministic answer actually is.
 */

import type { EntityType } from '@/domain/models';
import { canonicalJson } from '@/utils/canonical-json';
import { repairMergedState, type RepairInput, type RepairOutput } from '@/sync/oplog/repair';
import {
  account,
  budget,
  budgetPeriod,
  category,
  contribution,
  exchangeRate,
  goal,
  recurringRule,
  seededRandom,
  shuffled,
  tag,
  transaction,
} from '@/sync/oplog/__tests__/helpers';

const input = (over: Partial<RepairInput> = {}): RepairInput => ({
  settings: null,
  accounts: [],
  categories: [],
  tags: [],
  transactions: [],
  budgets: [],
  budgetPeriods: [],
  goals: [],
  contributions: [],
  recurringRules: [],
  exchangeRates: [],
  ...over,
});

const codes = (output: RepairOutput) => output.notes.map((note) => note.code);

const changedKeys = (output: RepairOutput) =>
  output.changed.map((record) => `${record.type}:${record.entity.id}`);

const find = <T extends { id: string }>(entities: readonly T[], id: string) =>
  entities.find((entity) => entity.id === id)!;

const TYPES: readonly EntityType[] = [
  'accounts',
  'categories',
  'tags',
  'transactions',
  'budgets',
  'budgetPeriods',
  'goals',
  'contributions',
  'recurringRules',
  'exchangeRates',
];

/**
 * Everything a device would write, in an order it does not control.
 *
 * The entity arrays come back in whatever order they went in — `repairMergedState` is not a
 * sort — so they are sorted here. `changed` and `notes` are not: their order is the pass's
 * own output, and it is expected to be pinned.
 */
const stable = (output: RepairOutput) =>
  canonicalJson({
    entities: TYPES.map((type) =>
      [...((output as unknown as Record<string, readonly { id: string }[]>)[type] ?? [])].sort(
        (first, second) => (first.id < second.id ? -1 : 1),
      ),
    ),
    changed: output.changed,
    notes: output.notes,
  });

// ---------------------------------------------------------------------------
// Determinism — the property every other suite rests on
// ---------------------------------------------------------------------------

/** One set that exercises every pass at once, including the interactions between them. */
const TANGLED = input({
  accounts: [
    account({ id: 'acc-1', currency: 'USD' }),
    account({ id: 'acc-2', deletedAt: '2026-02-01T00:00:00.000Z' }),
    account({ id: 'acc-3' }),
  ],
  categories: [
    category({ id: 'cat-1', name: 'Groceries' }),
    category({ id: 'cat-2', name: 'groceries' }),
    category({ id: 'cat-3', name: 'Salary', kind: 'income', parentId: 'cat-1' }),
  ],
  tags: [tag({ id: 'tag-1', name: 'Essential' }), tag({ id: 'tag-2', name: 'essential' })],
  transactions: [
    transaction({ id: 'txn-1', accountId: 'acc-2', currency: 'ILS', categoryId: 'cat-3' }),
    transaction({ id: 'txn-2', occurrenceKey: 'rule-1:2026-02-01', tagIds: ['gone'] }),
    transaction({ id: 'txn-3', occurrenceKey: 'rule-1:2026-02-01' }),
    transaction({ id: 'txn-4', occurrenceKey: 'rule-1:2026-02-01' }),
  ],
  budgets: [
    budget({
      id: 'bud-1',
      filters: { accountIds: ['missing'], categoryIds: ['cat-1'], tagIds: [] },
      categoryLimits: [
        { categoryId: 'cat-1', limitMinor: 100 },
        { categoryId: 'cat-9', limitMinor: 200 },
      ],
      period: { unit: 'month', interval: 1, anchorDate: '2026-01-01', endDate: '2026-12-31' },
    }),
  ],
  goals: [goal({ id: 'goal-1', linkedAccountId: 'gone', linkedCategoryId: 'cat-1' })],
  contributions: [
    contribution({ id: 'con-1', goalId: 'goal-1', transactionId: 'gone' }),
    contribution({ id: 'con-2', goalId: 'vanished' }),
  ],
  recurringRules: [recurringRule({ id: 'rule-1', nextDueDate: '2025-06-01' })],
  exchangeRates: [
    exchangeRate({ id: 'rate-1' }),
    exchangeRate({ id: 'rate-2' }),
    exchangeRate({ id: 'rate-3', effectiveDate: '2026-02-01' }),
  ],
});

const shuffle = (source: RepairInput, random: () => number): RepairInput => ({
  settings: source.settings,
  accounts: shuffled(source.accounts, random),
  categories: shuffled(source.categories, random),
  tags: shuffled(source.tags, random),
  transactions: shuffled(source.transactions, random),
  budgets: shuffled(source.budgets, random),
  budgetPeriods: shuffled(source.budgetPeriods, random),
  goals: shuffled(source.goals, random),
  contributions: shuffled(source.contributions, random),
  recurringRules: shuffled(source.recurringRules, random),
  exchangeRates: shuffled(source.exchangeRates, random),
});

describe('determinism', () => {
  it('produces the same repair however the merged set was ordered', () => {
    // Two devices materialize the same entities from the same ops and then read them back in
    // whatever order their storage index returns. That must not be observable in the result.
    const expected = stable(repairMergedState(TANGLED));
    const random = seededRandom(20_260_729);
    for (let round = 0; round < 60; round += 1) {
      expect(stable(repairMergedState(shuffle(TANGLED, random)))).toBe(expected);
    }
  });

  it('is a no-op on its own output', () => {
    // Not merely tidy: repair runs on every merge, and a pass that kept finding work would
    // rewrite records — bumping their revision each time — forever.
    const once = repairMergedState(TANGLED);
    const twice = repairMergedState(once);
    expect(twice.changed).toEqual([]);
    expect(twice.notes).toEqual([]);
  });

  it('does not mutate its input', () => {
    const before = canonicalJson(TANGLED);
    repairMergedState(TANGLED);
    expect(canonicalJson(TANGLED)).toBe(before);
  });

  it('reports every changed record exactly once, in a pinned order', () => {
    const changed = changedKeys(repairMergedState(TANGLED));
    expect(changed).toEqual([...changed].sort());
    expect(new Set(changed).size).toBe(changed.length);
  });

  it('leaves an already-valid set completely alone', () => {
    const clean = input({
      accounts: [account({ id: 'acc-1' })],
      categories: [category({ id: 'cat-1' })],
      transactions: [transaction({ id: 'txn-1', accountId: 'acc-1', categoryId: 'cat-1' })],
    });
    const output = repairMergedState(clean);
    expect(output.changed).toEqual([]);
    expect(output.notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('duplicate collapse', () => {
  const occurrence = (id: string, updatedAt = '2026-02-01T00:00:00.000Z') =>
    transaction({ id, occurrenceKey: 'rule-1:2026-02-01', updatedAt });

  it('keeps the lowest id and tombstones the rest', () => {
    const output = repairMergedState(
      input({ transactions: [occurrence('txn-b'), occurrence('txn-a')] }),
    );
    expect(find(output.transactions, 'txn-a').deletedAt).toBeNull();
    expect(find(output.transactions, 'txn-b').deletedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(codes(output)).toEqual(['duplicateOccurrence']);
  });

  it('clears the occurrence key before tombstoning the loser', () => {
    // `hydrateFromStorage` rebuilds its recurrence-suppression set from tombstoned occurrence
    // keys, so a tombstone that kept the key would permanently stop the *survivor* from ever
    // being regenerated.
    const output = repairMergedState(
      input({ transactions: [occurrence('txn-a'), occurrence('txn-b')] }),
    );
    expect(find(output.transactions, 'txn-b')).toMatchObject({
      occurrenceKey: null,
      deletedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(find(output.transactions, 'txn-a').occurrenceKey).toBe('rule-1:2026-02-01');
  });

  it('dates the tombstone from the record, never from a clock', () => {
    // A `nowIso()` here would give two devices two different `deletedAt` values for the same
    // row, and the repair would never settle.
    const output = repairMergedState(
      input({
        transactions: [occurrence('txn-a'), occurrence('txn-b', '2026-09-09T09:09:09.009Z')],
      }),
    );
    expect(find(output.transactions, 'txn-b').deletedAt).toBe('2026-09-09T09:09:09.009Z');
  });

  it('ignores transactions with no occurrence key', () => {
    const output = repairMergedState(
      input({ transactions: [transaction({ id: 'txn-a' }), transaction({ id: 'txn-b' })] }),
    );
    expect(output.changed).toEqual([]);
  });

  it('ignores rows that are already tombstoned', () => {
    const output = repairMergedState(
      input({
        transactions: [
          occurrence('txn-a'),
          { ...occurrence('txn-b'), deletedAt: '2026-03-01T00:00:00.000Z' },
        ],
      }),
    );
    expect(output.changed).toEqual([]);
  });

  it('collapses two snapshots of one budget period', () => {
    // Two rows make the history sort tie, `.at(-1)` pick arbitrarily, and the rollover carried
    // into the next period differ between devices — a wrong number, not a crash.
    const output = repairMergedState(
      input({
        budgetPeriods: [
          budgetPeriod({ id: 'per-b', rolloverMinor: 500 }),
          budgetPeriod({ id: 'per-a', rolloverMinor: 900 }),
        ],
      }),
    );
    expect(find(output.budgetPeriods, 'per-a').deletedAt).toBeNull();
    expect(find(output.budgetPeriods, 'per-b').deletedAt).not.toBeNull();
    expect(codes(output)).toEqual(['duplicateSnapshot']);
  });

  it('keeps snapshots of different periods', () => {
    const output = repairMergedState(
      input({
        budgetPeriods: [
          budgetPeriod({ id: 'per-a', periodStart: '2026-01-01' }),
          budgetPeriod({ id: 'per-b', periodStart: '2026-02-01' }),
        ],
      }),
    );
    expect(output.changed).toEqual([]);
  });

  it('collapses two rates for the same pair and date', () => {
    // `directOrInverseRate` breaks ties by whatever it finds first, so two rows convert the
    // same transaction differently on two phones.
    const output = repairMergedState(
      input({
        exchangeRates: [
          exchangeRate({ id: 'rate-b', rate: '3.9' }),
          exchangeRate({ id: 'rate-a', rate: '3.7' }),
        ],
      }),
    );
    expect(find(output.exchangeRates, 'rate-a').deletedAt).toBeNull();
    expect(find(output.exchangeRates, 'rate-b').deletedAt).not.toBeNull();
    expect(codes(output)).toEqual(['duplicateRate']);
  });

  it('keeps rates that differ by date or direction', () => {
    const output = repairMergedState(
      input({
        exchangeRates: [
          exchangeRate({ id: 'rate-a' }),
          exchangeRate({ id: 'rate-b', effectiveDate: '2026-02-01' }),
          exchangeRate({ id: 'rate-c', fromCurrency: 'ILS', toCurrency: 'USD' }),
        ],
      }),
    );
    expect(output.changed).toEqual([]);
  });
});

describe('account resurrection', () => {
  const buried = account({ id: 'acc-1', deletedAt: '2026-02-01T00:00:00.000Z' });

  it('brings back an account a live transaction still books against', () => {
    // A deletes an account it believes unused while B books a transaction on it. An account is
    // part of the identity of every ledger entry against it, so archived-and-live is exactly
    // what `deleteEntities` would itself have chosen.
    const output = repairMergedState(
      input({
        accounts: [buried],
        transactions: [transaction({ id: 'txn-1', accountId: 'acc-1' })],
      }),
    );
    expect(find(output.accounts, 'acc-1')).toMatchObject({ deletedAt: null, archived: true });
    expect(codes(output)).toContain('accountResurrected');
  });

  const REFERENCES: [string, Partial<RepairInput>][] = [
    [
      'a transfer destination',
      {
        transactions: [
          transaction({
            id: 'txn-1',
            kind: 'transfer',
            accountId: 'acc-9',
            destinationAccountId: 'acc-1',
          }),
        ],
      },
    ],
    ['a recurring template', { recurringRules: [recurringRule({ id: 'rule-1' })] }],
    [
      'a budget filter',
      {
        budgets: [
          budget({ id: 'bud-1', filters: { accountIds: ['acc-1'], categoryIds: [], tagIds: [] } }),
        ],
      },
    ],
    ['a linked goal', { goals: [goal({ id: 'goal-1', linkedAccountId: 'acc-1' })] }],
  ];

  it.each(REFERENCES)('brings it back for %s too', (_label, extra) => {
    const output = repairMergedState(input({ accounts: [buried], ...extra }));
    expect(find(output.accounts, 'acc-1')).toMatchObject({ deletedAt: null, archived: true });
  });

  it('leaves an unreferenced tombstone buried', () => {
    expect(repairMergedState(input({ accounts: [buried] })).changed).toEqual([]);
  });

  it('un-repairs by itself once the referencing transaction is gone', () => {
    // The property that makes an op-free repair safe: delete the transaction and the account
    // returns to tombstoned on its own, with no corrective op emitted anywhere.
    const referencing = transaction({ id: 'txn-1', accountId: 'acc-1' });
    const alive = repairMergedState(input({ accounts: [buried], transactions: [referencing] }));
    expect(find(alive.accounts, 'acc-1').deletedAt).toBeNull();

    const after = repairMergedState(
      input({
        accounts: [buried],
        transactions: [{ ...referencing, deletedAt: '2026-03-03T00:00:00.000Z' }],
      }),
    );
    expect(find(after.accounts, 'acc-1').deletedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(after.changed).toEqual([]);
  });
});

describe('account currency', () => {
  it('pins the account to what its transactions actually recorded', () => {
    // `assertTransactionSetSafe` adds `amountMinor` straight into the balance with no currency
    // check, so a mismatch here is silently wrong numbers rather than a thrown error.
    const output = repairMergedState(
      input({
        accounts: [account({ id: 'acc-1', currency: 'USD' })],
        transactions: [transaction({ id: 'txn-1', accountId: 'acc-1', currency: 'ILS' })],
      }),
    );
    expect(find(output.accounts, 'acc-1').currency).toBe('ILS');
    expect(codes(output)).toEqual(['accountCurrencyPinned']);
  });

  it('takes the oldest transaction when they disagree with each other', () => {
    const output = repairMergedState(
      input({
        accounts: [account({ id: 'acc-1', currency: 'USD' })],
        transactions: [
          transaction({
            id: 'txn-2',
            accountId: 'acc-1',
            currency: 'EUR',
            createdAt: '2026-05-05T00:00:00.000Z',
          }),
          transaction({
            id: 'txn-1',
            accountId: 'acc-1',
            currency: 'ILS',
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
        ],
      }),
    );
    expect(find(output.accounts, 'acc-1').currency).toBe('ILS');
  });

  it('reads the destination side of a transfer', () => {
    const output = repairMergedState(
      input({
        accounts: [account({ id: 'acc-2', currency: 'USD' })],
        transactions: [
          transaction({
            id: 'txn-1',
            kind: 'transfer',
            accountId: 'acc-1',
            destinationAccountId: 'acc-2',
            destinationCurrency: 'ILS',
            destinationAmountMinor: 3_700,
            destinationBaseAmountMinor: 1_000,
          }),
        ],
      }),
    );
    expect(find(output.accounts, 'acc-2').currency).toBe('ILS');
  });

  it('leaves an account with no transactions alone', () => {
    expect(repairMergedState(input({ accounts: [account({ id: 'acc-1' })] })).changed).toEqual([]);
  });
});

describe('dangling references', () => {
  it('nulls a parent that is missing, deleted, self-referential, or itself a child', () => {
    const output = repairMergedState(
      input({
        categories: [
          category({ id: 'cat-1', name: 'Missing parent', parentId: 'gone' }),
          category({ id: 'cat-2', name: 'Self parent', parentId: 'cat-2' }),
          category({ id: 'cat-3', name: 'Wrong kind', kind: 'income', parentId: 'cat-4' }),
          category({ id: 'cat-4', name: 'Top' }),
          category({ id: 'cat-5', name: 'Grandchild', parentId: 'cat-6' }),
          category({ id: 'cat-6', name: 'Middle', parentId: 'cat-4' }),
        ],
      }),
    );
    for (const id of ['cat-1', 'cat-2', 'cat-3', 'cat-5']) {
      expect(find(output.categories, id).parentId).toBeNull();
    }
    // One level of nesting is legal and must survive untouched.
    expect(find(output.categories, 'cat-6').parentId).toBe('cat-4');
  });

  it('nulls a transaction category of the wrong kind', () => {
    const output = repairMergedState(
      input({
        categories: [category({ id: 'cat-1', kind: 'income' })],
        transactions: [transaction({ id: 'txn-1', kind: 'expense', categoryId: 'cat-1' })],
      }),
    );
    expect(find(output.transactions, 'txn-1').categoryId).toBeNull();
  });

  it('nulls a category on a transfer, which cannot carry one', () => {
    const output = repairMergedState(
      input({
        categories: [category({ id: 'cat-1' })],
        transactions: [transaction({ id: 'txn-1', kind: 'transfer', categoryId: 'cat-1' })],
      }),
    );
    expect(find(output.transactions, 'txn-1').categoryId).toBeNull();
  });

  it('drops tags and schedules that no longer exist, keeping the ones that do', () => {
    const output = repairMergedState(
      input({
        tags: [tag({ id: 'tag-1' })],
        transactions: [
          transaction({ id: 'txn-1', tagIds: ['tag-1', 'gone'], recurringRuleId: 'vanished' }),
        ],
      }),
    );
    expect(find(output.transactions, 'txn-1')).toMatchObject({
      tagIds: ['tag-1'],
      recurringRuleId: null,
    });
  });

  it('nulls goal links to a missing account or a mis-kinded category', () => {
    const output = repairMergedState(
      input({
        categories: [category({ id: 'cat-1', kind: 'expense' })],
        goals: [
          goal({ id: 'goal-1', kind: 'saving', linkedAccountId: 'gone', linkedCategoryId: 'cat-1' }),
        ],
      }),
    );
    expect(find(output.goals, 'goal-1')).toMatchObject({
      linkedAccountId: null,
      linkedCategoryId: null,
    });
  });

  it('keeps a goal link whose category kind matches', () => {
    const output = repairMergedState(
      input({
        categories: [category({ id: 'cat-1', name: 'Salary', kind: 'income' })],
        goals: [goal({ id: 'goal-1', kind: 'saving', linkedCategoryId: 'cat-1' })],
      }),
    );
    expect(output.changed).toEqual([]);
  });

  it('tombstones a contribution whose goal is gone, because goalId cannot move', () => {
    const output = repairMergedState(
      input({
        contributions: [
          contribution({ id: 'con-1', goalId: 'gone', updatedAt: '2026-04-04T00:00:00.000Z' }),
        ],
      }),
    );
    expect(find(output.contributions, 'con-1').deletedAt).toBe('2026-04-04T00:00:00.000Z');
    expect(codes(output)).toEqual(['contributionOrphaned']);
  });

  it('only nulls the transaction link when the goal survives', () => {
    const output = repairMergedState(
      input({
        goals: [goal({ id: 'goal-1' })],
        contributions: [contribution({ id: 'con-1', goalId: 'goal-1', transactionId: 'gone' })],
      }),
    );
    expect(find(output.contributions, 'con-1')).toMatchObject({
      deletedAt: null,
      transactionId: null,
    });
  });

  it('cleans a recurring template without disturbing the rest of it', () => {
    const rule = recurringRule({ id: 'rule-1' });
    const output = repairMergedState(
      input({
        accounts: [account({ id: 'acc-1' })],
        tags: [tag({ id: 'tag-1' })],
        recurringRules: [
          {
            ...rule,
            template: { ...rule.template, categoryId: 'gone', tagIds: ['tag-1', 'vanished'] },
          },
        ],
      }),
    );
    expect(find(output.recurringRules, 'rule-1').template).toMatchObject({
      categoryId: null,
      tagIds: ['tag-1'],
      title: 'Rent',
      amountMinor: 150_000,
    });
  });
});

describe('budgets', () => {
  it('drops a limit for a category the merged filters no longer contain', () => {
    // The permanently-unsavable case: A removes the category from the filters while B adds a
    // limit for it, and every future `saveBudget` throws on a field the user cannot see.
    const output = repairMergedState(
      input({
        categories: [
          category({ id: 'cat-1', name: 'Groceries' }),
          category({ id: 'cat-2', name: 'Transport' }),
        ],
        budgets: [
          budget({
            id: 'bud-1',
            filters: { accountIds: [], categoryIds: ['cat-1'], tagIds: [] },
            categoryLimits: [
              { categoryId: 'cat-1', limitMinor: 100 },
              { categoryId: 'cat-2', limitMinor: 200 },
            ],
          }),
        ],
      }),
    );
    expect(find(output.budgets, 'bud-1').categoryLimits).toEqual([
      { categoryId: 'cat-1', limitMinor: 100 },
    ]);
    expect(codes(output)).toEqual(['budgetLimitDropped']);
  });

  it('drops filter ids whose target is gone, and the limits that went with them', () => {
    const output = repairMergedState(
      input({
        accounts: [account({ id: 'acc-1' })],
        categories: [category({ id: 'cat-1' })],
        tags: [tag({ id: 'tag-1' })],
        budgets: [
          budget({
            id: 'bud-1',
            filters: {
              accountIds: ['acc-1', 'gone'],
              categoryIds: ['cat-1', 'vanished'],
              tagIds: ['tag-1', 'missing'],
            },
            categoryLimits: [
              { categoryId: 'cat-1', limitMinor: 100 },
              { categoryId: 'vanished', limitMinor: 200 },
            ],
          }),
        ],
      }),
    );
    expect(find(output.budgets, 'bud-1')).toMatchObject({
      filters: { accountIds: ['acc-1'], categoryIds: ['cat-1'], tagIds: ['tag-1'] },
      categoryLimits: [{ categoryId: 'cat-1', limitMinor: 100 }],
    });
  });

  it('rejects an income category as a budget filter', () => {
    const output = repairMergedState(
      input({
        categories: [category({ id: 'cat-1', kind: 'income' })],
        budgets: [
          budget({ id: 'bud-1', filters: { accountIds: [], categoryIds: ['cat-1'], tagIds: [] } }),
        ],
      }),
    );
    expect(find(output.budgets, 'bud-1').filters.categoryIds).toEqual([]);
  });

  it('collapses two limits for one category', () => {
    const output = repairMergedState(
      input({
        categories: [category({ id: 'cat-1' })],
        budgets: [
          budget({
            id: 'bud-1',
            filters: { accountIds: [], categoryIds: ['cat-1'], tagIds: [] },
            categoryLimits: [
              { categoryId: 'cat-1', limitMinor: 100 },
              { categoryId: 'cat-1', limitMinor: 200 },
            ],
          }),
        ],
      }),
    );
    expect(find(output.budgets, 'bud-1').categoryLimits).toEqual([
      { categoryId: 'cat-1', limitMinor: 100 },
    ]);
  });

  it('clears an end date on a repeating budget and keeps one on a custom period', () => {
    const output = repairMergedState(
      input({
        budgets: [
          budget({
            id: 'bud-1',
            period: { unit: 'month', interval: 1, anchorDate: '2026-01-01', endDate: '2026-12-31' },
          }),
          budget({
            id: 'bud-2',
            period: {
              unit: 'custom',
              interval: 1,
              anchorDate: '2026-01-01',
              endDate: '2026-12-31',
            },
          }),
        ],
      }),
    );
    expect(find(output.budgets, 'bud-1').period.endDate).toBeNull();
    expect(find(output.budgets, 'bud-2').period.endDate).toBe('2026-12-31');
    expect(codes(output)).toEqual(['budgetPeriodNormalized']);
  });
});

describe('schedules', () => {
  it('clamps a pointer that a schedule edit left before the start date', () => {
    // `nextDueDate` is monotone-max, so it cannot follow a `startDate` move on its own.
    const output = repairMergedState(
      input({
        accounts: [account({ id: 'acc-1' })],
        recurringRules: [
          recurringRule({ id: 'rule-1', startDate: '2026-06-01', nextDueDate: '2026-02-01' }),
        ],
      }),
    );
    expect(find(output.recurringRules, 'rule-1').nextDueDate).toBe('2026-06-01');
    expect(codes(output)).toEqual(['scheduleClamped']);
  });

  it('pauses a rule whose account is gone and resumes it when the account returns', () => {
    const rule = recurringRule({ id: 'rule-1' });
    const paused = repairMergedState(input({ recurringRules: [rule] }));
    expect(find(paused.recurringRules, 'rule-1').pausedByDependency).toBe(true);
    expect(codes(paused)).toEqual(['schedulePaused']);

    const resumed = repairMergedState(
      input({
        accounts: [account({ id: 'acc-1' })],
        recurringRules: [{ ...rule, pausedByDependency: true }],
      }),
    );
    expect(find(resumed.recurringRules, 'rule-1').pausedByDependency).toBe(false);
  });

  it('pauses a rule whose category was archived', () => {
    const rule = recurringRule({ id: 'rule-1' });
    const output = repairMergedState(
      input({
        accounts: [account({ id: 'acc-1' })],
        categories: [category({ id: 'cat-1', archived: true })],
        recurringRules: [{ ...rule, template: { ...rule.template, categoryId: 'cat-1' } }],
      }),
    );
    expect(find(output.recurringRules, 'rule-1').pausedByDependency).toBe(true);
  });
});

describe('name disambiguation', () => {
  it('renames a collision identically on every device, ignoring case', () => {
    // `assertUniqueName` rejects a duplicate on save, so two "Groceries" categories mean the
    // user's next category edit fails on something they never touched.
    const output = repairMergedState(
      input({
        categories: [
          category({ id: 'cat-b', name: 'groceries', createdAt: '2026-02-01T00:00:00.000Z' }),
          category({ id: 'cat-a', name: 'Groceries', createdAt: '2026-01-01T00:00:00.000Z' }),
        ],
      }),
    );
    expect(find(output.categories, 'cat-a').name).toBe('Groceries');
    expect(find(output.categories, 'cat-b').name).toBe('groceries (duplicate)');
    expect(codes(output)).toEqual(['nameDisambiguated']);
  });

  it('yields the name to the live entry and marks the archived one', () => {
    const output = repairMergedState(
      input({
        accounts: [
          account({
            id: 'acc-a',
            name: 'Cash',
            archived: true,
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
          account({ id: 'acc-b', name: 'Cash', createdAt: '2026-02-01T00:00:00.000Z' }),
        ],
      }),
    );
    expect(find(output.accounts, 'acc-b').name).toBe('Cash');
    expect(find(output.accounts, 'acc-a').name).toBe('Cash (archived)');
  });

  it('ignores tombstoned entries, which cannot collide', () => {
    const output = repairMergedState(
      input({
        tags: [
          tag({ id: 'tag-a', name: 'Essential' }),
          tag({ id: 'tag-b', name: 'Essential', deletedAt: '2026-02-01T00:00:00.000Z' }),
        ],
      }),
    );
    expect(output.changed).toEqual([]);
  });

  it('handles three of the same name without reusing a generated one', () => {
    const output = repairMergedState(
      input({
        tags: [
          tag({ id: 'tag-a', name: 'Fun', createdAt: '2026-01-01T00:00:00.000Z' }),
          tag({ id: 'tag-b', name: 'Fun', createdAt: '2026-01-02T00:00:00.000Z' }),
          tag({ id: 'tag-c', name: 'Fun', createdAt: '2026-01-03T00:00:00.000Z' }),
        ],
      }),
    );
    const names = output.tags.map((entity) => entity.name);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain('Fun');
  });
});

describe('pass interaction', () => {
  it('resurrects an account before deciding whether its schedule can run', () => {
    // Resurrection runs first precisely so a rule is not paused for an account the same repair
    // is about to bring back. The pause it does get is for the right reason: a resurrected
    // account comes back archived, and archived is still not activatable.
    const output = repairMergedState(
      input({
        accounts: [account({ id: 'acc-1', deletedAt: '2026-02-01T00:00:00.000Z' })],
        recurringRules: [recurringRule({ id: 'rule-1' })],
      }),
    );
    expect(find(output.accounts, 'acc-1')).toMatchObject({ deletedAt: null, archived: true });
    expect(find(output.recurringRules, 'rule-1').pausedByDependency).toBe(true);
  });

  it('drops a budget limit for a category the reference pass just invalidated', () => {
    const output = repairMergedState(
      input({
        categories: [category({ id: 'cat-1', deletedAt: '2026-02-01T00:00:00.000Z' })],
        budgets: [
          budget({
            id: 'bud-1',
            filters: { accountIds: [], categoryIds: ['cat-1'], tagIds: [] },
            categoryLimits: [{ categoryId: 'cat-1', limitMinor: 100 }],
          }),
        ],
      }),
    );
    expect(find(output.budgets, 'bud-1')).toMatchObject({
      filters: { accountIds: [], categoryIds: [], tagIds: [] },
      categoryLimits: [],
    });
  });
});
