/**
 * Characterization tests for the `disambiguateNames` extraction.
 *
 * `LocalFinanceRepository` has resolved name collisions on load since long before sync, in a
 * private method called from `migrateLoadedState`. Sync needs the *same* answer from the
 * repair pass, so the logic moved to `src/utils/naming.ts` — and an extraction is only safe
 * if it is provably behaviour-preserving.
 *
 * `legacyDisambiguate` below is a faithful transcription of that private method as it stood
 * before the move. It is the oracle: most of this file asserts that the extracted function
 * agrees with it. The rest documents the two places where it deliberately does *not*, and
 * why each change was required rather than incidental.
 */

import { compareInvariant, disambiguateNames, normalizeName } from '@/utils/naming';
import type { NameableEntity, NameRename } from '@/utils/naming';
import type { Account, Category, Tag } from '@/domain/models';

const BASE = { revision: 1, updatedAt: '2024-01-01T00:00:00.000Z', deletedAt: null } as const;

const account = (
  id: string,
  name: string,
  over: Partial<Account> = {},
): Account => ({
  ...BASE,
  id,
  name,
  createdAt: '2024-01-01T00:00:00.000Z',
  type: 'checking',
  currency: 'USD',
  openingBalanceMinor: 0,
  icon: 'banknote',
  color: '#4F46E5',
  archived: false,
  ...over,
});

const category = (
  id: string,
  name: string,
  over: Partial<Category> = {},
): Category => ({
  ...BASE,
  id,
  name,
  createdAt: '2024-01-01T00:00:00.000Z',
  kind: 'expense',
  icon: 'cart',
  color: '#4F46E5',
  parentId: null,
  archived: false,
  ...over,
});

/** Tags have no `archived` field, which is the branch `'archived' in entity` exists for. */
const tag = (id: string, name: string, over: Partial<Tag> = {}): Tag => ({
  ...BASE,
  id,
  name,
  createdAt: '2024-01-01T00:00:00.000Z',
  color: '#4F46E5',
  ...over,
});

/**
 * The repository's private `disambiguateNames`, transcribed.
 *
 * Two details are preserved exactly because they are the ones under test: the sort uses
 * `localeCompare`, and the *generated* candidate is lowercased without being trimmed even
 * though the *original* names are trimmed first. `locale` is a parameter only so the
 * `toLocaleLowerCase` divergence can be demonstrated; the original passed nothing and
 * inherited the host's locale.
 *
 * Returns `{ id, name }[]` in rename order — the legacy method built a Map in the same
 * order and spread its values, so this is directly comparable to the extracted output.
 */
const legacyDisambiguate = (
  entities: readonly NameableEntity[],
  locale?: string,
): NameRename[] => {
  const fold = (value: string) => value.toLocaleLowerCase(locale);
  const reserved = new Set(entities.map((entity) => fold(entity.name.trim())));
  const used = new Set<string>();
  const renames: NameRename[] = [];
  const ordered = [...entities].sort((first, second) => {
    const firstArchived = 'archived' in first && first.archived ? 1 : 0;
    const secondArchived = 'archived' in second && second.archived ? 1 : 0;
    return (
      firstArchived - secondArchived ||
      first.createdAt.localeCompare(second.createdAt) ||
      first.id.localeCompare(second.id)
    );
  });
  for (const entity of ordered) {
    const normalized = fold(entity.name.trim());
    if (!used.has(normalized)) {
      used.add(normalized);
      continue;
    }
    const suffix = 'archived' in entity && entity.archived ? 'archived' : 'duplicate';
    let index = 1;
    let name = '';
    let candidate = '';
    do {
      name = `${entity.name.trim()} (${suffix}${index === 1 ? '' : ` ${index}`})`;
      candidate = fold(name);
      index += 1;
    } while (used.has(candidate) || reserved.has(candidate));
    used.add(candidate);
    renames.push({ id: entity.id, name });
  }
  return renames;
};

const named = (renames: readonly NameRename[]) => renames.map((rename) => rename.name);

