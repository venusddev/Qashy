import { LocalFinanceRepository } from '@/data/local-finance-repository';
import { MemoryStorageAdapter } from '@/data/memory-storage';

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
});
