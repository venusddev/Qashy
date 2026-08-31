import type { EntityType, FinanceEntity } from '@/domain/models';
import {
  ENTITY_TYPES,
  REGISTRY,
  createOnlyFieldsOf,
  elementSetsOf,
  isEntityType,
  keyedMapsOf,
  readPath,
  registerOf,
  registersOf,
  specFor,
  writePath,
} from '@/sync/oplog/registry';
import {
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

/** One fully-populated sample of every entity type, for the coverage walk below. */
const SAMPLES: Record<EntityType, FinanceEntity> = {
  settings: settings(),
  accounts: account({ id: 'acc-1' }),
  categories: category({ id: 'cat-1' }),
  tags: tag({ id: 'tag-1' }),
  transactions: transaction({ id: 'txn-1' }),
  budgets: budget({ id: 'bud-1' }),
  budgetPeriods: budgetPeriod({ id: 'per-1' }),
  goals: goal({ id: 'goal-1' }),
  contributions: contribution({ id: 'con-1' }),
  recurringRules: recurringRule({ id: 'rule-1' }),
  exchangeRates: exchangeRate({ id: 'rate-1' }),
};

describe('registry coverage', () => {
  it('covers every entity type in the domain', () => {
    expect(ENTITY_TYPES.sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  /**
   * The assertion this whole file exists for.
   *
   * A field absent from the registry does not fail loudly — it simply never syncs, and the
   * user finds out when an edit made on their phone is missing from their laptop with no
   * error anywhere. Walking the real entity shapes is the only way to catch that when the
   * domain grows a field and the registry does not.
   */
  it.each(ENTITY_TYPES)('accounts for every field of %s', (entityType) => {
    const spec = specFor(entityType);
    const paths = Object.keys(spec);
    const uncovered = Object.keys(SAMPLES[entityType]).filter(
      (field) => !(field in spec) && !paths.some((path) => path.startsWith(`${field}.`)),
    );
    expect(uncovered).toEqual([]);
  });

  it.each(ENTITY_TYPES)('has no field of %s that the domain does not have', (entityType) => {
    const missing = Object.keys(specFor(entityType)).filter(
      (path) => readPath(SAMPLES[entityType], path) === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('treats id and createdAt as immutable everywhere', () => {
    for (const entityType of ENTITY_TYPES) {
      expect(specFor(entityType).id).toEqual({ kind: 'createOnly' });
      expect(specFor(entityType).createdAt).toEqual({ kind: 'createOnly' });
    }
  });

  it('derives updatedAt, revision, and deletedAt rather than merging them', () => {
    for (const entityType of ENTITY_TYPES) {
      expect(specFor(entityType).updatedAt).toEqual({ kind: 'derived' });
      expect(specFor(entityType).revision).toEqual({ kind: 'derived' });
      expect(specFor(entityType).deletedAt).toEqual({ kind: 'derived' });
    }
  });

  it('keeps the invariants that the field groups exist to protect', () => {
    const ledger = registersOf('transactions').find((register) => register.name === 'ledger');
    // Every one of these is derived from or derives another; a per-field merge across them
    // produces a row whose stored conversion does not describe its own amount.
    expect(ledger?.fields).toEqual(
      [
        'accountId',
        'amountMinor',
        'baseAmountMinor',
        'currency',
        'destinationAccountId',
        'destinationAmountMinor',
        'destinationBaseAmountMinor',
        'destinationCurrency',
        'exchangeRate',
        'kind',
        'localDate',
        'transferGroupId',
      ].sort(),
    );
    // Recategorising is the most common concurrent edit there is; it must not be swallowed
    // by someone else fixing a typo in the amount.
    expect(specFor('transactions').categoryId).toEqual({ kind: 'lww' });
  });

  it('pins the strategies that are load-bearing rather than stylistic', () => {
    expect(specFor('settings').baseCurrency).toEqual({ kind: 'createOnly' });
    expect(specFor('settings').onboardingComplete).toEqual({ kind: 'monotoneTrue' });
    expect(specFor('settings').themeMode).toEqual({ kind: 'deviceLocal' });
    expect(specFor('recurringRules').nextDueDate).toEqual({ kind: 'monotoneMax' });
    expect(specFor('recurringRules').pausedByDependency).toEqual({ kind: 'derived' });
    expect(specFor('transactions').occurrenceKey).toEqual({ kind: 'createOnly' });
    expect(specFor('budgetPeriods').budgetId).toEqual({ kind: 'createOnly' });
    expect(specFor('contributions').goalId).toEqual({ kind: 'createOnly' });
  });

  it('gives a live budget set semantics and a closed period snapshot atomic ones', () => {
    // A snapshot is frozen history. Set semantics would let an edit to the live budget bleed
    // backwards and restate a number the user has already seen.
    expect(elementSetsOf('budgets')).toEqual([
      'filters.accountIds',
      'filters.categoryIds',
      'filters.tagIds',
    ]);
    expect(elementSetsOf('budgetPeriods')).toEqual([]);
    expect(specFor('budgetPeriods').filters).toEqual({ kind: 'group', group: 'snapshot' });
    expect(specFor('budgetPeriods').categoryLimits).toEqual({ kind: 'group', group: 'snapshot' });
  });

  it('exposes keyed maps with their key field', () => {
    expect(keyedMapsOf('budgets')).toEqual([{ path: 'categoryLimits', key: 'categoryId' }]);
    expect(keyedMapsOf('accounts')).toEqual([]);
  });

  it('lists element sets and create-only fields deterministically', () => {
    expect(elementSetsOf('transactions')).toEqual(['tagIds']);
    expect(createOnlyFieldsOf('transactions')).toEqual(['createdAt', 'id', 'occurrenceKey']);
  });
});

describe('registersOf', () => {
  it('groups co-dependent fields into one register', () => {
    const names = registersOf('budgets').map((register) => register.name);
    expect(names).toContain('period');
    expect(registersOf('budgets').find((register) => register.name === 'period')?.fields).toEqual([
      'period',
    ]);
  });

  it('gives a lone LWW field a single-field register, so both merge through one path', () => {
    const name = registersOf('tags').find((register) => register.name === 'name');
    expect(name).toEqual({ name: 'name', fields: ['name'], strategy: { kind: 'lww' } });
  });

  it('excludes everything that does not travel as a register', () => {
    const names = registersOf('settings').map((register) => register.name);
    expect(names).not.toContain('themeMode');
    expect(names).not.toContain('baseCurrency');
    expect(names).not.toContain('revision');
    expect(names).not.toContain('deletedAt');
  });

  it('is deterministic and stable across calls', () => {
    expect(registersOf('transactions')).toBe(registersOf('transactions'));
    expect(registersOf('goals').map((register) => register.name)).toEqual(
      [...registersOf('goals').map((register) => register.name)].sort(),
    );
  });
});

describe('registerOf', () => {
  it('maps a field to its group, or to itself', () => {
    expect(registerOf({ kind: 'lww' }, 'name')).toBe('name');
    expect(registerOf({ kind: 'group', group: 'ledger' }, 'amountMinor')).toBe('ledger');
    expect(registerOf({ kind: 'monotoneMax' }, 'nextDueDate')).toBe('nextDueDate');
  });

  it('returns null for everything with its own path through the merge', () => {
    expect(registerOf({ kind: 'createOnly' }, 'id')).toBeNull();
    expect(registerOf({ kind: 'derived' }, 'revision')).toBeNull();
    expect(registerOf({ kind: 'deviceLocal' }, 'themeMode')).toBeNull();
    expect(registerOf({ kind: 'elementSet' }, 'tagIds')).toBeNull();
    expect(registerOf({ kind: 'keyedMap', key: 'categoryId' }, 'categoryLimits')).toBeNull();
  });
});

describe('unknown entity types', () => {
  it('answers "nothing to merge" instead of throwing', () => {
    // A peer on a newer build can legitimately send ops for a type this one has never heard
    // of. Those ops are kept and forwarded, so every lookup has to survive them.
    const future = 'somethingNew' as EntityType;
    expect(isEntityType(future)).toBe(false);
    expect(specFor(future)).toEqual({});
    expect(registersOf(future)).toEqual([]);
    expect(elementSetsOf(future)).toEqual([]);
    expect(keyedMapsOf(future)).toEqual([]);
    expect(createOnlyFieldsOf(future)).toEqual([]);
  });

  it('does not treat inherited object properties as entity types', () => {
    expect(isEntityType('toString')).toBe(false);
    expect(isEntityType('constructor')).toBe(false);
    expect(isEntityType(REGISTRY.accounts)).toBe(false);
  });
});

describe('dotted paths', () => {
  it('reads a nested leaf', () => {
    expect(readPath({ filters: { tagIds: ['a'] } }, 'filters.tagIds')).toEqual(['a']);
    expect(readPath({ a: 1 }, 'a')).toBe(1);
  });

  it('returns undefined for a missing branch instead of throwing', () => {
    expect(readPath({}, 'filters.tagIds')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
    expect(readPath({ a: null }, 'a.b')).toBeUndefined();
  });

  it('writes without mutating, so a previously-materialized value cannot change underneath', () => {
    const original = { filters: { tagIds: ['a'] }, other: 1 };
    const next = writePath(original, 'filters.tagIds', ['b']);
    expect(original.filters.tagIds).toEqual(['a']);
    expect(next.filters.tagIds).toEqual(['b']);
    expect(next.other).toBe(1);
  });

  it('creates intermediate objects', () => {
    expect(writePath({}, 'a.b.c', 1)).toEqual({ a: { b: { c: 1 } } });
  });
});
