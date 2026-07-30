/**
 * The convergence suite.
 *
 * `merge.ts` states three properties it must have. Everything else in the sync stack is
 * built on the assumption that they hold, and none of them fails loudly when broken — a
 * merge that is not commutative produces two devices that quietly disagree forever. So they
 * are asserted directly, exhaustively where the op set is small enough to enumerate.
 */

import type { EntityType, FinanceEntity, Tag } from '@/domain/models';
import { OP_SCHEMA_VERSION } from '@/sync/crypto';
import { canonicalJson } from '@/utils/canonical-json';
import { diffEntity } from '@/sync/oplog/diff';
import type { Hlc } from '@/sync/oplog/hlc';
import {
  applyOp,
  applyOps,
  changedTypes,
  finalize,
  isElementPresent,
  materialize,
  mergeMeta,
  mergeMetaMaps,
} from '@/sync/oplog/merge';
import { metaKey, type CausalMeta, type OpKind, type SyncOpBody } from '@/sync/oplog/types';
import {
  DEVICE_A,
  DEVICE_B,
  DEVICE_C,
  at,
  budget,
  permutations,
  recurringRule,
  seededRandom,
  settings,
  shuffled,
  tag,
  transaction,
} from '@/sync/oplog/__tests__/helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ops the way they are really produced — through the diff, from a before/after pair. */
const write = (
  type: EntityType,
  previous: FinanceEntity | null,
  next: FinanceEntity,
  hlc: Hlc,
): SyncOpBody[] => [...diffEntity(type, previous, next, hlc).ops];

const op = (partial: Partial<SyncOpBody> & { kind: OpKind; hlc: Hlc }): SyncOpBody => ({
  entityType: 'tags',
  entityId: 'tag-1',
  payload: {},
  schema: OP_SCHEMA_VERSION,
  ...partial,
});

const fold = (ops: readonly SyncOpBody[]) => applyOps(new Map<string, CausalMeta>(), ops);

/** Order-independent comparison of a whole merge state. */
const snapshot = (metas: ReadonlyMap<string, CausalMeta>) =>
  canonicalJson(
    [...metas.entries()].sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0)),
  );

const only = (metas: ReadonlyMap<string, CausalMeta>, type: EntityType, id: string) => {
  const meta = metas.get(metaKey(type, id));
  if (!meta) throw new Error(`no meta for ${type}:${id}`);
  return meta;
};

const project = (metas: ReadonlyMap<string, CausalMeta>, type: EntityType, id: string) =>
  materialize(only(metas, type, id), null);

// ---------------------------------------------------------------------------
// A concurrent edit, from three devices, on one transaction
// ---------------------------------------------------------------------------

const BASE = transaction({ id: 'txn-1', tagIds: ['keep'] });

/**
 * Five ops that a real three-device session produces: the original write, two devices
 * editing different fields while offline, a third adding a tag, and one of them deleting it.
 */
const CONCURRENT: SyncOpBody[] = [
  ...write('transactions', null, BASE, at(1, DEVICE_A)),
  ...write('transactions', BASE, { ...BASE, amountMinor: 2_500 }, at(10, DEVICE_A)),
  ...write('transactions', BASE, { ...BASE, title: 'Tea' }, at(11, DEVICE_B)),
  ...write('transactions', BASE, { ...BASE, tagIds: ['keep', 'new'] }, at(12, DEVICE_C)),
  ...write(
    'transactions',
    BASE,
    { ...BASE, deletedAt: '2026-02-02T00:00:00.000Z' },
    at(20, DEVICE_B),
  ),
];

