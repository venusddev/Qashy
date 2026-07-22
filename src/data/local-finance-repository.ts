import { Decimal } from 'decimal.js';
import { z } from 'zod';

import { PlatformStorageAdapter } from '@/data/storage';
import type { StorageAdapter, StoredEntity } from '@/data/storage-adapter';
import type {
  Account,
  AppSettings,
  Budget,
  BudgetFilters,
  BudgetPeriodSnapshot,
  BudgetStatus,
  Category,
  CsvImportRow,
  DashboardSummary,
  EntityType,
  ExchangeRate,
  FinanceEntity,
  FinanceState,
  Goal,
  GoalContribution,
  ImportResult,
  RecurringRule,
  Tag,
  TransactionQuery,
  TransactionRecord,
} from '@/domain/models';
import type {
  AccountInput,
  BudgetInput,
  CategoryInput,
  ContributionInput,
  FinanceRepository,
  GoalInput,
  GoalContributionInput,
  OnboardingInput,
  RateInput,
  RecurringInput,
  TagInput,
  TransactionInput,
} from '@/data/repository';
import { createDefaultCategories, createInitialState, defaultAccountName, initialSettings } from '@/domain/defaults';
import {
  addRecurrence,
  firstRecurrenceOnOrAfter,
  isLocalDate,
  todayLocal,
} from '@/utils/date';
import { createEntity, makeId, nowIso, updateEntity } from '@/utils/entity';
import { escapeCsv } from '@/utils/csv';
import { validateLocale } from '@/utils/form-validation';
import {
  addMinor,
  convertMinor,
  isSafeMinor,
  isSupportedCurrencyCode,
  minorToDecimalString,
  parseInvariantMoney,
  subtractMinor,
  sumMinor,
} from '@/utils/money';
import { resolvePeriod } from '@/utils/period';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_TYPES = ['cash', 'checking', 'savings', 'credit', 'wallet'] as const;
const CATEGORY_KINDS = ['expense', 'income'] as const;
const GOAL_KINDS = ['saving', 'spending'] as const;
const TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;
const TRANSACTION_STATUSES = ['posted', 'upcoming', 'skipped'] as const;
const PERIOD_UNITS = ['day', 'week', 'month', 'year', 'custom'] as const;
const RECURRENCE_UNITS = ['day', 'week', 'month', 'year'] as const;
const THEME_MODES = ['system', 'light', 'dark'] as const;
const ACCENT_SOURCES = ['system', 'preset', 'custom'] as const;
const MAX_RECURRING_OCCURRENCES_PER_RUN = 100_000;
// How far a manually entered rate may sit from the reciprocal of an existing
// opposite-direction rate before the pair is treated as contradictory (2%).
const RECIPROCAL_RATE_TOLERANCE = 0.02;
const csvRowSchema = z.object({
  rowNumber: z.number(),
  date: z.string().regex(DATE_PATTERN).refine(isLocalDate, 'Enter a real calendar date.'),
  type: z.enum(TRANSACTION_TYPES),
  status: z.enum(TRANSACTION_STATUSES).default('posted'),
  title: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()),
  account: z.string().min(1),
  category: z.string().default(''),
  tags: z.string().default(''),
  note: z.string().default(''),
  exchangeRate: z.string().default(''),
  destinationAccount: z.string().default(''),
  destinationAmount: z.string().default(''),
  destinationBaseAmountMinor: z.string().default(''),
});

const ENTITY_TYPES: EntityType[] = [
  'accounts',
  'categories',
  'tags',
  'transactions',
  'budgets',
  'budgetPeriods',
  'goals',
  'contributions',
  'recurringRules',
  'exchangeRates',
];

type ListKey = Exclude<EntityType, 'settings'>;

export class LocalFinanceRepository implements FinanceRepository {
  private state = createInitialState();
  private listeners = new Set<() => void>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private deletedOccurrenceKeys = new Set<string>();

  constructor(private storage: StorageAdapter = new PlatformStorageAdapter()) {}

  initialize() {
    return this.enqueueMutation(() => this.initializeNow());
  }

