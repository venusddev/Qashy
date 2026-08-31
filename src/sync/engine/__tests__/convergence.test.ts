/**
 * Three real devices, one vault, and the only question that matters: do they end up the same,
 * and is what they end up with still usable?
 *
 * Everything here runs through the public `FinanceRepository` API. Not one op is hand-written.
 * That is the point — a merge engine can be provably correct in isolation and still produce
 * states the finance core refuses to accept, because the two have different ideas about what a
 * valid budget is. The only way to find that out is to drive the real thing.
 *
 * Two assertions run at the end of the property test and they are not redundant:
 *
 *   1. Every device's normalized snapshot is identical. Convergence.
 *   2. Every device can still *write*. Validity.
 *
 * The second is the one that earns its keep. A converged-but-unsavable budget passes a deep
 * equality check on all three devices and then throws on every future edit, on every device,
 * permanently — the worst possible shape for a bug, because it looks like success right up
 * until the user tries to change something.
 */

import type { Account, Budget, FinanceState, Goal, RecurringRule } from '@/domain/models';
import {
  BASE_CURRENCY,
  expectConverged,
  expectDiverged,
  inputOf,
  makeVault,
  onboard,
  randomSource,
  settle,
  sync,
  type VaultDevice,
} from '@/sync/engine/__tests__/vault';

const TODAY = '2026-07-15';

/**
 * A vault with history, shared by every device.
 *
 * One device onboards and the rest receive everything through sync, which is what pairing a
 * new phone with an existing one actually does. The both-devices-already-populated case is
 * genuinely different and gets its own tests below.
 */
async function populatedVault(count: number) {
  const devices = await makeVault({ count });
  await onboard(devices[0]);
  await sync(devices, 3);
  return devices;
}

// ---------------------------------------------------------------------------
// The property test
// ---------------------------------------------------------------------------

interface Action {
  readonly name: string;
  /** Returns false when the vault does not currently hold what the action needs. */
  run: (device: VaultDevice, tick: number) => Promise<boolean>;
}

const liveAccounts = (state: FinanceState) => state.accounts.filter((row) => !row.archived);