describe('commutativity', () => {
  it('lands on the same state for every one of the 120 arrival orders', () => {
    // Arrival order is not controllable — a relay, two transports, and a peer that was
    // offline all deliver on their own schedule. If it mattered, it would be a fork.
    const expected = snapshot(fold(CONCURRENT));
    const orders = permutations(CONCURRENT);
    expect(orders).toHaveLength(120);
    for (const order of orders) expect(snapshot(fold(order))).toBe(expected);
  });

  it('merges each device edit into the field it touched, losing none of them', () => {
    const merged = project(fold(CONCURRENT), 'transactions', 'txn-1');
    expect(merged).toMatchObject({
      id: 'txn-1',
      amountMinor: 2_500,
      title: 'Tea',
      tagIds: ['keep', 'new'],
      deletedAt: '2026-02-02T00:00:00.000Z',
    });
  });

  it('holds for entities with keyed maps and nested sets too', () => {
    const base = budget({ id: 'bud-1' });
    const ops = [
      ...write('budgets', null, base, at(1, DEVICE_A)),
      ...write(
        'budgets',
        base,
        { ...base, filters: { ...base.filters, categoryIds: ['cat-1'] } },
        at(5, DEVICE_A),
      ),
      ...write(
        'budgets',
        base,
        { ...base, categoryLimits: [{ categoryId: 'cat-1', limitMinor: 400 }] },
        at(6, DEVICE_B),
      ),
      ...write('budgets', base, { ...base, limitMinor: 250_000 }, at(7, DEVICE_C)),
    ];
    const expected = snapshot(fold(ops));
    for (const order of permutations(ops)) expect(snapshot(fold(order))).toBe(expected);
    expect(project(fold(ops), 'budgets', 'bud-1')).toMatchObject({
      limitMinor: 250_000,
      filters: { accountIds: [], categoryIds: ['cat-1'], tagIds: [] },
      categoryLimits: [{ categoryId: 'cat-1', limitMinor: 400 }],
    });
  });
});

describe('idempotence', () => {
  it('changes nothing when a relay re-delivers a batch', () => {
    const once = fold(CONCURRENT);
    expect(snapshot(applyOps(once, CONCURRENT))).toBe(snapshot(once));
  });

  it('changes nothing when a peer sends an overlapping range in a different order', () => {
    const once = fold(CONCURRENT);
    const random = seededRandom(20_260_729);
    for (let round = 0; round < 20; round += 1) {
      expect(snapshot(applyOps(once, shuffled(CONCURRENT, random)))).toBe(snapshot(once));
    }
  });

  it('applying one op twice is applying it once', () => {
    const single = CONCURRENT[1];
    const meta = applyOp(null, single);
    expect(canonicalJson(applyOp(meta, single))).toBe(canonicalJson(meta));
  });
});

describe('associativity', () => {
  it('does not care how the ops were grouped into batches', () => {
    // One device merged A then B; another merged B then A; a third got them as one batch.
    const random = seededRandom(4_242);
    const expected = snapshot(fold(CONCURRENT));
    for (let round = 0; round < 50; round += 1) {
      const order = shuffled(CONCURRENT, random);
      const first = Math.floor(random() * order.length);
      const second = first + Math.floor(random() * (order.length - first));
      const groups = [order.slice(0, first), order.slice(first, second), order.slice(second)];
      let metas = new Map<string, CausalMeta>();
      for (const group of groups) metas = applyOps(metas, group);
      expect(snapshot(metas)).toBe(expected);
    }
  });
});