  private async initializeNow() {
    await this.storage.initialize();
    const settingsRecords = await this.storage.readAll('settings');
    const settings = (settingsRecords.find((item) => item.id === 'settings' && !item.deletedAt) ??
      initialSettings()) as AppSettings;

    const loaded = await Promise.all(ENTITY_TYPES.map((type) => this.storage.readAll(type)));
    const loadedTransactions = loaded[ENTITY_TYPES.indexOf('transactions')] as TransactionRecord[];
    this.deletedOccurrenceKeys = new Set(
      loadedTransactions
        .filter((transaction) => transaction.deletedAt && transaction.occurrenceKey)
        .map((transaction) => transaction.occurrenceKey!),
    );
    const next = { ...createInitialState(), settings, ready: true } as FinanceState;
    ENTITY_TYPES.forEach((type, index) => {
      (next[type] as FinanceEntity[]) = loaded[index].filter((entity) => !entity.deletedAt);
    });
    this.state = next;
    await this.migrateLoadedState();
    if (!settingsRecords.length) await this.persist('settings', [settings]);
    await this.generateRecurringNow(addRecurrence(todayLocal(), 'month', 1));
    this.emit();
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  completeOnboarding(input: OnboardingInput) {
    return this.enqueueMutation(() => this.completeOnboardingNow(input));
  }

  private async completeOnboardingNow(input: OnboardingInput) {
    if (this.state.settings.onboardingComplete) throw new Error('Qashy setup is already complete.');
    this.assertLocale(input.locale);
    const baseCurrency = this.normalizeCurrency(input.baseCurrency);
    this.assertSafeMinor(input.openingBalanceMinor, 'Opening balance');
    this.assertColor(input.accentHex);
    if (!ACCOUNT_TYPES.includes(input.accountType)) throw new Error('Choose a valid account type.');
    if (!THEME_MODES.includes(input.themeMode)) throw new Error('Choose a valid theme mode.');
    if (!ACCENT_SOURCES.includes(input.accentSource)) throw new Error('Choose a valid accent source.');
    const settings = updateEntity(this.state.settings, {
      onboardingComplete: true,
      locale: input.locale,
      baseCurrency,
      themeMode: input.themeMode,
      accentSource: input.accentSource,
      accentHex: input.accentHex.toUpperCase(),
    });
    const account = createEntity({
      id: makeId(),
      name: input.accountName.trim() || defaultAccountName(input.locale),
      type: input.accountType,
      currency: baseCurrency,
      openingBalanceMinor: input.openingBalanceMinor,
      icon: 'wallet.bifold',
      color: input.accentHex.toUpperCase(),
      archived: false,
    });
    const categories = createDefaultCategories(input.locale);
    await this.storage.putMany([
      { type: 'settings', entity: settings },
      { type: 'accounts', entity: account },
      ...categories.map((entity) => ({ type: 'categories' as const, entity })),
    ]);
    this.state = { ...this.state, settings, accounts: [account], categories };
    this.emit();
  }

  updateSettings(patch: Partial<AppSettings>) {
    return this.enqueueMutation(() => this.updateSettingsNow(patch));
  }

  private async updateSettingsNow(patch: Partial<AppSettings>) {
    const locale = patch.locale ?? this.state.settings.locale;
    const baseCurrency = this.normalizeCurrency(patch.baseCurrency ?? this.state.settings.baseCurrency);
    this.assertLocale(locale);
    this.assertColor(patch.accentHex ?? this.state.settings.accentHex);
    const themeMode = patch.themeMode ?? this.state.settings.themeMode;
    const accentSource = patch.accentSource ?? this.state.settings.accentSource;
    if (!THEME_MODES.includes(themeMode)) throw new Error('Choose a valid theme mode.');
    if (!ACCENT_SOURCES.includes(accentSource)) throw new Error('Choose a valid accent source.');
    if (baseCurrency !== this.state.settings.baseCurrency && this.state.settings.onboardingComplete) {
      throw new Error('Base currency cannot change after setup is complete.');
    }
    const settings = updateEntity(this.state.settings, {
      onboardingComplete: patch.onboardingComplete ?? this.state.settings.onboardingComplete,
      locale,
      baseCurrency,
      themeMode,
      accentSource,
      accentHex: (patch.accentHex ?? this.state.settings.accentHex).toUpperCase(),
    });
    await this.persist('settings', [settings]);
    this.state = { ...this.state, settings };
    this.emit();
    return settings;
  }

  saveAccount(input: AccountInput, id?: string) {
    return this.enqueueMutation(() => this.saveAccountNow(input, id));
  }

  private async saveAccountNow(input: AccountInput, id?: string) {
    const currency = this.normalizeCurrency(input.currency);
    this.assertSafeMinor(input.openingBalanceMinor, 'Opening balance');
    this.assertColor(input.color);
    if (!ACCOUNT_TYPES.includes(input.type)) throw new Error('Choose a valid account type.');
    const name = input.name.trim() || 'Account';
    this.assertUniqueName('accounts', name, id);
    const existing = this.findExisting(this.state.accounts, id, 'account');
    if (existing && existing.currency !== currency) {
      const hasTransactions = this.state.transactions.some((item) =>
        item.accountId === existing.id || item.destinationAccountId === existing.id,
      );
      const hasRules = this.state.recurringRules.some((item) => item.template.accountId === existing.id);
      if (hasTransactions || hasRules) {
        throw new Error('Account currency cannot change after transactions or schedules reference it.');
      }
    }
    const account = existing
      ? updateEntity(existing, { ...input, name, currency, color: input.color.toUpperCase() })
      : createEntity({ id: makeId(), ...input, name, currency, color: input.color.toUpperCase() }) as Account;
    const accounts = this.withEntity(this.state.accounts, account);
    this.assertTransactionSetSafe(this.state.transactions, accounts);
    const rules = input.archived
      ? this.state.recurringRules
        .filter((rule) => rule.active && rule.template.accountId === account.id)
        .map((rule) => updateEntity(rule, { active: false, pausedByDependency: true }))
      : existing?.archived
        ? this.state.recurringRules
          .filter((rule) =>
            !rule.active &&
            rule.pausedByDependency &&
            rule.template.accountId === account.id &&
            this.canActivateRecurringRule(rule, accounts, this.state.categories),
          )
          .map((rule) => updateEntity(rule, { active: true, pausedByDependency: false }))
        : [];
    await this.storage.putMany([
      { type: 'accounts', entity: account },
      ...rules.map((entity) => ({ type: 'recurringRules' as const, entity })),
    ]);
    this.replaceInList('accounts', account);
    rules.forEach((rule) => this.replaceInList('recurringRules', rule));
    this.emit();
    if (rules.some((rule) => rule.active)) {
      await this.generateRecurringNow(addRecurrence(todayLocal(), 'month', 1));
    }
    return account;
  }

  saveCategory(input: CategoryInput, id?: string) {
    return this.enqueueMutation(() => this.saveCategoryNow(input, id));
  }

  private async saveCategoryNow(input: CategoryInput, id?: string) {
    const name = input.name.trim() || 'Category';
    this.assertUniqueName('categories', name, id);
    this.assertColor(input.color);
    if (!CATEGORY_KINDS.includes(input.kind)) throw new Error('Choose a valid category kind.');
    const existing = this.findExisting(this.state.categories, id, 'category');
    if (existing && existing.kind !== input.kind) {
      const isReferenced = this.state.transactions.some((item) => item.categoryId === existing.id) ||
        this.state.recurringRules.some((item) => item.template.categoryId === existing.id) ||
        this.state.budgets.some((item) => item.filters.categoryIds.includes(existing.id)) ||
        this.state.goals.some((item) => item.linkedCategoryId === existing.id);
      if (isReferenced) throw new Error('Category kind cannot change after finance records reference it.');
    }
    if (input.parentId) {
      const parent = this.state.categories.find((item) => item.id === input.parentId);
      const preservesArchivedParent = !!existing && existing.parentId === parent?.id;
      if (!parent || (!preservesArchivedParent && parent.archived) || parent.kind !== input.kind || parent.parentId || parent.id === id) {
        throw new Error('Choose a valid top-level parent category of the same kind.');
      }
      if (existing && this.state.categories.some((item) => item.parentId === existing.id)) {
        throw new Error('A category with child categories cannot also have a parent.');
      }
    }
    const values = {
      ...input,
      name,
      color: input.color.toUpperCase(),
    };
    const category = existing ? updateEntity(existing, values) : createEntity({ id: makeId(), ...values }) as Category;
    const categories = this.withEntity(this.state.categories, category);
    const rules = input.archived
      ? this.state.recurringRules
        .filter((rule) => rule.active && rule.template.categoryId === category.id)
        .map((rule) => updateEntity(rule, { active: false, pausedByDependency: true }))
      : existing?.archived
        ? this.state.recurringRules
          .filter((rule) =>
            !rule.active &&
            rule.pausedByDependency &&
            rule.template.categoryId === category.id &&
            this.canActivateRecurringRule(rule, this.state.accounts, categories),
          )
          .map((rule) => updateEntity(rule, { active: true, pausedByDependency: false }))
        : [];
    await this.storage.putMany([
      { type: 'categories', entity: category },
      ...rules.map((entity) => ({ type: 'recurringRules' as const, entity })),
    ]);
    this.replaceInList('categories', category);
    rules.forEach((rule) => this.replaceInList('recurringRules', rule));
    this.emit();
    if (rules.some((rule) => rule.active)) {
      await this.generateRecurringNow(addRecurrence(todayLocal(), 'month', 1));
    }
    return category;
  }

  saveTag(input: TagInput, id?: string) {
    return this.enqueueMutation(() => this.saveTagNow(input, id));
  }

  private async saveTagNow(input: TagInput, id?: string) {
    const name = input.name.trim();
    if (!name) throw new Error('Tag name is required.');
    this.assertUniqueName('tags', name, id);
    this.assertColor(input.color);
    return await this.saveListEntity<Tag>('tags', { ...input, name, color: input.color.toUpperCase() }, id);
  }

  saveTransaction(input: TransactionInput, id?: string) {
    return this.enqueueMutation(() => this.saveTransactionNow(input, id));
  }

  private async saveTransactionNow(input: TransactionInput, id?: string) {
    const transaction = this.buildTransaction(input, id);
    this.assertTransactionSetSafe(this.withEntity(this.state.transactions, transaction));
    await this.persist('transactions', [transaction]);
    this.replaceInList('transactions', transaction);
    this.emit();
    return transaction;
  }

  saveBudget(input: BudgetInput, id?: string) {
    return this.enqueueMutation(() => this.saveBudgetNow(input, id));
  }

  private async saveBudgetNow(input: BudgetInput, id?: string) {
    const normalized = this.validateBudget(input);
    const existing = this.findExisting(this.state.budgets, id, 'budget');
    const budget = existing
      ? updateEntity(existing, normalized)
      : createEntity({ id: makeId(), ...normalized }) as Budget;
    const periods = this.buildBudgetSnapshots(budget, true);
    periods.forEach((period) => {
      addMinor(period.limitMinor, period.rolloverMinor, `${budget.name} effective limit`);
    });
    await this.storage.putMany([
      { type: 'budgets', entity: budget },
      ...periods.map((entity) => ({ type: 'budgetPeriods' as const, entity })),
    ]);
    this.replaceInList('budgets', budget);
    periods.forEach((period) => this.replaceInList('budgetPeriods', period));
    this.emit();
    return budget;
  }

  saveGoal(input: GoalInput, id?: string) {
    return this.enqueueMutation(() => this.saveGoalAndContributionNow(input, undefined, id));
  }

  saveGoalAndContribution(
    input: GoalInput,
    contribution?: GoalContributionInput,
    id?: string,
  ) {
    return this.enqueueMutation(() => this.saveGoalAndContributionNow(input, contribution, id));
  }

  private async saveGoalAndContributionNow(
    input: GoalInput,
    contribution?: GoalContributionInput,
    id?: string,
  ) {
    const normalized = this.validateGoal(input, id);
    const existing = this.findExisting(this.state.goals, id, 'goal');
    const goal = existing
      ? updateEntity(existing, normalized)
      : createEntity({ id: makeId(), ...normalized }) as Goal;
    let contributionEntity: GoalContribution | undefined;
    if (contribution) {
      this.assertPositiveMinor(contribution.amountMinor, 'Contribution');
      this.assertDate(contribution.localDate);
      if (
        contribution.transactionId &&
        !this.state.transactions.some((item) => item.id === contribution.transactionId)
      ) {
        throw new Error('Choose a valid transaction.');
      }
      contributionEntity = createEntity({
        id: makeId(),
        ...contribution,
        goalId: goal.id,
        note: contribution.note.trim(),
      }) as GoalContribution;
    }
    const goals = this.withEntity(this.state.goals, goal);
    const contributions = contributionEntity
      ? [...this.state.contributions, contributionEntity]
      : this.state.contributions;
    this.assertGoalProgressSafe(goal.id, goals, contributions);
    await this.storage.putMany([
      { type: 'goals', entity: goal },
      ...(contributionEntity
        ? [{ type: 'contributions' as const, entity: contributionEntity }]
        : []),
    ]);
    // Re-derive from the post-await snapshot rather than reusing the `goals` /
    // `contributions` copies taken before the write. Another mutation can land
    // while the persist is in flight, and rebuilding from the stale copy drops
    // it from the in-memory state while it stays on disk — the UI then shows a
    // goal total that disagrees with the database until the next reload.
    this.state = {
      ...this.state,
      goals: this.withEntity(this.state.goals, goal),
      contributions: contributionEntity ? this.withEntity(this.state.contributions, contributionEntity) : this.state.contributions,
    };
    this.emit();
    return goal;
  }

  saveContribution(input: ContributionInput, id?: string) {
    return this.enqueueMutation(() => this.saveContributionNow(input, id));
  }

  private async saveContributionNow(input: ContributionInput, id?: string) {
    this.assertPositiveMinor(input.amountMinor, 'Contribution');
    this.assertDate(input.localDate);
    if (!this.state.goals.some((item) => item.id === input.goalId)) throw new Error('Choose a valid goal.');
    if (input.transactionId && !this.state.transactions.some((item) => item.id === input.transactionId)) {
      throw new Error('Choose a valid transaction.');
    }
    const existing = this.findExisting(this.state.contributions, id, 'contribution');
    const contribution = existing
      ? updateEntity(existing, { ...input, note: input.note.trim() })
      : createEntity({ id: makeId(), ...input, note: input.note.trim() }) as GoalContribution;
    const contributions = this.withEntity(this.state.contributions, contribution);
    this.assertGoalProgressSafe(input.goalId, this.state.goals, contributions);
    await this.persist('contributions', [contribution]);
    this.replaceInList('contributions', contribution);
    this.emit();
    return contribution;
  }

  saveRecurringRule(input: RecurringInput, id?: string) {
    return this.enqueueMutation(() => this.saveRecurringRuleNow(input, id));
  }

  private async saveRecurringRuleNow(input: RecurringInput, id?: string) {
    const existing = this.findExisting(this.state.recurringRules, id, 'recurring rule');
    const scheduleChanged = !!existing && (
      existing.unit !== input.unit ||
      existing.interval !== input.interval ||
      existing.startDate !== input.startDate ||
      existing.endDate !== input.endDate
    );
    const templateChanged = !!existing && (
      existing.template.kind !== input.template.kind ||
      existing.template.title !== input.template.title ||
      existing.template.note !== input.template.note ||
      existing.template.accountId !== input.template.accountId ||
      existing.template.categoryId !== input.template.categoryId ||
      existing.template.amountMinor !== input.template.amountMinor ||
      existing.template.currency !== input.template.currency ||
      JSON.stringify(existing.template.tagIds) !== JSON.stringify(input.template.tagIds)
    );
    const currentUpcoming = existing
      ? this.state.transactions.filter((transaction) =>
        transaction.recurringRuleId === existing.id && transaction.status === 'upcoming',
      )
      : [];
    const earliestUpcomingDate = currentUpcoming
      .map((transaction) => transaction.localDate)
      .sort()[0];
    const nextInput = scheduleChanged
      ? {
        ...input,
        nextDueDate: firstRecurrenceOnOrAfter(
          input.startDate,
          input.unit,
          input.interval,
          [input.startDate, earliestUpcomingDate ?? existing.nextDueDate, todayLocal()].sort().at(-1)!,
        ),
      }
      : input;
    const normalized = this.validateRecurring(nextInput, id);
    const pausedByDependency = Boolean(
      existing?.pausedByDependency && input.active && !normalized.active,
    );
    const rule = existing
      ? updateEntity(existing, { ...normalized, pausedByDependency })
      : createEntity({ id: makeId(), ...normalized, pausedByDependency: false }) as RecurringRule;
    const transactionChanges = scheduleChanged
      ? currentUpcoming.map((transaction) => updateEntity(transaction, {
        deletedAt: nowIso(),
        occurrenceKey: null,
      }))
      : templateChanged
        ? currentUpcoming.map((transaction) => this.buildTransaction({
          ...normalized.template,
          localDate: transaction.localDate,
          status: transaction.status,
          exchangeRate: transaction.accountId === normalized.template.accountId
            ? transaction.exchangeRate
            : undefined,
          recurringRuleId: rule.id,
          occurrenceKey: transaction.occurrenceKey,
        }, transaction.id))
        : [];
    await this.storage.putMany([
      { type: 'recurringRules', entity: rule },
      ...transactionChanges.map((entity) => ({ type: 'transactions' as const, entity })),
    ]);
    const replacements = new Map(
      transactionChanges
        .filter((transaction) => !transaction.deletedAt)
        .map((transaction) => [transaction.id, transaction]),
    );
    const removedIds = new Set(
      transactionChanges
        .filter((transaction) => transaction.deletedAt)
        .map((transaction) => transaction.id),
    );
    this.state = {
      ...this.state,
      recurringRules: this.withEntity(this.state.recurringRules, rule),
      transactions: this.state.transactions
        .filter((transaction) => !removedIds.has(transaction.id))
        .map((transaction) => replacements.get(transaction.id) ?? transaction),
    };
    this.emit();
    if (rule.active) await this.generateRecurringNow(addRecurrence(todayLocal(), 'month', 1));
    return rule;
  }

  saveExchangeRate(input: RateInput, id?: string) {
    return this.enqueueMutation(() => this.saveExchangeRateNow(input, id));
  }

  private async saveExchangeRateNow(input: RateInput, id?: string) {
    const fromCurrency = this.normalizeCurrency(input.fromCurrency);
    const toCurrency = this.normalizeCurrency(input.toCurrency);
    if (fromCurrency === toCurrency) throw new Error('Exchange-rate currencies must be different.');
    this.assertDate(input.effectiveDate);
    const rate = this.normalizeRate(input.rate);
    const duplicate = this.state.exchangeRates.find((item) =>
      item.id !== id && item.fromCurrency === fromCurrency && item.toCurrency === toCurrency &&
      item.effectiveDate === input.effectiveDate,
    );
    if (duplicate) throw new Error('A rate already exists for this currency pair and date.');
    this.assertReciprocalRate(fromCurrency, toCurrency, rate, input.effectiveDate, id);
    return await this.saveListEntity<ExchangeRate>('exchangeRates', {
      ...input,
      fromCurrency,
      toCurrency,
      rate,
    }, id);
  }

  queryTransactions(query: TransactionQuery = {}) {
    const normalizedSearch = query.search?.trim().toLocaleLowerCase();
    let result = this.active(this.state.transactions).filter((transaction) => {
      if (normalizedSearch && !`${transaction.title} ${transaction.note}`.toLocaleLowerCase().includes(normalizedSearch)) return false;
      if (
        query.accountIds?.length &&
        !query.accountIds.includes(transaction.accountId) &&
        !(transaction.kind === 'transfer' && transaction.destinationAccountId && query.accountIds.includes(transaction.destinationAccountId))
      ) return false;
      if (query.categoryIds?.length && (!transaction.categoryId || !query.categoryIds.includes(transaction.categoryId))) return false;
      if (query.tagIds?.length && !query.tagIds.some((id) => transaction.tagIds.includes(id))) return false;
      if (query.kinds?.length && !query.kinds.includes(transaction.kind)) return false;
      if (query.statuses?.length && !query.statuses.includes(transaction.status)) return false;
      if (query.fromDate && transaction.localDate < query.fromDate) return false;
      if (query.toDate && transaction.localDate > query.toDate) return false;
      if (query.minMinor !== undefined && transaction.baseAmountMinor < query.minMinor) return false;
      if (query.maxMinor !== undefined && transaction.baseAmountMinor > query.maxMinor) return false;
      return true;
    });
    result = result.sort((a, b) => {
      if (query.sort === 'oldest') return a.localDate.localeCompare(b.localDate) || a.createdAt.localeCompare(b.createdAt);
      if (query.sort === 'amount-desc') return b.baseAmountMinor - a.baseAmountMinor;
      return b.localDate.localeCompare(a.localDate) || b.createdAt.localeCompare(a.createdAt);
    });
    const offset = query.offset ?? 0;
    return result.slice(offset, query.limit ? offset + query.limit : undefined);
  }

  getDashboard(fromDate: string, toDate: string): DashboardSummary {
    this.assertDate(fromDate);
    this.assertDate(toDate);
    if (fromDate > toDate) throw new Error('Dashboard start date must not be after its end date.');
    const posted = this.queryTransactions({ fromDate, toDate, statuses: ['posted'] });
    const allPosted = this.queryTransactions({ statuses: ['posted'], sort: 'oldest' });
    const accounts = this.active(this.state.accounts).filter((account) => !account.archived);
    const accountBalances = accounts.map((account) => {
      let balanceMinor = account.openingBalanceMinor;
      for (const transaction of allPosted) {
        if (transaction.accountId === account.id) {
          if (transaction.kind === 'expense' || transaction.kind === 'transfer') {
            balanceMinor = subtractMinor(balanceMinor, transaction.amountMinor, `${account.name} balance`);
          }
          if (transaction.kind === 'income') {
            balanceMinor = addMinor(balanceMinor, transaction.amountMinor, `${account.name} balance`);
          }
        }
        if (transaction.kind === 'transfer' && transaction.destinationAccountId === account.id) {
          balanceMinor = addMinor(
            balanceMinor,
            transaction.destinationAmountMinor ?? 0,
            `${account.name} balance`,
          );
        }
      }
      return { account, balanceMinor };
    });
    const incomeMinor = sumMinor(
      posted.filter((item) => item.kind === 'income').map((item) => item.baseAmountMinor),
      'Income total',
    );
    const expenseMinor = sumMinor(
      posted.filter((item) => item.kind === 'expense').map((item) => item.baseAmountMinor),
      'Expense total',
    );
    const expenseCategories = this.active(this.state.categories)
      .filter((category) => category.kind === 'expense');
    const categorySpend: DashboardSummary['categorySpend'] = expenseCategories
      .map((category) => ({
        category,
        amountMinor: sumMinor(posted
          .filter((item) => item.kind === 'expense' && item.categoryId === category.id)
          .map((item) => item.baseAmountMinor), `${category.name} spending`),
      }))
      .filter((item) => item.amountMinor > 0);
    const expenseCategoryIds = new Set(expenseCategories.map((category) => category.id));
    const uncategorizedMinor = sumMinor(posted
      .filter((item) =>
        item.kind === 'expense' &&
        (!item.categoryId || !expenseCategoryIds.has(item.categoryId)),
      )
      .map((item) => item.baseAmountMinor), 'Uncategorized spending');
    if (uncategorizedMinor > 0) {
      categorySpend.push({ category: null, amountMinor: uncategorizedMinor });
    }
    categorySpend.sort((a, b) => b.amountMinor - a.amountMinor);
    const today = todayLocal();
    const budgetDate = today >= fromDate && today <= toDate ? today : toDate;
    const budgetEntries = this.getBudgetStatuses(budgetDate, { includeInactiveCustom: true })
      .filter(({ budget, snapshot }) =>
        budget.period.unit !== 'custom' ||
        (snapshot.periodStart <= toDate && snapshot.periodEnd >= fromDate),
      );
    const budgetLimitMinor = sumMinor(
      budgetEntries.map((entry) => entry.effectiveLimitMinor),
      'Budget limit total',
    );
    const budgetSpentMinor = sumMinor(
      budgetEntries.map((entry) => entry.spentMinor),
      'Budget spending total',
    );
    const dayTotals = new Map<string, number>();
    posted.filter((item) => item.kind === 'expense').forEach((item) => {
      dayTotals.set(
        item.localDate,
        addMinor(dayTotals.get(item.localDate) ?? 0, item.baseAmountMinor, 'Daily spending'),
      );
    });
    const dailySpend: DashboardSummary['dailySpend'] = [];
    let spendDate = fromDate;
    let spendGuard = 0;
    while (spendDate <= toDate && spendGuard < 36600) {
      dailySpend.push({ date: spendDate, amountMinor: dayTotals.get(spendDate) ?? 0 });
      spendDate = addRecurrence(spendDate, 'day', 1);
      spendGuard += 1;
    }
    let netWorthMinor = 0;
    const missingExchangeRates: DashboardSummary['missingExchangeRates'] = [];
    const balanceDate = todayLocal();
    for (const item of accountBalances) {
      let rate: string;
      try {
        rate = this.resolveRate(
          item.account.currency,
          this.state.settings.baseCurrency,
          balanceDate,
        );
      } catch {
        if (!missingExchangeRates.some((rate) => rate.fromCurrency === item.account.currency)) {
          missingExchangeRates.push({
            fromCurrency: item.account.currency,
            toCurrency: this.state.settings.baseCurrency,
          });
        }
        continue;
      }
      netWorthMinor = addMinor(
        netWorthMinor,
        convertMinor(
          item.balanceMinor,
          item.account.currency,
          this.state.settings.baseCurrency,
          rate,
          this.state.settings.locale,
        ),
        'Net worth',
      );
    }
    return {
      netWorthMinor,
      incomeMinor,
      expenseMinor,
      netFlowMinor: subtractMinor(incomeMinor, expenseMinor, 'Net flow'),
      budgetLimitMinor,
      budgetSpentMinor,
      accountBalances,
      categorySpend,
      recentTransactions: posted.slice(0, 5),
      upcomingTransactions: this.queryTransactions({ statuses: ['upcoming'], sort: 'oldest', limit: 5 }),
      dailySpend,
      missingExchangeRates,
    };
  }

  getBudgetStatuses(
    onDate: string,
    options: { includeInactiveCustom?: boolean } = {},
  ): BudgetStatus[] {
    this.assertDate(onDate);
    return this.active(this.state.budgets)
      .filter((budget) => !budget.archived)
      .flatMap((budget) => {
        const bounds = resolvePeriod(budget.period, onDate);
        if (
          budget.period.unit === 'custom' &&
          !options.includeInactiveCustom &&
          (onDate < bounds.start || onDate > bounds.end)
        ) return [];
        // Fall back to a transient snapshot when the period rolled over while
        // the app stayed open; the next generateRecurring run persists it.
        const snapshot = this.state.budgetPeriods.find((item) =>
          item.budgetId === budget.id && item.periodStart === bounds.start,
        ) ?? this.buildBudgetSnapshots(budget, false, onDate).find((item) => item.periodStart === bounds.start);
        if (!snapshot) return [];
        const spentMinor = this.budgetSpend(snapshot.filters, snapshot.periodStart, snapshot.periodEnd);
        const categorySpend = snapshot.categoryLimits.map((limit) => ({
          ...limit,
          amountMinor: this.budgetSpend(
            { ...snapshot.filters, categoryIds: [limit.categoryId] },
            snapshot.periodStart,
            snapshot.periodEnd,
          ),
        }));
        return [{
          budget,
          snapshot,
          spentMinor,
          effectiveLimitMinor: addMinor(
            snapshot.limitMinor,
            snapshot.rolloverMinor,
            `${budget.name} effective limit`,
          ),
          categorySpend,
        }];
      });
  }

  getGoalProgress(goalId: string) {
    return this.calculateGoalProgress(
      goalId,
      this.state.goals,
      this.state.contributions,
      this.state.transactions,
    );
  }

  // The base value credited by a transfer's destination leg. baseAmountMinor
  // snapshots the source leg, which diverges from the destination whenever the
  // manual destination amount disagrees with the source-leg conversion.
  private transferInflowBaseMinor(item: TransactionRecord) {
    return item.destinationBaseAmountMinor ?? item.baseAmountMinor;
  }

  generateRecurring(horizonDate = addRecurrence(todayLocal(), 'month', 1)) {
    return this.enqueueMutation(() => this.generateRecurringNow(horizonDate));
  }

  private async generateRecurringNow(horizonDate: string) {
    this.assertDate(horizonDate);
    const today = todayLocal();
    let generated = 0;
    const transactions = [...this.state.transactions];
    const transactionChanges: TransactionRecord[] = [];
    const ruleChanges: RecurringRule[] = [];
    for (const rule of this.active(this.state.recurringRules).filter((item) => item.active)) {
      // A rule that can no longer build its transaction (dangling reference,
      // missing exchange rate) is skipped so one bad rule never blocks the
      // other rules or app startup, which awaits this generation.
      try {
        if (rule.autoPost) {
          transactions.forEach((transaction, index) => {
            if (
              transaction.recurringRuleId === rule.id &&
              transaction.status === 'upcoming' &&
              transaction.localDate <= today
            ) {
              const updated = updateEntity(transaction, { status: 'posted' });
              transactions[index] = updated;
              transactionChanges.push(updated);
            }
          });
        }
        let due = rule.nextDueDate;
        let guard = 0;
        while (due <= horizonDate && guard < MAX_RECURRING_OCCURRENCES_PER_RUN) {
          guard += 1;
          if (rule.endDate && due > rule.endDate) break;
          const occurrenceKey = `${rule.id}:${due}`;
          if (
            !this.deletedOccurrenceKeys.has(occurrenceKey) &&
            !transactions.some((item) => item.occurrenceKey === occurrenceKey)
          ) {
            const transaction = this.buildTransaction({
              ...rule.template,
              localDate: due,
              status: rule.autoPost && due <= today ? 'posted' : 'upcoming',
              recurringRuleId: rule.id,
              occurrenceKey,
            });
            transactions.push(transaction);
            transactionChanges.push(transaction);
            generated += 1;
          }
          const nextDue = addRecurrence(due, rule.unit, Math.max(1, rule.interval), rule.startDate);
          if (nextDue <= due) throw new Error('Recurring schedule did not advance.');
          due = nextDue;
        }
        if (guard >= MAX_RECURRING_OCCURRENCES_PER_RUN && due <= horizonDate) {
          throw new Error('Recurring schedule has too many occurrences to generate in one run.');
        }
        const active = !rule.endDate || due <= rule.endDate;
        if (due !== rule.nextDueDate || active !== rule.active) {
          ruleChanges.push(updateEntity(rule, { nextDueDate: due, active }));
        }
      } catch {
        // Generation for this rule failed — most often a missing exchange rate
        // for its currency pair. Swallowing it silently left `nextDueDate`
        // frozen forever with no error, no flag, and nothing for the user to
        // act on. Pause the rule instead so it surfaces as "Paused" in the
        // Automation list and the user can fix the cause and re-enable it.
        if (rule.active) ruleChanges.push(updateEntity(rule, { active: false, pausedByDependency: false }));
        continue;
      }
    }
    const recurringChanged = transactionChanges.length > 0 || ruleChanges.length > 0;
    if (recurringChanged) {
      this.assertTransactionSetSafe(transactions);
      await this.storage.putMany([
        ...transactionChanges.map((entity) => ({ type: 'transactions' as const, entity })),
        ...ruleChanges.map((entity) => ({ type: 'recurringRules' as const, entity })),
      ]);
      // Merge into the current state rather than replacing it with the
      // pre-await snapshot, so transactions saved while putMany was in
      // flight are not dropped.
      const changedTransactions = new Map(transactionChanges.map((item) => [item.id, item]));
      const changedRules = new Map(ruleChanges.map((rule) => [rule.id, rule]));
      const currentIds = new Set(this.state.transactions.map((item) => item.id));
      this.state = {
        ...this.state,
        transactions: [
          ...this.state.transactions.map((item) => changedTransactions.get(item.id) ?? item),
          ...transactionChanges.filter((item) => !currentIds.has(item.id)),
        ],
        recurringRules: this.state.recurringRules.map((rule) => changedRules.get(rule.id) ?? rule),
      };
    }
    const budgetChanges = await this.ensureBudgetSnapshots();
    if (recurringChanged || budgetChanges) this.emit();
    return generated;
  }

  confirmUpcoming(id: string) {
    return this.enqueueMutation(() => this.confirmUpcomingNow(id));
  }

  private async confirmUpcomingNow(id: string) {
    const transaction = this.state.transactions.find((item) => item.id === id);
    if (!transaction || transaction.status !== 'upcoming') return;
    const updated = updateEntity(transaction, { status: 'posted' });
    this.assertTransactionSetSafe(this.withEntity(this.state.transactions, updated));
    await this.persist('transactions', [updated]);
    this.replaceInList('transactions', updated);
    this.emit();
  }

  skipUpcoming(id: string) {
    return this.enqueueMutation(() => this.skipUpcomingNow(id));
  }

  private async skipUpcomingNow(id: string) {
    const transaction = this.state.transactions.find((item) => item.id === id);
    if (!transaction || transaction.status !== 'upcoming') return;
    const updated = updateEntity(transaction, { status: 'skipped' });
    await this.persist('transactions', [updated]);
    this.replaceInList('transactions', updated);
    this.emit();
  }

  updateTransactionsCategory(ids: string[], categoryId: string | null) {
    return this.enqueueMutation(() => this.updateTransactionsCategoryNow(ids, categoryId));
  }

  private async updateTransactionsCategoryNow(ids: string[], categoryId: string | null) {
    const selected = new Set(ids);
    const candidates = this.state.transactions.filter((item) => selected.has(item.id));
    if (candidates.some((item) => item.kind === 'transfer')) {
      throw new Error('Transfers do not have categories.');
    }
    if (categoryId) {
      const category = this.state.categories.find((item) => item.id === categoryId && !item.archived);
      if (!category) throw new Error('Choose a valid category.');
      if (candidates.some((item) => item.kind !== category.kind)) {
        throw new Error(`The ${category.name} category can only be assigned to ${category.kind} transactions.`);
      }
    }
    const updated = candidates.map((item) => updateEntity(item, { categoryId }));
    await this.persist('transactions', updated);
    const replacements = new Map(updated.map((item) => [item.id, item]));
    this.state = {
      ...this.state,
      transactions: this.state.transactions.map((item) => replacements.get(item.id) ?? item),
    };
    this.emit();
  }

  deleteEntities(type: keyof FinanceState, ids: string[]) {
    return this.enqueueMutation(() => this.deleteEntitiesNow(type, ids));
  }

  private async deleteEntitiesNow(type: keyof FinanceState, ids: string[]) {
    if (type === 'ready' || type === 'settings') return;
    const list = this.state[type] as FinanceEntity[];
    const deleted = list.filter((entity) => ids.includes(entity.id)).map((entity) => updateEntity(entity, { deletedAt: nowIso() }));
    // Deactivate recurring rules that reference a deleted account or category,
    // mirroring the archive paths in saveAccount/saveCategory, so recurring
    // generation never trips over a dangling reference.
    const deletedIds = new Set(ids);
    const rules = type === 'accounts' || type === 'categories'
      ? this.state.recurringRules
        .filter((rule) => rule.active && !rule.deletedAt && deletedIds.has(
          (type === 'accounts' ? rule.template.accountId : rule.template.categoryId) ?? '',
        ))
        .map((rule) => updateEntity(rule, { active: false, pausedByDependency: true }))
      : [];
    const contributions = type === 'goals'
      ? this.state.contributions
        .filter((item) => deletedIds.has(item.goalId))
        .map((item) => updateEntity(item, { deletedAt: nowIso() }))
      : [];
    const budgetPeriods = type === 'budgets'
      ? this.state.budgetPeriods
        .filter((item) => deletedIds.has(item.budgetId))
        .map((item) => updateEntity(item, { deletedAt: nowIso() }))
      : [];
    // Deleting a transaction must retire the goal contribution it funded,
    // otherwise the goal keeps counting money that no longer exists.
    const orphanedContributions = type === 'transactions'
      ? this.state.contributions
        .filter((item) => !item.deletedAt && item.transactionId !== null && deletedIds.has(item.transactionId))
        .map((item) => updateEntity(item, { deletedAt: nowIso() }))
      : [];
    // Deleting a rule must release the transactions it already generated, or they
    // keep pointing at a rule that is gone.
    const releasedTransactions = type === 'recurringRules'
      ? this.state.transactions
        .filter((item) => !item.deletedAt && item.recurringRuleId !== null && deletedIds.has(item.recurringRuleId))
        .map((item) => updateEntity(item, { recurringRuleId: null }))
      : [];
    // Deleting a tag must strip it from every transaction. Leaving the id behind
    // makes the transaction fail its own tag validation the next time the user
    // saves it — a dead end with no way out from the UI.
    const untaggedTransactions = type === 'tags'
      ? this.state.transactions
        .filter((item) => !item.deletedAt && item.tagIds.some((tagId) => deletedIds.has(tagId)))
        .map((item) => updateEntity(item, { tagIds: item.tagIds.filter((tagId) => !deletedIds.has(tagId)) }))
      : [];
    // Same dead end as tags, one level up: `buildTransaction` rejects a
    // categoryId with no matching category, so a transaction left pointing at a
    // deleted category throws "Choose a valid expense category." on every
    // subsequent save and cannot be repaired from the UI.
    const uncategorisedTransactions = type === 'categories'
      ? this.state.transactions
        .filter((item) => !item.deletedAt && item.categoryId !== null && deletedIds.has(item.categoryId))
        .map((item) => updateEntity(item, { categoryId: null }))
      : [];
    const transactionChanges = [...releasedTransactions, ...untaggedTransactions, ...uncategorisedTransactions];
    if (type === 'transactions') {
      this.assertTransactionSetSafe(
        this.state.transactions.filter((item) => !deletedIds.has(item.id)),
      );
    }
    await this.storage.putMany([
      ...deleted.map((entity) => ({ type: type as EntityType, entity })),
      ...rules.map((entity) => ({ type: 'recurringRules' as const, entity })),
      ...contributions.map((entity) => ({ type: 'contributions' as const, entity })),
      ...orphanedContributions.map((entity) => ({ type: 'contributions' as const, entity })),
      ...budgetPeriods.map((entity) => ({ type: 'budgetPeriods' as const, entity })),
      ...transactionChanges.map((entity) => ({ type: 'transactions' as const, entity })),
    ]);
    if (type === 'transactions') {
      deleted.forEach((entity) => {
        const occurrenceKey = (entity as TransactionRecord).occurrenceKey;
        if (occurrenceKey) this.deletedOccurrenceKeys.add(occurrenceKey);
      });
    }
    const ruleChanges = new Map(rules.map((rule) => [rule.id, rule]));
    const nextState = {
      ...this.state,
      [type]: (this.state[type] as FinanceEntity[]).filter((entity) => !deletedIds.has(entity.id)),
    } as FinanceState;
    nextState.recurringRules = nextState.recurringRules.map((rule) => ruleChanges.get(rule.id) ?? rule);
    if (transactionChanges.length) {
      const edits = new Map(transactionChanges.map((item) => [item.id, item]));
      nextState.transactions = nextState.transactions.map((item) => edits.get(item.id) ?? item);
    }
    if (orphanedContributions.length) {
      const retired = new Set(orphanedContributions.map((item) => item.id));
      nextState.contributions = nextState.contributions.filter((item) => !retired.has(item.id));
    }
    if (type === 'goals') {
      nextState.contributions = nextState.contributions.filter((item) => !deletedIds.has(item.goalId));
    }
    if (type === 'budgets') {
      nextState.budgetPeriods = nextState.budgetPeriods.filter((item) => !deletedIds.has(item.budgetId));
    }
    this.state = nextState;
    this.emit();
  }

  importCsv(rows: CsvImportRow[], commit = false) {
    return commit
      ? this.enqueueMutation(() => this.importCsvNow(rows, true))
      : this.importCsvNow(rows, false);
  }

  private async importCsvNow(rows: CsvImportRow[], commit = false) {
    const result: ImportResult = { validRows: [], rejectedRows: [], duplicateRows: [], warnings: [], committedIds: [] };
    const staged: { input: TransactionInput; tagNames: string[] }[] = [];
    const duplicateKeys = new Set(this.state.transactions.map((item) => this.transactionDuplicateKey(item)));
    for (const raw of rows) {
      const parsed = csvRowSchema.safeParse(raw);
      if (!parsed.success) {
        result.rejectedRows.push({ rowNumber: raw.rowNumber, reason: parsed.error.issues[0]?.message ?? 'Invalid row' });
        continue;
      }
      const row = parsed.data;
      const account = this.active(this.state.accounts).find((item) =>
        !item.archived && item.name.toLowerCase() === row.account.toLowerCase(),
      );
      if (!account) {
        result.rejectedRows.push({ rowNumber: row.rowNumber, reason: `Unknown account: ${row.account}` });
        continue;
      }
      try {
        if (row.currency !== account.currency) {
          throw new Error(`Currency ${row.currency} does not match ${account.name} (${account.currency}).`);
        }
        const amountMinor = parseInvariantMoney(row.amount, row.currency, this.state.settings.locale);
        const destination = row.destinationAccount
          ? this.active(this.state.accounts).find((item) =>
            !item.archived && item.name.toLowerCase() === row.destinationAccount.toLowerCase(),
          )
          : undefined;
        if (row.type === 'transfer' && !destination) {
          result.rejectedRows.push({ rowNumber: row.rowNumber, reason: `Unknown destination account: ${row.destinationAccount || 'missing'}` });
          continue;
        }
        const category = row.category
          ? this.active(this.state.categories).find((item) =>
            !item.archived && item.name.toLowerCase() === row.category.toLowerCase(),
          )
          : undefined;
        if (row.category && !category) throw new Error(`Unknown category: ${row.category}`);
        const tagNames = row.tags.split('|').map((item) => item.trim()).filter(Boolean);
        const input: TransactionInput = {
          kind: row.type,
          status: row.status,
          title: row.title,
          note: row.note,
          localDate: row.date,
          accountId: account.id,
          destinationAccountId: destination?.id ?? null,
          categoryId: category?.id ?? null,
          tagIds: [],
          amountMinor,
          destinationAmountMinor: destination && row.destinationAmount
            ? parseInvariantMoney(row.destinationAmount, destination.currency, this.state.settings.locale)
            : null,
          destinationBaseAmountMinor: row.destinationBaseAmountMinor
            ? this.parseMinorInteger(row.destinationBaseAmountMinor, 'Destination base amount')
            : null,
          exchangeRate: row.exchangeRate || undefined,
        };
        // Build once during preview so rate and transfer validation errors are reported per row.
        const previewTransaction = this.buildTransaction(input);
        const duplicateKey = this.transactionDuplicateKey(previewTransaction, tagNames);
        if (duplicateKeys.has(duplicateKey)) {
          result.duplicateRows.push(row.rowNumber);
          continue;
        }
        duplicateKeys.add(duplicateKey);
        result.validRows.push(row as CsvImportRow);
        staged.push({ input, tagNames });
      } catch (reason) {
        result.rejectedRows.push({
          rowNumber: row.rowNumber,
          reason: reason instanceof Error ? reason.message : 'Invalid amount or exchange rate.',
        });
      }
    }
    if (commit && staged.length) {
      const tags = [...this.state.tags];
      const newTags: Tag[] = [];
      const transactions = staged.map(({ input, tagNames }) => {
        const tagIds = tagNames.map((name) => {
          const existing = tags.find((item) => !item.deletedAt && item.name.toLowerCase() === name.toLowerCase());
          if (existing) return existing.id;
          const tag = createEntity({ id: makeId(), name, color: '#6D7885' }) as Tag;
          tags.push(tag);
          newTags.push(tag);
          return tag.id;
        });
        return this.buildTransaction({ ...input, tagIds }, undefined, tags.map((tag) => tag.id));
      });
      this.assertTransactionSetSafe([...this.state.transactions, ...transactions]);
      await this.storage.putMany([
        ...newTags.map((entity) => ({ type: 'tags' as const, entity })),
        ...transactions.map((entity) => ({ type: 'transactions' as const, entity })),
      ]);
      // Append only the new tags onto current state; the pre-await `tags`
      // snapshot may be missing tags saved while putMany was in flight.
      this.state = {
        ...this.state,
        tags: [...this.state.tags, ...newTags],
        transactions: [...this.state.transactions, ...transactions],
      };
      result.committedIds = transactions.map((item) => item.id);
      this.emit();
    }
    if (result.rejectedRows.length) result.warnings.push('Rejected rows were not imported.');
    if (result.duplicateRows.length) result.warnings.push('Likely duplicates were skipped.');
    return result;
  }

  exportCsv() {
    const headers = ['date', 'type', 'status', 'title', 'amount', 'currency', 'account', 'destination_account', 'destination_amount', 'destination_base_amount_minor', 'category', 'tags', 'note', 'exchange_rate', 'base_amount_minor', 'transfer_id'];
    const rows = this.queryTransactions({ sort: 'oldest' }).map((transaction) => {
      const account = this.state.accounts.find((item) => item.id === transaction.accountId)?.name ?? '';
      const destination = this.state.accounts.find((item) => item.id === transaction.destinationAccountId);
      const category = this.state.categories.find((item) => item.id === transaction.categoryId)?.name ?? '';
      const tags = transaction.tagIds.map((id) => this.state.tags.find((item) => item.id === id)?.name).filter(Boolean).join('|');
      return [transaction.localDate, transaction.kind, transaction.status, transaction.title, minorToDecimalString(transaction.amountMinor, transaction.currency, this.state.settings.locale), transaction.currency, account, destination?.name ?? '', transaction.destinationAmountMinor !== null && destination ? minorToDecimalString(transaction.destinationAmountMinor, destination.currency, this.state.settings.locale) : '', transaction.destinationBaseAmountMinor ?? '', category, tags, transaction.note, transaction.exchangeRate, transaction.baseAmountMinor, transaction.transferGroupId ?? ''];
    });
    return `\uFEFF${[headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n')}`;
  }

  resetAllData() {
    return this.enqueueMutation(() => this.resetAllDataNow());
  }

  private async resetAllDataNow() {
    // Nothing below this line may touch `this.state` until the disk wipe has
    // succeeded, so a failing `clear()` leaves the snapshot intact.
    await this.storage.clear();
    const next = { ...createInitialState(), ready: true };
    this.deletedOccurrenceKeys.clear();
    this.state = next;
    this.emit();
    // The wipe is already the source of truth at this point: an empty store
    // rehydrates to exactly `createInitialState()` on next launch. Re-seeding the
    // settings row is an optimisation, so a failure here must not be reported as
    // a failed reset.
    await this.persist('settings', [next.settings]).catch(() => undefined);
  }

  private enqueueMutation<T>(operation: () => Promise<T>) {
    const run = this.mutationQueue.then(operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async saveListEntity<T extends FinanceEntity>(type: ListKey, input: Omit<T, keyof import('@/domain/models').SyncEntity>, id?: string) {
    const list = this.state[type] as T[];
    const existing = this.findExisting(list, id, type.slice(0, -1));
    const entity = existing ? updateEntity(existing, input as Partial<T>) : createEntity<T>({ id: makeId(), ...input } as T);
    await this.persist(type, [entity]);
    this.replaceInList(type, entity);
    this.emit();
    return entity;
  }

  private buildTransaction(input: TransactionInput, id?: string, additionalTagIds: string[] = []) {
    this.assertPositiveMinor(input.amountMinor, 'Amount');
    this.assertDate(input.localDate);
    if (!TRANSACTION_TYPES.includes(input.kind)) throw new Error('Choose a valid transaction type.');
    const status = input.status ?? 'posted';
    if (!TRANSACTION_STATUSES.includes(status)) throw new Error('Choose a valid transaction status.');
    const existing = this.findExisting(this.state.transactions, id, 'transaction');
    const account = this.active(this.state.accounts).find((item) => item.id === input.accountId);
    if (!account || (account.archived && existing?.accountId !== account.id)) throw new Error('Choose a valid account.');
    const destination = input.kind === 'transfer' && input.destinationAccountId
      ? this.active(this.state.accounts).find((item) => item.id === input.destinationAccountId)
      : null;
    if (
      input.kind === 'transfer' &&
      (!destination || destination.id === account.id || (destination.archived && existing?.destinationAccountId !== destination.id))
    ) {
      throw new Error('Choose a different destination account.');
    }
    const category = input.categoryId
      ? this.active(this.state.categories).find((item) => item.id === input.categoryId)
      : null;
    if (
      input.kind !== 'transfer' &&
      input.categoryId &&
      (!category || category.kind !== input.kind || (category.archived && existing?.categoryId !== category.id))
    ) {
      throw new Error(`Choose a valid ${input.kind} category.`);
    }
    // The transaction form does not expose tags, so an omitted tagIds field on
    // update means "leave them unchanged". Callers can still clear every tag by
    // passing an explicit empty array.
    const tagIds = [...new Set(input.tagIds ?? existing?.tagIds ?? [])];
    const knownTagIds = new Set([...this.state.tags.map((tag) => tag.id), ...additionalTagIds]);
    if (tagIds.some((tagId) => !knownTagIds.has(tagId))) {
      throw new Error('Choose valid tags.');
    }
    const rate = account.currency === this.state.settings.baseCurrency
      ? '1'
      : input.exchangeRate
        ? this.normalizeRate(input.exchangeRate)
        : this.resolveRate(account.currency, this.state.settings.baseCurrency, input.localDate);
    const baseAmountMinor = convertMinor(
      input.amountMinor,
      account.currency,
      this.state.settings.baseCurrency,
      rate,
      this.state.settings.locale,
    );
    let destinationAmountMinor: number | null = null;
    let destinationBaseAmountMinor: number | null = null;
    if (input.kind === 'transfer') {
      if (destination!.currency === account.currency) {
        destinationAmountMinor = input.amountMinor;
      } else if (input.destinationAmountMinor !== undefined && input.destinationAmountMinor !== null) {
        this.assertPositiveMinor(input.destinationAmountMinor, 'Destination amount');
        destinationAmountMinor = input.destinationAmountMinor;
      } else {
        destinationAmountMinor = convertMinor(
          input.amountMinor,
          account.currency,
          destination!.currency,
          this.resolveRate(account.currency, destination!.currency, input.localDate),
          this.state.settings.locale,
        );
      }
      const preservesDestinationSnapshot = existing?.kind === 'transfer' &&
        existing.destinationAccountId === destination!.id &&
        existing.localDate === input.localDate &&
        existing.destinationAmountMinor === destinationAmountMinor &&
        existing.destinationBaseAmountMinor !== null;
      if (input.destinationBaseAmountMinor !== undefined && input.destinationBaseAmountMinor !== null) {
        this.assertPositiveMinor(input.destinationBaseAmountMinor, 'Destination base amount');
        destinationBaseAmountMinor = input.destinationBaseAmountMinor;
      } else if (preservesDestinationSnapshot) {
        // Historical destination-leg value is a transaction snapshot. A title,
        // note, category, or source-side edit must not revalue it through rates
        // that may have changed (or been deleted) since the transfer occurred.
        destinationBaseAmountMinor = existing.destinationBaseAmountMinor;
      } else if (destination!.currency === this.state.settings.baseCurrency) {
        destinationBaseAmountMinor = destinationAmountMinor;
      } else if (destination!.currency === account.currency) {
        destinationBaseAmountMinor = baseAmountMinor;
      } else {
        destinationBaseAmountMinor = convertMinor(
          destinationAmountMinor,
          destination!.currency,
          this.state.settings.baseCurrency,
          this.resolveRate(destination!.currency, this.state.settings.baseCurrency, input.localDate),
          this.state.settings.locale,
        );
      }
    }
    const value = {
      kind: input.kind,
      status,
      title: input.title.trim() || (input.kind === 'transfer' ? 'Transfer' : 'Untitled'),
      note: input.note?.trim() ?? '',
      localDate: input.localDate,
      accountId: account.id,
      destinationAccountId: destination?.id ?? null,
      categoryId: input.kind === 'transfer' ? null : (category?.id ?? null),
      tagIds,
      amountMinor: input.amountMinor,
      destinationAmountMinor,
      destinationBaseAmountMinor,
      currency: account.currency,
      destinationCurrency: destination?.currency ?? null,
      exchangeRate: rate,
      baseAmountMinor,
      transferGroupId: input.kind === 'transfer' ? (existing?.transferGroupId ?? makeId()) : null,
      recurringRuleId: input.recurringRuleId ?? existing?.recurringRuleId ?? null,
      occurrenceKey: input.occurrenceKey ?? existing?.occurrenceKey ?? null,
    } satisfies Omit<TransactionRecord, keyof import('@/domain/models').SyncEntity>;
    return existing
      ? updateEntity(existing, value)
      : createEntity({ id: makeId(), ...value }) as TransactionRecord;
  }

  private replaceInList(type: ListKey, entity: FinanceEntity) {
    const list = this.state[type] as FinanceEntity[];
    const exists = list.some((item) => item.id === entity.id);
    this.state = { ...this.state, [type]: exists ? list.map((item) => item.id === entity.id ? entity : item) : [...list, entity] };
  }

  private async persist(type: EntityType, entities: FinanceEntity[]) {
    await this.storage.putMany(entities.map((entity) => ({ type, entity }) satisfies StoredEntity));
  }

  private active<T extends FinanceEntity>(entities: T[]) {
    return entities.filter((entity) => !entity.deletedAt);
  }

  private resolveRate(fromValue: string, toValue: string, localDate: string) {
    const fromCurrency = this.normalizeCurrency(fromValue);
    const toCurrency = this.normalizeCurrency(toValue);
    this.assertDate(localDate);
    if (fromCurrency === toCurrency) return '1';
    const direct = this.directOrInverseRate(fromCurrency, toCurrency, localDate);
    if (direct) return direct;
    const baseCurrency = this.state.settings.baseCurrency;
    if (fromCurrency !== baseCurrency && toCurrency !== baseCurrency) {
      const fromBase = this.directOrInverseRate(fromCurrency, baseCurrency, localDate);
      const toBase = this.directOrInverseRate(toCurrency, baseCurrency, localDate);
      if (fromBase && toBase) return new Decimal(fromBase).div(toBase).toSignificantDigits(20).toString();
    }
    if (fromCurrency === baseCurrency) {
      const toBase = this.directOrInverseRate(toCurrency, baseCurrency, localDate);
      if (toBase) return new Decimal(1).div(toBase).toSignificantDigits(20).toString();
    }
    throw new Error(`Missing exchange rate for ${fromCurrency} → ${toCurrency} on ${localDate}.`);
  }

  // A pair may be entered in either direction. If both directions exist and they
  // disagree, a transfer converts out through one and back in through the other,
  // so the two legs no longer describe the same amount and the difference is
  // conjured into (or out of) the base-currency totals. Reject the contradiction
  // at entry rather than letting it silently corrupt every later conversion.
  private assertReciprocalRate(fromCurrency: string, toCurrency: string, rate: string, effectiveDate: string, id?: string) {
    const rates = this.active(this.state.exchangeRates).filter((item) => item.id !== id);
    const nextDirectDate = rates
      .filter((item) =>
        item.fromCurrency === fromCurrency &&
        item.toCurrency === toCurrency &&
        item.effectiveDate > effectiveDate,
      )
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))[0]?.effectiveDate;
    const opposite = rates
      .filter((item) => item.fromCurrency === toCurrency && item.toCurrency === fromCurrency)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.updatedAt.localeCompare(b.updatedAt));
    const effectiveReciprocal = opposite
      .filter((item) => item.effectiveDate <= effectiveDate)
      .at(-1);
    const laterReciprocals = opposite.filter((item) =>
      item.effectiveDate > effectiveDate &&
      (!nextDirectDate || item.effectiveDate < nextDirectDate),
    );
    const reciprocals = [effectiveReciprocal, ...laterReciprocals]
      .filter((item): item is ExchangeRate => Boolean(item));
    const entered = new Decimal(rate);
    for (const reciprocal of reciprocals) {
      const implied = new Decimal(1).div(this.normalizeRate(reciprocal.rate));
      // Manually entered rates carry real spread and rounding, so compare with a
      // tolerance instead of demanding an exact reciprocal.
      const drift = entered.minus(implied).abs().div(implied);
      if (drift.lessThanOrEqualTo(RECIPROCAL_RATE_TOLERANCE)) continue;
      throw new Error(
        `This contradicts the existing ${toCurrency} → ${fromCurrency} rate of ${reciprocal.rate}, which implies ${implied.toSignificantDigits(8)}. Update or remove that rate first.`,
      );
    }
  }