/** Deterministic shuffle, so a failure is reproducible from the seed alone. */
const seededRandom = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const shuffled = <T>(items: readonly T[], seed: number) => {
  const next = seededRandom(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(next() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
};

/**
 * Every collision shape the repository has ever had to resolve, in one set.
 *
 * Used both as a plain expectation fixture and as the corpus the oracle comparison shuffles,
 * so the two suites cannot drift apart.
 */
const CORPUS: NameableEntity[] = [
  account('a1', 'Groceries'),
  account('a2', 'groceries', { createdAt: '2024-02-01T00:00:00.000Z' }),
  account('a3', '  GROCERIES  ', { createdAt: '2024-03-01T00:00:00.000Z' }),
  account('a4', 'Groceries (duplicate)', { createdAt: '2024-04-01T00:00:00.000Z' }),
  account('a5', 'Savings', { archived: true, createdAt: '2023-01-01T00:00:00.000Z' }),
  account('a6', 'Savings', { createdAt: '2024-05-01T00:00:00.000Z' }),
  category('c1', 'Rent'),
  category('c2', 'Rent', { createdAt: '2024-01-01T00:00:00.000Z' }),
  category('c3', 'Unique'),
  tag('t1', 'work'),
  tag('t2', 'Work', { createdAt: '2024-06-01T00:00:00.000Z' }),
];

describe('normalizeName', () => {
  it('trims and folds case without consulting the device locale', () => {
    expect(normalizeName('  Groceries  ')).toBe('groceries');
    expect(normalizeName('GROCERIES')).toBe('groceries');
  });

  it('matches what assertUniqueName compares, so a repaired set is a savable set', () => {
    // `assertUniqueName` rejects on `name.trim().toLocaleLowerCase()` equality. The repair
    // has to use the same equivalence or it "fixes" a set the repository still refuses.
    expect(normalizeName(' Rent ')).toBe(normalizeName('RENT'));
  });
});

describe('compareInvariant', () => {
  it('orders by code unit', () => {
    expect(compareInvariant('a', 'b')).toBe(-1);
    expect(compareInvariant('b', 'a')).toBe(1);
    expect(compareInvariant('a', 'a')).toBe(0);
  });

  it('disagrees with localeCompare on case, which is the point of not using it', () => {
    // ICU's default collation sorts lowercase before uppercase; code units do the reverse.
    // Nothing sorted here is mixed-case today, but the comparator is the seam where a
    // future id format could quietly make two devices disagree, so it is pinned closed.
    expect(compareInvariant('x', 'X')).toBe(1);
    expect(Math.sign('x'.localeCompare('X'))).toBe(-1);
  });

  it('agrees with localeCompare on the ISO timestamps and UUIDs it is actually given', () => {
    const timestamps = ['2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.500Z', '2024-02-01T00:00:00.000Z'];
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000000a'];
    for (const values of [timestamps, ids]) {
      for (const first of values) {
        for (const second of values) {
          expect(compareInvariant(first, second)).toBe(Math.sign(first.localeCompare(second)));
        }
      }
    }
  });
});

describe('disambiguateNames — behaviour pinned from migrateLoadedState', () => {
  it('renames nothing when every name is already distinct', () => {
    expect(disambiguateNames([account('a1', 'Cash'), account('a2', 'Card')])).toEqual([]);
  });

  it('suffixes a live duplicate with "(duplicate)"', () => {
    const renames = disambiguateNames([
      account('a1', 'Groceries'),
      account('a2', 'Groceries', { createdAt: '2024-02-01T00:00:00.000Z' }),
    ]);
    expect(renames).toEqual([{ id: 'a2', name: 'Groceries (duplicate)' }]);
  });

  it('suffixes an archived duplicate with "(archived)"', () => {
    const renames = disambiguateNames([
      account('a1', 'Savings'),
      account('a2', 'Savings', { archived: true, createdAt: '2024-02-01T00:00:00.000Z' }),
    ]);
    expect(renames).toEqual([{ id: 'a2', name: 'Savings (archived)' }]);
  });

  it('lets a live entity keep the name even when the archived one is older', () => {
    // Archived-ness outranks creation order, so the entity still in use is never the one
    // that gets renamed out from under the person looking at it.
    const renames = disambiguateNames([
      account('a1', 'Savings', { archived: true, createdAt: '2020-01-01T00:00:00.000Z' }),
      account('a2', 'Savings', { createdAt: '2024-01-01T00:00:00.000Z' }),
    ]);
    expect(renames).toEqual([{ id: 'a1', name: 'Savings (archived)' }]);
  });

  it('escalates to " 2" only on the second collision of the same base', () => {
    const renames = disambiguateNames([
      account('a1', 'Groceries'),
      account('a2', 'Groceries', { createdAt: '2024-02-01T00:00:00.000Z' }),
      account('a3', 'Groceries', { createdAt: '2024-03-01T00:00:00.000Z' }),
      account('a4', 'Groceries', { createdAt: '2024-04-01T00:00:00.000Z' }),
    ]);
    expect(named(renames)).toEqual([
      'Groceries (duplicate)',
      'Groceries (duplicate 2)',
      'Groceries (duplicate 3)',
    ]);
  });

  it('counts the archived and live suffixes independently', () => {
    const renames = disambiguateNames([
      account('a1', 'Groceries'),
      account('a2', 'Groceries', { createdAt: '2024-02-01T00:00:00.000Z' }),
      account('a3', 'Groceries', { archived: true, createdAt: '2024-03-01T00:00:00.000Z' }),
      account('a4', 'Groceries', { archived: true, createdAt: '2024-04-01T00:00:00.000Z' }),
    ]);
    expect(named(renames)).toEqual([
      'Groceries (duplicate)',
      'Groceries (archived)',
      'Groceries (archived 2)',
    ]);
  });

  it('does not steal a generated name from an entity that already holds it', () => {
    // `reserved` carries every original name, including ones the loop has not reached. Drop
    // it and 'a2' would take "Groceries (duplicate)" and 'a3' would be renamed instead —
    // the pass would have created the collision it was called to fix.
    const renames = disambiguateNames([
      account('a1', 'Groceries'),
      account('a2', 'Groceries', { createdAt: '2024-02-01T00:00:00.000Z' }),
      account('a3', 'Groceries (duplicate)', { createdAt: '2024-03-01T00:00:00.000Z' }),
    ]);
    expect(renames).toEqual([{ id: 'a2', name: 'Groceries (duplicate 2)' }]);
  });

  it('avoids a reserved name case-insensitively, not just exactly', () => {
    const renames = disambiguateNames([
      account('a1', 'Groceries'),
      account('a2', 'Groceries', { createdAt: '2024-02-01T00:00:00.000Z' }),
      account('a3', 'GROCERIES (DUPLICATE)', { createdAt: '2024-03-01T00:00:00.000Z' }),
    ]);
    expect(named(renames)).toEqual(['Groceries (duplicate 2)']);
  });

  it('collides on trimmed names and builds the new name from the trimmed original', () => {
    const renames = disambiguateNames([
      account('a1', 'Groceries'),
      account('a2', '  Groceries  ', { createdAt: '2024-02-01T00:00:00.000Z' }),
    ]);
    expect(renames).toEqual([{ id: 'a2', name: 'Groceries (duplicate)' }]);
  });

  it('treats a tag as never archived, since tags have no such field', () => {
    const renames = disambiguateNames([
      tag('t1', 'work'),
      tag('t2', 'Work', { createdAt: '2024-02-01T00:00:00.000Z' }),
    ]);
    expect(renames).toEqual([{ id: 't2', name: 'Work (duplicate)' }]);
  });

  it('breaks a tie on identical createdAt with the id', () => {
    const first = disambiguateNames([category('c9', 'Rent'), category('c1', 'Rent')]);
    expect(first).toEqual([{ id: 'c9', name: 'Rent (duplicate)' }]);
  });
});

describe('disambiguateNames — determinism', () => {
  it('returns the same renames whatever order the entities arrive in', () => {
    const expected = JSON.stringify(disambiguateNames(CORPUS));
    for (let seed = 1; seed <= 40; seed += 1) {
      expect(JSON.stringify(disambiguateNames(shuffled(CORPUS, seed)))).toBe(expected);
    }
  });

  it('does not mutate its input', () => {
    const snapshot = JSON.stringify(CORPUS);
    disambiguateNames(CORPUS);
    expect(JSON.stringify(CORPUS)).toBe(snapshot);
  });

  it('leaves a set it has already repaired alone', () => {
    // The repair pass runs on every merge, so a second pass over its own output must find
    // nothing — otherwise names would drift by one suffix on every sync.
    const renames = new Map(disambiguateNames(CORPUS).map((rename) => [rename.id, rename.name]));
    const repaired = CORPUS.map((entity) => ({ ...entity, name: renames.get(entity.id) ?? entity.name }));
    expect(disambiguateNames(repaired)).toEqual([]);
  });

  it('produces names that are unique under the repository’s own equality', () => {
    const renames = new Map(disambiguateNames(CORPUS).map((rename) => [rename.id, rename.name]));
    const finalNames = CORPUS.map((entity) => normalizeName(renames.get(entity.id) ?? entity.name));
    expect(new Set(finalNames).size).toBe(finalNames.length);
  });
});

describe('disambiguateNames — agreement with the pre-extraction implementation', () => {
  it('matches the legacy method on the full corpus', () => {
    expect(disambiguateNames(CORPUS)).toEqual(legacyDisambiguate(CORPUS));
  });

  it('matches it however the entities were ordered', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const input = shuffled(CORPUS, seed);
      expect(disambiguateNames(input)).toEqual(legacyDisambiguate(input));
    }
  });

  it.each([
    ['no collisions', [account('a1', 'Cash'), account('a2', 'Card')]],
    ['a single pair', [account('a1', 'X'), account('a2', 'X', { createdAt: '2024-02-01T00:00:00.000Z' })]],
    [
      'a three-way collision',
      [
        category('c1', 'Rent'),
        category('c2', 'rent', { createdAt: '2024-02-01T00:00:00.000Z' }),
        category('c3', 'RENT', { createdAt: '2024-03-01T00:00:00.000Z' }),
      ],
    ],
    [
      'a reserved generated name',
      [
        tag('t1', 'Trip'),
        tag('t2', 'Trip', { createdAt: '2024-02-01T00:00:00.000Z' }),
        tag('t3', 'Trip (duplicate)', { createdAt: '2024-03-01T00:00:00.000Z' }),
      ],
    ],
    [
      'archived and live mixed',
      [
        account('a1', 'Old', { archived: true }),
        account('a2', 'Old', { createdAt: '2024-02-01T00:00:00.000Z' }),
        account('a3', 'Old', { archived: true, createdAt: '2024-03-01T00:00:00.000Z' }),
      ],
    ],
    ['an empty list', []],
    ['a single entity', [account('a1', 'Solo')]],
  ])('matches the legacy method for %s', (_label, entities) => {
    expect(disambiguateNames(entities)).toEqual(legacyDisambiguate(entities));
  });
});