describe('tie-breaks', () => {
  it('resolves an identical wall clock and counter by device id, in both directions', () => {
    const base = tag({ id: 'tag-1' });
    const create = write('tags', null, base, at(1, DEVICE_A));
    const fromA = write('tags', base, { ...base, name: 'From A' }, at(9, DEVICE_A));
    const fromB = write('tags', base, { ...base, name: 'From B' }, at(9, DEVICE_B));
    expect(project(fold([...create, ...fromA, ...fromB]), 'tags', 'tag-1')).toMatchObject({
      name: 'From B',
    });
    expect(project(fold([...create, ...fromB, ...fromA]), 'tags', 'tag-1')).toMatchObject({
      name: 'From B',
    });
  });

  it('keeps an entity deleted when a delete and a restore share one reading', () => {
    // Cannot happen from one device — it is what a hand-built or replayed batch produces,
    // and the bias has to be stated rather than left to whichever arrived last.
    const create = write('tags', null, tag({ id: 'tag-1' }), at(1, DEVICE_A));
    const remove = op({ kind: 'delete', hlc: at(5, DEVICE_A), payload: { at: '2026-03-03T00:00:00.000Z' } });
    const restore = op({ kind: 'restore', hlc: at(5, DEVICE_A) });
    for (const order of [
      [...create, remove, restore],
      [...create, restore, remove],
    ]) {
      expect(project(fold(order), 'tags', 'tag-1')).toMatchObject({
        deletedAt: '2026-03-03T00:00:00.000Z',
      });
    }
  });

  it('lets a later restore bring a deleted entity back', () => {
    const base = tag({ id: 'tag-1' });
    const deleted = { ...base, deletedAt: '2026-03-03T00:00:00.000Z' };
    const ops = [
      ...write('tags', null, base, at(1, DEVICE_A)),
      ...write('tags', base, deleted, at(5, DEVICE_A)),
      ...write('tags', deleted, { ...deleted, deletedAt: null }, at(6, DEVICE_B)),
    ];
    expect(project(fold(ops), 'tags', 'tag-1')).toMatchObject({ deletedAt: null });
    // Resurrection has to stay reachable — §2.6 relies on it for referenced accounts.
    expect(project(fold(shuffled(ops, seededRandom(7))), 'tags', 'tag-1')).toMatchObject({
      deletedAt: null,
    });
  });
});

describe('field groups', () => {
  it('takes a whole ledger from one device, never a blend of two', () => {
    // The failure this prevents: A's amount with B's currency and an exchange rate that
    // describes neither, which no local mutation could ever produce and nothing detects.
    const create = write('transactions', null, BASE, at(1, DEVICE_A));
    const fromA = write(
      'transactions',
      BASE,
      { ...BASE, amountMinor: 2_500, baseAmountMinor: 2_500 },
      at(10, DEVICE_A),
    );
    const fromB = write(
      'transactions',
      BASE,
      { ...BASE, currency: 'ILS', exchangeRate: '3.7', baseAmountMinor: 270 },
      at(11, DEVICE_B),
    );
    const merged = project(fold([...create, ...fromA, ...fromB]), 'transactions', 'txn-1');
    expect(merged).toMatchObject({
      amountMinor: 1_000,
      currency: 'ILS',
      exchangeRate: '3.7',
      baseAmountMinor: 270,
    });
  });

  it('still lets a concurrent recategorisation through', () => {
    // `categoryId` sits outside the group precisely so this is not swallowed.
    const create = write('transactions', null, BASE, at(1, DEVICE_A));
    const amount = write('transactions', BASE, { ...BASE, amountMinor: 2_500 }, at(10, DEVICE_A));
    const category = write('transactions', BASE, { ...BASE, categoryId: 'cat-9' }, at(11, DEVICE_B));
    expect(project(fold([...create, ...amount, ...category]), 'transactions', 'txn-1')).toMatchObject(
      { amountMinor: 2_500, categoryId: 'cat-9' },
    );
  });
});

describe('monotone registers', () => {
  it('never rewinds nextDueDate, whatever the clocks say', () => {
    // A device that was offline for a month reconnects holding a stale pointer with a newer
    // reading. Under plain LWW `generateRecurring` would re-walk the whole span on every
    // launch and post the same occurrences again.
    const base = recurringRule({ id: 'rule-1' });
    const ops = [
      ...write('recurringRules', null, base, at(1, DEVICE_A)),
      ...write('recurringRules', base, { ...base, nextDueDate: '2026-06-01' }, at(10, DEVICE_A)),
      ...write('recurringRules', base, { ...base, nextDueDate: '2026-03-01' }, at(99, DEVICE_B)),
    ];
    expect(project(fold(ops), 'recurringRules', 'rule-1')).toMatchObject({
      nextDueDate: '2026-06-01',
    });
    expect(project(fold(shuffled(ops, seededRandom(11))), 'recurringRules', 'rule-1')).toMatchObject(
      { nextDueDate: '2026-06-01' },
    );
  });

  it('never un-onboards a device', () => {
    const fresh = settings({ onboardingComplete: false });
    const done = { ...fresh, onboardingComplete: true };
    const ops = [
      ...write('settings', null, fresh, at(1, DEVICE_A)),
      ...write('settings', fresh, done, at(5, DEVICE_A)),
      ...write('settings', fresh, { ...fresh, locale: 'he-IL' }, at(50, DEVICE_B)),
    ];
    // B's op carries no onboarding change, but the register merge must not let its state
    // through either — a peer that never onboarded would otherwise lock the other out.
    const merged = project(fold(ops), 'settings', 'settings');
    expect(merged).toMatchObject({ onboardingComplete: true, locale: 'he-IL' });
    const explicitFalse = op({
      kind: 'set',
      hlc: at(500, DEVICE_C),
      entityType: 'settings',
      entityId: 'settings',
      payload: { registers: { onboardingComplete: { onboardingComplete: false } } },
    });
    expect(project(fold([...ops, explicitFalse]), 'settings', 'settings')).toMatchObject({
      onboardingComplete: true,
    });
  });
});