  private directOrInverseRate(fromCurrency: string, toCurrency: string, localDate: string) {
    const direct = this.latestRate(fromCurrency, toCurrency, localDate);
    if (direct) return this.normalizeRate(direct.rate);
    const inverse = this.latestRate(toCurrency, fromCurrency, localDate);
    if (!inverse) return null;
    return new Decimal(1).div(this.normalizeRate(inverse.rate)).toSignificantDigits(20).toString();
  }

  private latestRate(fromCurrency: string, toCurrency: string, localDate: string) {
    return this.active(this.state.exchangeRates)
      .filter((item) => item.fromCurrency === fromCurrency && item.toCurrency === toCurrency && item.effectiveDate <= localDate)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate) || b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  // A deficit compounds across every period it is carried through, so a few
  // months of overspending can drive the rollover far enough negative that the
  // effective limit turns permanently unreachable and the budget becomes
  // useless. Cap the carried deficit at a single period's limit — one period of
  // debt is a meaningful signal, ten is noise.
  private clampRollover(rolloverMinor: number, limitMinor: number) {
    const floor = -Math.abs(limitMinor);
    return rolloverMinor < floor ? floor : rolloverMinor;
  }

  private budgetSpend(filters: BudgetFilters, fromDate: string, toDate: string) {
    return sumMinor(this.queryTransactions({ fromDate, toDate, statuses: ['posted'], kinds: ['expense'] })
      .filter((item) => !filters.accountIds.length || filters.accountIds.includes(item.accountId))
      .filter((item) => !filters.categoryIds.length || (!!item.categoryId && filters.categoryIds.includes(item.categoryId)))
      .filter((item) => !filters.tagIds.length || filters.tagIds.some((id) => item.tagIds.includes(id)))
      .map((item) => item.baseAmountMinor), 'Budget spending');
  }

