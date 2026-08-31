/**
 * The deterministic repair pass.
 *
 * A CRDT guarantees that every device reaches the *same* state. It does not guarantee that
 * the state is *valid*. Two devices editing a budget offline can produce a merged budget
 * whose category limits reference a category the merged filters no longer contain — both
 * edits legal on their own, the result permanently unsavable, because `validateBudget`
 * throws on every future save. Converged and broken is worse than diverged and working,
 * so something has to reconcile the merged set with the finance model's invariants.
 *
 * Two properties make this safe, and both are load-bearing:
 *
 * **It emits no ops.** Repair is a pure function of the merged set, so every device
 * computes the identical repair independently and writes the identical records. Nothing
 * propagates and nothing ping-pongs. A repair that emitted ops would be a repair that
 * triggers another device's repair, which emits ops, forever.
 *
 * **It is recomputed from scratch on every merge, never accumulated.** So a later op that
 * fixes the underlying cause automatically un-repairs: resurrect an account because a
 * merged-in transaction references it, then delete that transaction, and the account
 * returns to tombstoned by itself — with no new ops and no special case.
 *
 * That forces hard constraints on everything in this file. No `Date.now()`, no
 * `todayLocal()`, no `nowIso()`, no `makeId()`, no `Math.random()`, no locale-sensitive
 * comparison, and no reads of anything outside the arguments. Every one of those would
 * make two devices compute different repairs from the same input, which is exactly the
 * permanent divergence the op log exists to prevent.
 */

import type {
  Account,
  AppSettings,
  Budget,
  BudgetPeriodSnapshot,
  Category,
  EntityType,
  ExchangeRate,
  FinanceEntity,
  Goal,
  GoalContribution,
  RecurringRule,
  Tag,
  TransactionRecord,
} from '@/domain/models';
import { canActivateRecurringRule, goalCategoryKind } from '@/domain/rules';
import { compareInvariant, disambiguateNames } from '@/utils/naming';

export interface RepairInput {
  readonly settings: AppSettings | null;
  /** Tombstones included — resurrection and reference checks both need to see them. */
  readonly accounts: readonly Account[];
  readonly categories: readonly Category[];
  readonly tags: readonly Tag[];
  readonly transactions: readonly TransactionRecord[];
  readonly budgets: readonly Budget[];
  readonly budgetPeriods: readonly BudgetPeriodSnapshot[];
  readonly goals: readonly Goal[];
  readonly contributions: readonly GoalContribution[];
  readonly recurringRules: readonly RecurringRule[];
  readonly exchangeRates: readonly ExchangeRate[];
}

export type RepairCode =
  | 'duplicateOccurrence'
  | 'duplicateSnapshot'
  | 'duplicateRate'
  | 'accountResurrected'
  | 'accountCurrencyPinned'
  | 'referenceCleared'
  | 'budgetLimitDropped'
  | 'budgetFilterDropped'
  | 'budgetPeriodNormalized'
  | 'contributionOrphaned'
  | 'schedulePaused'
  | 'scheduleClamped'
  | 'nameDisambiguated';

export interface RepairNote {
  readonly code: RepairCode;
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly detail: string;
}

export interface RepairedRecord {
  readonly type: EntityType;
  readonly entity: FinanceEntity;
}

export interface RepairOutput extends RepairInput {
  /** Only the entities this pass actually changed. */
  readonly changed: readonly RepairedRecord[];
  readonly notes: readonly RepairNote[];
}

const isLive = (entity: FinanceEntity) => !entity.deletedAt;

/**
 * The one ordering used wherever a repair has to pick a winner.
 *
 * Deliberately *not* `compareStoredEntities` — that falls back to `localeCompare` on the
 * name, and locale-aware collation orders the same two strings differently in he-IL and
 * en-US. Two devices would then pick different winners and never converge. `createdAt` and
 * `id` are both locale-invariant and both stable.
 */
const byCreationThenId = (first: FinanceEntity, second: FinanceEntity) =>
  compareInvariant(first.createdAt, second.createdAt) || compareInvariant(first.id, second.id);

const byId = (first: FinanceEntity, second: FinanceEntity) =>
  compareInvariant(first.id, second.id);

