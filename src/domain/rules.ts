/**
 * Pure predicates over the finance model.
 *
 * These have to be callable from two places that must never disagree: the repository, when
 * a user action changes a dependency, and the merge's repair pass, when the same change
 * arrives from another device. A copy in each is a copy that drifts, and drift here means
 * two paired devices showing a rule as paused on one and active on the other — with no
 * error anywhere, because both are locally consistent.
 *
 * Nothing here reads a clock, a locale, or any state beyond its arguments.
 */

import type { Account, Category, CategoryKind, GoalKind, RecurringRule } from '@/domain/models';

/**
 * Whether a recurring rule still has everything it needs to post.
 *
 * A rule is paused, not deleted, when its account or category is archived — the user's
 * schedule is still meaningful and comes back the moment the dependency does. That is why
 * `pausedByDependency` is derived from this on every merge rather than synced: it is a
 * function of the merged accounts and categories, and syncing it would let a peer's stale
 * view of an archived account pause a rule this device can see is fine.
 */
export function canActivateRecurringRule(
  rule: RecurringRule,
  accounts: readonly Account[],
  categories: readonly Category[],
): boolean {
  const account = accounts.find((item) => item.id === rule.template.accountId && !item.archived);
  const category = rule.template.categoryId
    ? categories.find(
        (item) =>
          item.id === rule.template.categoryId &&
          item.kind === rule.template.kind &&
          !item.archived,
      )
    : null;
  return (
    Boolean(account) &&
    (!rule.template.categoryId || Boolean(category)) &&
    (!rule.endDate || rule.nextDueDate <= rule.endDate)
  );
}

/**
 * The category kind a goal may link to.
 *
 * A saving goal is fed by income and a spending goal is measured against expense, so the
 * link is not a free choice — `validateGoal` rejects the other pairing outright, and the
 * repair pass has to null a link that a merge produced rather than leave a goal the user
 * can never save again.
 */
export const goalCategoryKind = (kind: GoalKind): CategoryKind =>
  kind === 'saving' ? 'income' : 'expense';