  private async ensureBudgetSnapshots() {
    const periods = this.active(this.state.budgets)
      .filter((item) => !item.archived)
      .flatMap((budget) => this.buildBudgetSnapshots(budget, false));
    if (!periods.length) return 0;
    await this.persist('budgetPeriods', periods);
    periods.forEach((period) => this.replaceInList('budgetPeriods', period));
    return periods.length;
  }

  private buildBudgetSnapshots(budget: Budget, updateCurrent: boolean, onDate = todayLocal()) {
    const bounds = resolvePeriod(budget.period, onDate);
    const existing = this.state.budgetPeriods.find((item) => item.budgetId === budget.id && item.periodStart === bounds.start);
    if (existing) {
      if (!updateCurrent) return [];
      return [updateEntity(existing, {
        periodEnd: bounds.end,
        limitMinor: budget.limitMinor,
        rolloverMinor: budget.rollover ? existing.rolloverMinor : 0,
        filters: budget.filters,
        categoryLimits: budget.categoryLimits,
      })];
    }
    const history = this.state.budgetPeriods
      .filter((item) => item.budgetId === budget.id && item.periodStart < bounds.start)
      .sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    const latest = history.at(-1);
    const makePeriod = (periodStart: string, periodEnd: string, previous?: BudgetPeriodSnapshot) =>
      createEntity({
        id: makeId(),
        budgetId: budget.id,
        periodStart,
        periodEnd,
        limitMinor: budget.limitMinor,
        rolloverMinor: budget.rollover && previous
          ? this.clampRollover(subtractMinor(
            addMinor(previous.rolloverMinor, previous.limitMinor, `${budget.name} rollover`),
            this.budgetSpend(previous.filters, previous.periodStart, previous.periodEnd),
            `${budget.name} rollover`,
          ), budget.limitMinor)
          : 0,
        filters: budget.filters,
        categoryLimits: budget.categoryLimits,
      }) as BudgetPeriodSnapshot;
    if (!latest || updateCurrent || budget.period.unit === 'custom') {
      return [makePeriod(bounds.start, bounds.end, latest)];
    }
    const periods: BudgetPeriodSnapshot[] = [];
    let previous = latest;
    let guard = 0;
    while (previous.periodStart < bounds.start && guard < 3660) {
      guard += 1;
      const nextBounds = resolvePeriod(budget.period, addRecurrence(previous.periodEnd, 'day', 1));
      if (nextBounds.start <= previous.periodStart || nextBounds.start > bounds.start) break;
      const period = makePeriod(nextBounds.start, nextBounds.end, previous);
      periods.push(period);
      previous = period;
    }
    if (!periods.some((period) => period.periodStart === bounds.start)) {
      periods.push(makePeriod(bounds.start, bounds.end, previous));
    }
    return periods;
  }