/**
 * A mutable working set that remembers what it touched.
 *
 * Repair runs as a sequence of passes over the same entities, and a later pass has to see
 * an earlier one's output — resurrecting an account changes what "live account" means for
 * the reference checks that follow.
 */
class Draft {
  private readonly dirty = new Set<string>();
  readonly notes: RepairNote[] = [];

  constructor(private readonly tables: Map<EntityType, Map<string, FinanceEntity>>) {}

  all<T extends FinanceEntity>(type: EntityType): T[] {
    return [...(this.tables.get(type)?.values() ?? [])] as T[];
  }

  live<T extends FinanceEntity>(type: EntityType): T[] {
    return this.all<T>(type).filter(isLive);
  }

  get<T extends FinanceEntity>(type: EntityType, id: string | null): T | undefined {
    return id ? (this.tables.get(type)?.get(id) as T | undefined) : undefined;
  }

  liveIds(type: EntityType): Set<string> {
    return new Set(this.live(type).map((entity) => entity.id));
  }

  patch<T extends FinanceEntity>(type: EntityType, entity: T, changes: Partial<T>, note: RepairNote) {
    const next = { ...entity, ...changes } as FinanceEntity;
    this.tables.get(type)?.set(entity.id, next);
    this.dirty.add(`${type}:${entity.id}`);
    this.notes.push(note);
    return next as T;
  }

  changedRecords(): RepairedRecord[] {
    const records: RepairedRecord[] = [];
    for (const key of [...this.dirty].sort()) {
      const separator = key.indexOf(':');
      const type = key.slice(0, separator) as EntityType;
      const entity = this.tables.get(type)?.get(key.slice(separator + 1));
      if (entity) records.push({ type, entity });
    }
    return records;
  }
}

const tableOf = <T extends FinanceEntity>(entities: readonly T[]) =>
  new Map<string, FinanceEntity>(entities.map((entity) => [entity.id, entity]));

/** Repairs a merged set into one the finance core will accept. */
export function repairMergedState(input: RepairInput): RepairOutput {
  const tables = new Map<EntityType, Map<string, FinanceEntity>>([
    ['accounts', tableOf(input.accounts)],
    ['categories', tableOf(input.categories)],
    ['tags', tableOf(input.tags)],
    ['transactions', tableOf(input.transactions)],
    ['budgets', tableOf(input.budgets)],
    ['budgetPeriods', tableOf(input.budgetPeriods)],
    ['goals', tableOf(input.goals)],
    ['contributions', tableOf(input.contributions)],
    ['recurringRules', tableOf(input.recurringRules)],
    ['exchangeRates', tableOf(input.exchangeRates)],
  ]);
  const draft = new Draft(tables);

  collapseDuplicates(draft);
  resurrectReferencedAccounts(draft);
  pinAccountCurrencies(draft);
  clearDanglingReferences(draft);
  repairBudgets(draft);
  repairSchedules(draft);
  disambiguate(draft);

  return {
    settings: input.settings,
    accounts: draft.all<Account>('accounts'),
    categories: draft.all<Category>('categories'),
    tags: draft.all<Tag>('tags'),
    transactions: draft.all<TransactionRecord>('transactions'),
    budgets: draft.all<Budget>('budgets'),
    budgetPeriods: draft.all<BudgetPeriodSnapshot>('budgetPeriods'),
    goals: draft.all<Goal>('goals'),
    contributions: draft.all<GoalContribution>('contributions'),
    recurringRules: draft.all<RecurringRule>('recurringRules'),
    exchangeRates: draft.all<ExchangeRate>('exchangeRates'),
    changed: draft.changedRecords(),
    notes: draft.notes,
  };
}

// ---------------------------------------------------------------------------

/**
 * Collapses rows that two devices generated independently for the same logical thing.
 *
 * §2.10 prevents most of this by deriving the *id* from the occurrence key and the budget
 * period, so both devices produce the same entity id and the CRDT merges them into one row
 * by construction. What remains here is the legacy case: rows created before sync shipped,
 * which already have random ids and cannot be un-created.
 */
