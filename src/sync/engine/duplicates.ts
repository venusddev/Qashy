/**
 * Duplicate review for the first pairing of two already-populated vaults.
 *
 * The deterministic repair pass in `src/sync/oplog/repair.ts` *renames* colliding accounts,
 * categories, and tags rather than merging them — "Bakery" and "bakery" become "Bakery" and
 * "bakery (duplicate)". That is the only thing an automatic pass may do, because renaming is
 * a deterministic function of the merged set and merging is a judgement about the world: two
 * categories called "Groceries" created on two phones might be the same category, or might be
 * a shared one and a personal one. Only the person who made them knows.
 *
 * So this module is the other half. It suggests what *looks* like the same thing on both
 * sides, and — once the user confirms — turns a merge into a batch of ordinary entity writes:
 * retarget every reference from the loser to the winner, then tombstone the loser. No new op
 * kind, no special-casing in the merge engine. `SyncingStorageAdapter` derives ops from the
 * write exactly as it would from any edit, and the merge propagates to every peer as normal
 * history that the activity log records and that another device can inspect after the fact.
 *
 * ## Order matters, and the UI must present it in this order
 *
 * Transaction matching keys on `accountId` and `categoryId`. Before accounts are merged, the
 * two vaults' copies of "Everyday" are different entities with different ids, so no
 * transaction pair will ever match. Merge accounts, categories, and tags first, re-run
 * `suggestDuplicates`, and only then will the transaction groups appear. That is not a
 * limitation to work around — a transaction on *this* account is genuinely not the same
 * record as one on a different account until the user says those accounts are the same.
 *
 * ## What this deliberately does not do
 *
 * - **No fuzzy matching.** Groups are formed by exact normalized-name equality after the
 *   repair's disambiguation suffix is stripped. Edit-distance matching invites false
 *   positives, and a false positive here silently rewrites a person's ledger.
 * - **No merging of budgets, goals, or recurring rules.** Two vaults that each hold a copy of
 *   the same monthly rule end up with two rules, both of which keep posting. That shows up as
 *   two visibly identical rules the user can delete with the existing UI, which is a two-tap
 *   fix — whereas an automatic rule merge would have to reconcile two schedules, two
 *   `nextDueDate` pointers, and the occurrence tombstones behind them.
 * - **Nothing is applied here.** Every function is pure. `LocalFinanceRepository.mergeDuplicates`
 *   validates and writes, so the whole-set money invariants run before anything lands.
 */

import type { StoredEntity } from '@/data/storage-adapter';
import type {
  Account,
  Budget,
  BudgetCategoryLimit,
  BudgetFilters,
  BudgetPeriodSnapshot,
  Category,
  FinanceEntity,
  FinanceState,
  Goal,
  GoalContribution,
  RecurringRule,
  Tag,
  TransactionRecord,
} from '@/domain/models';
import { compareInvariant, normalizeName } from '@/utils/naming';
import { nowIso, updateEntity } from '@/utils/entity';

/** The entity types this screen can merge. See the module note for why the list stops here. */
export type MergeKind = 'accounts' | 'categories' | 'tags' | 'transactions';

export interface DuplicateGroup {
  readonly kind: MergeKind;
  /** The surviving entity. Everything in `mergeIds` is retargeted onto it and tombstoned. */
  readonly keepId: string;
  readonly mergeIds: readonly string[];
  /** Display text for the review row. Data, not chrome — render it with `literal`. */
  readonly label: string;
  /**
   * Why this group cannot be merged, in the user's terms, or `null` when it can.
   *
   * Blocked groups are still returned rather than filtered out. A pair of same-named accounts
   * in two different currencies is exactly what the user is looking for on this screen, and
   * silently omitting it reads as "Qashy didn't notice" rather than "this one needs a
   * different fix".
   */
  readonly blocked: string | null;
}