describe('element sets', () => {
  const withTags = (tagIds: string[]) => ({ ...BASE, tagIds });

  it('keeps an element added and removed at the same reading', () => {
    const create = write('transactions', null, withTags([]), at(1, DEVICE_A));
    const added = op({
      kind: 'setAdd',
      hlc: at(5, DEVICE_A),
      entityType: 'transactions',
      entityId: 'txn-1',
      payload: { field: 'tagIds', elements: ['x'] },
    });
    const removed = { ...added, kind: 'setRemove' as const };
    expect(project(fold([...create, added, removed]), 'transactions', 'txn-1')).toMatchObject({
      tagIds: ['x'],
    });
    expect(project(fold([...create, removed, added]), 'transactions', 'txn-1')).toMatchObject({
      tagIds: ['x'],
    });
  });

  it('honours a later remove and a later re-add', () => {
    const create = write('transactions', null, withTags(['x']), at(1, DEVICE_A));
    const remove = write('transactions', withTags(['x']), withTags([]), at(5, DEVICE_B));
    const readd = write('transactions', withTags([]), withTags(['x']), at(9, DEVICE_A));
    expect(project(fold([...create, ...remove]), 'transactions', 'txn-1')).toMatchObject({
      tagIds: [],
    });
    expect(project(fold([...create, ...remove, ...readd]), 'transactions', 'txn-1')).toMatchObject({
      tagIds: ['x'],
    });
  });

  it('projects elements sorted, so two devices agree byte for byte', () => {
    const create = write('transactions', null, withTags(['zebra', 'apple']), at(1, DEVICE_A));
    const later = write(
      'transactions',
      withTags(['zebra', 'apple']),
      withTags(['zebra', 'apple', 'mango']),
      at(5, DEVICE_B),
    );
    expect(project(fold([...create, ...later]), 'transactions', 'txn-1')).toMatchObject({
      tagIds: ['apple', 'mango', 'zebra'],
    });
  });

  it('decides presence add-wins', () => {
    expect(isElementPresent({ addHlc: at(5), removeHlc: null })).toBe(true);
    expect(isElementPresent({ addHlc: at(5), removeHlc: at(5) })).toBe(true);
    expect(isElementPresent({ addHlc: at(5), removeHlc: at(6) })).toBe(false);
    expect(isElementPresent({ addHlc: null, removeHlc: at(6) })).toBe(false);
  });
});