function collapseDuplicates(draft: Draft) {
  const groups = <T extends FinanceEntity>(entities: readonly T[], key: (entity: T) => string | null) => {
    const byKey = new Map<string, T[]>();
    for (const entity of entities) {
      const value = key(entity);
      if (value === null) continue;
      const list = byKey.get(value);
      if (list) list.push(entity);
      else byKey.set(value, [entity]);
    }
    // Both the group order and the order within a group are pinned, so the notes two
    // devices produce for the same merged set match as exactly as the records do.
    return [...byKey.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => [key, [...list].sort(byId)] as const)
      .sort(([first], [second]) => compareInvariant(first, second));
  };

  for (const [key, list] of groups(draft.live<TransactionRecord>('transactions'), (entity) => entity.occurrenceKey)) {
    const keeper = list[0];
    for (const loser of list) {
      if (loser.id === keeper.id) continue;
      // The occurrence key has to be cleared *before* the tombstone, not after: on the next
      // load `hydrateFromStorage` rebuilds its suppression set from tombstoned occurrence
      // keys, so a tombstone that still carries the key would permanently stop the survivor
      // from ever being regenerated.
      draft.patch<TransactionRecord>('transactions', loser, { occurrenceKey: null, deletedAt: loser.updatedAt }, {
        code: 'duplicateOccurrence',
        entityType: 'transactions',
        entityId: loser.id,
        detail: `Duplicate of ${keeper.id} for occurrence ${key}.`,
      });
    }
  }

  for (const [key, list] of groups(
    draft.live<BudgetPeriodSnapshot>('budgetPeriods'),
    (entity) => `${entity.budgetId}:${entity.periodStart}`,
  )) {
    const keeper = list[0];
    for (const loser of list) {
      if (loser.id === keeper.id) continue;
      // Two snapshots for one period make the history sort tie, `.at(-1)` pick arbitrarily,
      // and the rollover carried into the next period differ between devices — a wrong
      // number on screen rather than a crash, which is why it has to be collapsed.
      draft.patch<BudgetPeriodSnapshot>('budgetPeriods', loser, { deletedAt: loser.updatedAt }, {
        code: 'duplicateSnapshot',
        entityType: 'budgetPeriods',
        entityId: loser.id,
        detail: `Duplicate of ${keeper.id} for period ${key}.`,
      });
    }
  }

  for (const [key, list] of groups(
    draft.live<ExchangeRate>('exchangeRates'),
    (entity) => `${entity.fromCurrency}:${entity.toCurrency}:${entity.effectiveDate}`,
  )) {
    const keeper = list[0];
    for (const loser of list) {
      if (loser.id === keeper.id) continue;
      // `directOrInverseRate` breaks ties by whatever it finds first, so two rows for the
      // same pair and date convert the *same transaction* differently on two phones.
      draft.patch<ExchangeRate>('exchangeRates', loser, { deletedAt: loser.updatedAt }, {
        code: 'duplicateRate',
        entityType: 'exchangeRates',
        entityId: loser.id,
        detail: `Duplicate of ${keeper.id} for ${key}.`,
      });
    }
  }
}

/**
 * Brings back a tombstoned account that something live still points at.
 *
 * `deleteEntities` deliberately archives rather than deletes an account that is referenced,
 * because an account is part of the identity of every ledger entry booked against it — the
 * currency, the balance, the conversion. A merge can produce the state the repository
 * refuses to create: A deletes an account it believes unused while B books a transaction on
 * it. Archived-and-live is the state the repository would have chosen, so that is what this
 * restores. Categories, tags, and goals can legitimately be nulled instead, and are.
 */
function resurrectReferencedAccounts(draft: Draft) {
  const referenced = new Set<string>();
  for (const transaction of draft.live<TransactionRecord>('transactions')) {
    referenced.add(transaction.accountId);
    if (transaction.destinationAccountId) referenced.add(transaction.destinationAccountId);
  }
  for (const rule of draft.live<RecurringRule>('recurringRules')) referenced.add(rule.template.accountId);
  for (const budget of draft.live<Budget>('budgets')) {
    for (const id of budget.filters.accountIds) referenced.add(id);
  }
  for (const goal of draft.live<Goal>('goals')) {
    if (goal.linkedAccountId) referenced.add(goal.linkedAccountId);
  }

  for (const account of draft.all<Account>('accounts').sort(byCreationThenId)) {
    if (isLive(account) || !referenced.has(account.id)) continue;
    draft.patch<Account>('accounts', account, { deletedAt: null, archived: true }, {
      code: 'accountResurrected',
      entityType: 'accounts',
      entityId: account.id,
      detail: 'Restored as archived because a transaction or schedule still uses it.',
    });
  }
}