  private validateBudget(input: BudgetInput): BudgetInput {
    this.assertPositiveMinor(input.limitMinor, 'Budget limit');
    this.assertDate(input.period.anchorDate);
    if (!Number.isSafeInteger(input.period.interval) || input.period.interval < 1) {
      throw new Error('Budget interval must be a positive whole number.');
    }
    if (!PERIOD_UNITS.includes(input.period.unit)) throw new Error('Choose a valid budget period.');
    if (input.period.unit === 'custom') {
      if (!input.period.endDate) throw new Error('Custom budgets require an end date.');
      this.assertDate(input.period.endDate);
      if (input.period.endDate < input.period.anchorDate) throw new Error('Budget end date must not precede its start date.');
    }
    this.assertIdsExist(input.filters.accountIds, this.state.accounts, 'account');
    this.assertIdsExist(input.filters.tagIds, this.state.tags, 'tag');
    this.assertIdsExist(input.filters.categoryIds, this.state.categories.filter((item) => item.kind === 'expense'), 'expense category');
    const limitedCategories = new Set<string>();
    input.categoryLimits.forEach((limit) => {
      this.assertPositiveMinor(limit.limitMinor, 'Category limit');
      if (limitedCategories.has(limit.categoryId)) throw new Error('Each category can have only one limit.');
      limitedCategories.add(limit.categoryId);
      if (!input.filters.categoryIds.includes(limit.categoryId)) {
        throw new Error('Category limits must belong to the budget filters.');
      }
    });
    this.assertColor(input.color);
    return {
      ...input,
      name: input.name.trim() || 'Budget',
      color: input.color.toUpperCase(),
      filters: {
        accountIds: [...new Set(input.filters.accountIds)],
        categoryIds: [...new Set(input.filters.categoryIds)],
        tagIds: [...new Set(input.filters.tagIds)],
      },
      categoryLimits: input.categoryLimits.map((limit) => ({ ...limit })),
      period: { ...input.period, endDate: input.period.unit === 'custom' ? input.period.endDate : null },
    };
  }