describe('keyed maps', () => {
  const limits = (entries: { categoryId: string; limitMinor: number }[]) =>
    budget({ id: 'bud-1', categoryLimits: entries });

  it('resolves per entry, so two devices editing different categories both survive', () => {
    const base = limits([
      { categoryId: 'cat-1', limitMinor: 100 },
      { categoryId: 'cat-2', limitMinor: 200 },
    ]);
    const ops = [
      ...write('budgets', null, base, at(1, DEVICE_A)),
      ...write(
        'budgets',
        base,
        limits([
          { categoryId: 'cat-1', limitMinor: 999 },
          { categoryId: 'cat-2', limitMinor: 200 },
        ]),
        at(5, DEVICE_A),
      ),
      ...write(
        'budgets',
        base,
        limits([
          { categoryId: 'cat-1', limitMinor: 100 },
          { categoryId: 'cat-2', limitMinor: 888 },
        ]),
        at(6, DEVICE_B),
      ),
    ];
    expect(project(fold(ops), 'budgets', 'bud-1')).toMatchObject({
      categoryLimits: [
        { categoryId: 'cat-1', limitMinor: 999 },
        { categoryId: 'cat-2', limitMinor: 888 },
      ],
    });
  });

  it('keeps a removal as a tombstone so a re-delivered upsert cannot resurrect it', () => {
    const base = limits([{ categoryId: 'cat-1', limitMinor: 100 }]);
    const removal = write('budgets', base, limits([]), at(9, DEVICE_B));
    const create = write('budgets', null, base, at(1, DEVICE_A));
    expect(project(fold([...create, ...removal]), 'budgets', 'bud-1')).toMatchObject({
      categoryLimits: [],
    });
    expect(project(fold([...removal, ...create]), 'budgets', 'bud-1')).toMatchObject({
      categoryLimits: [],
    });
  });
});

describe('create collisions', () => {
  it('folds two independent creations of the same id into one entity', () => {
    // §2.10 derives ids from the occurrence key precisely so that two devices generating
    // the same recurrence collide into one entity instead of two duplicates.
    const fromA = transaction({ id: 'txn-1', occurrenceKey: 'rule-1:2026-02-01', title: 'Rent' });
    const fromB = { ...fromA, createdAt: '2026-02-01T09:00:00.000Z', title: 'Rent payment' };
    const ops = [
      ...write('transactions', null, fromA, at(10, DEVICE_A)),
      ...write('transactions', null, fromB, at(20, DEVICE_B)),
    ];
    const merged = project(fold(ops), 'transactions', 'txn-1');
    // Immutables come from the lower reading — a stable choice both devices reach alone.
    expect(merged).toMatchObject({ createdAt: fromA.createdAt, title: 'Rent payment' });
    expect(snapshot(fold(ops))).toBe(snapshot(fold([...ops].reverse())));
  });
});

describe('ops this build cannot interpret', () => {
  const future = (partial: Partial<SyncOpBody> = {}) =>
    op({ kind: 'set', hlc: at(50, DEVICE_B), schema: OP_SCHEMA_VERSION + 1, ...partial });

  it('keeps a newer schema rather than dropping it', () => {
    // Dropping it would break the hash chain for every peer downstream, and the edit
    // reappears intact the moment this device is updated.
    const meta = applyOp(null, future());
    expect(meta.unknown).toHaveLength(1);
    expect(meta.registers).toEqual({});
    expect(meta.maxHlc).toBe(at(50, DEVICE_B));
  });

  it('keeps an unknown entity type and an unknown kind', () => {
    expect(applyOp(null, op({ kind: 'set', hlc: at(1), entityType: 'future' as EntityType })).unknown)
      .toHaveLength(1);
    expect(applyOp(null, op({ kind: 'rekey' as OpKind, hlc: at(1) })).unknown).toHaveLength(1);
  });

  it('does not grow the list when the same op is re-delivered', () => {
    const once = applyOp(null, future());
    expect(applyOp(once, future()).unknown).toHaveLength(1);
  });

  it('holds them in the same order however they arrived', () => {
    const first = future({ hlc: at(50, DEVICE_B) });
    const second = future({ hlc: at(60, DEVICE_C), kind: 'delete' });
    const third = future({ hlc: at(55, DEVICE_A) });
    const forward = applyOps(new Map(), [first, second, third]);
    const backward = applyOps(new Map(), [third, second, first]);
    expect(snapshot(forward)).toBe(snapshot(backward));
  });

  it('does not materialize an entity that has only uninterpretable ops', () => {
    expect(materialize(applyOp(null, future()), null)).toBeNull();
  });

  it('still merges the ops it does understand from the same batch', () => {
    const create = write('tags', null, tag({ id: 'tag-1' }), at(1, DEVICE_A));
    const merged = project(fold([...create, future()]), 'tags', 'tag-1');
    expect(merged).toMatchObject({ id: 'tag-1', name: 'Essential' });
  });

  it('keeps an unknown register name on a schema it does understand', () => {
    // A version that adds a field without reshaping anything else is then a pure upgrade.
    const create = write('tags', null, tag({ id: 'tag-1' }), at(1, DEVICE_A));
    const extra = op({
      kind: 'set',
      hlc: at(5, DEVICE_B),
      payload: { registers: { emoji: { emoji: '🏷️' } } },
    });
    expect(only(fold([...create, extra]), 'tags', 'tag-1').registers.emoji).toEqual({
      hlc: at(5, DEVICE_B),
      value: { emoji: '🏷️' },
    });
  });
});

