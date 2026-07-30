import { diffEntity, diffRecords } from '@/sync/oplog/diff';
import { metaKey, type SyncOpBody } from '@/sync/oplog/types';
import {
  DEVICE_A,
  at,
  budget,
  budgetPeriod,
  recurringRule,
  settings,
  tag,
  transaction,
} from '@/sync/oplog/__tests__/helpers';

const HLC = at(100, DEVICE_A);

const byKind = (ops: readonly SyncOpBody[], kind: SyncOpBody['kind']) =>
  ops.filter((op) => op.kind === kind);

describe('create', () => {
  it('emits one op carrying the whole entity', () => {
    const entity = tag({ id: 'tag-1' });
    const { ops, warnings } = diffEntity('tags', null, entity, HLC);
    expect(warnings).toEqual([]);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('create');
    expect(ops[0].payload.entity).toBe(entity);
    expect(ops[0].hlc).toBe(HLC);
  });
});

describe('registers', () => {
  it('accumulates every changed LWW field into a single set op', () => {
    const before = tag({ id: 'tag-1' });
    const after = { ...before, name: 'Renamed', color: '#ffffff' };
    const { ops } = diffEntity('tags', before, after, HLC);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe('set');
    expect(ops[0].payload.registers).toEqual({ name: { name: 'Renamed' }, color: { color: '#ffffff' } });
  });

  it('emits nothing when nothing moved', () => {
    const before = tag({ id: 'tag-1' });
    expect(diffEntity('tags', before, { ...before }, HLC).ops).toEqual([]);
  });

  it('ignores derived fields, which never travel', () => {
    const before = transaction({ id: 'txn-1' });
    const after = { ...before, revision: 9, updatedAt: '2027-01-01T00:00:00.000Z' };
    expect(diffEntity('transactions', before, after, HLC).ops).toEqual([]);
  });

  it('ignores device-local fields', () => {
    const before = settings();
    const after = { ...before, themeMode: 'dark' as const };
    expect(diffEntity('settings', before, after, HLC).ops).toEqual([]);
  });

  it('emits every member of a group when any one of them moved', () => {
    // Half a group on the wire is half a group in the merge — which is the exact state that
    // produces a transaction whose currency disagrees with its own conversion.
    const before = transaction({ id: 'txn-1' });
    const after = { ...before, amountMinor: 2_500 };
    const { ops } = diffEntity('transactions', before, after, HLC);
    const registers = ops[0].payload.registers as Record<string, Record<string, unknown>>;
    expect(Object.keys(registers)).toEqual(['ledger']);
    expect(registers.ledger).toEqual({
      accountId: 'acc-1',
      amountMinor: 2_500,
      baseAmountMinor: 1_000,
      currency: 'USD',
      destinationAccountId: null,
      destinationAmountMinor: null,
      destinationBaseAmountMinor: null,
      destinationCurrency: null,
      exchangeRate: '1',
      kind: 'expense',
      localDate: '2026-01-01',
      transferGroupId: null,
    });
  });

  it('keeps categoryId out of the ledger group', () => {
    const before = transaction({ id: 'txn-1' });
    const after = { ...before, categoryId: 'cat-9' };
    const registers = diffEntity('transactions', before, after, HLC).ops[0].payload
      .registers as Record<string, unknown>;
    expect(Object.keys(registers)).toEqual(['categoryId']);
  });

  it('treats a nested group object as one value', () => {
    const before = budget({ id: 'bud-1' });
    const after = { ...before, period: { ...before.period, interval: 3 } };
    const registers = diffEntity('budgets', before, after, HLC).ops[0].payload.registers as Record<
      string,
      unknown
    >;
    expect(registers).toEqual({
      period: { period: { unit: 'month', interval: 3, anchorDate: '2026-01-01', endDate: null } },
    });
  });
});