  private validateGoal(input: GoalInput, id?: string): GoalInput {
    const existing = this.findExisting(this.state.goals, id, 'goal');
    if (!GOAL_KINDS.includes(input.kind)) throw new Error('Choose a valid goal kind.');
    this.assertPositiveMinor(input.targetMinor, 'Goal target');
    this.assertSafeMinor(input.initialMinor, 'Starting progress');
    if (input.initialMinor < 0) throw new Error('Starting progress cannot be negative.');
    if (input.targetDate) this.assertDate(input.targetDate);
    if (input.linkedAccountId) {
      const account = this.state.accounts.find((item) => item.id === input.linkedAccountId);
      if (!account || (account.archived && existing?.linkedAccountId !== account.id)) {
        throw new Error('Choose a valid linked account.');
      }
    }
    if (input.linkedCategoryId) {
      const expectedKind = input.kind === 'saving' ? 'income' : 'expense';
      const category = this.state.categories.find((item) => item.id === input.linkedCategoryId);
      if (
        !category ||
        category.kind !== expectedKind ||
        (category.archived && existing?.linkedCategoryId !== category.id)
      ) {
        throw new Error(`Choose a valid ${expectedKind} category.`);
      }
    }
    this.assertColor(input.color);
    return { ...input, name: input.name.trim() || 'Goal', color: input.color.toUpperCase() };
  }