describe('materialize', () => {
  it('returns null until the create arrives, rather than a half-formed row', () => {
    const later = write('tags', tag({ id: 'tag-1' }), tag({ id: 'tag-1', name: 'Renamed' }), at(9));
    const metas = fold(later);
    expect(project(metas, 'tags', 'tag-1')).toBeNull();
    const create = write('tags', null, tag({ id: 'tag-1' }), at(1));
    expect(project(applyOps(metas, create), 'tags', 'tag-1')).toMatchObject({ name: 'Renamed' });
  });

  it('derives updatedAt from the winning clock reading', () => {
    const wall = Date.parse('2026-04-04T04:04:04.004Z');
    const create = write('tags', null, tag({ id: 'tag-1' }), at(wall, DEVICE_A));
    expect(project(fold(create), 'tags', 'tag-1')).toMatchObject({
      updatedAt: '2026-04-04T04:04:04.004Z',
    });
  });

  it('holds updatedAt monotone so a merge cannot move a row backwards in a sorted list', () => {
    const previous = tag({ id: 'tag-1', updatedAt: '2030-01-01T00:00:00.000Z' });
    const create = write('tags', null, tag({ id: 'tag-1' }), at(1_000, DEVICE_A));
    expect(materialize(only(fold(create), 'tags', 'tag-1'), previous)).toMatchObject({
      updatedAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('keeps a device-local field on the device that holds it', () => {
    const local = settings({ themeMode: 'dark' });
    const remote = settings({ themeMode: 'light', locale: 'he-IL' });
    const ops = [
      ...write('settings', null, settings({ themeMode: 'light' }), at(1, DEVICE_B)),
      ...write('settings', settings({ themeMode: 'light' }), remote, at(9, DEVICE_B)),
    ];

    const merged = materialize(only(fold(ops), 'settings', 'settings'), local);
    // The peer's locale edit lands; its theme does not. Otherwise changing the language on a
    // phone would drag a laptop out of dark mode, which is exactly what `deviceLocal` means.
    expect(merged).toMatchObject({ locale: 'he-IL', themeMode: 'dark' });
    expect(finalize(merged!, local).changed).toBe(true);
  });

  it('seeds a device-local field for a device that holds no copy at all', () => {
    const create = write('settings', null, settings({ themeMode: 'dark' }), at(1, DEVICE_B));
    // A restored-from-phrase device has no settings row to preserve. Projecting without the
    // field would produce an entity the model rejects, so the create carries a seed.
    expect(project(fold(create), 'settings', 'settings')).toMatchObject({ themeMode: 'dark' });
  });

  it('leaves revision alone, because finalize settles it after the repair pass', () => {
    const create = write('tags', null, tag({ id: 'tag-1' }), at(1));
    const previous = tag({ id: 'tag-1', revision: 7 });
    expect(materialize(only(fold(create), 'tags', 'tag-1'), previous)?.revision).toBe(7);
    expect(project(fold(create), 'tags', 'tag-1')?.revision).toBe(1);
  });
});

describe('finalize', () => {
  it('bumps revision when something genuinely changed', () => {
    const previous = tag({ id: 'tag-1', revision: 3 });
    const next = { ...previous, name: 'Renamed' };
    expect(finalize(next, previous)).toEqual({
      entity: { ...next, revision: 4 },
      changed: true,
    });
  });

  it('reports no change when only the derived fields moved, and keeps the old row', () => {
    // Otherwise every merge that merely advances an entity's clock rewrites the record,
    // bumps its revision, and rejects whatever form the user has open.
    const previous = tag({ id: 'tag-1', revision: 3, updatedAt: '2026-01-01T00:00:00.000Z' });
    const next = { ...previous, revision: 1, updatedAt: '2026-09-09T00:00:00.000Z' };
    expect(finalize(next, previous)).toEqual({ entity: previous, changed: false });
  });

  it('starts a brand new record at revision 1', () => {
    expect(finalize(tag({ id: 'tag-1', revision: 99 }), null).entity.revision).toBe(1);
  });

  it('is strictly locally monotone across a burst of merges', () => {
    let current = tag({ id: 'tag-1', revision: 1 });
    for (let index = 2; index < 8; index += 1) {
      // `finalize` is typed over the whole `FinanceEntity` union because it is called from
      // the generic apply path; the fixture narrows it back for the next round.
      current = finalize({ ...current, name: `Name ${index}` }, current).entity as Tag;
      expect(current.revision).toBe(index);
    }
  });
});

describe('state-based merge', () => {
  it('agrees with the op-based merge, which is the point of sharing the comparisons', () => {
    // A peer past the compaction watermark gets state, not ops. If the two paths could
    // disagree, that peer would converge to something no other device holds.
    const random = seededRandom(90_210);
    for (let round = 0; round < 40; round += 1) {
      const order = shuffled(CONCURRENT, random);
      const cut = Math.floor(random() * (order.length + 1));
      const left = fold(order.slice(0, cut));
      const right = fold(order.slice(cut));
      expect(snapshot(mergeMetaMaps(left, right))).toBe(snapshot(fold(order)));
      expect(snapshot(mergeMetaMaps(right, left))).toBe(snapshot(fold(order)));
    }
  });

  it('keeps the receiver newer values instead of overwriting them', () => {
    const base = tag({ id: 'tag-1' });
    const local = fold([
      ...write('tags', null, base, at(1, DEVICE_A)),
      ...write('tags', base, { ...base, name: 'Local wins' }, at(90, DEVICE_A)),
    ]);
    const remote = fold([
      ...write('tags', null, base, at(1, DEVICE_A)),
      ...write('tags', base, { ...base, color: '#abcdef' }, at(50, DEVICE_B)),
    ]);
    const merged = mergeMeta(only(local, 'tags', 'tag-1'), only(remote, 'tags', 'tag-1'));
    expect(materialize(merged, null)).toMatchObject({ name: 'Local wins', color: '#abcdef' });
  });

  it('takes a whole entity the receiver has never seen', () => {
    const local = new Map<string, CausalMeta>();
    const remote = fold(write('tags', null, tag({ id: 'tag-9' }), at(1, DEVICE_B)));
    expect(snapshot(mergeMetaMaps(local, remote))).toBe(snapshot(remote));
  });

  it('is idempotent and commutative in its own right', () => {
    const left = only(fold(CONCURRENT.slice(0, 3)), 'transactions', 'txn-1');
    const right = only(fold(CONCURRENT.slice(3)), 'transactions', 'txn-1');
    const merged = mergeMeta(left, right);
    expect(canonicalJson(mergeMeta(right, left))).toBe(canonicalJson(merged));
    expect(canonicalJson(mergeMeta(merged, merged))).toBe(canonicalJson(merged));
  });
});

describe('changedTypes', () => {
  it('lists what a batch touched, sorted and deduplicated', () => {
    expect(
      changedTypes([
        op({ kind: 'set', hlc: at(1), entityType: 'transactions' }),
        op({ kind: 'set', hlc: at(2), entityType: 'accounts' }),
        op({ kind: 'set', hlc: at(3), entityType: 'transactions' }),
      ]),
    ).toEqual(['accounts', 'transactions']);
  });

  it('omits a type this build has never heard of', () => {
    expect(changedTypes([op({ kind: 'set', hlc: at(1), entityType: 'future' as EntityType })])).toEqual(
      [],
    );
  });
});