describe('disambiguateNames — the deliberate divergences', () => {
  it('folds case the same way in every locale, where the legacy method did not', () => {
    // This is the divergence the extraction exists for. `'I'.toLocaleLowerCase('tr')` is
    // 'ı', so under a Turkish locale the legacy method saw no collision between "IT" and
    // "it" at all — two paired devices with different locales would compute different
    // collision sets, pick different names, and never converge.
    const entities = [
      category('c1', 'IT'),
      category('c2', 'it', { createdAt: '2024-02-01T00:00:00.000Z' }),
    ];
    expect(legacyDisambiguate(entities, 'en-US')).toEqual([{ id: 'c2', name: 'it (duplicate)' }]);
    expect(legacyDisambiguate(entities, 'tr')).toEqual([]);

    // The extracted function gives the en-US answer, and gives it unconditionally.
    expect(disambiguateNames(entities)).toEqual([{ id: 'c2', name: 'it (duplicate)' }]);
  });

  it('normalizes a generated name the same way as an original one', () => {
    // The legacy method trimmed the names it read but not the candidates it generated, so
    // a blank name produced the key ' (duplicate)' while a real entity called
    // ' (duplicate)' produced '(duplicate)'. The two never matched, both entities kept the
    // name, and `assertUniqueName` — which trims — then rejected every later save.
    const entities = [
      tag('t1', ''),
      tag('t2', '  ', { createdAt: '2024-02-01T00:00:00.000Z' }),
      tag('t3', ' (duplicate)', { createdAt: '2024-03-01T00:00:00.000Z' }),
    ];

    const legacy = new Map(legacyDisambiguate(entities, 'en-US').map((r) => [r.id, r.name]));
    const legacyNames = entities.map((entity) => (legacy.get(entity.id) ?? entity.name).trim().toLowerCase());
    expect(new Set(legacyNames).size).toBeLessThan(legacyNames.length);

    const fixed = new Map(disambiguateNames(entities).map((r) => [r.id, r.name]));
    const fixedNames = entities.map((entity) => normalizeName(fixed.get(entity.id) ?? entity.name));
    expect(new Set(fixedNames).size).toBe(fixedNames.length);
    expect(fixed.get('t2')).toBe(' (duplicate 2)');
  });
});