describe('element sets', () => {
  it('emits sorted adds and removes as batched ops', () => {
    const before = transaction({ id: 'txn-1', tagIds: ['b', 'c'] });
    const after = { ...before, tagIds: ['c', 'a', 'z'] };
    const { ops } = diffEntity('transactions', before, after, HLC);
    expect(byKind(ops, 'setAdd')[0].payload).toEqual({ field: 'tagIds', elements: ['a', 'z'] });
    expect(byKind(ops, 'setRemove')[0].payload).toEqual({ field: 'tagIds', elements: ['b'] });
  });

  it('batches a multi-tag change into one op per direction', () => {
    // Three tags added is one op, not three — identical merge semantics, a third of the bytes.
    const before = transaction({ id: 'txn-1', tagIds: [] });
    const after = { ...before, tagIds: ['a', 'b', 'c'] };
    expect(byKind(diffEntity('transactions', before, after, HLC).ops, 'setAdd')).toHaveLength(1);
  });

  it('emits nothing when only the order changed', () => {
    const before = transaction({ id: 'txn-1', tagIds: ['a', 'b'] });
    const after = { ...before, tagIds: ['b', 'a'] };
    expect(diffEntity('transactions', before, after, HLC).ops).toEqual([]);
  });

  it('handles nested set paths', () => {
    const before = budget({ id: 'bud-1' });
    const after = {
      ...before,
      filters: { ...before.filters, categoryIds: ['cat-1'] },
    };
    const { ops } = diffEntity('budgets', before, after, HLC);
    expect(byKind(ops, 'setAdd')[0].payload).toEqual({
      field: 'filters.categoryIds',
      elements: ['cat-1'],
    });
  });
});

describe('keyed maps', () => {
  it('upserts changed entries and removes dropped keys', () => {
    const before = budget({
      id: 'bud-1',
      categoryLimits: [
        { categoryId: 'cat-1', limitMinor: 100 },
        { categoryId: 'cat-2', limitMinor: 200 },
      ],
    });
    const after = {
      ...before,
      categoryLimits: [
        { categoryId: 'cat-1', limitMinor: 999 },
        { categoryId: 'cat-3', limitMinor: 300 },
      ],
    };
    const { ops } = diffEntity('budgets', before, after, HLC);
    expect(byKind(ops, 'mapUpsert')[0].payload).toEqual({
      field: 'categoryLimits',
      entries: {
        'cat-1': { categoryId: 'cat-1', limitMinor: 999 },
        'cat-3': { categoryId: 'cat-3', limitMinor: 300 },
      },
    });
    expect(byKind(ops, 'mapRemove')[0].payload).toEqual({
      field: 'categoryLimits',
      keys: ['cat-2'],
    });
  });

  it('emits nothing for an unchanged entry', () => {
    const before = budget({
      id: 'bud-1',
      categoryLimits: [{ categoryId: 'cat-1', limitMinor: 100 }],
    });
    const after = { ...before, categoryLimits: [{ categoryId: 'cat-1', limitMinor: 100 }] };
    expect(diffEntity('budgets', before, after, HLC).ops).toEqual([]);
  });
});

describe('deletion', () => {
  it('emits a delete carrying the tombstone timestamp', () => {
    const before = tag({ id: 'tag-1' });
    const after = { ...before, deletedAt: '2026-05-05T00:00:00.000Z' };
    const { ops } = diffEntity('tags', before, after, HLC);
    expect(ops).toEqual([
      expect.objectContaining({ kind: 'delete', payload: { at: '2026-05-05T00:00:00.000Z' } }),
    ]);
  });

  it('emits a restore when a tombstone is lifted', () => {
    const before = tag({ id: 'tag-1', deletedAt: '2026-05-05T00:00:00.000Z' });
    const after = { ...before, deletedAt: null };
    expect(diffEntity('tags', before, after, HLC).ops).toEqual([
      expect.objectContaining({ kind: 'restore' }),
    ]);
  });

  it('emits both the field change and the delete when they happen together', () => {
    const before = tag({ id: 'tag-1' });
    const after = { ...before, name: 'Gone', deletedAt: '2026-05-05T00:00:00.000Z' };
    const { ops } = diffEntity('tags', before, after, HLC);
    expect(ops.map((op) => op.kind)).toEqual(['set', 'delete']);
  });
});

