import {
  ID_NAMESPACES,
  budgetPeriodId,
  deterministicId,
  occurrenceTransactionId,
} from '@/utils/deterministic-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('deterministicId', () => {
  it('returns the same id for the same namespace and key, every time', () => {
    const first = deterministicId(ID_NAMESPACES.occurrence, 'rule-1:2026-07-01');
    const second = deterministicId(ID_NAMESPACES.occurrence, 'rule-1:2026-07-01');
    expect(second).toBe(first);
  });

  it('is pinned to an exact value, so two app versions cannot drift apart', () => {
    // A change to the derivation is a change to entity identity: every device on the old
    // version would keep generating the old id and the two would stop merging. If this
    // assertion has to be updated, the change needs a migration, not a new expectation.
    expect(deterministicId(ID_NAMESPACES.occurrence, 'rule-1:2026-07-01')).toBe(
      '1b588201-0298-83c2-828d-579ff20e2ea1',
    );
    expect(budgetPeriodId('budget-1', '2026-07-01')).toBe('8ba607f1-3369-8630-b62b-1ebdd4ac79df');
  });

  it('separates the namespaces, so two key spaces cannot collide', () => {
    const key = 'x:2026-07-01';
    expect(deterministicId(ID_NAMESPACES.occurrence, key)).not.toBe(
      deterministicId(ID_NAMESPACES.budgetPeriod, key),
    );
  });

  it('cannot be confused by a part that spans a boundary', () => {
    // Length-prefixing every part is what makes this true. Joined with a delimiter, these
    // three would all hash the same string and be one entity.
    const ids = new Set([
      deterministicId(ID_NAMESPACES.budgetPeriod, 'a', 'b:c'),
      deterministicId(ID_NAMESPACES.budgetPeriod, 'a:b', 'c'),
      deterministicId(ID_NAMESPACES.budgetPeriod, 'a:b:c'),
    ]);
    expect(ids.size).toBe(3);
  });

  it('produces a well-formed UUID', () => {
    expect(deterministicId(ID_NAMESPACES.occurrence, 'rule-1:2026-07-01')).toMatch(UUID);
    expect(budgetPeriodId('budget-1', '2026-07-01')).toMatch(UUID);
  });

  it('marks itself version 8, so a derived id is never mistaken for a random one', () => {
    // RFC 9562 reserves version 8 for application-defined derivations. `makeId()` returns
    // version 4, so the two spaces are provably disjoint rather than merely unlikely to
    // collide.
    for (const key of ['a', 'b', 'rule-1:2026-01-01', 'budget-9:1999-12-31']) {
      const id = deterministicId(ID_NAMESPACES.occurrence, key);
      expect(id[14]).toBe('8');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    }
  });

  it('gives different keys different ids', () => {
    const ids = new Set(
      ['2026-07-01', '2026-07-02', '2026-08-01'].map((date) =>
        occurrenceTransactionId(`rule-1:${date}`),
      ),
    );
    expect(ids.size).toBe(3);
  });

  it('does not leak the key it was derived from', () => {
    // Ids reach React keys, routes, and the CSV export. Using the natural key directly
    // would put a rule id and a date in all three.
    const id = occurrenceTransactionId('rule-1:2026-07-01');
    expect(id).not.toContain('rule-1');
    expect(id).not.toContain('2026');
  });
});

describe('budgetPeriodId', () => {
  it('identifies a period by its budget and start, and nothing else', () => {
    expect(budgetPeriodId('budget-1', '2026-07-01')).toBe(budgetPeriodId('budget-1', '2026-07-01'));
    expect(budgetPeriodId('budget-1', '2026-07-01')).not.toBe(budgetPeriodId('budget-2', '2026-07-01'));
    expect(budgetPeriodId('budget-1', '2026-07-01')).not.toBe(budgetPeriodId('budget-1', '2026-08-01'));
  });

  it('is not confusable across the budget/date boundary', () => {
    expect(budgetPeriodId('a', 'b:c')).not.toBe(budgetPeriodId('a:b', 'c'));
  });
});
