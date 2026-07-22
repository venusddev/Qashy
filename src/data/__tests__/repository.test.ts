import { LocalFinanceRepository } from '@/data/local-finance-repository';
import { MemoryStorageAdapter } from '@/data/memory-storage';
import type { CsvImportRow, RecurringRule, TransactionKind, TransactionStatus } from '@/domain/models';
import { parseCsvTable } from '@/utils/csv';

async function createRepository(storage = new MemoryStorageAdapter(), locale = 'en-US') {
  const repository = new LocalFinanceRepository(storage);
  await repository.initialize();
  await repository.completeOnboarding({
    locale,
    baseCurrency: 'USD',
    accountName: 'Everyday',
    accountType: 'checking',
    openingBalanceMinor: 0,
    themeMode: 'system',
    accentSource: 'system',
    accentHex: '#5966E9',
  });
  return { repository, storage };
}

describe('FinanceRepository contract', () => {
  it('persists onboarding, derives balances, and excludes transfers from cash flow', async () => {
    const storage = new MemoryStorageAdapter();
    const repository = new LocalFinanceRepository(storage);
    await repository.initialize();
    await repository.completeOnboarding({
      locale: 'en-US',
      baseCurrency: 'USD',
      accountName: 'Everyday',
      accountType: 'checking',
      openingBalanceMinor: 100_00,
      themeMode: 'system',
      accentSource: 'system',
      accentHex: '#5966E9',
    });
    const first = repository.getSnapshot().accounts[0];
    const second = await repository.saveAccount({
      name: 'Savings',
      type: 'savings',
      currency: 'USD',
      openingBalanceMinor: 0,
      icon: 'wallet',
      color: '#00A58E',
      archived: false,
    });
    const expense = await repository.saveTransaction({ kind: 'expense', title: 'Groceries', localDate: '2026-07-10', accountId: first.id, amountMinor: 2500 });
    const transfer = await repository.saveTransaction({ kind: 'transfer', title: 'Save', localDate: '2026-07-11', accountId: first.id, destinationAccountId: second.id, amountMinor: 3000 });

    const summary = repository.getDashboard('2026-07-01', '2026-07-31');
    expect(summary.expenseMinor).toBe(2500);
    expect(summary.netFlowMinor).toBe(-2500);
    expect(summary.dailySpend).toHaveLength(31);
    expect(summary.dailySpend.find((item) => item.date === '2026-07-10')?.amountMinor).toBe(2500);
    expect(summary.dailySpend.find((item) => item.date === '2026-07-09')?.amountMinor).toBe(0);
    expect(summary.accountBalances.find((item) => item.account.id === first.id)?.balanceMinor).toBe(4500);
    expect(summary.accountBalances.find((item) => item.account.id === second.id)?.balanceMinor).toBe(3000);

    const groceries = repository.getSnapshot().categories.find((item) => item.name === 'Groceries')!;
    await expect(repository.updateTransactionsCategory([expense.id, transfer.id], groceries.id))
      .rejects.toThrow('Transfers do not have categories');
    expect(repository.getSnapshot().transactions.find((item) => item.id === expense.id)?.categoryId).toBeNull();
    await repository.updateTransactionsCategory([expense.id], groceries.id);
    expect(repository.getSnapshot().transactions.find((item) => item.id === expense.id)?.categoryId).toBe(groceries.id);
    expect(repository.getSnapshot().transactions.find((item) => item.id === transfer.id)?.categoryId).toBeNull();

    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    expect(reloaded.queryTransactions()).toHaveLength(2);
  });

  it('generates recurring occurrences idempotently', async () => {
    const repository = new LocalFinanceRepository(new MemoryStorageAdapter());
    await repository.initialize();
    await repository.completeOnboarding({ locale: 'en-US', baseCurrency: 'USD', accountName: 'Everyday', accountType: 'checking', openingBalanceMinor: 0, themeMode: 'system', accentSource: 'system', accentHex: '#5966E9' });
    const account = repository.getSnapshot().accounts[0];
    await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Rent', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 120000, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2026-01-31', endDate: '2026-03-31', nextDueDate: '2026-01-31', autoPost: false, active: true,
    });
    await repository.generateRecurring('2026-03-31');
    await repository.generateRecurring('2026-03-31');
    expect(repository.getSnapshot().transactions.map((item) => item.localDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('commits a CSV batch atomically when storage fails', async () => {
    class FailingStorage extends MemoryStorageAdapter {
      fail = false;

      override async putMany(records: Parameters<MemoryStorageAdapter['putMany']>[0]) {
        if (this.fail) throw new Error('simulated disk failure');
        await super.putMany(records);
      }
    }

    const storage = new FailingStorage();
    const repository = new LocalFinanceRepository(storage);
    await repository.initialize();
    await repository.completeOnboarding({ locale: 'en-US', baseCurrency: 'USD', accountName: 'Everyday', accountType: 'checking', openingBalanceMinor: 0, themeMode: 'system', accentSource: 'system', accentHex: '#5966E9' });
    const rows = [
      { rowNumber: 2, date: '2026-07-10', type: 'expense' as const, title: 'Coffee', amount: '4.50', currency: 'USD', account: 'Everyday', category: 'Dining', tags: 'Work', note: '', exchangeRate: '1', destinationAccount: '', destinationAmount: '' },
      { rowNumber: 3, date: '2026-07-11', type: 'expense' as const, title: 'Lunch', amount: '12.00', currency: 'USD', account: 'Everyday', category: 'Dining', tags: 'Work', note: '', exchangeRate: '1', destinationAccount: '', destinationAmount: '' },
    ];

    expect((await repository.importCsv(rows, false)).validRows).toHaveLength(2);
    storage.fail = true;
    await expect(repository.importCsv(rows, true)).rejects.toThrow('simulated disk failure');
    expect(repository.getSnapshot().transactions).toHaveLength(0);
    expect(repository.getSnapshot().tags).toHaveLength(0);
  });

  it('derives cross-currency transfers through base rates and reports missing net-worth rates', async () => {
    const { repository } = await createRepository();
    const eur = await repository.saveAccount({ name: 'Euro', type: 'checking', currency: 'EUR', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    const gbp = await repository.saveAccount({ name: 'Pounds', type: 'checking', currency: 'GBP', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '2', effectiveDate: '2026-01-01' });
    await repository.saveExchangeRate({ fromCurrency: 'GBP', toCurrency: 'USD', rate: '4', effectiveDate: '2026-01-01' });

    const transfer = await repository.saveTransaction({ kind: 'transfer', title: 'Cross rate', localDate: '2026-07-15', accountId: eur.id, destinationAccountId: gbp.id, amountMinor: 10000 });
    expect(transfer.destinationAmountMinor).toBe(5000);

    await expect(repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '-1', effectiveDate: '2026-02-01' })).rejects.toThrow('positive');
    const yen = await repository.saveAccount({ name: 'Yen', type: 'checking', currency: 'JPY', openingBalanceMinor: 1000, icon: 'wallet', color: '#5966E9', archived: false });
    await expect(repository.saveTransaction({ kind: 'expense', title: 'No rate', localDate: '2026-07-15', accountId: yen.id, amountMinor: 100 })).rejects.toThrow('Missing exchange rate');
    expect(repository.getDashboard('2026-07-01', '2026-07-31').missingExchangeRates).toEqual([{ fromCurrency: 'JPY', toCurrency: 'USD' }]);
  });

  it('locks account currency after finance records reference it', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    await repository.saveTransaction({ kind: 'expense', title: 'Coffee', localDate: '2026-07-15', accountId: account.id, amountMinor: 500 });
    await expect(repository.saveAccount({ name: account.name, type: account.type, currency: 'JPY', openingBalanceMinor: account.openingBalanceMinor, icon: account.icon, color: account.color, archived: false }, account.id)).rejects.toThrow('currency cannot change');
  });

  it('locks the base currency as soon as onboarding creates base-denominated records', async () => {
    const { repository } = await createRepository();

    await expect(repository.updateSettings({ baseCurrency: 'EUR' }))
      .rejects.toThrow('cannot change after setup');
    expect(repository.getSnapshot().settings.baseCurrency).toBe('USD');
  });

  it('auto-posts an existing recurring occurrence after its due date', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const { repository } = await createRepository();
      const account = repository.getSnapshot().accounts[0];
      await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Auto', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
        unit: 'month', interval: 1, startDate: '2026-07-16', endDate: null, nextDueDate: '2026-07-16', autoPost: true, active: true,
      });
      await repository.generateRecurring('2026-07-31');
      expect(repository.getSnapshot().transactions.find((item) => item.localDate === '2026-07-16')?.status).toBe('upcoming');

      jest.setSystemTime(new Date('2026-07-17T09:00:00Z'));
      await repository.generateRecurring('2026-08-31');
      expect(repository.getSnapshot().transactions.find((item) => item.localDate === '2026-07-16')?.status).toBe('posted');
    } finally {
      jest.useRealTimers();
    }
  });

  it('carries budget rollover forward and preserves prior snapshots', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-06-15T09:00:00Z'));
      const storage = new MemoryStorageAdapter();
      const { repository } = await createRepository(storage);
      const account = repository.getSnapshot().accounts[0];
      const budget = await repository.saveBudget({
        name: 'Monthly', icon: 'chart', color: '#5966E9', limitMinor: 1000,
        period: { unit: 'month', interval: 1, anchorDate: '2026-06-01', endDate: null },
        rollover: true, filters: { accountIds: [], categoryIds: [], tagIds: [] }, categoryLimits: [], archived: false,
      });
      await repository.saveTransaction({ kind: 'expense', title: 'June', localDate: '2026-06-20', accountId: account.id, amountMinor: 400 });

      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const reloaded = new LocalFinanceRepository(storage);
      await reloaded.initialize();
      expect(reloaded.getBudgetStatuses('2026-07-15')[0]).toMatchObject({ effectiveLimitMinor: 1600, spentMinor: 0 });

      await reloaded.saveBudget({
        name: budget.name, icon: budget.icon, color: budget.color, limitMinor: 2000,
        period: budget.period, rollover: budget.rollover, filters: budget.filters,
        categoryLimits: budget.categoryLimits, archived: false,
      }, budget.id);
      expect(reloaded.getSnapshot().budgetPeriods.find((item) => item.periodStart === '2026-06-01')?.limitMinor).toBe(1000);
      expect(reloaded.getBudgetStatuses('2026-07-15')[0].effectiveLimitMinor).toBe(2600);
    } finally {
      jest.useRealTimers();
    }
  });

  it('saves a budget and its period snapshot atomically', async () => {
    class FailingStorage extends MemoryStorageAdapter {
      fail = false;

      override async putMany(records: Parameters<MemoryStorageAdapter['putMany']>[0]) {
        if (this.fail) throw new Error('simulated disk failure');
        await super.putMany(records);
      }
    }
    const storage = new FailingStorage();
    const { repository } = await createRepository(storage);
    storage.fail = true;
    await expect(repository.saveBudget({
      name: 'Atomic', icon: 'chart', color: '#5966E9', limitMinor: 1000,
      period: { unit: 'month', interval: 1, anchorDate: '2026-07-01', endDate: null },
      rollover: false, filters: { accountIds: [], categoryIds: [], tagIds: [] }, categoryLimits: [], archived: false,
    })).rejects.toThrow('simulated disk failure');
    expect(repository.getSnapshot().budgets).toHaveLength(0);
    expect(repository.getSnapshot().budgetPeriods).toHaveLength(0);
  });

  it('tracks linked savings goals with transfer-aware net movement', async () => {
    const { repository } = await createRepository();
    const checking = repository.getSnapshot().accounts[0];
    const savings = await repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    await repository.saveTransaction({ kind: 'transfer', title: 'Save', localDate: '2026-07-10', accountId: checking.id, destinationAccountId: savings.id, amountMinor: 3000 });
    await repository.saveTransaction({ kind: 'expense', title: 'Withdrawal', localDate: '2026-07-11', accountId: savings.id, amountMinor: 500 });
    const goal = await repository.saveGoal({ name: 'Fund', kind: 'saving', icon: 'target', color: '#5966E9', targetMinor: 10000, initialMinor: 0, targetDate: null, linkedAccountId: savings.id, linkedCategoryId: null, archived: false });
    expect(repository.getGoalProgress(goal.id)).toBe(2500);
  });

  it('uses semantic CSV duplicates and preserves transaction status on round-trip', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    await repository.saveTransaction({ kind: 'expense', title: 'Same', localDate: '2026-07-15', accountId: account.id, amountMinor: 500 });
    const incomeRow: CsvImportRow = { rowNumber: 2, date: '2026-07-15', type: 'income', status: 'posted', title: 'Same', amount: '5.00', currency: 'USD', account: 'Everyday', category: '', tags: '', note: '', exchangeRate: '', destinationAccount: '', destinationAmount: '' };
    const preview = await repository.importCsv([incomeRow], false);
    expect(preview.validRows).toHaveLength(1);
    expect(preview.duplicateRows).toHaveLength(0);
    await repository.saveTransaction({ kind: 'expense', status: 'upcoming', title: 'Future', localDate: '2026-08-01', accountId: account.id, amountMinor: 900 });

    const table = parseCsvTable(repository.exportCsv());
    const rows = table.rows.map((record) => ({
      rowNumber: Number(record.rowNumber),
      date: String(record.date), type: String(record.type) as TransactionKind,
      status: String(record.status) as TransactionStatus, title: String(record.title), amount: String(record.amount),
      currency: String(record.currency), account: String(record.account), category: String(record.category),
      tags: String(record.tags), note: String(record.note), exchangeRate: String(record.exchange_rate),
      destinationAccount: String(record.destination_account), destinationAmount: String(record.destination_amount),
      destinationBaseAmountMinor: String(record.destination_base_amount_minor),
    } satisfies CsvImportRow));
    const { repository: imported } = await createRepository();
    await imported.importCsv(rows, true);
    expect(imported.queryTransactions({ statuses: ['upcoming'] }).map((item) => item.title)).toEqual(['Future']);
  });

  it('deactivates recurring rules when their account or category is deleted', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const account = await repository.saveAccount({ name: 'Doomed', type: 'checking', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    const rule = await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Sub', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2099-01-01', endDate: null, nextDueDate: '2099-01-01', autoPost: false, active: true,
    });
    await repository.deleteEntities('accounts', [account.id]);
    expect(repository.getSnapshot().recurringRules.find((item) => item.id === rule.id)?.active).toBe(false);

    const reloaded = new LocalFinanceRepository(storage);
    await expect(reloaded.initialize()).resolves.toBeUndefined();
  });

  it('removes a recurring rule from memory and persisted storage', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    const rule = await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Temporary', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
      unit: 'month',
      interval: 1,
      startDate: '2099-01-01',
      endDate: null,
      nextDueDate: '2099-01-01',
      autoPost: false,
      active: true,
    });
    await repository.deleteEntities('recurringRules', [rule.id]);
    expect(repository.getSnapshot().recurringRules).toHaveLength(0);

    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    expect(reloaded.getSnapshot().recurringRules).toHaveLength(0);
  });

  it('skips a poisoned recurring rule without blocking startup or healthy rules', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const storage = new MemoryStorageAdapter();
      const { repository } = await createRepository(storage);
      const usd = repository.getSnapshot().accounts[0];
      const eur = await repository.saveAccount({ name: 'Euro', type: 'checking', currency: 'EUR', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
      const rate = await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '2', effectiveDate: '2026-01-01' });
      await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Foreign', note: '', accountId: eur.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'EUR' },
        unit: 'month', interval: 1, startDate: '2026-09-01', endDate: '2026-09-01', nextDueDate: '2026-09-01', autoPost: false, active: true,
      });
      await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Healthy', note: '', accountId: usd.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
        unit: 'month', interval: 1, startDate: '2026-09-01', endDate: '2026-09-01', nextDueDate: '2026-09-01', autoPost: false, active: true,
      });
      await repository.deleteEntities('exchangeRates', [rate.id]);

      jest.setSystemTime(new Date('2026-08-20T09:00:00Z'));
      const reloaded = new LocalFinanceRepository(storage);
      await expect(reloaded.initialize()).resolves.toBeUndefined();
      expect(reloaded.getSnapshot().transactions.some((item) => item.title === 'Healthy')).toBe(true);
      expect(reloaded.getSnapshot().transactions.some((item) => item.title === 'Foreign')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not drop a transaction saved while recurring generation is persisting', async () => {
    class PausableStorage extends MemoryStorageAdapter {
      pauseNext = false;
      private release: (() => void) | null = null;

      override async putMany(records: Parameters<MemoryStorageAdapter['putMany']>[0]) {
        if (this.pauseNext) {
          this.pauseNext = false;
          await new Promise<void>((resolve) => { this.release = resolve; });
        }
        await super.putMany(records);
      }

      releasePaused() {
        this.release?.();
        this.release = null;
      }
    }

    const storage = new PausableStorage();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Rent', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 1000, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2099-01-01', endDate: '2099-01-31', nextDueDate: '2099-01-01', autoPost: false, active: true,
    });

    storage.pauseNext = true;
    const generation = repository.generateRecurring('2099-01-31');
    await Promise.resolve();
    await Promise.resolve();
    const concurrentSave = repository.saveTransaction({ kind: 'expense', title: 'Concurrent', localDate: '2026-07-15', accountId: account.id, amountMinor: 500 });
    storage.releasePaused();
    await Promise.all([generation, concurrentSave]);

    const titles = repository.getSnapshot().transactions.map((item) => item.title);
    expect(titles).toContain('Concurrent');
    expect(titles).toContain('Rent');
  });

  it('measures linked-goal inflows by the destination leg of cross-currency transfers', async () => {
    const { repository } = await createRepository();
    const savings = await repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    const eur = await repository.saveAccount({ name: 'Euro', type: 'checking', currency: 'EUR', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '2', effectiveDate: '2026-01-01' });
    // Manual destination amount disagrees with the source-leg conversion (20000).
    await repository.saveTransaction({ kind: 'transfer', title: 'Move', localDate: '2026-07-10', accountId: eur.id, destinationAccountId: savings.id, amountMinor: 10000, destinationAmountMinor: 19500 });
    const goal = await repository.saveGoal({ name: 'Fund', kind: 'saving', icon: 'target', color: '#5966E9', targetMinor: 100000, initialMinor: 0, targetDate: null, linkedAccountId: savings.id, linkedCategoryId: null, archived: false });
    expect(repository.getGoalProgress(goal.id)).toBe(19500);
  });

  it('reports budget statuses across a period rollover without reinitializing', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-06-15T09:00:00Z'));
      const { repository } = await createRepository();
      const account = repository.getSnapshot().accounts[0];
      await repository.saveBudget({
        name: 'Monthly', icon: 'chart', color: '#5966E9', limitMinor: 1000,
        period: { unit: 'month', interval: 1, anchorDate: '2026-06-01', endDate: null },
        rollover: true, filters: { accountIds: [], categoryIds: [], tagIds: [] }, categoryLimits: [], archived: false,
      });
      await repository.saveTransaction({ kind: 'expense', title: 'June', localDate: '2026-06-20', accountId: account.id, amountMinor: 400 });

      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      expect(repository.getBudgetStatuses('2026-07-15')[0]).toMatchObject({ effectiveLimitMinor: 1600, spentMinor: 0 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reserves archived names so CSV lookups and restoration stay unambiguous', async () => {
    const { repository } = await createRepository();
    const original = await repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    await repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: true }, original.id);
    await expect(repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false })).rejects.toThrow('already in use');
    await expect(repository.saveAccount({ ...original, archived: false }, original.id)).resolves.toMatchObject({ archived: false });
  });

  it('rejects invalid dates, zero targets, and incompatible batch categories', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    await expect(repository.saveGoal({ name: 'Zero', kind: 'saving', icon: 'target', color: '#5966E9', targetMinor: 0, initialMinor: 0, targetDate: null, linkedAccountId: null, linkedCategoryId: null, archived: false })).rejects.toThrow('greater than zero');
    const invalid = await repository.importCsv([{ rowNumber: 2, date: '2026-99-99', type: 'expense', title: 'Bad', amount: '5.00', currency: 'USD', account: 'Everyday', category: '', tags: '', note: '', exchangeRate: '', destinationAccount: '', destinationAmount: '' }], false);
    expect(invalid.rejectedRows).toHaveLength(1);
    const income = await repository.saveTransaction({ kind: 'income', title: 'Salary', localDate: '2026-07-15', accountId: account.id, amountMinor: 1000 });
    const expenseCategory = repository.getSnapshot().categories.find((item) => item.kind === 'expense')!;
    await expect(repository.updateTransactionsCategory([income.id], expenseCategory.id)).rejects.toThrow('only be assigned');
  });

  it('round-trips exported money and formula-guarded text independently of locale', async () => {
    const { repository } = await createRepository(new MemoryStorageAdapter(), 'de-DE');
    const sourceAccount = await repository.saveAccount({
      name: '=Cash',
      type: 'cash',
      currency: 'EUR',
      openingBalanceMinor: 0,
      icon: 'wallet',
      color: '#5966E9',
      archived: false,
    });
    await repository.saveExchangeRate({
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: '1.125',
      effectiveDate: '2026-01-01',
    });
    await repository.saveTransaction({
      kind: 'expense',
      title: '+Coffee',
      note: '@morning',
      localDate: '2026-07-15',
      accountId: sourceAccount.id,
      amountMinor: 1250,
    });

    const table = parseCsvTable(repository.exportCsv());
    const rows = table.rows.map((record) => ({
      rowNumber: Number(record.rowNumber),
      date: String(record.date),
      type: String(record.type) as TransactionKind,
      status: String(record.status) as TransactionStatus,
      title: String(record.title),
      amount: String(record.amount),
      currency: String(record.currency),
      account: String(record.account),
      category: String(record.category),
      tags: String(record.tags),
      note: String(record.note),
      exchangeRate: String(record.exchange_rate),
      destinationAccount: String(record.destination_account),
      destinationAmount: String(record.destination_amount),
      destinationBaseAmountMinor: String(record.destination_base_amount_minor),
    } satisfies CsvImportRow));

    const { repository: imported } = await createRepository(new MemoryStorageAdapter(), 'de-DE');
    await imported.saveAccount({
      name: '=Cash',
      type: 'cash',
      currency: 'EUR',
      openingBalanceMinor: 0,
      icon: 'wallet',
      color: '#5966E9',
      archived: false,
    });
    await imported.saveExchangeRate({
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: '1.125',
      effectiveDate: '2026-01-01',
    });
    const result = await imported.importCsv(rows, true);
    expect(result.rejectedRows).toHaveLength(0);
    expect(imported.getSnapshot().transactions[0]).toMatchObject({
      title: '+Coffee',
      note: '@morning',
      amountMinor: 1250,
    });
  });

  it('keeps recurring schedule edits from generating historical auto-posts', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const { repository } = await createRepository();
      const account = repository.getSnapshot().accounts[0];
      const rule = await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Subscription', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
        unit: 'month',
        interval: 1,
        startDate: '2026-01-01',
        endDate: null,
        nextDueDate: '2026-08-01',
        autoPost: true,
        active: true,
      });
      const edited = await repository.saveRecurringRule({
        ...rule,
        unit: 'week',
        nextDueDate: rule.startDate,
      }, rule.id);
      expect(edited.nextDueDate).toBe('2026-08-06');

      await repository.generateRecurring('2026-08-31');
      expect(repository.getSnapshot().transactions.every((item) => item.localDate >= '2026-08-01')).toBe(true);
      expect(repository.getSnapshot().transactions.every((item) => item.status === 'upcoming')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not count unrelated expenses toward an unlinked spending goal', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    await repository.saveTransaction({
      kind: 'expense',
      title: 'Unrelated',
      localDate: '2026-07-15',
      accountId: account.id,
      amountMinor: 5000,
    });
    const goal = await repository.saveGoal({
      name: 'Planned purchase',
      kind: 'spending',
      icon: 'target',
      color: '#5966E9',
      targetMinor: 10000,
      initialMinor: 250,
      targetDate: null,
      linkedAccountId: null,
      linkedCategoryId: null,
      archived: false,
    });
    expect(repository.getGoalProgress(goal.id)).toBe(250);
  });

  it('forces same-currency transfers to conserve value', async () => {
    const { repository } = await createRepository();
    const source = repository.getSnapshot().accounts[0];
    const destination = await repository.saveAccount({
      name: 'Savings',
      type: 'savings',
      currency: 'USD',
      openingBalanceMinor: 0,
      icon: 'wallet',
      color: '#5966E9',
      archived: false,
    });
    const transfer = await repository.saveTransaction({
      kind: 'transfer',
      title: 'Move',
      localDate: '2026-07-15',
      accountId: source.id,
      destinationAccountId: destination.id,
      amountMinor: 1000,
      destinationAmountMinor: 2500,
    });
    expect(transfer.destinationAmountMinor).toBe(1000);
  });

  it('keeps inactive custom budgets manageable without adding them to dashboards', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const { repository } = await createRepository();
      await repository.saveBudget({
        name: 'January trip',
        icon: 'chart',
        color: '#5966E9',
        limitMinor: 10000,
        period: { unit: 'custom', interval: 1, anchorDate: '2026-01-01', endDate: '2026-01-31' },
        rollover: false,
        filters: { accountIds: [], categoryIds: [], tagIds: [] },
        categoryLimits: [],
        archived: false,
      });
      expect(repository.getBudgetStatuses('2026-07-15')).toHaveLength(0);
      expect(repository.getBudgetStatuses('2026-07-15', { includeInactiveCustom: true })).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('accounts for uncategorized expenses in the dashboard breakdown', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    await repository.saveTransaction({
      kind: 'expense',
      title: 'Uncategorized',
      localDate: '2026-07-15',
      accountId: account.id,
      categoryId: null,
      amountMinor: 725,
    });
    const summary = repository.getDashboard('2026-07-01', '2026-07-31');
    expect(summary.categorySpend.reduce((sum, item) => sum + item.amountMinor, 0)).toBe(summary.expenseMinor);
    expect(summary.categorySpend).toContainEqual({ category: null, amountMinor: 725 });
  });

  it('cascades goal contributions and budget snapshots through one atomic delete', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const goal = await repository.saveGoal({
      name: 'Fund',
      kind: 'saving',
      icon: 'target',
      color: '#5966E9',
      targetMinor: 10000,
      initialMinor: 0,
      targetDate: null,
      linkedAccountId: null,
      linkedCategoryId: null,
      archived: false,
    });
    await repository.saveContribution({
      goalId: goal.id,
      amountMinor: 500,
      localDate: '2026-07-15',
      transactionId: null,
      note: '',
    });
    const budget = await repository.saveBudget({
      name: 'Monthly',
      icon: 'chart',
      color: '#5966E9',
      limitMinor: 10000,
      period: { unit: 'month', interval: 1, anchorDate: '2026-07-01', endDate: null },
      rollover: false,
      filters: { accountIds: [], categoryIds: [], tagIds: [] },
      categoryLimits: [],
      archived: false,
    });
    await repository.deleteEntities('goals', [goal.id]);
    await repository.deleteEntities('budgets', [budget.id]);
    expect(repository.getSnapshot().contributions).toHaveLength(0);
    expect(repository.getSnapshot().budgetPeriods).toHaveLength(0);

    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    expect(reloaded.getSnapshot().contributions).toHaveLength(0);
    expect(reloaded.getSnapshot().budgetPeriods).toHaveLength(0);
  });

  it('preserves a concurrent save while another entity is being deleted', async () => {
    class PausableStorage extends MemoryStorageAdapter {
      pauseNext = false;
      private release: (() => void) | null = null;

      override async putMany(records: Parameters<MemoryStorageAdapter['putMany']>[0]) {
        if (this.pauseNext) {
          this.pauseNext = false;
          await new Promise<void>((resolve) => { this.release = resolve; });
        }
        await super.putMany(records);
      }

      releasePaused() {
        this.release?.();
        this.release = null;
      }
    }

    const storage = new PausableStorage();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    const doomed = await repository.saveTransaction({
      kind: 'expense',
      title: 'Doomed',
      localDate: '2026-07-14',
      accountId: account.id,
      amountMinor: 100,
    });
    storage.pauseNext = true;
    const deletion = repository.deleteEntities('transactions', [doomed.id]);
    await Promise.resolve();
    await Promise.resolve();
    const concurrentSave = repository.saveTransaction({
      kind: 'expense',
      title: 'Concurrent',
      localDate: '2026-07-15',
      accountId: account.id,
      amountMinor: 200,
    });
    storage.releasePaused();
    await Promise.all([deletion, concurrentSave]);
    expect(repository.getSnapshot().transactions.map((item) => item.title)).toEqual(['Concurrent']);
  });

  it('derives account balances from every posted transaction, not the browsed month', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    await repository.saveTransaction({
      kind: 'income',
      title: 'Later',
      localDate: '2026-08-01',
      accountId: account.id,
      amountMinor: 1000,
    });
    const july = repository.getDashboard('2026-07-01', '2026-07-31');
    expect(july.incomeMinor).toBe(0);
    expect(july.accountBalances[0].balanceMinor).toBe(1000);
    expect(july.netWorthMinor).toBe(1000);
  });

  it('builds transient budget status for the date being browsed', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const { repository } = await createRepository();
      await repository.saveBudget({
        name: 'Monthly',
        icon: 'chart',
        color: '#5966E9',
        limitMinor: 1000,
        period: { unit: 'month', interval: 1, anchorDate: '2026-07-01', endDate: null },
        rollover: false,
        filters: { accountIds: [], categoryIds: [], tagIds: [] },
        categoryLimits: [],
        archived: false,
      });
      expect(repository.getBudgetStatuses('2026-06-15')[0]?.snapshot.periodStart).toBe('2026-06-01');
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses base-currency values for amount filters', async () => {
    const { repository } = await createRepository();
    const euro = await repository.saveAccount({
      name: 'Euro',
      type: 'checking',
      currency: 'EUR',
      openingBalanceMinor: 0,
      icon: 'wallet',
      color: '#5966E9',
      archived: false,
    });
    await repository.saveExchangeRate({
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: '2',
      effectiveDate: '2026-01-01',
    });
    const transaction = await repository.saveTransaction({
      kind: 'expense',
      title: 'Foreign',
      localDate: '2026-07-15',
      accountId: euro.id,
      amountMinor: 10000,
    });
    expect(repository.queryTransactions({ minMinor: 15000 }).map((item) => item.id)).toEqual([transaction.id]);
    expect(repository.queryTransactions({ minMinor: 25000 })).toHaveLength(0);
  });

  it('rejects syntactically valid but unsupported currency codes', async () => {
    const { repository } = await createRepository();
    await expect(repository.saveAccount({
      name: 'Typo',
      type: 'cash',
      currency: 'ZZZ',
      openingBalanceMinor: 0,
      icon: 'wallet',
      color: '#5966E9',
      archived: false,
    })).rejects.toThrow('ISO 4217');
  });

  it('sorts equal-timestamp memory records semantically like production adapters', async () => {
    const storage = new MemoryStorageAdapter();
    const timestamp = '2026-07-15T00:00:00.000Z';
    await storage.putMany([
      { type: 'tags', entity: { id: 'a', revision: 1, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, name: 'Zulu', color: '#5966E9' } },
      { type: 'tags', entity: { id: 'z', revision: 1, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, name: 'Alpha', color: '#5966E9' } },
    ]);
    expect((await storage.readAll('tags')).map((item) => item.id)).toEqual(['z', 'a']);
  });

  it('preserves curated starter-category order after reload', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const initialOrder = repository.getSnapshot().categories.map((item) => item.name);
    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    expect(reloaded.getSnapshot().categories.map((item) => item.name)).toEqual(initialOrder);
  });

  it('rejects repeated onboarding without creating duplicate starter data', async () => {
    const { repository } = await createRepository();
    const before = repository.getSnapshot();
    await expect(repository.completeOnboarding({
      locale: 'en-US',
      baseCurrency: 'USD',
      accountName: 'Duplicate',
      accountType: 'cash',
      openingBalanceMinor: 0,
      themeMode: 'system',
      accentSource: 'system',
      accentHex: '#5966E9',
    })).rejects.toThrow('already complete');
    expect(repository.getSnapshot().accounts).toHaveLength(before.accounts.length);
    expect(repository.getSnapshot().categories).toHaveLength(before.categories.length);
  });

  it('resets every persisted entity and returns to pre-onboarding settings', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    await repository.saveTransaction({
      kind: 'expense',
      title: 'Erase me',
      localDate: '2026-07-15',
      accountId: account.id,
      amountMinor: 500,
    });

    await repository.resetAllData();

    expect(repository.getSnapshot()).toMatchObject({
      ready: true,
      settings: { onboardingComplete: false },
      accounts: [],
      categories: [],
      transactions: [],
    });

    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    expect(reloaded.getSnapshot()).toMatchObject({
      ready: true,
      settings: { onboardingComplete: false },
      accounts: [],
      categories: [],
      transactions: [],
    });
  });

  it('keeps a deleted recurring occurrence deleted across regeneration and reload', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const storage = new MemoryStorageAdapter();
      const { repository } = await createRepository(storage);
      const account = repository.getSnapshot().accounts[0];
      const created = await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Optional', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
        unit: 'month', interval: 1, startDate: '2026-07-20', endDate: null, nextDueDate: '2026-07-20', autoPost: false, active: true,
      });
      const occurrence = repository.getSnapshot().transactions.find((item) => item.localDate === '2026-07-20')!;
      await repository.deleteEntities('transactions', [occurrence.id]);
      const currentRule = repository.getSnapshot().recurringRules.find((item) => item.id === created.id)!;
      await repository.saveRecurringRule({ ...currentRule, nextDueDate: '2026-07-20' }, currentRule.id);
      expect(repository.getSnapshot().transactions.some((item) => item.localDate === '2026-07-20')).toBe(false);

      const reloaded = new LocalFinanceRepository(storage);
      await reloaded.initialize();
      expect(reloaded.getSnapshot().transactions.some((item) => item.localDate === '2026-07-20')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps archived dependencies editable and reactivates schedules after restoration', async () => {
    const { repository } = await createRepository();
    const account = await repository.saveAccount({ name: 'Projects', type: 'checking', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    const category = repository.getSnapshot().categories.find((item) => item.kind === 'expense')!;
    const transaction = await repository.saveTransaction({
      kind: 'expense',
      title: 'Supplies',
      localDate: '2026-07-15',
      accountId: account.id,
      categoryId: category.id,
      amountMinor: 500,
    });
    const budget = await repository.saveBudget({
      name: 'Projects',
      icon: 'chart',
      color: '#5966E9',
      limitMinor: 10000,
      period: { unit: 'month', interval: 1, anchorDate: '2026-07-01', endDate: null },
      rollover: false,
      filters: { accountIds: [account.id], categoryIds: [category.id], tagIds: [] },
      categoryLimits: [{ categoryId: category.id, limitMinor: 5000 }],
      archived: false,
    });
    const goal = await repository.saveGoal({
      name: 'Project purchase',
      kind: 'spending',
      icon: 'target',
      color: '#5966E9',
      targetMinor: 10000,
      initialMinor: 0,
      targetDate: null,
      linkedAccountId: account.id,
      linkedCategoryId: category.id,
      archived: false,
    });
    const rule = await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Hosting', note: '', accountId: account.id, categoryId: category.id, tagIds: [], amountMinor: 100, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2099-01-01', endDate: null, nextDueDate: '2099-01-01', autoPost: false, active: true,
    });

    await repository.saveAccount({ ...account, archived: true }, account.id);
    await repository.saveCategory({ ...category, archived: true }, category.id);
    expect(repository.getSnapshot().recurringRules.find((item) => item.id === rule.id)?.active).toBe(false);
    await expect(repository.saveTransaction({
      kind: transaction.kind,
      status: transaction.status,
      title: 'Updated supplies',
      note: transaction.note,
      localDate: transaction.localDate,
      accountId: transaction.accountId,
      categoryId: transaction.categoryId,
      amountMinor: transaction.amountMinor,
    }, transaction.id)).resolves.toMatchObject({ title: 'Updated supplies' });
    await expect(repository.saveBudget({ ...budget, name: 'Updated projects' }, budget.id)).resolves.toMatchObject({ name: 'Updated projects' });
    await expect(repository.saveGoal({ ...goal, name: 'Updated purchase' }, goal.id)).resolves.toMatchObject({ name: 'Updated purchase' });
    await expect(repository.saveRecurringRule({
      ...repository.getSnapshot().recurringRules.find((item) => item.id === rule.id)!,
      template: { ...rule.template, title: 'Updated hosting' },
      active: true,
    }, rule.id)).resolves.toMatchObject({ active: false });

    await repository.saveAccount({ ...account, archived: false }, account.id);
    expect(repository.getSnapshot().recurringRules.find((item) => item.id === rule.id)?.active).toBe(false);
    await repository.saveCategory({ ...category, archived: false }, category.id);
    expect(repository.getSnapshot().recurringRules.find((item) => item.id === rule.id)?.active).toBe(true);
  });

  it('does not reactivate a schedule that was already paused before its account was archived', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    const rule = await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Paused', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2099-01-01', endDate: null, nextDueDate: '2099-01-01', autoPost: false, active: false,
    });

    await repository.saveAccount({ ...account, archived: true }, account.id);
    await repository.saveAccount({ ...account, archived: false }, account.id);

    expect(repository.getSnapshot().recurringRules.find((item) => item.id === rule.id))
      .toMatchObject({ active: false, pausedByDependency: false });
  });

  it('migrates legacy recurring schedules without pause provenance', async () => {
    const { repository, storage } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    const rule = await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Legacy', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2099-01-01', endDate: null, nextDueDate: '2099-01-01', autoPost: false, active: false,
    });
    const { pausedByDependency: _legacyField, ...legacyRule } = rule;
    await storage.putMany([{ type: 'recurringRules', entity: legacyRule as RecurringRule }]);

    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();

    expect(reloaded.getSnapshot().recurringRules.find((item) => item.id === rule.id))
      .toMatchObject({ active: false, pausedByDependency: false });
    expect((await storage.readAll('recurringRules')).find((item) => item.id === rule.id))
      .toMatchObject({ pausedByDependency: false });
  });

  it('updates generated upcoming transactions when a recurring template changes', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const { repository } = await createRepository();
      const account = repository.getSnapshot().accounts[0];
      const rule = await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Old title', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
        unit: 'month', interval: 1, startDate: '2026-07-20', endDate: null, nextDueDate: '2026-07-20', autoPost: false, active: true,
      });
      const before = repository.getSnapshot().transactions.find((item) => item.localDate === '2026-07-20')!;
      const currentRule = repository.getSnapshot().recurringRules.find((item) => item.id === rule.id)!;
      await repository.saveRecurringRule({
        ...currentRule,
        template: { ...currentRule.template, title: 'New title', amountMinor: 250 },
      }, rule.id);
      const after = repository.getSnapshot().transactions.find((item) => item.localDate === '2026-07-20')!;
      expect(after).toMatchObject({ id: before.id, title: 'New title', amountMinor: 250 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('generates more than 366 missed recurring occurrences in one catch-up', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2025-01-01T09:00:00Z'));
      const { repository } = await createRepository();
      const account = repository.getSnapshot().accounts[0];
      await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Daily', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 1, currency: 'USD' },
        unit: 'day', interval: 1, startDate: '2025-01-01', endDate: '2026-06-30', nextDueDate: '2025-01-01', autoPost: false, active: true,
      });
      await repository.generateRecurring('2026-06-30');
      const occurrences = repository.getSnapshot().transactions.filter((item) => item.title === 'Daily');
      expect(occurrences.length).toBeGreaterThan(366);
      expect(occurrences.at(-1)?.localDate).toBe('2026-06-30');
    } finally {
      jest.useRealTimers();
    }
  });

  it('snapshots the destination base value used by cross-currency goal progress', async () => {
    const { repository } = await createRepository();
    const eur = await repository.saveAccount({ name: 'Euro', type: 'checking', currency: 'EUR', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    const gbp = await repository.saveAccount({ name: 'Pounds', type: 'savings', currency: 'GBP', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '2', effectiveDate: '2026-01-01' });
    const gbpRate = await repository.saveExchangeRate({ fromCurrency: 'GBP', toCurrency: 'USD', rate: '4', effectiveDate: '2026-01-01' });
    const transfer = await repository.saveTransaction({
      kind: 'transfer',
      title: 'Move',
      localDate: '2026-07-15',
      accountId: eur.id,
      destinationAccountId: gbp.id,
      amountMinor: 10000,
    });
    const goal = await repository.saveGoal({
      name: 'Pounds goal',
      kind: 'saving',
      icon: 'target',
      color: '#5966E9',
      targetMinor: 100000,
      initialMinor: 0,
      targetDate: null,
      linkedAccountId: gbp.id,
      linkedCategoryId: null,
      archived: false,
    });
    expect(transfer.destinationBaseAmountMinor).toBe(20000);
    expect(repository.getGoalProgress(goal.id)).toBe(20000);
    await repository.saveExchangeRate({ ...gbpRate, rate: '8' }, gbpRate.id);
    expect(repository.getGoalProgress(goal.id)).toBe(20000);
    const edited = await repository.saveTransaction({
      kind: transfer.kind,
      status: transfer.status,
      title: 'Move renamed',
      note: transfer.note,
      localDate: transfer.localDate,
      accountId: transfer.accountId,
      destinationAccountId: transfer.destinationAccountId,
      destinationAmountMinor: transfer.destinationAmountMinor,
      amountMinor: transfer.amountMinor,
      exchangeRate: transfer.exchangeRate,
    }, transfer.id);
    expect(edited.destinationBaseAmountMinor).toBe(20000);
    expect(repository.getGoalProgress(goal.id)).toBe(20000);
    await repository.deleteEntities('exchangeRates', [gbpRate.id]);
    expect(repository.getGoalProgress(goal.id)).toBe(20000);
    await expect(repository.saveTransaction({
      kind: edited.kind,
      status: edited.status,
      title: 'Move renamed again',
      note: edited.note,
      localDate: edited.localDate,
      accountId: edited.accountId,
      destinationAccountId: edited.destinationAccountId,
      destinationAmountMinor: edited.destinationAmountMinor,
      amountMinor: edited.amountMinor,
      exchangeRate: edited.exchangeRate,
    }, edited.id)).resolves.toMatchObject({ destinationBaseAmountMinor: 20000 });
  });

  it('preserves existing tags when an edit payload omits tagIds', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    const tag = await repository.saveTag({ name: 'Work', color: '#5966E9' });
    const transaction = await repository.saveTransaction({
      kind: 'expense',
      title: 'Coffee',
      localDate: '2026-07-15',
      accountId: account.id,
      tagIds: [tag.id],
      amountMinor: 500,
    });
    const edited = await repository.saveTransaction({
      kind: transaction.kind,
      status: transaction.status,
      title: 'Coffee renamed',
      note: transaction.note,
      localDate: transaction.localDate,
      accountId: transaction.accountId,
      categoryId: transaction.categoryId,
      amountMinor: transaction.amountMinor,
      exchangeRate: transaction.exchangeRate,
    }, transaction.id);
    expect(edited.tagIds).toEqual([tag.id]);
    await expect(repository.saveTransaction({
      kind: edited.kind,
      status: edited.status,
      title: edited.title,
      note: edited.note,
      localDate: edited.localDate,
      accountId: edited.accountId,
      categoryId: edited.categoryId,
      tagIds: [],
      amountMinor: edited.amountMinor,
      exchangeRate: edited.exchangeRate,
    }, edited.id)).resolves.toMatchObject({ tagIds: [] });
  });

  it('clears transfer-only fields when a transaction becomes non-transfer', async () => {
    const { repository } = await createRepository();
    const source = repository.getSnapshot().accounts[0];
    const destination = await repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    const transfer = await repository.saveTransaction({
      kind: 'transfer',
      title: 'Move',
      localDate: '2026-07-15',
      accountId: source.id,
      destinationAccountId: destination.id,
      amountMinor: 1000,
    });
    const expense = await repository.saveTransaction({
      kind: 'expense',
      title: 'Spent instead',
      localDate: transfer.localDate,
      accountId: source.id,
      destinationAccountId: destination.id,
      destinationAmountMinor: 1000,
      amountMinor: transfer.amountMinor,
    }, transfer.id);
    expect(expense).toMatchObject({
      destinationAccountId: null,
      destinationAmountMinor: null,
      destinationBaseAmountMinor: null,
      destinationCurrency: null,
      transferGroupId: null,
    });
  });

  it('clears an existing transaction category when passed an explicit null', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    const category = repository.getSnapshot().categories.find((item) => item.name === 'Dining')!;
    const transaction = await repository.saveTransaction({
      kind: 'expense', title: 'Categorized', localDate: '2026-07-15', accountId: account.id, categoryId: category.id, amountMinor: 100,
    });

    await expect(repository.saveTransaction({
      kind: transaction.kind,
      status: transaction.status,
      title: transaction.title,
      note: transaction.note,
      localDate: transaction.localDate,
      accountId: transaction.accountId,
      categoryId: null,
      amountMinor: transaction.amountMinor,
      exchangeRate: transaction.exchangeRate,
    }, transaction.id)).resolves.toMatchObject({ categoryId: null });
  });

  it('saves a goal edit and manual contribution atomically', async () => {
    class FailingStorage extends MemoryStorageAdapter {
      fail = false;

      override async putMany(records: Parameters<MemoryStorageAdapter['putMany']>[0]) {
        if (this.fail) throw new Error('simulated disk failure');
        await super.putMany(records);
      }
    }
    const storage = new FailingStorage();
    const { repository } = await createRepository(storage);
    const goal = await repository.saveGoal({
      name: 'Original',
      kind: 'saving',
      icon: 'target',
      color: '#5966E9',
      targetMinor: 10000,
      initialMinor: 0,
      targetDate: null,
      linkedAccountId: null,
      linkedCategoryId: null,
      archived: false,
    });
    storage.fail = true;
    await expect(repository.saveGoalAndContribution(
      { ...goal, name: 'Changed' },
      { amountMinor: 500, localDate: '2026-07-15', transactionId: null, note: '' },
      goal.id,
    )).rejects.toThrow('simulated disk failure');
    expect(repository.getSnapshot().goals.find((item) => item.id === goal.id)?.name).toBe('Original');
    expect(repository.getSnapshot().contributions).toHaveLength(0);
  });

  it('migrates legacy duplicate names to unique values', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    await storage.putMany([{
      type: 'accounts',
      entity: {
        ...account,
        id: 'legacy-duplicate-account',
        archived: true,
        revision: 1,
      },
    }]);
    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    const normalizedNames = reloaded.getSnapshot().accounts.map((item) => item.name.toLocaleLowerCase());
    expect(new Set(normalizedNames).size).toBe(normalizedNames.length);
    expect(reloaded.getSnapshot().accounts.find((item) => item.id === 'legacy-duplicate-account')?.name).toContain('(archived');
  });

  it('rejects transactions whose account or analytics totals exceed safe integers', async () => {
    const { repository } = await createRepository();
    const first = await repository.saveAccount({ name: 'Large one', type: 'checking', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    const second = await repository.saveAccount({ name: 'Large two', type: 'checking', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    await repository.saveTransaction({
      kind: 'income',
      title: 'Large',
      localDate: '2026-07-15',
      accountId: first.id,
      amountMinor: Number.MAX_SAFE_INTEGER - 50,
    });
    await expect(repository.saveTransaction({
      kind: 'income',
      title: 'Overflow',
      localDate: '2026-07-15',
      accountId: second.id,
      amountMinor: 100,
    })).rejects.toThrow('outside the supported range');
    expect(repository.getSnapshot().transactions).toHaveLength(1);
  });

  it('rejects account changes that would overflow net worth', async () => {
    const { repository } = await createRepository();
    await repository.saveAccount({
      name: 'Almost maximum',
      type: 'checking',
      currency: 'USD',
      openingBalanceMinor: Number.MAX_SAFE_INTEGER - 50,
      icon: 'wallet',
      color: '#5966E9',
      archived: false,
    });
    await expect(repository.saveAccount({
      name: 'Overflowing account',
      type: 'checking',
      currency: 'USD',
      openingBalanceMinor: 100,
      icon: 'wallet',
      color: '#5966E9',
      archived: false,
    })).rejects.toThrow('Net worth is outside the supported range');
  });

  it('keeps entity order stable after an edit and reload', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const storage = new MemoryStorageAdapter();
      const { repository } = await createRepository(storage);
      const first = await repository.saveTag({ name: 'First', color: '#5966E9' });
      jest.setSystemTime(new Date('2026-07-15T09:00:01Z'));
      await repository.saveTag({ name: 'Second', color: '#5966E9' });
      jest.setSystemTime(new Date('2026-07-15T09:00:02Z'));
      await repository.saveTag({ name: 'First updated', color: '#5966E9' }, first.id);
      expect(repository.getSnapshot().tags.map((item) => item.name)).toEqual(['First updated', 'Second']);

      const reloaded = new LocalFinanceRepository(storage);
      await reloaded.initialize();
      expect(reloaded.getSnapshot().tags.map((item) => item.name)).toEqual(['First updated', 'Second']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an exchange rate that contradicts its existing reciprocal', async () => {
    const { repository } = await createRepository();
    await repository.saveExchangeRate({ fromCurrency: 'USD', toCurrency: 'EUR', rate: '0.5', effectiveDate: '2026-01-01' });
    // 1 / 0.5 === 2, so the opposite direction agrees exactly.
    const reciprocal = await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '2', effectiveDate: '2026-01-01' });
    expect(reciprocal.rate).toBe('2');

    await expect(repository.saveExchangeRate({
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: '2.5',
      effectiveDate: '2026-02-01',
    })).rejects.toThrow('contradicts');
    expect(repository.getSnapshot().exchangeRates).toHaveLength(2);

    // Editing a stored rate compares against the opposite direction only, so an
    // in-place edit that stays inside the tolerance must not trip the check.
    await expect(repository.saveExchangeRate({ ...reciprocal, rate: '2.02' }, reciprocal.id))
      .resolves.toMatchObject({ id: reciprocal.id, rate: '2.02' });
    await expect(repository.saveExchangeRate({ ...reciprocal, rate: '2.5' }, reciprocal.id))
      .rejects.toThrow('contradicts');
  });

  it('rejects an older rate that would contradict a reciprocal entered for a later date', async () => {
    const { repository } = await createRepository();
    await repository.saveExchangeRate({
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      rate: '0.5',
      effectiveDate: '2026-02-01',
    });

    await expect(repository.saveExchangeRate({
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      rate: '3',
      effectiveDate: '2026-01-01',
    })).rejects.toThrow('contradicts');
  });

  it('retires goal contributions funded by a deleted transaction', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    const goal = await repository.saveGoal({
      name: 'Fund',
      kind: 'saving',
      icon: 'target',
      color: '#5966E9',
      targetMinor: 10000,
      initialMinor: 0,
      targetDate: null,
      linkedAccountId: null,
      linkedCategoryId: null,
      archived: false,
    });
    const funding = await repository.saveTransaction({
      kind: 'income',
      title: 'Bonus',
      localDate: '2026-07-15',
      accountId: account.id,
      amountMinor: 500,
    });
    await repository.saveContribution({ goalId: goal.id, amountMinor: 500, localDate: '2026-07-15', transactionId: funding.id, note: '' });
    const unrelated = await repository.saveContribution({ goalId: goal.id, amountMinor: 250, localDate: '2026-07-16', transactionId: null, note: '' });
    expect(repository.getGoalProgress(goal.id)).toBe(750);

    await repository.deleteEntities('transactions', [funding.id]);
    expect(repository.getSnapshot().contributions.map((item) => item.id)).toEqual([unrelated.id]);
    expect(repository.getGoalProgress(goal.id)).toBe(250);

    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    expect(reloaded.getSnapshot().contributions.map((item) => item.id)).toEqual([unrelated.id]);
  });

  it('releases generated transactions when their recurring rule is deleted', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const storage = new MemoryStorageAdapter();
      const { repository } = await createRepository(storage);
      const account = repository.getSnapshot().accounts[0];
      const rule = await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Streaming', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
        unit: 'month', interval: 1, startDate: '2026-07-20', endDate: null, nextDueDate: '2026-07-20', autoPost: false, active: true,
      });
      const generated = repository.getSnapshot().transactions.find((item) => item.recurringRuleId === rule.id)!;
      expect(generated).toBeDefined();

      await repository.deleteEntities('recurringRules', [rule.id]);
      expect(repository.getSnapshot().recurringRules).toHaveLength(0);
      expect(repository.getSnapshot().transactions.find((item) => item.id === generated.id)).toMatchObject({
        id: generated.id,
        recurringRuleId: null,
      });

      const reloaded = new LocalFinanceRepository(storage);
      await reloaded.initialize();
      expect(reloaded.getSnapshot().transactions.find((item) => item.id === generated.id)?.recurringRuleId).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('strips a deleted tag from the transactions that carried it', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    const doomed = await repository.saveTag({ name: 'Work', color: '#5966E9' });
    const kept = await repository.saveTag({ name: 'Travel', color: '#5966E9' });
    const transaction = await repository.saveTransaction({
      kind: 'expense',
      title: 'Taxi',
      localDate: '2026-07-15',
      accountId: account.id,
      tagIds: [doomed.id, kept.id],
      amountMinor: 500,
    });

    await repository.deleteEntities('tags', [doomed.id]);
    expect(repository.getSnapshot().transactions.find((item) => item.id === transaction.id)?.tagIds).toEqual([kept.id]);

    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    const current = reloaded.getSnapshot().transactions.find((item) => item.id === transaction.id)!;
    expect(current.tagIds).toEqual([kept.id]);
    // A leftover tag id would fail tag validation the next time the row is saved.
    await expect(reloaded.saveTransaction({
      kind: current.kind,
      title: current.title,
      localDate: current.localDate,
      accountId: current.accountId,
      tagIds: current.tagIds,
      amountMinor: current.amountMinor,
    }, current.id)).resolves.toMatchObject({ tagIds: [kept.id] });
  });

  it('clears a deleted category from the transactions that used it', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    const categories = repository.getSnapshot().categories.filter((item) => item.kind === 'expense');
    const doomed = categories[0];
    const kept = categories[1];
    const affected = await repository.saveTransaction({
      kind: 'expense',
      title: 'Taxi',
      localDate: '2026-07-15',
      accountId: account.id,
      categoryId: doomed.id,
      amountMinor: 500,
    });
    const untouched = await repository.saveTransaction({
      kind: 'expense',
      title: 'Coffee',
      localDate: '2026-07-15',
      accountId: account.id,
      categoryId: kept.id,
      amountMinor: 300,
    });

    await repository.deleteEntities('categories', [doomed.id]);
    const snapshot = repository.getSnapshot().transactions;
    expect(snapshot.find((item) => item.id === affected.id)?.categoryId).toBeNull();
    expect(snapshot.find((item) => item.id === untouched.id)?.categoryId).toBe(kept.id);

    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    const current = reloaded.getSnapshot().transactions.find((item) => item.id === affected.id)!;
    expect(current.categoryId).toBeNull();
    // A leftover category id made every later save throw "Choose a valid
    // expense category.", which the UI gave no way to recover from.
    await expect(reloaded.saveTransaction({
      kind: current.kind,
      title: current.title,
      localDate: current.localDate,
      accountId: current.accountId,
      categoryId: current.categoryId,
      amountMinor: current.amountMinor,
    }, current.id)).resolves.toMatchObject({ categoryId: null });
  });

  it('clamps a carried budget deficit at a single period limit', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-06-15T09:00:00Z'));
      const { repository } = await createRepository();
      const heavy = await repository.saveAccount({ name: 'Heavy', type: 'checking', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
      const mild = await repository.saveAccount({ name: 'Mild', type: 'checking', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
      const saver = await repository.saveAccount({ name: 'Saver', type: 'checking', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
      const saveBudget = (name: string, accountId: string) => repository.saveBudget({
        name, icon: 'chart', color: '#5966E9', limitMinor: 1000,
        period: { unit: 'month', interval: 1, anchorDate: '2026-06-01', endDate: null },
        rollover: true, filters: { accountIds: [accountId], categoryIds: [], tagIds: [] },
        categoryLimits: [], archived: false,
      });
      await saveBudget('Heavy deficit', heavy.id);
      await saveBudget('Mild deficit', mild.id);
      await saveBudget('Surplus', saver.id);
      await repository.saveTransaction({ kind: 'expense', title: 'Heavy June', localDate: '2026-06-20', accountId: heavy.id, amountMinor: 5000 });
      await repository.saveTransaction({ kind: 'expense', title: 'Mild June', localDate: '2026-06-20', accountId: mild.id, amountMinor: 1500 });
      await repository.saveTransaction({ kind: 'expense', title: 'Saver June', localDate: '2026-06-20', accountId: saver.id, amountMinor: 400 });

      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const statuses = repository.getBudgetStatuses('2026-07-15');
      const status = (name: string) => statuses.find((item) => item.budget.name === name)!;
      // 1000 limit minus 5000 spent carries -4000, floored at one period limit.
      expect(status('Heavy deficit').snapshot.rolloverMinor).toBe(-1000);
      expect(status('Heavy deficit').effectiveLimitMinor).toBe(0);
      // -500 sits inside the floor and passes through untouched.
      expect(status('Mild deficit').snapshot.rolloverMinor).toBe(-500);
      expect(status('Mild deficit').effectiveLimitMinor).toBe(500);
      // A surplus is never clamped.
      expect(status('Surplus').snapshot.rolloverMinor).toBe(600);
      expect(status('Surplus').effectiveLimitMinor).toBe(1600);
    } finally {
      jest.useRealTimers();
    }
  });

  it('pauses a recurring rule whose generation fails instead of retrying it forever', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const storage = new MemoryStorageAdapter();
      const { repository } = await createRepository(storage);
      const usd = repository.getSnapshot().accounts[0];
      const eur = await repository.saveAccount({ name: 'Euro', type: 'checking', currency: 'EUR', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
      const rate = await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '2', effectiveDate: '2026-01-01' });
      const poisoned = await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Foreign', note: '', accountId: eur.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'EUR' },
        unit: 'month', interval: 1, startDate: '2026-09-01', endDate: null, nextDueDate: '2026-09-01', autoPost: false, active: true,
      });
      const healthy = await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Healthy', note: '', accountId: usd.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
        unit: 'month', interval: 1, startDate: '2026-09-01', endDate: null, nextDueDate: '2026-09-01', autoPost: false, active: true,
      });
      // Removing the rate leaves the EUR rule unable to build its occurrence.
      await repository.deleteEntities('exchangeRates', [rate.id]);

      await expect(repository.generateRecurring('2026-09-30')).resolves.toBe(1);
      const rules = repository.getSnapshot().recurringRules;
      expect(rules.find((item) => item.id === poisoned.id)).toMatchObject({ active: false, nextDueDate: '2026-09-01' });
      expect(rules.find((item) => item.id === healthy.id)).toMatchObject({ active: true, nextDueDate: '2026-10-01' });
      expect(repository.getSnapshot().transactions.map((item) => item.title)).toEqual(['Healthy']);

      const reloaded = new LocalFinanceRepository(storage);
      await reloaded.initialize();
      expect(reloaded.getSnapshot().recurringRules.find((item) => item.id === poisoned.id)?.active).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('serialises concurrent name validation with repository writes', async () => {
    class PausableStorage extends MemoryStorageAdapter {
      pauseNext = false;
      private release: (() => void) | null = null;

      override async putMany(records: Parameters<MemoryStorageAdapter['putMany']>[0]) {
        if (this.pauseNext) {
          this.pauseNext = false;
          await new Promise<void>((resolve) => { this.release = resolve; });
        }
        await super.putMany(records);
      }

      releasePaused() {
        this.release?.();
        this.release = null;
      }
    }

    const storage = new PausableStorage();
    const { repository } = await createRepository(storage);
    const input = { name: 'Race account', type: 'checking' as const, currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false };
    storage.pauseNext = true;
    const first = repository.saveAccount(input);
    await Promise.resolve();
    await Promise.resolve();
    const second = repository.saveAccount(input);
    storage.releasePaused();
    const results = await Promise.allSettled([first, second]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(repository.getSnapshot().accounts.filter((item) => item.name === input.name)).toHaveLength(1);
  });

  it('prevents a category with children from being reparented', async () => {
    const { repository } = await createRepository();
    const parent = await repository.saveCategory({ name: 'Parent', kind: 'expense', color: '#5966E9', icon: 'house', parentId: null, archived: false });
    await repository.saveCategory({ name: 'Child', kind: 'expense', color: '#5966E9', icon: 'house', parentId: parent.id, archived: false });
    const otherParent = await repository.saveCategory({ name: 'Other parent', kind: 'expense', color: '#5966E9', icon: 'house', parentId: null, archived: false });

    await expect(repository.saveCategory({ ...parent, parentId: otherParent.id }, parent.id))
      .rejects.toThrow('child categories');
    expect(repository.getSnapshot().categories.find((item) => item.id === parent.id)?.parentId).toBeNull();
  });

  it('validates a reactivated foreign schedule at its next due date', async () => {
    const { repository } = await createRepository();
    const account = await repository.saveAccount({ name: 'Euro', type: 'checking', currency: 'EUR', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    const oldRate = await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.1', effectiveDate: '2099-01-01' });
    const rule = await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Foreign', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'EUR' },
      unit: 'month', interval: 1, startDate: '2099-01-01', endDate: null, nextDueDate: '2099-09-01', autoPost: false, active: false,
    });
    await repository.deleteEntities('exchangeRates', [oldRate.id]);
    await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.2', effectiveDate: '2099-07-01' });

    await expect(repository.saveRecurringRule({ ...rule, active: true }, rule.id))
      .resolves.toMatchObject({ active: true });
  });

  it('catches up a dependency-paused schedule as soon as its account is restored', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-01-01T09:00:00Z'));
      const { repository } = await createRepository();
      const account = repository.getSnapshot().accounts[0];
      await repository.saveRecurringRule({
        template: { kind: 'expense', title: 'Restored', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
        unit: 'month', interval: 1, startDate: '2026-02-01', endDate: '2026-05-01', nextDueDate: '2026-02-01', autoPost: false, active: true,
      });
      await repository.saveAccount({ ...account, archived: true }, account.id);
      jest.setSystemTime(new Date('2026-04-15T09:00:00Z'));

      await repository.saveAccount({ ...account, archived: false }, account.id);

      expect(repository.getSnapshot().transactions
        .filter((item) => item.title === 'Restored')
        .map((item) => item.localDate)).toEqual([
        '2026-02-01',
        '2026-03-01',
        '2026-04-01',
        '2026-05-01',
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('includes an overlapping short custom budget in the dashboard period', async () => {
    const { repository } = await createRepository();
    await repository.saveBudget({
      name: 'First half', icon: 'chart', color: '#5966E9', limitMinor: 1000,
      period: { unit: 'custom', interval: 1, anchorDate: '2026-01-01', endDate: '2026-01-15' },
      rollover: false, filters: { accountIds: [], categoryIds: [], tagIds: [] }, categoryLimits: [], archived: false,
    });

    expect(repository.getDashboard('2026-01-01', '2026-01-31').budgetLimitMinor).toBe(1000);
    expect(repository.getDashboard('2026-02-01', '2026-02-28').budgetLimitMinor).toBe(0);
  });

  it('rejects a transaction deletion that would make derived totals unsafe', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    await repository.saveAccount({ ...account, openingBalanceMinor: Number.MAX_SAFE_INTEGER - 50 }, account.id);
    const offset = await repository.saveTransaction({ kind: 'expense', title: 'Offset', localDate: '2026-07-14', accountId: account.id, amountMinor: 100 });
    await repository.saveTransaction({ kind: 'income', title: 'Income', localDate: '2026-07-15', accountId: account.id, amountMinor: 100 });

    await expect(repository.deleteEntities('transactions', [offset.id])).rejects.toThrow('supported range');
    expect(repository.getSnapshot().transactions.map((item) => item.title)).toEqual(['Offset', 'Income']);
    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    expect(reloaded.getSnapshot().transactions.map((item) => item.title)).toEqual(['Offset', 'Income']);
  });

  it('serialises a reset behind recurring generation that is already in flight', async () => {
    class PausableStorage extends MemoryStorageAdapter {
      pauseNext = false;
      private release: (() => void) | null = null;

      override async putMany(records: Parameters<MemoryStorageAdapter['putMany']>[0]) {
        if (this.pauseNext) {
          this.pauseNext = false;
          await new Promise<void>((resolve) => { this.release = resolve; });
        }
        await super.putMany(records);
      }

      releasePaused() {
        this.release?.();
        this.release = null;
      }
    }

    const storage = new PausableStorage();
    const { repository } = await createRepository(storage);
    const account = repository.getSnapshot().accounts[0];
    await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Rent', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 1000, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2099-01-01', endDate: '2099-01-31', nextDueDate: '2099-01-01', autoPost: false, active: true,
    });

    const settled: string[] = [];
    storage.pauseNext = true;
    const generation = repository.generateRecurring('2099-01-31').then(() => { settled.push('generation'); });
    await Promise.resolve();
    await Promise.resolve();
    const reset = repository.resetAllData().then(() => { settled.push('reset'); });
    storage.releasePaused();
    await Promise.all([generation, reset]);

    expect(settled).toEqual(['generation', 'reset']);
    expect(repository.getSnapshot()).toMatchObject({
      ready: true,
      settings: { onboardingComplete: false },
      accounts: [],
      categories: [],
      transactions: [],
      recurringRules: [],
    });

    const reloaded = new LocalFinanceRepository(storage);
    await reloaded.initialize();
    expect(reloaded.getSnapshot()).toMatchObject({
      ready: true,
      settings: { onboardingComplete: false },
      accounts: [],
      transactions: [],
      recurringRules: [],
    });
  });

  it('reconciles shared storage and rejects a stale entity revision', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository: first } = await createRepository(storage);
    const second = new LocalFinanceRepository(storage);
    await second.initialize();
    const stale = second.getSnapshot().categories.find((item) => item.name === 'Groceries')!;
    const current = first.getSnapshot().categories.find((item) => item.id === stale.id)!;

    await first.saveCategory({ ...current, name: 'Food' }, current.id, current.revision);
    await second.refresh();
    expect(second.getSnapshot().categories.find((item) => item.id === stale.id)?.name).toBe('Food');

    await expect(second.saveCategory({ ...stale, name: 'Old form value' }, stale.id, stale.revision))
      .rejects.toThrow('changed in another window');
    expect(first.getSnapshot().categories.find((item) => item.id === stale.id)?.name).toBe('Food');
  });

  it('does not allow settings updates to reopen onboarding', async () => {
    const { repository } = await createRepository();
    await repository.updateSettings({ onboardingComplete: false } as never);
    expect(repository.getSnapshot().settings.onboardingComplete).toBe(true);
    await expect(repository.completeOnboarding({
      locale: 'en-US', baseCurrency: 'EUR', accountName: 'Second', accountType: 'checking',
      openingBalanceMinor: 0, themeMode: 'system', accentSource: 'system', accentHex: '#5966E9',
    })).rejects.toThrow('already complete');
  });

  it('includes child-category activity in parent budgets and goals', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    const parent = await repository.saveCategory({ name: 'Household', kind: 'expense', icon: 'house', color: '#5966E9', parentId: null, archived: false });
    const child = await repository.saveCategory({ name: 'Repairs', kind: 'expense', icon: 'wrench', color: '#5966E9', parentId: parent.id, archived: false });
    await repository.saveTransaction({ kind: 'expense', title: 'Fix', localDate: '2026-07-15', accountId: account.id, categoryId: child.id, amountMinor: 400 });
    await repository.saveBudget({
      name: 'Home', icon: 'chart', color: '#5966E9', limitMinor: 1000,
      period: { unit: 'custom', interval: 1, anchorDate: '2026-07-01', endDate: '2026-07-31' },
      rollover: false, filters: { accountIds: [], categoryIds: [parent.id], tagIds: [] }, categoryLimits: [], archived: false,
    });
    const goal = await repository.saveGoal({
      name: 'Renovation', kind: 'spending', icon: 'target', color: '#5966E9', targetMinor: 1000,
      initialMinor: 0, targetDate: null, linkedAccountId: null, linkedCategoryId: parent.id, archived: false,
    });

    expect(repository.getBudgetStatuses('2026-07-15')[0].spentMinor).toBe(400);
    expect(repository.getGoalProgress(goal.id)).toBe(400);
  });

  it('removes a deleted tag from editable budgets and recurring templates', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    const tag = await repository.saveTag({ name: 'Work', color: '#5966E9' });
    const budget = await repository.saveBudget({
      name: 'Work', icon: 'chart', color: '#5966E9', limitMinor: 1000,
      period: { unit: 'month', interval: 1, anchorDate: '2026-07-01', endDate: null },
      rollover: false, filters: { accountIds: [], categoryIds: [], tagIds: [tag.id] }, categoryLimits: [], archived: false,
    });
    const rule = await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Tool', note: '', accountId: account.id, categoryId: null, tagIds: [tag.id], amountMinor: 100, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2099-01-01', endDate: null, nextDueDate: '2099-01-01', autoPost: false, active: true,
    });

    await repository.deleteEntities('tags', [tag.id]);
    const cleanedBudget = repository.getSnapshot().budgets.find((item) => item.id === budget.id)!;
    const cleanedRule = repository.getSnapshot().recurringRules.find((item) => item.id === rule.id)!;
    expect(cleanedBudget.filters.tagIds).toEqual([]);
    expect(cleanedRule.template.tagIds).toEqual([]);
    await expect(repository.saveBudget(cleanedBudget, cleanedBudget.id, cleanedBudget.revision)).resolves.toBeDefined();
    await expect(repository.saveRecurringRule(cleanedRule, cleanedRule.id, cleanedRule.revision)).resolves.toBeDefined();
  });

  it('does not count contributions whose linked transaction is skipped', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    const goal = await repository.saveGoal({
      name: 'Fund', kind: 'saving', icon: 'target', color: '#5966E9', targetMinor: 1000,
      initialMinor: 0, targetDate: null, linkedAccountId: null, linkedCategoryId: null, archived: false,
    });
    const upcoming = await repository.saveTransaction({ kind: 'income', status: 'upcoming', title: 'Future', localDate: '2026-08-01', accountId: account.id, amountMinor: 100 });
    await repository.saveContribution({ goalId: goal.id, amountMinor: 100, localDate: '2026-08-01', transactionId: upcoming.id, note: '' });
    expect(repository.getGoalProgress(goal.id)).toBe(0);
    await repository.skipUpcoming(upcoming.id);
    expect(repository.getGoalProgress(goal.id)).toBe(0);
  });

  it('rejects an unsafe recurring rule before persisting it', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const storage = new MemoryStorageAdapter();
      const { repository } = await createRepository(storage);
      const account = repository.getSnapshot().accounts[0];
      await repository.saveAccount({ ...account, openingBalanceMinor: Number.MAX_SAFE_INTEGER }, account.id, account.revision);
      await expect(repository.saveRecurringRule({
        template: { kind: 'income', title: 'Overflow', note: '', accountId: account.id, categoryId: null, tagIds: [], amountMinor: 1, currency: 'USD' },
        unit: 'month', interval: 1, startDate: '2026-07-15', endDate: '2026-07-15', nextDueDate: '2026-07-15', autoPost: true, active: true,
      })).rejects.toThrow('supported range');
      expect(repository.getSnapshot().recurringRules).toEqual([]);
      const reloaded = new LocalFinanceRepository(storage);
      await expect(reloaded.initialize()).resolves.toBeUndefined();
      expect(reloaded.getSnapshot().recurringRules).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('prevents a parent category kind change while it has children', async () => {
    const { repository } = await createRepository();
    const parent = await repository.saveCategory({ name: 'Parent', kind: 'expense', icon: 'house', color: '#5966E9', parentId: null, archived: false });
    await repository.saveCategory({ name: 'Child', kind: 'expense', icon: 'wrench', color: '#5966E9', parentId: parent.id, archived: false });
    await expect(repository.saveCategory({ ...parent, kind: 'income' }, parent.id, parent.revision))
      .rejects.toThrow('kind cannot change');
  });

  it('validates linked-goal ranges before batch category changes persist', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    const salary = repository.getSnapshot().categories.find((item) => item.name === 'Salary')!;
    const other = repository.getSnapshot().categories.find((item) => item.name === 'Other income')!;
    await repository.saveGoal({
      name: 'Maximum', kind: 'saving', icon: 'target', color: '#5966E9', targetMinor: Number.MAX_SAFE_INTEGER,
      initialMinor: Number.MAX_SAFE_INTEGER - 50, targetDate: null, linkedAccountId: null, linkedCategoryId: salary.id, archived: false,
    });
    const transaction = await repository.saveTransaction({ kind: 'income', title: 'Bonus', localDate: '2026-07-15', accountId: account.id, categoryId: other.id, amountMinor: 100 });
    await expect(repository.updateTransactionsCategory([transaction.id], salary.id)).rejects.toThrow('supported range');
    expect(repository.getSnapshot().transactions.find((item) => item.id === transaction.id)?.categoryId).toBe(other.id);
  });

  it('deduplicates repeated CSV tag names before building duplicate keys', async () => {
    const { repository } = await createRepository();
    const row: CsvImportRow = {
      rowNumber: 2, date: '2026-07-15', type: 'expense', status: 'posted', title: 'Taxi', amount: '10.00',
      currency: 'USD', account: 'Everyday', category: '', tags: 'Work|Work', note: '', exchangeRate: '', destinationAccount: '', destinationAmount: '',
    };
    await repository.importCsv([row], true);
    const preview = await repository.importCsv([row], false);
    expect(preview.validRows).toEqual([]);
    expect(preview.duplicateRows).toEqual([2]);
  });

  it('caps positive rollover so a valid budget remains renderable next period', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const storage = new MemoryStorageAdapter();
      const { repository } = await createRepository(storage);
      await repository.saveBudget({
        name: 'Boundary', icon: 'chart', color: '#5966E9', limitMinor: Number.MAX_SAFE_INTEGER,
        period: { unit: 'day', interval: 1, anchorDate: '2026-07-15', endDate: null },
        rollover: true, filters: { accountIds: [], categoryIds: [], tagIds: [] }, categoryLimits: [], archived: false,
      });
      jest.setSystemTime(new Date('2026-07-16T09:00:00Z'));
      const reloaded = new LocalFinanceRepository(storage);
      await reloaded.initialize();
      expect(reloaded.getBudgetStatuses('2026-07-16')[0]).toMatchObject({
        effectiveLimitMinor: Number.MAX_SAFE_INTEGER,
        snapshot: { rolloverMinor: 0 },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a rate edit that would overflow net worth', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-15T09:00:00Z'));
      const { repository } = await createRepository();
      const rate = await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '1', effectiveDate: '2026-01-01' });
      await repository.saveAccount({ name: 'Euro', type: 'checking', currency: 'EUR', openingBalanceMinor: Number.MAX_SAFE_INTEGER, icon: 'wallet', color: '#5966E9', archived: false });
      await expect(repository.saveExchangeRate({ ...rate, rate: '2' }, rate.id, rate.revision)).rejects.toThrow('supported range');
      expect(repository.getSnapshot().exchangeRates.find((item) => item.id === rate.id)?.rate).toBe('1');
      expect(repository.getDashboard('2026-07-01', '2026-07-31').netWorthMinor).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects budget sets whose maximum aggregate limit is unsafe', async () => {
    const { repository } = await createRepository();
    const input = {
      icon: 'chart', color: '#5966E9', limitMinor: Number.MAX_SAFE_INTEGER,
      period: { unit: 'custom' as const, interval: 1, anchorDate: '2026-07-01', endDate: '2026-07-31' },
      rollover: false, filters: { accountIds: [], categoryIds: [], tagIds: [] }, categoryLimits: [], archived: false,
    };
    await repository.saveBudget({ ...input, name: 'First' });
    await expect(repository.saveBudget({ ...input, name: 'Second' })).rejects.toThrow('supported range');
    expect(repository.getSnapshot().budgets).toHaveLength(1);
  });

  it('cleans category references atomically and archives referenced accounts', async () => {
    const { repository } = await createRepository();
    const account = repository.getSnapshot().accounts[0];
    const category = await repository.saveCategory({ name: 'Project', kind: 'expense', icon: 'house', color: '#5966E9', parentId: null, archived: false });
    const child = await repository.saveCategory({ name: 'Project child', kind: 'expense', icon: 'wrench', color: '#5966E9', parentId: category.id, archived: false });
    const transaction = await repository.saveTransaction({ kind: 'expense', title: 'Project', localDate: '2026-07-15', accountId: account.id, categoryId: category.id, amountMinor: 100 });
    const budget = await repository.saveBudget({
      name: 'Project', icon: 'chart', color: '#5966E9', limitMinor: 1000,
      period: { unit: 'month', interval: 1, anchorDate: '2026-07-01', endDate: null }, rollover: false,
      filters: { accountIds: [], categoryIds: [category.id], tagIds: [] }, categoryLimits: [{ categoryId: category.id, limitMinor: 500 }], archived: false,
    });
    const goal = await repository.saveGoal({
      name: 'Project', kind: 'spending', icon: 'target', color: '#5966E9', targetMinor: 1000, initialMinor: 0,
      targetDate: null, linkedAccountId: null, linkedCategoryId: category.id, archived: false,
    });
    const rule = await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Project', note: '', accountId: account.id, categoryId: category.id, tagIds: [], amountMinor: 100, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2099-01-01', endDate: null, nextDueDate: '2099-01-01', autoPost: false, active: true,
    });

    await repository.deleteEntities('categories', [category.id]);
    expect(repository.getSnapshot().categories.find((item) => item.id === child.id)?.parentId).toBeNull();
    expect(repository.getSnapshot().transactions.find((item) => item.id === transaction.id)?.categoryId).toBeNull();
    expect(repository.getSnapshot().budgets.find((item) => item.id === budget.id)).toMatchObject({ filters: { categoryIds: [] }, categoryLimits: [] });
    expect(repository.getSnapshot().goals.find((item) => item.id === goal.id)?.linkedCategoryId).toBeNull();
    expect(repository.getSnapshot().recurringRules.find((item) => item.id === rule.id)?.template.categoryId).toBeNull();

    await repository.deleteEntities('accounts', [account.id]);
    expect(repository.getSnapshot().accounts.find((item) => item.id === account.id)?.archived).toBe(true);
    expect(repository.getSnapshot().transactions.find((item) => item.id === transaction.id)?.accountId).toBe(account.id);
  });
});