/**
 * Forces an account's currency to agree with the transactions booked against it.
 *
 * `saveAccount` only allows a currency change while nothing references the account, but a
 * merge can reach the forbidden state — and it is silent, because `assertTransactionSetSafe`
 * sums `amountMinor` straight into the balance with no currency check at all. The
 * transaction snapshot wins, which is the whole reason each row stores its own
 * `exchangeRate` and `baseAmountMinor`: those numbers were computed against the currency
 * the transaction recorded, and no amount of re-basing the account can make them describe
 * a different one.
 */
function pinAccountCurrencies(draft: Draft) {
  const observed = new Map<string, TransactionRecord>();
  for (const transaction of draft.live<TransactionRecord>('transactions').sort(byCreationThenId)) {
    if (!observed.has(transaction.accountId)) observed.set(transaction.accountId, transaction);
    if (transaction.destinationAccountId && !observed.has(transaction.destinationAccountId)) {
      observed.set(transaction.destinationAccountId, transaction);
    }
  }

  for (const account of draft.live<Account>('accounts').sort(byCreationThenId)) {
    const transaction = observed.get(account.id);
    if (!transaction) continue;
    const currency =
      transaction.accountId === account.id ? transaction.currency : transaction.destinationCurrency;
    if (!currency || currency === account.currency) continue;
    draft.patch<Account>('accounts', account, { currency }, {
      code: 'accountCurrencyPinned',
      entityType: 'accounts',
      entityId: account.id,
      detail: `Set to ${currency} to match transaction ${transaction.id}.`,
    });
  }
}

/**
 * Nulls every reference whose target is gone, mismatched, or otherwise unusable.
 *
 * Each rule mirrors one the repository already enforces on save — the merged set has to
 * pass the same validators the user's next edit will run, or that edit fails with an error
 * about something they never touched.
 */
