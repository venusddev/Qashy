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
  OnboardingInput,
  RateInput,
  RecurringInput,
  TagInput,
  TransactionInput,
} from '@/data/repository';
import { createDefaultCategories, createInitialState, initialSettings } from '@/domain/defaults';
import { addRecurrence, isLocalDate, todayLocal } from '@/utils/date';
import { createEntity, makeId, nowIso, updateEntity } from '@/utils/entity';
import { escapeCsv } from '@/utils/csv';
import { convertMinor, isSafeMinor, minorToDecimalString, parseMoney } from '@/utils/money';
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
  private recurringQueue: Promise<void> = Promise.resolve();

  constructor(private storage: StorageAdapter = new PlatformStorageAdapter()) {}

  async initialize() {
    await this.storage.initialize();
    const settingsRecords = await this.storage.readAll('settings');
    const settings = (settingsRecords.find((item) => item.id === 'settings' && !item.deletedAt) ??
      initialSettings()) as AppSettings;

    const loaded = await Promise.all(ENTITY_TYPES.map((type) => this.storage.readAll(type)));
    const next = { ...createInitialState(), settings, ready: true } as FinanceState;
    ENTITY_TYPES.forEach((type, index) => {
      (next[type] as FinanceEntity[]) = loaded[index].filter((entity) => !entity.deletedAt);
    });
    this.state = next;
    if (!settingsRecords.length) await this.persist('settings', [settings]);
    await this.generateRecurring();
    this.emit();
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async completeOnboarding(input: OnboardingInput) {
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
      name: input.accountName.trim() || 'Everyday',
      type: input.accountType,
      currency: baseCurrency,
      openingBalanceMinor: input.openingBalanceMinor,
      icon: 'wallet.bifold',
      color: input.accentHex.toUpperCase(),
      archived: false,
    });
    const categories = createDefaultCategories();
    await this.storage.putMany([
      { type: 'settings', entity: settings },
      { type: 'accounts', entity: account },
      ...categories.map((entity) => ({ type: 'categories' as const, entity })),
    ]);
    this.state = { ...this.state, settings, accounts: [account], categories };
    this.emit();
  }

  async updateSettings(patch: Partial<AppSettings>) {
    const locale = patch.locale ?? this.state.settings.locale;
    const baseCurrency = this.normalizeCurrency(patch.baseCurrency ?? this.state.settings.baseCurrency);
    this.assertLocale(locale);
    this.assertColor(patch.accentHex ?? this.state.settings.accentHex);
    const themeMode = patch.themeMode ?? this.state.settings.themeMode;
    const accentSource = patch.accentSource ?? this.state.settings.accentSource;
    if (!THEME_MODES.includes(themeMode)) throw new Error('Choose a valid theme mode.');
    if (!ACCENT_SOURCES.includes(accentSource)) throw new Error('Choose a valid accent source.');
    if (baseCurrency !== this.state.settings.baseCurrency && this.state.transactions.length) {
      throw new Error('Base currency cannot change after transactions have been recorded.');
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

  async saveAccount(input: AccountInput, id?: string) {
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
    const rules = input.archived
      ? this.state.recurringRules
        .filter((rule) => rule.active && rule.template.accountId === account.id)
        .map((rule) => updateEntity(rule, { active: false }))
      : [];
    await this.storage.putMany([
      { type: 'accounts', entity: account },
      ...rules.map((entity) => ({ type: 'recurringRules' as const, entity })),
    ]);
    this.replaceInList('accounts', account);
    rules.forEach((rule) => this.replaceInList('recurringRules', rule));
    this.emit();
    return account;
  }

  async saveCategory(input: CategoryInput, id?: string) {
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
      const parent = this.state.categories.find((item) => item.id === input.parentId && !item.archived);
      if (!parent || parent.kind !== input.kind || parent.parentId || parent.id === id) {
        throw new Error('Choose a valid top-level parent category of the same kind.');
      }
    }
    const values = {
      ...input,
      name,
      color: input.color.toUpperCase(),
    };
    const category = existing ? updateEntity(existing, values) : createEntity({ id: makeId(), ...values }) as Category;
    const rules = input.archived
      ? this.state.recurringRules
        .filter((rule) => rule.active && rule.template.categoryId === category.id)
        .map((rule) => updateEntity(rule, { active: false }))
      : [];
    await this.storage.putMany([
      { type: 'categories', entity: category },
      ...rules.map((entity) => ({ type: 'recurringRules' as const, entity })),
    ]);
    this.replaceInList('categories', category);
    rules.forEach((rule) => this.replaceInList('recurringRules', rule));
    this.emit();
    return category;
  }

  async saveTag(input: TagInput, id?: string) {
    const name = input.name.trim();
    if (!name) throw new Error('Tag name is required.');
    this.assertUniqueName('tags', name, id);
    this.assertColor(input.color);
    return await this.saveListEntity<Tag>('tags', { ...input, name, color: input.color.toUpperCase() }, id);
  }

  async saveTransaction(input: TransactionInput, id?: string) {
    const transaction = this.buildTransaction(input, id);
    await this.persist('transactions', [transaction]);
    this.replaceInList('transactions', transaction);
    this.emit();
    return transaction;
  }

  async saveBudget(input: BudgetInput, id?: string) {
    const normalized = this.validateBudget(input);
    const existing = this.findExisting(this.state.budgets, id, 'budget');
    const budget = existing
      ? updateEntity(existing, normalized)
      : createEntity({ id: makeId(), ...normalized }) as Budget;
    const periods = this.buildBudgetSnapshots(budget, true);
    await this.storage.putMany([
      { type: 'budgets', entity: budget },
      ...periods.map((entity) => ({ type: 'budgetPeriods' as const, entity })),
    ]);
    this.replaceInList('budgets', budget);
    periods.forEach((period) => this.replaceInList('budgetPeriods', period));
    this.emit();
    return budget;
  }

  async saveGoal(input: GoalInput, id?: string) {
    const normalized = this.validateGoal(input);
    return await this.saveListEntity<Goal>('goals', normalized, id);
  }

  async saveContribution(input: ContributionInput, id?: string) {
    this.assertPositiveMinor(input.amountMinor, 'Contribution');
    this.assertDate(input.localDate);
    if (!this.state.goals.some((item) => item.id === input.goalId)) throw new Error('Choose a valid goal.');
    if (input.transactionId && !this.state.transactions.some((item) => item.id === input.transactionId)) {
      throw new Error('Choose a valid transaction.');
    }
    return await this.saveListEntity<GoalContribution>('contributions', { ...input, note: input.note.trim() }, id);
  }

  async saveRecurringRule(input: RecurringInput, id?: string) {
    const normalized = this.validateRecurring(input);
    return await this.saveListEntity<RecurringRule>('recurringRules', normalized, id);
  }

  async saveExchangeRate(input: RateInput, id?: string) {
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
      if (query.minMinor !== undefined && transaction.amountMinor < query.minMinor) return false;
      if (query.maxMinor !== undefined && transaction.amountMinor > query.maxMinor) return false;
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
    const allPosted = this.queryTransactions({ toDate, statuses: ['posted'], sort: 'oldest' });
    const accounts = this.active(this.state.accounts).filter((account) => !account.archived);
    const accountBalances = accounts.map((account) => {
      let balanceMinor = account.openingBalanceMinor;
      for (const transaction of allPosted) {
        if (transaction.accountId === account.id) {
          if (transaction.kind === 'expense' || transaction.kind === 'transfer') balanceMinor -= transaction.amountMinor;
          if (transaction.kind === 'income') balanceMinor += transaction.amountMinor;
        }
        if (transaction.kind === 'transfer' && transaction.destinationAccountId === account.id) {
          balanceMinor += transaction.destinationAmountMinor ?? 0;
        }
      }
      return { account, balanceMinor };
    });
    const incomeMinor = posted.filter((item) => item.kind === 'income').reduce((sum, item) => sum + item.baseAmountMinor, 0);
    const expenseMinor = posted.filter((item) => item.kind === 'expense').reduce((sum, item) => sum + item.baseAmountMinor, 0);
    const categorySpend = this.active(this.state.categories)
      .filter((category) => category.kind === 'expense')
      .map((category) => ({
        category,
        amountMinor: posted
          .filter((item) => item.kind === 'expense' && item.categoryId === category.id)
          .reduce((sum, item) => sum + item.baseAmountMinor, 0),
      }))
      .filter((item) => item.amountMinor > 0)
      .sort((a, b) => b.amountMinor - a.amountMinor);
    const today = todayLocal();
    const budgetDate = today >= fromDate && today <= toDate ? today : toDate;
    const budgetEntries = this.getBudgetStatuses(budgetDate);
    const budgetLimitMinor = budgetEntries.reduce((sum, entry) => sum + entry.effectiveLimitMinor, 0);
    const budgetSpentMinor = budgetEntries.reduce((sum, entry) => sum + entry.spentMinor, 0);
    const dayTotals = new Map<string, number>();
    posted.filter((item) => item.kind === 'expense').forEach((item) => {
      dayTotals.set(item.localDate, (dayTotals.get(item.localDate) ?? 0) + item.baseAmountMinor);
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
    for (const item of accountBalances) {
      try {
        netWorthMinor += convertMinor(
          item.balanceMinor,
          item.account.currency,
          this.state.settings.baseCurrency,
          this.resolveRate(item.account.currency, this.state.settings.baseCurrency, toDate),
          this.state.settings.locale,
        );
      } catch {
        if (!missingExchangeRates.some((rate) => rate.fromCurrency === item.account.currency)) {
          missingExchangeRates.push({
            fromCurrency: item.account.currency,
            toCurrency: this.state.settings.baseCurrency,
          });
        }
      }
    }
    return {
      netWorthMinor,
      incomeMinor,
      expenseMinor,
      netFlowMinor: incomeMinor - expenseMinor,
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

  getBudgetStatuses(onDate: string): BudgetStatus[] {
    this.assertDate(onDate);
    return this.active(this.state.budgets)
      .filter((budget) => !budget.archived)
      .flatMap((budget) => {
        const bounds = resolvePeriod(budget.period, onDate);
        if (budget.period.unit === 'custom' && (onDate < bounds.start || onDate > bounds.end)) return [];
        // Fall back to a transient snapshot when the period rolled over while
        // the app stayed open; the next generateRecurring run persists it.
        const snapshot = this.state.budgetPeriods.find((item) =>
          item.budgetId === budget.id && item.periodStart === bounds.start,
        ) ?? this.buildBudgetSnapshots(budget, false).find((item) => item.periodStart === bounds.start);
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
          effectiveLimitMinor: snapshot.limitMinor + snapshot.rolloverMinor,
          categorySpend,
        }];
      });
  }

  getGoalProgress(goalId: string) {
    const goal = this.state.goals.find((item) => item.id === goalId);
    if (!goal) throw new Error('Choose a valid goal.');
    const manual = this.state.contributions
      .filter((item) => item.goalId === goal.id)
      .reduce((sum, item) => sum + item.amountMinor, 0);
    const linked = this.state.transactions
      .filter((item) => item.status === 'posted')
      .filter((item) => !goal.linkedCategoryId || item.categoryId === goal.linkedCategoryId)
      .reduce((sum, item) => {
        if (goal.kind === 'spending') {
          if (item.kind !== 'expense') return sum;
          if (goal.linkedAccountId && item.accountId !== goal.linkedAccountId) return sum;
          return sum + item.baseAmountMinor;
        }
        if (goal.linkedCategoryId) {
          if (item.kind !== 'income') return sum;
          if (goal.linkedAccountId && item.accountId !== goal.linkedAccountId) return sum;
          return sum + item.baseAmountMinor;
        }
        if (!goal.linkedAccountId) return sum;
        if (item.kind === 'income' && item.accountId === goal.linkedAccountId) return sum + item.baseAmountMinor;
        if (item.kind === 'expense' && item.accountId === goal.linkedAccountId) return sum - item.baseAmountMinor;
        if (item.kind === 'transfer' && item.accountId === goal.linkedAccountId) return sum - item.baseAmountMinor;
        if (item.kind === 'transfer' && item.destinationAccountId === goal.linkedAccountId) {
          return sum + this.transferInflowBaseMinor(item);
        }
        return sum;
      }, 0);
    return goal.initialMinor + manual + linked;
  }

  // The base value credited by a transfer's destination leg. baseAmountMinor
  // snapshots the source leg, which diverges from the destination whenever the
  // manual destination amount disagrees with the source-leg conversion.
  private transferInflowBaseMinor(item: TransactionRecord) {
    const base = this.state.settings.baseCurrency;
    const destination = this.state.accounts.find((account) => account.id === item.destinationAccountId);
    const destinationAmount = item.destinationAmountMinor;
    if (!destination || destinationAmount === null) return item.baseAmountMinor;
    if (destination.currency === base) return destinationAmount;
    try {
      const rate = this.resolveRate(destination.currency, base, item.localDate);
      if (!rate) return item.baseAmountMinor;
      return convertMinor(destinationAmount, destination.currency, base, rate, this.state.settings.locale);
    } catch {
      return item.baseAmountMinor;
    }
  }

  generateRecurring(horizonDate = addRecurrence(todayLocal(), 'month', 1)) {
    const run = this.recurringQueue.then(() => this.generateRecurringNow(horizonDate));
    this.recurringQueue = run.then(() => undefined, () => undefined);
    return run;
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
        while (due <= horizonDate && guard < 366) {
          guard += 1;
          if (rule.endDate && due > rule.endDate) break;
          const occurrenceKey = `${rule.id}:${due}`;
          if (!transactions.some((item) => item.occurrenceKey === occurrenceKey)) {
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
          due = addRecurrence(due, rule.unit, Math.max(1, rule.interval), rule.startDate);
        }
        const active = !rule.endDate || due <= rule.endDate;
        if (due !== rule.nextDueDate || active !== rule.active) {
          ruleChanges.push(updateEntity(rule, { nextDueDate: due, active }));
        }
      } catch {
        continue;
      }
    }
    const recurringChanged = transactionChanges.length > 0 || ruleChanges.length > 0;
    if (recurringChanged) {
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

  async confirmUpcoming(id: string) {
    const transaction = this.state.transactions.find((item) => item.id === id);
    if (!transaction || transaction.status !== 'upcoming') return;
    const updated = updateEntity(transaction, { status: 'posted' });
    await this.persist('transactions', [updated]);
    this.replaceInList('transactions', updated);
    this.emit();
  }

  async skipUpcoming(id: string) {
    const transaction = this.state.transactions.find((item) => item.id === id);
    if (!transaction || transaction.status !== 'upcoming') return;
    const updated = updateEntity(transaction, { status: 'skipped' });
    await this.persist('transactions', [updated]);
    this.replaceInList('transactions', updated);
    this.emit();
  }

  async updateTransactionsCategory(ids: string[], categoryId: string | null) {
    const selected = new Set(ids);
    const candidates = this.state.transactions.filter((item) => selected.has(item.id) && item.kind !== 'transfer');
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

  async deleteEntities(type: keyof FinanceState, ids: string[]) {
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
        .map((rule) => updateEntity(rule, { active: false }))
      : [];
    await this.storage.putMany([
      ...deleted.map((entity) => ({ type: type as EntityType, entity })),
      ...rules.map((entity) => ({ type: 'recurringRules' as const, entity })),
    ]);
    this.state = { ...this.state, [type]: list.filter((entity) => !ids.includes(entity.id)) };
    rules.forEach((rule) => this.replaceInList('recurringRules', rule));
    this.emit();
  }

  async importCsv(rows: CsvImportRow[], commit = false) {
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
        const amountMinor = parseMoney(row.amount, row.currency, this.state.settings.locale);
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
            ? parseMoney(row.destinationAmount, destination.currency, this.state.settings.locale)
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
    const headers = ['date', 'type', 'status', 'title', 'amount', 'currency', 'account', 'destination_account', 'destination_amount', 'category', 'tags', 'note', 'exchange_rate', 'base_amount_minor', 'transfer_id'];
    const rows = this.queryTransactions({ sort: 'oldest' }).map((transaction) => {
      const account = this.state.accounts.find((item) => item.id === transaction.accountId)?.name ?? '';
      const destination = this.state.accounts.find((item) => item.id === transaction.destinationAccountId);
      const category = this.state.categories.find((item) => item.id === transaction.categoryId)?.name ?? '';
      const tags = transaction.tagIds.map((id) => this.state.tags.find((item) => item.id === id)?.name).filter(Boolean).join('|');
      return [transaction.localDate, transaction.kind, transaction.status, transaction.title, minorToDecimalString(transaction.amountMinor, transaction.currency, this.state.settings.locale), transaction.currency, account, destination?.name ?? '', transaction.destinationAmountMinor !== null && destination ? minorToDecimalString(transaction.destinationAmountMinor, destination.currency, this.state.settings.locale) : '', category, tags, transaction.note, transaction.exchangeRate, transaction.baseAmountMinor, transaction.transferGroupId ?? ''];
    });
    return `\uFEFF${[headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n')}`;
  }

  async resetAllData() {
    await this.storage.clear();
    this.state = { ...createInitialState(), ready: true };
    await this.persist('settings', [this.state.settings]);
    this.emit();
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
    const destination = input.destinationAccountId
      ? this.active(this.state.accounts).find((item) => item.id === input.destinationAccountId)
      : null;
    if (
      input.kind === 'transfer' &&
      (!destination || destination.id === account.id || (destination.archived && existing?.destinationAccountId !== destination.id))
    ) {
      throw new Error('Choose a different destination account.');
    }
    const category = input.categoryId
      ? this.active(this.state.categories).find((item) => item.id === input.categoryId && !item.archived)
      : null;
    if (input.kind !== 'transfer' && input.categoryId && (!category || category.kind !== input.kind)) {
      throw new Error(`Choose a valid ${input.kind} category.`);
    }
    const tagIds = [...new Set(input.tagIds ?? [])];
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
    if (input.kind === 'transfer') {
      if (input.destinationAmountMinor !== undefined && input.destinationAmountMinor !== null) {
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

  private budgetSpend(filters: BudgetFilters, fromDate: string, toDate: string) {
    return this.queryTransactions({ fromDate, toDate, statuses: ['posted'], kinds: ['expense'] })
      .filter((item) => !filters.accountIds.length || filters.accountIds.includes(item.accountId))
      .filter((item) => !filters.categoryIds.length || (!!item.categoryId && filters.categoryIds.includes(item.categoryId)))
      .filter((item) => !filters.tagIds.length || filters.tagIds.some((id) => item.tagIds.includes(id)))
      .reduce((sum, item) => sum + item.baseAmountMinor, 0);
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

  private buildBudgetSnapshots(budget: Budget, updateCurrent: boolean) {
    const bounds = resolvePeriod(budget.period, todayLocal());
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
          ? previous.rolloverMinor + previous.limitMinor - this.budgetSpend(previous.filters, previous.periodStart, previous.periodEnd)
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

  private validateGoal(input: GoalInput): GoalInput {
    if (!GOAL_KINDS.includes(input.kind)) throw new Error('Choose a valid goal kind.');
    this.assertPositiveMinor(input.targetMinor, 'Goal target');
    this.assertSafeMinor(input.initialMinor, 'Starting progress');
    if (input.initialMinor < 0) throw new Error('Starting progress cannot be negative.');
    if (input.targetDate) this.assertDate(input.targetDate);
    if (input.linkedAccountId && !this.state.accounts.some((item) => item.id === input.linkedAccountId && !item.archived)) {
      throw new Error('Choose a valid linked account.');
    }
    if (input.linkedCategoryId) {
      const expectedKind = input.kind === 'saving' ? 'income' : 'expense';
      if (!this.state.categories.some((item) => item.id === input.linkedCategoryId && item.kind === expectedKind && !item.archived)) {
        throw new Error(`Choose a valid ${expectedKind} category.`);
      }
    }
    this.assertColor(input.color);
    return { ...input, name: input.name.trim() || 'Goal', color: input.color.toUpperCase() };
  }

  private validateRecurring(input: RecurringInput): RecurringInput {
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
    const account = this.state.accounts.find((item) => item.id === input.template.accountId && !item.archived);
    if (!account) throw new Error('Choose a valid account.');
    if (this.normalizeCurrency(input.template.currency) !== account.currency) {
      throw new Error('Recurring currency must match its account.');
    }
    if (account.currency !== this.state.settings.baseCurrency) {
      this.resolveRate(account.currency, this.state.settings.baseCurrency, input.startDate);
    }
    if (input.template.categoryId) {
      const category = this.state.categories.find((item) =>
        item.id === input.template.categoryId && item.kind === input.template.kind && !item.archived,
      );
      if (!category) throw new Error(`Choose a valid ${input.template.kind} category.`);
    }
    this.assertIdsExist(input.template.tagIds, this.state.tags, 'tag');
    return {
      ...input,
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
    // Archived entities are hidden everywhere, so their names are free to
    // reuse; restoring one re-checks against the active set.
    const duplicate = (this.state[type] as (Account | Category | Tag)[]).some((item) =>
      item.id !== id &&
      !('archived' in item && item.archived) &&
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
    try {
      new Intl.Locale(value);
      new Intl.NumberFormat(value).format(1);
    } catch {
      throw new Error('Use a valid locale such as en-US.');
    }
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