describe('immutable fields', () => {
  it('warns and emits nothing rather than forking the peers copies', () => {
    const before = transaction({ id: 'txn-1', occurrenceKey: 'rule-1:2026-01-01' });
    const after = { ...before, occurrenceKey: 'rule-1:2026-02-01' };
    const { ops, warnings } = diffEntity('transactions', before, after, HLC);
    expect(ops).toEqual([]);
    expect(warnings).toEqual([
      'transactions.occurrenceKey changed on txn-1 but is immutable; not synced.',
    ]);
  });

  it('warns on a changed createdAt', () => {
    const before = tag({ id: 'tag-1' });
    const after = { ...before, createdAt: '2027-01-01T00:00:00.000Z' };
    expect(diffEntity('tags', before, after, HLC).warnings).toHaveLength(1);
  });

  it('still emits the mutable part of the same write', () => {
    const before = budgetPeriod({ id: 'per-1' });
    const after = { ...before, budgetId: 'other', limitMinor: 42 };
    const { ops, warnings } = diffEntity('budgetPeriods', before, after, HLC);
    expect(warnings).toHaveLength(1);
    expect(ops.map((op) => op.kind)).toEqual(['set']);
  });
});

describe('one write, one clock reading', () => {
  it('stamps every op of an entity with the same HLC', () => {
    const before = transaction({ id: 'txn-1', tagIds: ['b'] });
    const after = { ...before, amountMinor: 5, tagIds: ['a'], deletedAt: '2026-06-06T00:00:00.000Z' };
    const { ops } = diffEntity('transactions', before, after, HLC);
    expect(ops.length).toBeGreaterThan(3);
    expect(new Set(ops.map((op) => op.hlc))).toEqual(new Set([HLC]));
  });
});

describe('diffRecords', () => {
  it('diffs a whole putMany against the rows read in the same transaction', () => {
    const existing = tag({ id: 'tag-1' });
    const previous = new Map([[metaKey('tags', 'tag-1'), existing]]);
    const { ops } = diffRecords(
      previous,
      [
        { type: 'tags', entity: { ...existing, name: 'Renamed' } },
        { type: 'tags', entity: tag({ id: 'tag-2' }) },
      ],
      HLC,
    );
    expect(ops.map((op) => op.kind)).toEqual(['set', 'create']);
    expect(ops[1].entityId).toBe('tag-2');
  });

  it('treats an absent key as a genuinely new row', () => {
    const { ops } = diffRecords(new Map(), [{ type: 'tags', entity: tag({ id: 'tag-1' }) }], HLC);
    expect(ops[0].kind).toBe('create');
  });

  it('collects warnings across the whole batch', () => {
    const first = transaction({ id: 'txn-1', occurrenceKey: 'a' });
    const second = transaction({ id: 'txn-2', occurrenceKey: 'b' });
    const previous = new Map([
      [metaKey('transactions', 'txn-1'), first],
      [metaKey('transactions', 'txn-2'), second],
    ]);
    const { warnings } = diffRecords(
      previous,
      [
        { type: 'transactions', entity: { ...first, occurrenceKey: 'x' } },
        { type: 'transactions', entity: { ...second, occurrenceKey: 'y' } },
      ],
      HLC,
    );
    expect(warnings).toHaveLength(2);
  });

  it('emits nothing for an empty batch', () => {
    expect(diffRecords(new Map(), [], HLC)).toEqual({ ops: [], warnings: [] });
  });
});

describe('purity', () => {
  it('is synchronous and does not mutate its inputs', () => {
    // It runs inside a storage transaction, where awaiting anything foreign lets IndexedDB
    // commit underneath the write.
    const before = recurringRule({ id: 'rule-1' });
    const snapshot = JSON.stringify(before);
    const after = { ...before, nextDueDate: '2026-03-01' };
    const result = diffEntity('recurringRules', before, after, HLC);
    expect(result).not.toBeInstanceOf(Promise);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