function clearDanglingReferences(draft: Draft) {
  const liveCategories = new Map(draft.live<Category>('categories').map((entity) => [entity.id, entity]));
  const liveTags = draft.liveIds('tags');
  const liveAccounts = draft.liveIds('accounts');
  const liveRules = draft.liveIds('recurringRules');
  const liveGoals = draft.liveIds('goals');
  const liveTransactions = draft.liveIds('transactions');

  // Categories are one level deep: a parent may not itself have a parent, must share the
  // child's kind, and must not be the child. Anything else is a hierarchy the UI cannot render.
  for (const category of draft.live<Category>('categories').sort(byCreationThenId)) {
    if (!category.parentId) continue;
    const parent = liveCategories.get(category.parentId);
    if (parent && parent.kind === category.kind && !parent.parentId && parent.id !== category.id) continue;
    draft.patch<Category>('categories', category, { parentId: null }, {
      code: 'referenceCleared',
      entityType: 'categories',
      entityId: category.id,
      detail: 'Parent category is missing, deleted, or not a valid parent.',
    });
  }

  for (const transaction of draft.live<TransactionRecord>('transactions').sort(byCreationThenId)) {
    const changes: Partial<TransactionRecord> = {};
    const details: string[] = [];

    if (transaction.categoryId) {
      const category = liveCategories.get(transaction.categoryId);
      const expected = transaction.kind === 'transfer' ? null : transaction.kind;
      if (!expected || !category || category.kind !== expected) {
        changes.categoryId = null;
        details.push(
          expected ? 'Category is missing, deleted, or the wrong kind.' : 'Transfers cannot carry a category.',
        );
      }
    }
    const tagIds = transaction.tagIds.filter((id) => liveTags.has(id));
    if (tagIds.length !== transaction.tagIds.length) {
      changes.tagIds = tagIds;
      details.push('Dropped tags that no longer exist.');
    }
    if (transaction.recurringRuleId && !liveRules.has(transaction.recurringRuleId)) {
      changes.recurringRuleId = null;
      details.push('Recurring schedule is gone.');
    }
    if (details.length) {
      draft.patch<TransactionRecord>('transactions', transaction, changes, {
        code: 'referenceCleared',
        entityType: 'transactions',
        entityId: transaction.id,
        detail: details.join(' '),
      });
    }
  }

  for (const goal of draft.live<Goal>('goals').sort(byCreationThenId)) {
    const changes: Partial<Goal> = {};
    const details: string[] = [];
    if (goal.linkedAccountId && !liveAccounts.has(goal.linkedAccountId)) {
      changes.linkedAccountId = null;
      details.push('Linked account is gone.');
    }
    if (goal.linkedCategoryId) {
      const category = liveCategories.get(goal.linkedCategoryId);
      if (!category || category.kind !== goalCategoryKind(goal.kind)) {
        changes.linkedCategoryId = null;
        details.push(`Linked category must be ${goalCategoryKind(goal.kind)}.`);
      }
    }
    if (details.length) {
      draft.patch<Goal>('goals', goal, changes, {
        code: 'referenceCleared',
        entityType: 'goals',
        entityId: goal.id,
        detail: details.join(' '),
      });
    }
  }

  for (const contribution of draft.live<GoalContribution>('contributions').sort(byCreationThenId)) {
    // `goalId` is immutable, so a contribution whose goal is gone has nothing to point at
    // and no way to be re-homed. Tombstoning it is what `deleteEntities` already does.
    if (!liveGoals.has(contribution.goalId)) {
      draft.patch<GoalContribution>('contributions', contribution, { deletedAt: contribution.updatedAt }, {
        code: 'contributionOrphaned',
        entityType: 'contributions',
        entityId: contribution.id,
        detail: `Goal ${contribution.goalId} no longer exists.`,
      });
      continue;
    }
    if (contribution.transactionId && !liveTransactions.has(contribution.transactionId)) {
      draft.patch<GoalContribution>('contributions', contribution, { transactionId: null }, {
        code: 'referenceCleared',
        entityType: 'contributions',
        entityId: contribution.id,
        detail: 'Linked transaction is gone.',
      });
    }
  }

  for (const rule of draft.live<RecurringRule>('recurringRules').sort(byCreationThenId)) {
    const template = rule.template;
    const details: string[] = [];
    let categoryId = template.categoryId;
    if (categoryId) {
      const category = liveCategories.get(categoryId);
      if (!category || category.kind !== template.kind) {
        categoryId = null;
        details.push('Category is missing, deleted, or the wrong kind.');
      }
    }
    const tagIds = template.tagIds.filter((id) => liveTags.has(id));
    if (tagIds.length !== template.tagIds.length) details.push('Dropped tags that no longer exist.');
    if (!details.length) continue;
    draft.patch<RecurringRule>('recurringRules', rule, { template: { ...template, categoryId, tagIds } }, {
      code: 'referenceCleared',
      entityType: 'recurringRules',
      entityId: rule.id,
      detail: details.join(' '),
    });
  }
}

/**
 * Makes every merged budget satisfy `validateBudget`.
 *
 * The limits-must-be-a-subset-of-filters rule is the one that bites hardest: A removes a
 * category from the filters while B adds a spending limit for it, and the merged budget can
 * never be saved again — every future edit throws on a field the user cannot see. The limit
 * is dropped rather than the filter restored, which is what `deleteEntities` already does
 * when a category goes away.
 */
