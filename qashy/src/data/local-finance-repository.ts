import { z } from 'zod';

import { PlatformStorageAdapter } from '@/data/storage';
import type { StorageAdapter, StoredEntity } from '@/data/storage-adapter';
import type {
  Account,
  AppSettings,
  Budget,
  BudgetFilters,
  BudgetPeriodSnapshot,
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
import { addRecurrence, todayLocal } from '@/utils/date';
import { createEntity, makeId, nowIso, updateEntity } from '@/utils/entity';
import { escapeCsv } from '@/utils/csv';
import { convertMinor, isSafeMinor, minorToDecimalString, parseMoney } from '@/utils/money';
import { previousPeriod, resolvePeriod } from '@/utils/period';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRANSACTION_TYPES = ['expense', 'income', 'transfer'] as const;
const csvRowSchema = z.object({
  rowNumber: z.number(),
  date: z.string().regex(DATE_PATTERN),
  type: z.enum(TRANSACTION_TYPES),
  title: z.string().min(1),
  amount: z.string().min(1),
  currency: z.string().min(3).max(3),
  account: z.string().min(1),
  category: z.string().default(''),
  tags: z.string().default(''),
  note: z.string().default(''),
  exchangeRate: z.string().default('1'),
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
    await this.ensureBudgetSnapshots();
    await this.generateRecurring();
    this.emit();
  }

  getSnapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async completeOnboarding(input: OnboardingInput) {
    const settings = updateEntity(this.state.settings, {
      onboardingComplete: true,
      locale: input.locale,
      baseCurrency: input.baseCurrency.toUpperCase(),
      themeMode: input.themeMode,
      accentSource: input.accentSource,
      accentHex: input.accentHex,
    });
    const account = createEntity({
      id: makeId(),
      name: input.accountName.trim() || 'Everyday',
      type: input.accountType,
      currency: input.baseCurrency.toUpperCase(),
      openingBalanceMinor: input.openingBalanceMinor,
      icon: 'wallet.bifold',
      color: input.accentHex,
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
    const settings = updateEntity(this.state.settings, patch);
    await this.persist('settings', [settings]);
    this.state = { ...this.state, settings };
    this.emit();
    return settings;
  }

  saveAccount(input: AccountInput, id?: string) {
    return this.saveListEntity<Account>('accounts', input, id);
  }

  saveCategory(input: CategoryInput, id?: string) {
    return this.saveListEntity<Category>('categories', input, id);
  }

  saveTag(input: TagInput, id?: string) {
    return this.saveListEntity<Tag>('tags', input, id);
  }

  async saveTransaction(input: TransactionInput, id?: string) {
    const transaction = this.buildTransaction(input, id);
    await this.persist('transactions', [transaction]);
    this.replaceInList('transactions', transaction);
    this.emit();
    return transaction;
  }

  async saveBudget(input: BudgetInput, id?: string) {
    const budget = await this.saveListEntity<Budget>('budgets', input, id);
    await this.ensureBudgetSnapshot(budget);
    return budget;
  }

  saveGoal(input: GoalInput, id?: string) {
    return this.saveListEntity<Goal>('goals', input, id);
  }

  saveContribution(input: ContributionInput, id?: string) {
    return this.saveListEntity<GoalContribution>('contributions', input, id);
  }

  saveRecurringRule(input: RecurringInput, id?: string) {
    return this.saveListEntity<RecurringRule>('recurringRules', input, id);
  }

  saveExchangeRate(input: RateInput, id?: string) {
    return this.saveListEntity<ExchangeRate>('exchangeRates', input, id);
  }

  queryTransactions(query: TransactionQuery = {}) {
    const normalizedSearch = query.search?.trim().toLocaleLowerCase();
    let result = this.active(this.state.transactions).filter((transaction) => {
      if (normalizedSearch && !`${transaction.title} ${transaction.note}`.toLocaleLowerCase().includes(normalizedSearch)) return false;
      if (query.accountIds?.length && !query.accountIds.includes(transaction.accountId)) return false;
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
    const budgetEntries = this.active(this.state.budgets).filter((budget) => !budget.archived);
    const budgetLimitMinor = budgetEntries.reduce((sum, budget) => sum + budget.limitMinor, 0);
    const budgetSpentMinor = budgetEntries.reduce(
      (sum, budget) => sum + this.budgetSpend(budget.filters, fromDate, toDate),
      0,
    );
    const dayTotals = new Map<string, number>();
    posted.filter((item) => item.kind === 'expense').forEach((item) => {
      dayTotals.set(item.localDate, (dayTotals.get(item.localDate) ?? 0) + item.baseAmountMinor);
    });
    const netWorthMinor = accountBalances.reduce(
      (sum, item) =>
        sum +
        convertMinor(
          item.balanceMinor,
          item.account.currency,
          this.state.settings.baseCurrency,
          this.findRate(item.account.currency, toDate),
          this.state.settings.locale,
        ),
      0,
    );
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
      dailySpend: Array.from(dayTotals, ([date, amountMinor]) => ({ date, amountMinor })).sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  async generateRecurring(horizonDate = addRecurrence(todayLocal(), 'month', 1)) {
    let generated = 0;
    for (const rule of this.active(this.state.recurringRules).filter((item) => item.active)) {
      let due = rule.nextDueDate;
      let guard = 0;
      while (due <= horizonDate && guard < 366) {
        guard += 1;
        if (rule.endDate && due > rule.endDate) break;
        const occurrenceKey = `${rule.id}:${due}`;
        if (!this.state.transactions.some((item) => item.occurrenceKey === occurrenceKey)) {
          await this.saveTransaction({
            ...rule.template,
            localDate: due,
            status: rule.autoPost && due <= todayLocal() ? 'posted' : 'upcoming',
            recurringRuleId: rule.id,
            occurrenceKey,
          });
          generated += 1;
        }
        due = addRecurrence(due, rule.unit, Math.max(1, rule.interval));
      }
      await this.saveRecurringRule(
        { ...rule, nextDueDate: due, active: !rule.endDate || due <= rule.endDate },
        rule.id,
      );
    }
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
    const updated = this.state.transactions
      .filter((item) => selected.has(item.id) && item.kind !== 'transfer')
      .map((item) => updateEntity(item, { categoryId }));
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
    await this.persist(type as EntityType, deleted);
    this.state = { ...this.state, [type]: list.filter((entity) => !ids.includes(entity.id)) };
    this.emit();
  }

  async importCsv(rows: CsvImportRow[], commit = false) {
    const result: ImportResult = { validRows: [], rejectedRows: [], duplicateRows: [], warnings: [], committedIds: [] };
    const staged: { input: TransactionInput; tagNames: string[] }[] = [];
    const duplicateKeys = new Set(this.state.transactions.map((item) =>
      `${item.localDate}|${item.accountId}|${item.amountMinor}|${item.title.trim().toLowerCase()}`,
    ));
    for (const raw of rows) {
      const parsed = csvRowSchema.safeParse(raw);
      if (!parsed.success) {
        result.rejectedRows.push({ rowNumber: raw.rowNumber, reason: parsed.error.issues[0]?.message ?? 'Invalid row' });
        continue;
      }
      const row = parsed.data;
      const account = this.active(this.state.accounts).find((item) => item.name.toLowerCase() === row.account.toLowerCase());
      if (!account) {
        result.rejectedRows.push({ rowNumber: row.rowNumber, reason: `Unknown account: ${row.account}` });
        continue;
      }
      try {
        if (row.currency.toUpperCase() !== account.currency) {
          throw new Error(`Currency ${row.currency.toUpperCase()} does not match ${account.name} (${account.currency}).`);
        }
        const amountMinor = parseMoney(row.amount, row.currency, this.state.settings.locale);
        const destination = row.destinationAccount
          ? this.active(this.state.accounts).find((item) => item.name.toLowerCase() === row.destinationAccount.toLowerCase())
          : undefined;
        if (row.type === 'transfer' && !destination) {
          result.rejectedRows.push({ rowNumber: row.rowNumber, reason: `Unknown destination account: ${row.destinationAccount || 'missing'}` });
          continue;
        }
        const duplicateKey = `${row.date}|${account.id}|${amountMinor}|${row.title.trim().toLowerCase()}`;
        if (duplicateKeys.has(duplicateKey)) {
          result.duplicateRows.push(row.rowNumber);
          continue;
        }
        const category = this.active(this.state.categories).find((item) => item.name.toLowerCase() === row.category.toLowerCase());
        const tagNames = row.tags.split('|').map((item) => item.trim()).filter(Boolean);
        const input: TransactionInput = {
          kind: row.type,
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
          exchangeRate: row.exchangeRate || '1',
        };
        // Build once during preview so rate and transfer validation errors are reported per row.
        this.buildTransaction(input);
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
        return this.buildTransaction({ ...input, tagIds });
      });
      await this.storage.putMany([
        ...newTags.map((entity) => ({ type: 'tags' as const, entity })),
        ...transactions.map((entity) => ({ type: 'transactions' as const, entity })),
      ]);
      this.state = {
        ...this.state,
        tags,
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
    const headers = ['date', 'type', 'title', 'amount', 'currency', 'account', 'destination_account', 'destination_amount', 'category', 'tags', 'note', 'exchange_rate', 'base_amount_minor', 'transfer_id'];
    const rows = this.queryTransactions({ sort: 'oldest' }).map((transaction) => {
      const account = this.state.accounts.find((item) => item.id === transaction.accountId)?.name ?? '';
      const destination = this.state.accounts.find((item) => item.id === transaction.destinationAccountId);
      const category = this.state.categories.find((item) => item.id === transaction.categoryId)?.name ?? '';
      const tags = transaction.tagIds.map((id) => this.state.tags.find((item) => item.id === id)?.name).filter(Boolean).join('|');
      return [transaction.localDate, transaction.kind, transaction.title, minorToDecimalString(transaction.amountMinor, transaction.currency, this.state.settings.locale), transaction.currency, account, destination?.name ?? '', transaction.destinationAmountMinor !== null && destination ? minorToDecimalString(transaction.destinationAmountMinor, destination.currency, this.state.settings.locale) : '', category, tags, transaction.note, transaction.exchangeRate, transaction.baseAmountMinor, transaction.transferGroupId ?? ''];
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
    const existing = id ? list.find((item) => item.id === id) : undefined;
    const entity = existing ? updateEntity(existing, input as Partial<T>) : createEntity<T>({ id: makeId(), ...input } as T);
    await this.persist(type, [entity]);
    this.replaceInList(type, entity);
    this.emit();
    return entity;
  }

  private buildTransaction(input: TransactionInput, id?: string) {
    if (!isSafeMinor(input.amountMinor) || input.amountMinor <= 0) {
      throw new Error('Enter a valid positive amount.');
    }
    const account = this.active(this.state.accounts).find((item) => item.id === input.accountId);
    if (!account) throw new Error('Choose a valid account.');
    const destination = input.destinationAccountId
      ? this.active(this.state.accounts).find((item) => item.id === input.destinationAccountId)
      : null;
    if (input.kind === 'transfer' && (!destination || destination.id === account.id)) {
      throw new Error('Choose a different destination account.');
    }
    const rate = input.exchangeRate ?? this.findRate(account.currency, input.localDate);
    const baseAmountMinor = convertMinor(
      input.amountMinor,
      account.currency,
      this.state.settings.baseCurrency,
      rate,
      this.state.settings.locale,
    );
    const existing = id ? this.state.transactions.find((item) => item.id === id) : undefined;
    const value = {
      kind: input.kind,
      status: input.status ?? 'posted',
      title: input.title.trim() || (input.kind === 'transfer' ? 'Transfer' : 'Untitled'),
      note: input.note?.trim() ?? '',
      localDate: input.localDate,
      accountId: account.id,
      destinationAccountId: destination?.id ?? null,
      categoryId: input.kind === 'transfer' ? null : (input.categoryId ?? null),
      tagIds: input.tagIds ?? [],
      amountMinor: input.amountMinor,
      destinationAmountMinor: input.kind === 'transfer'
        ? (input.destinationAmountMinor ?? convertMinor(
          input.amountMinor,
          account.currency,
          destination!.currency,
          this.findRate(account.currency, input.localDate, destination!.currency),
          this.state.settings.locale,
        ))
        : null,
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

  private findRate(fromCurrency: string, localDate: string, toCurrency = this.state.settings.baseCurrency) {
    if (fromCurrency === toCurrency) return '1';
    const direct = this.active(this.state.exchangeRates)
      .filter((item) => item.fromCurrency === fromCurrency && item.toCurrency === toCurrency && item.effectiveDate <= localDate)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
    return direct?.rate ?? '1';
  }

  private budgetSpend(filters: BudgetFilters, fromDate: string, toDate: string) {
    return this.queryTransactions({ fromDate, toDate, statuses: ['posted'], kinds: ['expense'] })
      .filter((item) => !filters.accountIds.length || filters.accountIds.includes(item.accountId))
      .filter((item) => !filters.categoryIds.length || (!!item.categoryId && filters.categoryIds.includes(item.categoryId)))
      .filter((item) => !filters.tagIds.length || filters.tagIds.some((id) => item.tagIds.includes(id)))
      .reduce((sum, item) => sum + item.baseAmountMinor, 0);
  }

  private async ensureBudgetSnapshots() {
    for (const budget of this.active(this.state.budgets).filter((item) => !item.archived)) {
      await this.ensureBudgetSnapshot(budget);
    }
  }

  private async ensureBudgetSnapshot(budget: Budget) {
    const bounds = resolvePeriod(budget.period, todayLocal());
    const existing = this.state.budgetPeriods.find((item) => item.budgetId === budget.id && item.periodStart === bounds.start);
    let rolloverMinor = 0;
    if (budget.rollover && !existing) {
      const previous = previousPeriod(budget.period, bounds.start);
      if (previous) {
        const snapshot = this.state.budgetPeriods.find((item) => item.budgetId === budget.id && item.periodStart === previous.start);
        if (snapshot) rolloverMinor = snapshot.rolloverMinor + snapshot.limitMinor - this.budgetSpend(snapshot.filters, snapshot.periodStart, snapshot.periodEnd);
      }
    }
    const values = {
      budgetId: budget.id,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      limitMinor: budget.limitMinor,
      rolloverMinor,
      filters: budget.filters,
      categoryLimits: budget.categoryLimits,
    };
    const period = existing ? updateEntity(existing, values) : createEntity({ id: makeId(), ...values }) as BudgetPeriodSnapshot;
    await this.persist('budgetPeriods', [period]);
    this.replaceInList('budgetPeriods', period);
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

export const financeRepository = new LocalFinanceRepository();
