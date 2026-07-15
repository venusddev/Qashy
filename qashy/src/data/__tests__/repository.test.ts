import { LocalFinanceRepository } from '@/data/local-finance-repository';
import { MemoryStorageAdapter } from '@/data/memory-storage';
import type { CsvImportRow, TransactionKind, TransactionStatus } from '@/domain/models';
import { parseCsvTable } from '@/utils/csv';

async function createRepository(storage = new MemoryStorageAdapter()) {
  const repository = new LocalFinanceRepository(storage);
  await repository.initialize();
  await repository.completeOnboarding({
    locale: 'en-US',
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
    expect(summary.accountBalances.find((item) => item.account.id === first.id)?.balanceMinor).toBe(4500);
    expect(summary.accountBalances.find((item) => item.account.id === second.id)?.balanceMinor).toBe(3000);

    const groceries = repository.getSnapshot().categories.find((item) => item.name === 'Groceries')!;
    await repository.updateTransactionsCategory([expense.id, transfer.id], groceries.id);
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

  it('skips a poisoned recurring rule without blocking startup or healthy rules', async () => {
    const storage = new MemoryStorageAdapter();
    const { repository } = await createRepository(storage);
    const usd = repository.getSnapshot().accounts[0];
    const eur = await repository.saveAccount({ name: 'Euro', type: 'checking', currency: 'EUR', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    const rate = await repository.saveExchangeRate({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '2', effectiveDate: '2026-01-01' });
    await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Foreign', note: '', accountId: eur.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'EUR' },
      unit: 'month', interval: 1, startDate: '2026-01-01', endDate: '2026-01-31', nextDueDate: '2026-01-01', autoPost: false, active: true,
    });
    await repository.saveRecurringRule({
      template: { kind: 'expense', title: 'Healthy', note: '', accountId: usd.id, categoryId: null, tagIds: [], amountMinor: 100, currency: 'USD' },
      unit: 'month', interval: 1, startDate: '2026-01-01', endDate: '2026-01-31', nextDueDate: '2026-01-01', autoPost: false, active: true,
    });
    await repository.deleteEntities('exchangeRates', [rate.id]);

    const reloaded = new LocalFinanceRepository(storage);
    await expect(reloaded.initialize()).resolves.toBeUndefined();
    expect(reloaded.getSnapshot().transactions.some((item) => item.title === 'Healthy')).toBe(true);
    expect(reloaded.getSnapshot().transactions.some((item) => item.title === 'Foreign')).toBe(false);
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
      unit: 'month', interval: 1, startDate: '2026-01-01', endDate: '2026-01-31', nextDueDate: '2026-01-01', autoPost: false, active: true,
    });
    // Remove the occurrence so the next generation run writes again.
    const generatedId = repository.getSnapshot().transactions.find((item) => item.title === 'Rent')?.id;
    if (generatedId) await repository.deleteEntities('transactions', [generatedId]);

    storage.pauseNext = true;
    const generation = repository.generateRecurring('2026-01-31');
    await Promise.resolve();
    await Promise.resolve();
    const concurrentSave = repository.saveTransaction({ kind: 'expense', title: 'Concurrent', localDate: '2026-07-15', accountId: account.id, amountMinor: 500 });
    await concurrentSave;
    storage.releasePaused();
    await generation;

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

  it('frees archived names for reuse and rejects restoring into a conflict', async () => {
    const { repository } = await createRepository();
    const original = await repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    await repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: true }, original.id);
    const replacement = await repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false });
    expect(replacement.id).not.toBe(original.id);
    await expect(repository.saveAccount({ name: 'Savings', type: 'savings', currency: 'USD', openingBalanceMinor: 0, icon: 'wallet', color: '#5966E9', archived: false }, original.id)).rejects.toThrow('already in use');
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
});