  private validateRecurring(input: RecurringInput, id?: string): RecurringInput {
    const existing = this.findExisting(this.state.recurringRules, id, 'recurring rule');
    if (!CATEGORY_KINDS.includes(input.template.kind)) throw new Error('Choose a valid recurring transaction kind.');
    if (!RECURRENCE_UNITS.includes(input.unit)) throw new Error('Choose a valid recurrence period.');
    this.assertPositiveMinor(input.template.amountMinor, 'Recurring amount');
    this.assertDate(input.startDate);
    this.assertDate(input.nextDueDate);
    if (input.endDate) {
      this.assertDate(input.endDate);
      if (input.endDate < input.startDate) throw new Error('Schedule end date must not precede its start date.');
    }
    if (!Number.isSafeInteger(input.interval) || input.interval < 1) throw new Error('Repeat interval must be a positive whole number.');
    const account = this.state.accounts.find((item) => item.id === input.template.accountId);
    if (!account || (account.archived && existing?.template.accountId !== account.id)) {
      throw new Error('Choose a valid account.');
    }
    if (this.normalizeCurrency(input.template.currency) !== account.currency) {
      throw new Error('Recurring currency must match its account.');
    }
    if (account.currency !== this.state.settings.baseCurrency) {
      this.resolveRate(account.currency, this.state.settings.baseCurrency, input.nextDueDate);
    }
    if (input.template.categoryId) {
      const category = this.state.categories.find((item) => item.id === input.template.categoryId);
      if (
        !category ||
        category.kind !== input.template.kind ||
        (category.archived && existing?.template.categoryId !== category.id)
      ) {
        throw new Error(`Choose a valid ${input.template.kind} category.`);
      }
    }
    this.assertIdsExist(input.template.tagIds, this.state.tags, 'tag');
    const referencesArchivedEntity = account.archived ||
      Boolean(input.template.categoryId &&
        this.state.categories.find((item) => item.id === input.template.categoryId)?.archived);
    return {
      ...input,
      active: input.active && !referencesArchivedEntity,
      interval: Math.floor(input.interval),
      template: {
        ...input.template,
        title: input.template.title.trim() || 'Recurring transaction',
        note: input.template.note.trim(),
        currency: account.currency,
        tagIds: [...new Set(input.template.tagIds)],
      },
    };
  }

  private async migrateLoadedState() {
    const transactionUpdates = this.state.transactions.flatMap((transaction) => {
      const destinationBaseAmountMinor = (
        transaction as TransactionRecord & { destinationBaseAmountMinor?: number | null }
      ).destinationBaseAmountMinor;
      if (transaction.kind !== 'transfer') {
        if (
          transaction.destinationAccountId === null &&
          transaction.destinationAmountMinor === null &&
          destinationBaseAmountMinor === null &&
          transaction.destinationCurrency === null &&
          transaction.transferGroupId === null
        ) return [];
        return [updateEntity(transaction, {
          destinationAccountId: null,
          destinationAmountMinor: null,
          destinationBaseAmountMinor: null,
          destinationCurrency: null,
          transferGroupId: null,
        })];
      }
      if (
        typeof destinationBaseAmountMinor === 'number' &&
        isSafeMinor(destinationBaseAmountMinor) &&
        destinationBaseAmountMinor > 0
      ) return [];
      return [updateEntity(transaction, {
        destinationBaseAmountMinor: this.legacyTransferInflowBaseMinor(transaction),
      })];
    });
    const accountMigration = this.disambiguateNames(this.state.accounts);
    const categoryMigration = this.disambiguateNames(this.state.categories);
    const tagMigration = this.disambiguateNames(this.state.tags);
    const recurringRuleUpdates = this.state.recurringRules.flatMap((rule) =>
      typeof (rule as RecurringRule & { pausedByDependency?: boolean }).pausedByDependency === 'boolean'
        ? []
        : [updateEntity(rule, { pausedByDependency: false })],
    );
    const records: StoredEntity[] = [
      ...transactionUpdates.map((entity) => ({ type: 'transactions' as const, entity })),
      ...accountMigration.changed.map((entity) => ({ type: 'accounts' as const, entity })),
      ...categoryMigration.changed.map((entity) => ({ type: 'categories' as const, entity })),
      ...tagMigration.changed.map((entity) => ({ type: 'tags' as const, entity })),
      ...recurringRuleUpdates.map((entity) => ({ type: 'recurringRules' as const, entity })),
    ];
    if (!records.length) return;
    await this.storage.putMany(records);
    const transactionReplacements = new Map(transactionUpdates.map((entity) => [entity.id, entity]));
    const recurringRuleReplacements = new Map(recurringRuleUpdates.map((entity) => [entity.id, entity]));
    this.state = {
      ...this.state,
      accounts: accountMigration.entities,
      categories: categoryMigration.entities,
      tags: tagMigration.entities,
      transactions: this.state.transactions.map((entity) => transactionReplacements.get(entity.id) ?? entity),
      recurringRules: this.state.recurringRules.map((entity) => recurringRuleReplacements.get(entity.id) ?? entity),
    };
  }