const ACTIONS: readonly Action[] = [
  {
    name: 'addAccount',
    async run(device, tick) {
      await device.repository.saveAccount({
        name: `Account ${tick}`,
        type: 'checking',
        currency: BASE_CURRENCY,
        openingBalanceMinor: 1000 * (tick % 7),
        icon: 'wallet',
        color: '#00A58E',
        archived: false,
      });
      return true;
    },
  },
  {
    name: 'renameAccount',
    async run(device, tick) {
      const [account] = liveAccounts(device.state);
      if (!account) return false;
      await device.repository.saveAccount(
        { ...inputOf(account), name: `Renamed ${tick}` },
        account.id,
      );
      return true;
    },
  },
  {
    name: 'addCategory',
    async run(device, tick) {
      await device.repository.saveCategory({
        name: `Category ${tick}`,
        kind: 'expense',
        icon: 'tag',
        color: '#5B8DEF',
        parentId: null,
        archived: false,
      });
      return true;
    },
  },
  {
    name: 'addTag',
    async run(device, tick) {
      await device.repository.saveTag({ name: `Tag ${tick}`, color: '#C47ED0' });
      return true;
    },
  },
  {
    name: 'addTransaction',
    async run(device, tick) {
      const accounts = liveAccounts(device.state);
      if (!accounts.length) return false;
      const category = device.state.categories.find((row) => row.kind === 'expense');
      await device.repository.saveTransaction({
        kind: 'expense',
        title: `Spend ${tick}`,
        localDate: TODAY,
        accountId: accounts[tick % accounts.length].id,
        categoryId: category?.id ?? null,
        amountMinor: 100 + tick * 13,
      });
      return true;
    },
  },
  {
    name: 'editTransaction',
    async run(device, tick) {
      const [transaction] = device.state.transactions;
      if (!transaction) return false;
      await device.repository.saveTransaction(
        { ...inputOf(transaction), amountMinor: 500 + tick * 7 },
        transaction.id,
      );
      return true;
    },
  },
  {
    name: 'categorizeTransaction',
    async run(device, tick) {
      const transactions = device.state.transactions.filter((row) => row.kind !== 'transfer');
      const categories = device.state.categories.filter((row) => row.kind === 'expense');
      if (!transactions.length || !categories.length) return false;
      await device.repository.updateTransactionsCategory(
        [transactions[tick % transactions.length].id],
        categories[tick % categories.length].id,
      );
      return true;
    },
  },
  {
    name: 'deleteTransaction',
    async run(device, tick) {
      const transactions = device.state.transactions;
      if (transactions.length < 2) return false;
      await device.repository.deleteEntities('transactions', [
        transactions[tick % transactions.length].id,
      ]);
      return true;
    },
  },
  {
    name: 'addBudget',
    async run(device, tick) {
      const categories = device.state.categories.filter((row) => row.kind === 'expense');
      if (!categories.length) return false;
      const category = categories[tick % categories.length];
      await device.repository.saveBudget({
        name: `Budget ${tick}`,
        icon: 'chart.pie',
        color: '#E08C5A',
        limitMinor: 50_000,
        period: { unit: 'month', interval: 1, anchorDate: '2026-07-01', endDate: null },
        rollover: tick % 2 === 0,
        filters: { accountIds: [], categoryIds: [category.id], tagIds: [] },
        categoryLimits: [{ categoryId: category.id, limitMinor: 10_000 }],
        archived: false,
      });
      return true;
    },
  },
  {
    name: 'editBudgetFilters',
    async run(device, tick) {
      const [budget] = device.state.budgets;
      if (!budget) return false;
      const categories = device.state.categories.filter((row) => row.kind === 'expense');
      if (!categories.length) return false;
      const category = categories[tick % categories.length];
      await device.repository.saveBudget(
        {
          ...inputOf(budget),
          limitMinor: 40_000 + tick * 100,
          filters: { ...budget.filters, categoryIds: [category.id] },
          categoryLimits: [{ categoryId: category.id, limitMinor: 5_000 }],
        },
        budget.id,
      );
      return true;
    },
  },
  {
    name: 'addGoalAndContribution',
    async run(device, tick) {
      const goal = await device.repository.saveGoal({
        name: `Goal ${tick}`,
        kind: 'saving',
        icon: 'target',
        color: '#3B9A69',
        targetMinor: 100_000,
        initialMinor: 0,
        targetDate: null,
        linkedAccountId: null,
        linkedCategoryId: null,
        archived: false,
      });
      await device.repository.saveContribution({
        goalId: goal.id,
        amountMinor: 1_000 + tick,
        localDate: TODAY,
        transactionId: null,
        note: '',
      });
      return true;
    },
  },
  {
    name: 'addRecurringRule',
    async run(device, tick) {
      const accounts = liveAccounts(device.state);
      if (!accounts.length) return false;
      await device.repository.saveRecurringRule({
        template: {
          kind: 'expense',
          title: `Subscription ${tick}`,
          note: '',
          accountId: accounts[tick % accounts.length].id,
          categoryId: null,
          tagIds: [],
          amountMinor: 999,
          currency: BASE_CURRENCY,
        },
        unit: 'month',
        interval: 1,
        startDate: '2026-07-01',
        endDate: null,
        nextDueDate: '2026-08-01',
        autoPost: true,
        active: true,
      });
      return true;
    },
  },
  {
    name: 'generateRecurring',
    async run(device) {
      await device.repository.generateRecurring('2026-09-30');
      return true;
    },
  },
  {
    name: 'archiveAccount',
    async run(device, tick) {
      const accounts = liveAccounts(device.state);
      // Never the last one: an account-less vault cannot book anything, and the run would
      // spend its remaining operations bailing out rather than exercising the merge.
      if (accounts.length < 3) return false;
      const account = accounts[tick % accounts.length];
      await device.repository.saveAccount({ ...inputOf(account), archived: true }, account.id);
      return true;
    },
  },
];