export interface MergePlan {
  /** Every row to write: the retargeted referrers, then the tombstoned losers. */
  readonly records: readonly StoredEntity[];
  /** Referring entities rewritten. Surfaced so the review screen can preview the blast radius. */
  readonly retargeted: number;
  /** Entities tombstoned — always the total size of every group's `mergeIds`. */
  readonly removed: number;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/**
 * Strips the suffix `disambiguateNames` appends, so a renamed collision can find its twin.
 *
 * The suffixes are literal ASCII rather than translated strings, and deliberately so: the
 * repair pass has to produce identical names on a he-IL device and an en-US one or the two
 * never converge. That makes them safe to match on here.
 */
const BARE_NAME = /\s*\((?:duplicate|archived)(?:\s+\d+)?\)$/;

const bareName = (name: string) => normalizeName(name.trim().replace(BARE_NAME, ''));

const live = <T extends FinanceEntity>(rows: readonly T[]) => rows.filter((row) => !row.deletedAt);

/**
 * The order that decides which entity survives a merge.
 *
 * Identical to `disambiguateNames`' precedence on purpose: that function gave the *unsuffixed*
 * name to whichever entity sorts first, so sorting the same way here means the survivor is the
 * one the user already sees under the clean name. A merge that kept the other one would rename
 * a category out from under someone for no reason they could observe.
 */
const byPrecedence = (first: FinanceEntity, second: FinanceEntity) => {
  const firstArchived = 'archived' in first && first.archived ? 1 : 0;
  const secondArchived = 'archived' in second && second.archived ? 1 : 0;
  return (
    firstArchived - secondArchived ||
    compareInvariant(first.createdAt, second.createdAt) ||
    compareInvariant(first.id, second.id)
  );
};

/** Groups rows by a key, keeping only the keys that landed more than one row. */
function collide<T>(rows: readonly T[], keyOf: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()].filter((bucket) => bucket.length > 1);
}

/**
 * Why a set of same-named accounts still cannot be one account.
 *
 * Currency is the hard one. Every transaction stores the rate it was converted at and the
 * resulting `baseAmountMinor`, and the account's currency is what those snapshots were taken
 * against. Merging a USD account into an ILS one would leave the ILS account holding USD-
 * denominated rows, and the repair pass in §2.6 would then "fix" that by rewriting the
 * account's currency to match the first transaction it finds — silently changing what every
 * balance on that account means.
 */
function accountBlocker(members: readonly Account[], state: FinanceState) {
  const currencies = new Set(members.map((account) => account.currency));
  if (currencies.size > 1) {
    return `These accounts use different currencies (${[...currencies].sort().join(', ')}).`;
  }
  const ids = new Set(members.map((account) => account.id));
  // A transfer between two accounts that became one account is a transfer to itself, which
  // `validateTransaction` rejects — so the merged vault would be unwritable rather than wrong.
  const transfer = live(state.transactions).some(
    (row) =>
      row.destinationAccountId && ids.has(row.accountId) && ids.has(row.destinationAccountId),
  );
  return transfer ? 'A transfer moves money between these accounts, so they are not the same account.' : null;
}

function categoryBlocker(members: readonly Category[]) {
  const kinds = new Set(members.map((category) => category.kind));
  return kinds.size > 1 ? 'These categories track different kinds of money — one income, one expense.' : null;
}

/**
 * A content-addressed key for "you entered this transaction on both devices".
 *
 * The same tuple `importCsv` dedupes on, and deliberately the same one: there should be one
 * definition of "same transaction" in Qashy, not one for CSV and a second for sync. Tags are
 * compared by *name* rather than id so the key survives a tag merge that has not happened yet.
 */
export function transactionDuplicateKey(
  transaction: TransactionRecord,
  tagNameById: ReadonlyMap<string, string>,
) {
  return JSON.stringify([
    transaction.localDate,
    transaction.kind,
    transaction.status,
    transaction.accountId,
    transaction.destinationAccountId,
    transaction.amountMinor,
    transaction.destinationAmountMinor,
    transaction.currency,
    transaction.destinationCurrency,
    transaction.categoryId,
    normalizeName(transaction.title),
    normalizeName(transaction.note),
    [...new Set(transaction.tagIds.map((id) => normalizeName(tagNameById.get(id) ?? id)))].sort(),
    transaction.exchangeRate,
  ]);
}

