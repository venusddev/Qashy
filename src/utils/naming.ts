/**
 * Name collision handling for accounts, categories, and tags.
 *
 * Extracted from the repository so that the merge's repair pass and the on-load migration
 * run the *same* code rather than two implementations that agree today. They must produce
 * identical names on every device from identical input, because the repair emits no ops —
 * convergence depends on every device independently computing the same answer.
 *
 * ## Why `normalize` is a parameter, and why the default is not locale-aware
 *
 * The repository used to fold case with `toLocaleLowerCase()`. That is a genuine
 * divergence bug rather than a stylistic point: Qashy ships he-IL and en-US and lets the
 * user pick either, and case folding is locale-dependent — in a Turkish locale
 * `'I'.toLocaleLowerCase()` is `'ı'`, not `'i'`. Two paired devices with different locales
 * would compute different collision sets, choose different names, and never agree. So the
 * default folds with `toLowerCase()`, which is locale-invariant, and callers that need a
 * different rule pass one in explicitly instead of inheriting the device's.
 */

import type { Account, Category, Tag } from '@/domain/models';

export type NameableEntity = Account | Category | Tag;

/** Locale-invariant by design — see the note above. */
export const normalizeName = (value: string) => value.trim().toLowerCase();

/**
 * Code-unit string ordering, for the same reason `normalizeName` folds case invariantly.
 *
 * `localeCompare` is the obvious choice and the wrong one: collation can treat a hyphen as
 * ignorable, which reorders ISO timestamps and UUIDs — the two things sorted here — under
 * some locales and not others. Only used on machine-generated ASCII, never on a user's name.
 */
export const compareInvariant = (first: string, second: string) =>
  first < second ? -1 : first > second ? 1 : 0;

export interface NameRename {
  readonly id: string;
  readonly name: string;
}

/**
 * The order collisions are resolved in.
 *
 * Live entities keep their name over archived ones, then the older creation wins, then the
 * id. Every term is stable and device-independent — no clock, no locale, no insertion
 * order — which is what lets two devices that merged the same set produce the same names.
 */
const byPrecedence = (first: NameableEntity, second: NameableEntity) => {
  const firstArchived = 'archived' in first && first.archived ? 1 : 0;
  const secondArchived = 'archived' in second && second.archived ? 1 : 0;
  return (
    firstArchived - secondArchived ||
    compareInvariant(first.createdAt, second.createdAt) ||
    compareInvariant(first.id, second.id)
  );
};

/**
 * Returns the renames needed to make every name unique, and nothing else.
 *
 * Renaming rather than merging is deliberate. Two devices that each created "Groceries"
 * offline have produced two entities, and whether they are the *same* category is a
 * judgement only the person who made them can make — so the automatic step keeps both and
 * makes the merged set valid, and the merge review screen is where the human decides.
 */
export function disambiguateNames(
  entities: readonly NameableEntity[],
  normalize: (value: string) => string = normalizeName,
): NameRename[] {
  const reserved = new Set(entities.map((entity) => normalize(entity.name)));
  const used = new Set<string>();
  const renames: NameRename[] = [];

  for (const entity of [...entities].sort(byPrecedence)) {
    const normalized = normalize(entity.name);
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
      candidate = normalize(name);
      index += 1;
      // `reserved` holds every original name, so a generated name can never collide with
      // one this pass has not reached yet — otherwise resolving an early duplicate would
      // steal the name of a later entity that had every right to it.
    } while (used.has(candidate) || reserved.has(candidate));
    used.add(candidate);
    renames.push({ id: entity.id, name });
  }

  return renames;
}