describe('convergence — three devices, random edits', () => {
  // Fixed seeds rather than a random one per run: a property test nobody can replay reports
  // failures as folklore. New seeds are added by hand, after being watched to pass.
  it.each([11, 4242, 90210])('converges and stays writable (seed %i)', async (seed) => {
    const random = randomSource(seed);
    const devices = await populatedVault(3);
    const wires = [
      devices[0].wireTo(devices[1]),
      devices[0].wireTo(devices[2]),
      devices[1].wireTo(devices[2]),
    ];

    for (let tick = 0; tick < 60; tick += 1) {
      const device = random.pick(devices);
      const action = random.pick(ACTIONS);
      await action.run(device, tick);

      // Cut and restore links as the run goes, so edits are made against genuinely stale
      // views of the vault rather than against a state everyone already agreed on.
      const wire = random.pick(wires);
      if (random.next() < 0.2) wire.partition();
      else if (random.next() < 0.3) wire.heal();

      // Sync some of the time, so edits pile up unsynced and land in bursts — which is what a
      // phone that was in a pocket for an hour actually does.
      if (random.next() < 0.3) await sync([device], 1);
    }

    expectDiverged(devices);
    for (const wire of wires) wire.heal();
    await settle();

    // Twice, in a different order each time. The second pass must be a pure no-op: if
    // re-delivery is not idempotent, the two passes disagree and this fails.
    await sync(random.shuffle(devices), 3);
    await sync(random.shuffle(devices), 3);

    const converged = expectConverged(devices);
    expect(converged.transactions.length).toBeGreaterThan(0);
    for (const device of devices) expect(device.errors).toEqual([]);

    // Writable, on every device, against the merged state — the assertion the whole file is
    // built around. `saveBudget` re-validates filters against category limits, `saveAccount`
    // re-validates name uniqueness, and `saveRecurringRule` re-validates its template's
    // references, so re-saving what a device already holds is a full invariant sweep.
    for (const device of devices) {
      const state = device.state;
      for (const account of state.accounts) {
        await device.repository.saveAccount(inputOf(account) as Account, account.id);
      }
      for (const budget of state.budgets) {
        await device.repository.saveBudget(inputOf(budget) as Budget, budget.id);
      }
      for (const goal of state.goals) {
        await device.repository.saveGoal(inputOf(goal) as Goal, goal.id);
      }
      for (const rule of state.recurringRules) {
        const { pausedByDependency, ...input } = inputOf(rule) as RecurringRule;
        void pausedByDependency;
        await device.repository.saveRecurringRule(input, rule.id);
      }
      await device.repository.saveTransaction({
        kind: 'expense',
        title: 'After the merge',
        localDate: TODAY,
        accountId: liveAccounts(state)[0].id,
        amountMinor: 1_23,
      });
      await expect(device.repository.generateRecurring('2026-10-31')).resolves.toBeGreaterThanOrEqual(
        0,
      );
    }

    await sync(devices, 3);
    expectConverged(devices);
  });

  it('loses nothing across a partition and a heal', async () => {
    const [alice, bob] = await populatedVault(2);
    const wire = alice.wireTo(bob);
    wire.partition();

    await alice.repository.saveTransaction({
      kind: 'expense',
      title: 'Coffee',
      localDate: TODAY,
      accountId: alice.state.accounts[0].id,
      amountMinor: 450,
    });
    await bob.repository.saveTransaction({
      kind: 'income',
      title: 'Refund',
      localDate: TODAY,
      accountId: bob.state.accounts[0].id,
      amountMinor: 1_200,
    });

    // Both devices push into a dead wire and both believe they succeeded, because that is
    // exactly what a device on a broken network believes and it has no way to know better.
    await sync([alice, bob], 2);
    expect(alice.state.transactions).toHaveLength(1);
    expect(bob.state.transactions).toHaveLength(1);

    expect(wire.heal()).toBeGreaterThan(0);
    await settle();
    await sync([alice, bob], 3);

    const converged = expectConverged([alice, bob]);
    expect(converged.transactions.map((row) => row.title).sort()).toEqual(['Coffee', 'Refund']);
    // Balances are derived from the merged ledger rather than replicated, so agreeing on them
    // is a second, independent check that the same ops landed on both sides.
    const balance = (device: VaultDevice) =>
      device.repository
        .getDashboard('2026-07-01', '2026-07-31')
        .accountBalances.map((row) => row.balanceMinor);
    expect(balance(alice)).toEqual(balance(bob));
  });
});