/** Every group of records that look like the same thing recorded twice. */
export function suggestDuplicates(state: FinanceState): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  const named = <T extends Account | Category | Tag>(
    kind: Extract<MergeKind, 'accounts' | 'categories' | 'tags'>,
    rows: readonly T[],
    blocker: (members: readonly T[]) => string | null,
  ) => {
    for (const bucket of collide(live(rows), (row) => bareName(row.name))) {
      const [keep, ...merge] = [...bucket].sort(byPrecedence);
      groups.push({
        kind,
        keepId: keep.id,
        mergeIds: merge.map((row) => row.id),
        label: keep.name,
        blocked: blocker(bucket),
      });
    }
  };

  named('accounts', state.accounts, (members) => accountBlocker(members, state));
  named('categories', state.categories, categoryBlocker);
  named('tags', state.tags, () => null);

  const tagNameById = new Map(state.tags.map((tag) => [tag.id, tag.name]));
  for (const bucket of collide(live(state.transactions), (row) =>
    transactionDuplicateKey(row, tagNameById),
  )) {
    const [keep, ...merge] = [...bucket].sort(byPrecedence);
    groups.push({
      kind: 'transactions',
      keepId: keep.id,
      mergeIds: merge.map((row) => row.id),
      label: keep.title,
      blocked: null,
    });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Planning the write
// ---------------------------------------------------------------------------

type Remap = ReadonlyMap<string, string>;

/** `undefined` when nothing in the list moved, so callers can skip an unchanged entity. */
function remapList(ids: readonly string[], remap: Remap) {
  if (!ids.some((id) => remap.has(id))) return undefined;
  // Deduped, because the winner and a loser can both already be present — two devices that
  // each tagged the same transaction "Rent" leave one transaction carrying both tag ids.
  return [...new Set(ids.map((id) => remap.get(id) ?? id))];
}

function remapFilters(filters: BudgetFilters, accounts: Remap, categories: Remap, tags: Remap) {
  const accountIds = remapList(filters.accountIds, accounts);
  const categoryIds = remapList(filters.categoryIds, categories);
  const tagIds = remapList(filters.tagIds, tags);
  if (!accountIds && !categoryIds && !tagIds) return undefined;
  return {
    accountIds: accountIds ?? filters.accountIds,
    categoryIds: categoryIds ?? filters.categoryIds,
    tagIds: tagIds ?? filters.tagIds,
  };
}

/**
 * Retargets per-category limits, collapsing two limits that now name one category.
 *
 * The winner's own limit is kept rather than summing the two. A sum is a guess about intent
 * and it is the kind of guess that silently doubles a budget; keeping the one the user can
 * already see on the surviving category is at worst a number they can edit.
 */
function remapLimits(limits: readonly BudgetCategoryLimit[], categories: Remap) {
  if (!limits.some((limit) => categories.has(limit.categoryId))) return undefined;
  const kept = new Map<string, BudgetCategoryLimit>();
  for (const limit of limits) {
    const categoryId = categories.get(limit.categoryId) ?? limit.categoryId;
    // Whichever entry the budget already listed first survives the collapse. Arbitrary between
    // two limits, but stable — it does not depend on which side of the merge a device is on.
    if (!kept.has(categoryId)) kept.set(categoryId, { ...limit, categoryId });
  }
  return [...kept.values()];
}

/**
 * Turns confirmed groups into the complete set of rows to write.
 *
 * Pure apart from the timestamps `updateEntity` stamps, which is the correct kind of impurity
 * here: this is a local user action authored on this device's chain, not the repair pass.
 *
 * Throws on a blocked group rather than skipping it. A merge screen that silently dropped one
 * of five confirmed merges would leave the user believing they had cleaned up a vault they had
 * not, and the leftover duplicate would keep showing up in totals.
 */
export function planMerge(state: FinanceState, groups: readonly DuplicateGroup[]): MergePlan {
  const blocked = groups.find((group) => group.blocked);
  if (blocked) throw new Error(blocked.blocked!);

  const remaps: Record<MergeKind, Map<string, string>> = {
    accounts: new Map(),
    categories: new Map(),
    tags: new Map(),
    transactions: new Map(),
  };
  const byId = new Map<string, FinanceEntity>();
  for (const kind of ['accounts', 'categories', 'tags', 'transactions'] as const) {
    for (const row of state[kind]) byId.set(`${kind}:${row.id}`, row);
  }

  for (const group of groups) {
    if (!byId.has(`${group.kind}:${group.keepId}`)) {
      throw new Error('The record to keep no longer exists.');
    }
    for (const id of group.mergeIds) {
      if (id === group.keepId) continue;
      if (!byId.has(`${group.kind}:${id}`)) throw new Error('A record to merge no longer exists.');
      // Chained groups ("A into B" and "B into C" confirmed together) would otherwise leave a
      // reference pointing at a tombstone. Refusing is honest; resolving the chain silently
      // would merge two things the user never put in the same group.
      if (remaps[group.kind].has(id)) throw new Error('That record is already being merged into another.');
      remaps[group.kind].set(id, group.keepId);
    }
  }

  const { accounts, categories, tags, transactions } = remaps;
  const records: StoredEntity[] = [];
  let retargeted = 0;

  const push = <T extends FinanceEntity>(type: StoredEntity['type'], entity: T, changes: Partial<T>) => {
    if (!Object.keys(changes).length) return;
    records.push({ type, entity: updateEntity(entity, changes) });
    retargeted += 1;
  };

  for (const transaction of live(state.transactions)) {
    if (transactions.has(transaction.id)) continue;
    const changes: Partial<TransactionRecord> = {};
    const accountId = accounts.get(transaction.accountId);
    if (accountId) changes.accountId = accountId;
    if (transaction.destinationAccountId) {
      const destinationAccountId = accounts.get(transaction.destinationAccountId);
      if (destinationAccountId) changes.destinationAccountId = destinationAccountId;
    }
    if (transaction.categoryId) {
      const categoryId = categories.get(transaction.categoryId);
      if (categoryId) changes.categoryId = categoryId;
    }
    const tagIds = remapList(transaction.tagIds, tags);
    if (tagIds) changes.tagIds = tagIds;
    push('transactions', transaction, changes);
  }

  for (const category of live(state.categories)) {
    if (categories.has(category.id)) continue;
    if (!category.parentId) continue;
    const parentId = categories.get(category.parentId);
    if (!parentId) continue;
    // Merging a child into its own parent leaves the parent pointing at itself, which the
    // hierarchy repair would then have to undo on every device. Cut it here instead.
    push('categories', category, { parentId: parentId === category.id ? null : parentId });
  }

  for (const rule of live(state.recurringRules)) {
    const template = rule.template;
    const accountId = accounts.get(template.accountId);
    const categoryId = template.categoryId ? categories.get(template.categoryId) : undefined;
    const tagIds = remapList(template.tagIds, tags);
    if (!accountId && !categoryId && !tagIds) continue;
    push<RecurringRule>('recurringRules', rule, {
      template: {
        ...template,
        accountId: accountId ?? template.accountId,
        categoryId: categoryId ?? template.categoryId,
        tagIds: tagIds ?? template.tagIds,
      },
    });
  }

  for (const budget of live(state.budgets)) {
    const changes: Partial<Budget> = {};
    const filters = remapFilters(budget.filters, accounts, categories, tags);
    if (filters) changes.filters = filters;
    const categoryLimits = remapLimits(budget.categoryLimits, categories);
    if (categoryLimits) changes.categoryLimits = categoryLimits;
    push('budgets', budget, changes);
  }

  // Closed periods are immutable *history*, but they are not inert: `getBudgetStatuses` re-runs
  // `budgetSpend` over a period's own stored filters to show what was spent back then. Leaving
  // a merged-away account id in there would quietly drop those transactions from a past month's
  // total. Retargeting an id is not rewriting history — it is the same real-world account under
  // one identity instead of two, and the period still selects exactly the same rows.
  for (const period of live(state.budgetPeriods)) {
    const changes: Partial<BudgetPeriodSnapshot> = {};
    const filters = remapFilters(period.filters, accounts, categories, tags);
    if (filters) changes.filters = filters;
    const categoryLimits = remapLimits(period.categoryLimits, categories);
    if (categoryLimits) changes.categoryLimits = categoryLimits;
    push('budgetPeriods', period, changes);
  }

  for (const goal of live(state.goals)) {
    const changes: Partial<Goal> = {};
    if (goal.linkedAccountId) {
      const linkedAccountId = accounts.get(goal.linkedAccountId);
      if (linkedAccountId) changes.linkedAccountId = linkedAccountId;
    }
    if (goal.linkedCategoryId) {
      const linkedCategoryId = categories.get(goal.linkedCategoryId);
      if (linkedCategoryId) changes.linkedCategoryId = linkedCategoryId;
    }
    push('goals', goal, changes);
  }

  for (const contribution of live(state.contributions)) {
    if (!contribution.transactionId) continue;
    const transactionId = transactions.get(contribution.transactionId);
    if (transactionId) push<GoalContribution>('contributions', contribution, { transactionId });
  }

  const deletedAt = nowIso();
  let removed = 0;
  for (const kind of ['accounts', 'categories', 'tags', 'transactions'] as const) {
    for (const id of remaps[kind].keys()) {
      records.push({ type: kind, entity: updateEntity(byId.get(`${kind}:${id}`)!, { deletedAt }) });
      removed += 1;
    }
  }

  return { records, retargeted, removed };
}