function repairBudgets(draft: Draft) {
  const liveAccounts = draft.liveIds('accounts');
  const liveTags = draft.liveIds('tags');
  const expenseCategories = new Set(
    draft.live<Category>('categories').filter((category) => category.kind === 'expense').map((category) => category.id),
  );

  for (const budget of draft.live<Budget>('budgets').sort(byCreationThenId)) {
    const changes: Partial<Budget> = {};
    const details: string[] = [];

    const accountIds = budget.filters.accountIds.filter((id) => liveAccounts.has(id));
    const categoryIds = budget.filters.categoryIds.filter((id) => expenseCategories.has(id));
    const tagIds = budget.filters.tagIds.filter((id) => liveTags.has(id));
    if (
      accountIds.length !== budget.filters.accountIds.length ||
      categoryIds.length !== budget.filters.categoryIds.length ||
      tagIds.length !== budget.filters.tagIds.length
    ) {
      changes.filters = { accountIds, categoryIds, tagIds };
      details.push('Dropped filters whose target is gone.');
    }

    const allowed = new Set(categoryIds);
    const seen = new Set<string>();
    const categoryLimits = budget.categoryLimits.filter((limit) => {
      if (!allowed.has(limit.categoryId) || seen.has(limit.categoryId)) return false;
      seen.add(limit.categoryId);
      return true;
    });
    if (categoryLimits.length !== budget.categoryLimits.length) {
      changes.categoryLimits = categoryLimits;
      details.push('Dropped category limits outside the budget filters.');
    }

    // `validateBudget` requires an end date for a custom period and forbids one otherwise.
    // A merge of two `period` groups cannot produce a mismatch, but a rollover from an older
    // build can, and the cost of checking is nothing.
    if (budget.period.unit !== 'custom' && budget.period.endDate !== null) {
      changes.period = { ...budget.period, endDate: null };
      details.push('Cleared an end date on a repeating budget.');
    }

    if (details.length) {
      draft.patch<Budget>('budgets', budget, changes, {
        code: changes.categoryLimits ? 'budgetLimitDropped' : changes.filters ? 'budgetFilterDropped' : 'budgetPeriodNormalized',
        entityType: 'budgets',
        entityId: budget.id,
        detail: details.join(' '),
      });
    }
  }
}

/** Recomputes the derived schedule fields against the merged accounts and categories. */
function repairSchedules(draft: Draft) {
  const accounts = draft.live<Account>('accounts');
  const categories = draft.live<Category>('categories');

  for (const rule of draft.live<RecurringRule>('recurringRules').sort(byCreationThenId)) {
    // A `schedule`-group write can legitimately move `startDate` past the pointer, and the
    // pointer is monotone so it cannot follow on its own.
    const nextDueDate = rule.nextDueDate < rule.startDate ? rule.startDate : rule.nextDueDate;
    const clamped = nextDueDate === rule.nextDueDate ? rule : { ...rule, nextDueDate };
    const paused = !canActivateRecurringRule(clamped, accounts, categories);

    if (nextDueDate !== rule.nextDueDate) {
      draft.patch<RecurringRule>('recurringRules', rule, { nextDueDate, pausedByDependency: paused }, {
        code: 'scheduleClamped',
        entityType: 'recurringRules',
        entityId: rule.id,
        detail: `Next run moved to ${nextDueDate} to match the schedule start.`,
      });
      continue;
    }
    if (paused !== rule.pausedByDependency) {
      draft.patch<RecurringRule>('recurringRules', rule, { pausedByDependency: paused }, {
        code: 'schedulePaused',
        entityType: 'recurringRules',
        entityId: rule.id,
        detail: paused ? 'Paused: an account or category it needs is unavailable.' : 'Resumed.',
      });
    }
  }
}

/**
 * Renames colliding accounts, categories, and tags.
 *
 * `assertUniqueName` rejects a duplicate on save, so a merged set containing two
 * "Groceries" categories is one where the user's next category edit fails. Renaming is
 * deterministic; deciding the two are the *same* category is not, and that judgement belongs
 * to the person on the merge review screen.
 */
function disambiguate(draft: Draft) {
  const rename = <T extends Account | Category | Tag>(type: EntityType) => {
    const entities = draft.live<T>(type);
    for (const { id, name } of disambiguateNames(entities)) {
      const entity = draft.get<T>(type, id);
      if (!entity) continue;
      draft.patch<T>(type, entity, { name } as Partial<T>, {
        code: 'nameDisambiguated',
        entityType: type,
        entityId: id,
        detail: `Renamed to "${name}" because another entry already used that name.`,
      });
    }
  };
  rename<Account>('accounts');
  rename<Category>('categories');
  rename<Tag>('tags');
}
