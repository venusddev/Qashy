/**
 * Entity ids derived from a natural key instead of a random source.
 *
 * Two paired devices run `generateRecurring()` on every foreground and roll a budget over
 * on the first of the month independently. With `makeId()` that produces two entities for
 * one real-world thing, and the merge then has to notice the duplicate and tombstone one of
 * them — a repair that has to be right on both devices, every time, forever.
 *
 * Deriving the id from the key that already identifies the occurrence removes the problem
 * rather than resolving it: both devices mint the *same* id, so the two generations merge
 * into one entity by construction. No duplicate, no tombstone, no repair pass, and it fixes
 * the same double-generation race that exists today on a single device whenever two
 * foregrounds overlap.
 *
 * The hash is what makes it safe to do this. Using the natural key as the id directly would
 * leak it: a budget period id would spell out a budget id and a date, and a transaction id
 * would spell out a recurring rule id. Ids reach places record contents do not — React keys,
 * routes, the CSV export — so they are kept opaque.
 */

import { sha256, toHex, utf8Bytes } from '@/sync/crypto';

/**
 * Namespaces, so two different key spaces can never derive the same id.
 *
 * A budget period keyed `x:2026-07-01` and a recurrence occurrence keyed `x:2026-07-01` are
 * unrelated things that happen to spell the same string; without the namespace they would
 * be the same entity id in two different tables.
 */
export const ID_NAMESPACES = {
  budgetPeriod: 'qashy/id/v1/budget-period',
  occurrence: 'qashy/id/v1/occurrence',
} as const;

export type IdNamespace = (typeof ID_NAMESPACES)[keyof typeof ID_NAMESPACES];

/**
 * A stable UUID for `parts` within `namespace`.
 *
 * Every part is length-prefixed rather than joined with a delimiter. Any character used as a
 * separator can also occur in a part, and then `('a', 'b:c')` and `('a:b', 'c')` hash to the
 * same id — which is not hypothetical: a budget period is keyed by a budget id and a date,
 * and reading that boundary wrong would silently make two different periods one entity. A
 * length prefix is injective without reserving a character at all.
 *
 * Formatted as an RFC 9562 version 8 UUID — the "custom" version, reserved for exactly this
 * case, where the bits come from an application-defined derivation rather than a random
 * source. Stamping the version and variant nibbles keeps the value a well-formed UUID and
 * makes it impossible to collide with a version 4 id from `makeId()`, so a derived id and a
 * random one can always be told apart after the fact.
 */
export function deterministicId(namespace: IdNamespace, ...parts: readonly string[]) {
  const framed = [namespace, ...parts].map((part) => `${part.length}:${part}`).join('');
  const digest = toHex(sha256(utf8Bytes(framed)));
  const variant = ((parseInt(digest[16], 16) & 0b0011) | 0b1000).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `8${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

/** The id every device gives the transaction generated for one recurrence occurrence. */
export const occurrenceTransactionId = (occurrenceKey: string) =>
  deterministicId(ID_NAMESPACES.occurrence, occurrenceKey);

/** The id every device gives the snapshot of one budget's one period. */
export const budgetPeriodId = (budgetId: string, periodStart: string) =>
  deterministicId(ID_NAMESPACES.budgetPeriod, budgetId, periodStart);