  private legacyTransferInflowBaseMinor(transaction: TransactionRecord) {
    const destinationAmount = transaction.destinationAmountMinor;
    const destinationCurrency = transaction.destinationCurrency;
    if (destinationAmount === null || !destinationCurrency) return transaction.baseAmountMinor;
    if (destinationCurrency === this.state.settings.baseCurrency) return destinationAmount;
    if (destinationCurrency === transaction.currency) return transaction.baseAmountMinor;
    try {
      return convertMinor(
        destinationAmount,
        destinationCurrency,
        this.state.settings.baseCurrency,
        this.resolveRate(destinationCurrency, this.state.settings.baseCurrency, transaction.localDate),
        this.state.settings.locale,
      );
    } catch {
      return transaction.baseAmountMinor;
    }
  }

  private disambiguateNames<T extends Account | Category | Tag>(entities: T[]) {
    const reserved = new Set(entities.map((entity) => entity.name.trim().toLocaleLowerCase()));
    const used = new Set<string>();
    const replacements = new Map<string, T>();
    const ordered = [...entities].sort((first, second) => {
      const firstArchived = 'archived' in first && first.archived ? 1 : 0;
      const secondArchived = 'archived' in second && second.archived ? 1 : 0;
      return firstArchived - secondArchived ||
        first.createdAt.localeCompare(second.createdAt) ||
        first.id.localeCompare(second.id);
    });
    for (const entity of ordered) {
      const normalized = entity.name.trim().toLocaleLowerCase();
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
        candidate = name.toLocaleLowerCase();
        index += 1;
      } while (used.has(candidate) || reserved.has(candidate));
      const updated = updateEntity(entity, { name } as Partial<T>);
      used.add(candidate);
      replacements.set(entity.id, updated);
    }
    return {
      entities: entities.map((entity) => replacements.get(entity.id) ?? entity),
      changed: [...replacements.values()],
    };
  }

  private withEntity<T extends FinanceEntity>(entities: T[], entity: T) {
    return entities.some((item) => item.id === entity.id)
      ? entities.map((item) => item.id === entity.id ? entity : item)
      : [...entities, entity];
  }

  private canActivateRecurringRule(
    rule: RecurringRule,
    accounts: Account[],
    categories: Category[],
  ) {
    const account = accounts.find((item) => item.id === rule.template.accountId && !item.archived);
    const category = rule.template.categoryId
      ? categories.find((item) =>
        item.id === rule.template.categoryId &&
        item.kind === rule.template.kind &&
        !item.archived,
      )
      : null;
    return Boolean(account) &&
      (!rule.template.categoryId || Boolean(category)) &&
      (!rule.endDate || rule.nextDueDate <= rule.endDate);
  }

  private calculateGoalProgress(
    goalId: string,
    goals: Goal[],
    contributions: GoalContribution[],
    transactions: TransactionRecord[],
  ) {
    const goal = goals.find((item) => item.id === goalId);
    if (!goal) throw new Error('Choose a valid goal.');
    const manual = sumMinor(
      contributions
        .filter((item) => item.goalId === goal.id && !item.deletedAt)
        .map((item) => item.amountMinor),
      `${goal.name} contributions`,
    );
    if (!goal.linkedAccountId && !goal.linkedCategoryId) {
      return addMinor(goal.initialMinor, manual, `${goal.name} progress`);
    }
    let linked = 0;
    for (const item of transactions) {
      if (item.deletedAt || item.status !== 'posted') continue;
      if (goal.linkedCategoryId && item.categoryId !== goal.linkedCategoryId) continue;
      if (goal.kind === 'spending') {
        if (item.kind !== 'expense') continue;
        if (goal.linkedAccountId && item.accountId !== goal.linkedAccountId) continue;
        linked = addMinor(linked, item.baseAmountMinor, `${goal.name} progress`);
        continue;
      }
      if (goal.linkedCategoryId) {
        if (item.kind !== 'income') continue;
        if (goal.linkedAccountId && item.accountId !== goal.linkedAccountId) continue;
        linked = addMinor(linked, item.baseAmountMinor, `${goal.name} progress`);
        continue;
      }
      if (!goal.linkedAccountId) continue;
      if (item.kind === 'income' && item.accountId === goal.linkedAccountId) {
        linked = addMinor(linked, item.baseAmountMinor, `${goal.name} progress`);
      } else if (
        (item.kind === 'expense' || item.kind === 'transfer') &&
        item.accountId === goal.linkedAccountId
      ) {
        linked = subtractMinor(linked, item.baseAmountMinor, `${goal.name} progress`);
      } else if (item.kind === 'transfer' && item.destinationAccountId === goal.linkedAccountId) {
        linked = addMinor(linked, this.transferInflowBaseMinor(item), `${goal.name} progress`);
      }
    }
    return addMinor(
      addMinor(goal.initialMinor, manual, `${goal.name} progress`),
      linked,
      `${goal.name} progress`,
    );
  }

  private assertGoalProgressSafe(
    goalId: string,
    goals: Goal[],
    contributions: GoalContribution[],
    transactions = this.state.transactions,
  ) {
    this.calculateGoalProgress(goalId, goals, contributions, transactions);
  }

  private assertTransactionSetSafe(
    transactions: TransactionRecord[],
    accounts = this.state.accounts,
  ) {
    const posted = transactions.filter((item) => !item.deletedAt && item.status === 'posted');
    const balances = new Map<string, number>();
    for (const account of accounts.filter((item) => !item.deletedAt)) {
      let balance = account.openingBalanceMinor;
      this.assertSafeMinor(balance, `${account.name} balance`);
      for (const transaction of posted) {
        if (transaction.accountId === account.id) {
          if (transaction.kind === 'income') {
            balance = addMinor(balance, transaction.amountMinor, `${account.name} balance`);
          } else {
            balance = subtractMinor(balance, transaction.amountMinor, `${account.name} balance`);
          }
        }
        if (transaction.kind === 'transfer' && transaction.destinationAccountId === account.id) {
          balance = addMinor(
            balance,
            transaction.destinationAmountMinor ?? 0,
            `${account.name} balance`,
          );
        }
      }
      balances.set(account.id, balance);
    }
    sumMinor(
      posted.filter((item) => item.kind === 'income').map((item) => item.baseAmountMinor),
      'Income total',
    );
    sumMinor(
      posted.filter((item) => item.kind === 'expense').map((item) => item.baseAmountMinor),
      'Expense total',
    );
    this.state.goals.forEach((goal) => {
      this.assertGoalProgressSafe(goal.id, this.state.goals, this.state.contributions, transactions);
    });
    let netWorth = 0;
    for (const account of accounts.filter((item) => !item.deletedAt && !item.archived)) {
      let rate: string;
      try {
        rate = this.resolveRate(
          account.currency,
          this.state.settings.baseCurrency,
          todayLocal(),
        );
      } catch {
        continue;
      }
      netWorth = addMinor(
        netWorth,
        convertMinor(
          balances.get(account.id) ?? account.openingBalanceMinor,
          account.currency,
          this.state.settings.baseCurrency,
          rate,
          this.state.settings.locale,
        ),
        'Net worth',
      );
    }
  }

  private parseMinorInteger(value: string, label: string) {
    const normalized = value.trim();
    if (!/^-?\d+$/.test(normalized)) throw new Error(`${label} must be a whole number.`);
    const parsed = Number(normalized);
    this.assertSafeMinor(parsed, label);
    return parsed;
  }

  private transactionDuplicateKey(transaction: TransactionRecord, suppliedTagNames?: string[]) {
    const tagNames = suppliedTagNames ?? transaction.tagIds.map((id) =>
      this.state.tags.find((tag) => tag.id === id)?.name ?? id,
    );
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
      transaction.title.trim().toLocaleLowerCase(),
      transaction.note.trim().toLocaleLowerCase(),
      [...tagNames].map((name) => name.toLocaleLowerCase()).sort(),
      transaction.exchangeRate,
    ]);
  }

  private findExisting<T extends FinanceEntity>(entities: T[], id: string | undefined, label: string) {
    if (!id) return undefined;
    const existing = entities.find((item) => item.id === id);
    if (!existing) throw new Error(`Could not find the ${label} to update.`);
    return existing;
  }

  private assertUniqueName(type: 'accounts' | 'categories' | 'tags', name: string, id?: string) {
    const duplicate = (this.state[type] as (Account | Category | Tag)[]).some((item) =>
      item.id !== id &&
      item.name.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
    );
    if (duplicate) throw new Error(`${name} is already in use.`);
  }

  private assertIdsExist<T extends FinanceEntity>(ids: string[], entities: T[], label: string) {
    const known = new Set(entities.map((item) => item.id));
    if (ids.some((id) => !known.has(id))) throw new Error(`Choose valid ${label} values.`);
  }

  private normalizeCurrency(value: string) {
    const currency = value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Use a three-letter currency code such as USD.');
    if (!isSupportedCurrencyCode(currency)) throw new Error('Use a supported ISO 4217 currency code.');
    return currency;
  }

  private normalizeRate(value: string) {
    let rate: Decimal;
    try {
      rate = new Decimal(value.trim());
    } catch {
      throw new Error('Exchange rate must be a positive number.');
    }
    if (!rate.isFinite() || !rate.isPositive()) throw new Error('Exchange rate must be a positive number.');
    return rate.toSignificantDigits(20).toString();
  }

  private assertLocale(value: string) {
    const error = validateLocale(value);
    if (error) throw new Error(error);
  }

  private assertColor(value: string) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(value)) throw new Error('Use a six-digit hex color such as #5966E9.');
  }

  private assertDate(value: string) {
    if (!isLocalDate(value)) throw new Error('Use a real date in YYYY-MM-DD format.');
  }

  private assertSafeMinor(value: number, label: string) {
    if (!isSafeMinor(value)) throw new Error(`${label} is outside the supported range.`);
  }

  private assertPositiveMinor(value: number, label: string) {
    this.assertSafeMinor(value, label);
    if (value <= 0) throw new Error(`${label} must be greater than zero.`);
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

export const financeRepository = new LocalFinanceRepository();
