/**
 * The specific ways two devices can produce a state neither of them could produce alone.
 *
 * `convergence.test.ts` drives random edits and asks the general question. This file asks the
 * pointed ones — each test here is a bug that was reasoned about before the code was written,
 * written down, and is now pinned. They fall into three kinds:
 *
 *   **Deterministic identity.** Two devices independently generating "the same" record. The
 *   fix is not to deduplicate afterwards but to make both devices compute the same id, so the
 *   two generations *are* one entity by construction.
 *
 *   **Field groups.** Co-dependent fields that must move together. Splitting `amountMinor`
 *   from the `exchangeRate` that converted it produces a transaction whose base amount is
 *   arithmetic nobody performed — no exception, no warning, just a wrong total.
 *
 *   **Repair.** States that are individually legal and jointly invalid: a budget limit for a
 *   category the filters no longer include, a transaction on an account that was deleted. The
 *   repair pass is a pure function of the merged set precisely so every device computes the
 *   same correction without anybody emitting an op about it.
 *
 * Everything runs through the public repository API. A test that hand-authored the ops would
 * be asserting that the merge engine does what the merge engine does.
 */

import type { Budget, Category, TransactionRecord } from '@/domain/models';
import { convertMinor } from '@/utils/money';
import {
  activityOf,
  BASE_CURRENCY,
  expectConverged,
  inputOf,
  makeVault,
  normalize,
  onboard,
  opsOf,
  settle,
  sync,
  type VaultDevice,
} from '@/sync/engine/__tests__/vault';

const TODAY = '2026-07-15';

/**
 * Far enough out that saving a rule does not immediately post it.
 *
 * `saveRecurringRule` generates through *today plus a month* on the spot, so a rule due next
 * week is already posted by the time the test gets to partition the devices. Scheduling past
 * that window is what leaves the occurrence genuinely outstanding on both sides.
 */
const HORIZON = '2027-03-05';
const DUE = '2027-03-01';

/** One device onboards, the rest receive the vault — pairing a new phone with an old one. */
async function populated(count = 2) {
  const devices = await makeVault({ count });
  await onboard(devices[0]);
  await sync(devices, 3);
  return devices;
}

const live = <T extends { deletedAt: string | null }>(rows: readonly T[]) =>
  rows.filter((row) => !row.deletedAt);

const named = (device: VaultDevice, name: string) =>
  device.state.categories.find((row) => row.name === name);

// ---------------------------------------------------------------------------
// Deterministic identity
// ---------------------------------------------------------------------------

describe('merge scenarios — two devices generating the same record', () => {
  it('produces one transaction when both devices run the same recurrence', async () => {
    const [alice, bob] = await populated();
    const wire = alice.wireTo(bob);
    const rule = await alice.repository.saveRecurringRule({
      template: {
        kind: 'expense',
        title: 'Rent',
        note: '',
        accountId: alice.state.accounts[0].id,
        categoryId: null,
        tagIds: [],
        amountMinor: 120_000,
        currency: BASE_CURRENCY,
      },
      unit: 'month',
      interval: 1,
      startDate: DUE,
      endDate: null,
      nextDueDate: DUE,
      autoPost: true,
      active: true,
    });
    await sync([alice, bob], 3);
    expect(alice.state.transactions).toHaveLength(0);

    // Both devices foreground on the same morning with no connectivity between them. This is
    // not a rare race: `generateRecurring` runs on *every* foreground on *every* device, so
    // two paired phones do this by default rather than by accident.
    wire.partition();
    expect(await alice.repository.generateRecurring(HORIZON)).toBe(1);
    expect(await bob.repository.generateRecurring(HORIZON)).toBe(1);
    expect(alice.state.transactions).toHaveLength(1);
    expect(bob.state.transactions).toHaveLength(1);
    // Same occurrence, same id — computed independently, with nothing exchanged.
    expect(alice.state.transactions[0].id).toBe(bob.state.transactions[0].id);

    wire.heal();
    await settle();
    await sync([alice, bob], 3);

    const converged = expectConverged([alice, bob]);
    expect(converged.transactions).toHaveLength(1);
    // Zero, not "one already exists so skip": the occurrence key is claimed on both devices,
    // so neither considers it outstanding.
    expect(await alice.repository.generateRecurring(HORIZON)).toBe(0);
    expect(await bob.repository.generateRecurring(HORIZON)).toBe(0);
    expect(alice.state.recurringRules.find((row) => row.id === rule.id)?.nextDueDate).toBe(
      '2027-04-01',
    );
  });

  it('keeps a deleted occurrence deleted after it merges back', async () => {
    const [alice, bob] = await populated();
    await alice.repository.saveRecurringRule({
      template: {
        kind: 'expense',
        title: 'Gym',
        note: '',
        accountId: alice.state.accounts[0].id,
        categoryId: null,
        tagIds: [],
        amountMinor: 4_500,
        currency: BASE_CURRENCY,
      },
      unit: 'month',
      interval: 1,
      startDate: DUE,
      endDate: null,
      nextDueDate: DUE,
      autoPost: true,
      active: true,
    });
    expect(await alice.repository.generateRecurring(HORIZON)).toBe(1);
    await sync([alice, bob], 3);
    const generated = alice.state.transactions[0];

    // The user cancelled the gym and deleted the posted charge. The tombstone is what tells
    // every device never to regenerate that occurrence — hard-deleting the row instead would
    // resurrect the charge on the next foreground, on every device, forever.
    await alice.repository.deleteEntities('transactions', [generated.id]);
    await sync([alice, bob], 3);

    expectConverged([alice, bob]);
    expect(alice.state.transactions).toHaveLength(0);
    expect(bob.state.transactions).toHaveLength(0);
    expect(await bob.repository.generateRecurring(HORIZON)).toBe(0);
    expect(await alice.repository.generateRecurring(HORIZON)).toBe(0);

    await sync([alice, bob], 2);
    expect(expectConverged([alice, bob]).transactions).toHaveLength(0);
  });

  it('keeps one budget period per window, with the same rollover on both', async () => {
    // The calendar is the trigger here, so it has to be controlled. `setTimeout` is left real
    // because the loopback delivers frames through it — freezing it would deadlock `settle`.
    jest.useFakeTimers({
      now: new Date('2026-07-15T09:00:00Z'),
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'setImmediate',
        'clearImmediate',
        'queueMicrotask',
        'nextTick',
        'performance',
      ],
    });
    try {
      const [alice, bob] = await populated();
      const wire = alice.wireTo(bob);
      const category = await alice.repository.saveCategory({
        name: 'Bakery',
        kind: 'expense',
        icon: 'cart',
        color: '#5B8DEF',
        parentId: null,
        archived: false,
      });
      const budget = await alice.repository.saveBudget({
        name: 'Food',
        icon: 'chart.pie',
        color: '#E08C5A',
        limitMinor: 60_000,
        period: { unit: 'month', interval: 1, anchorDate: '2026-07-01', endDate: null },
        rollover: true,
        filters: { accountIds: [], categoryIds: [category.id], tagIds: [] },
        categoryLimits: [],
        archived: false,
      });
      // Spend some of July, so August has a rollover worth disagreeing about. A test where
      // both devices compute zero would pass with the rollover arithmetic deleted.
      await alice.repository.saveTransaction({
        kind: 'expense',
        title: 'Market',
        localDate: TODAY,
        accountId: alice.state.accounts[0].id,
        categoryId: category.id,
        amountMinor: 22_000,
      });
      await sync([alice, bob], 3);
      expect(alice.state.budgetPeriods).toHaveLength(1);

      // The 1st of the next month, both devices offline from each other. Each one notices
      // July has closed and opens August on its own.
      jest.setSystemTime(new Date('2026-08-03T09:00:00Z'));
      wire.partition();
      await alice.repository.generateRecurring();
      await bob.repository.generateRecurring();
      expect(alice.state.budgetPeriods).toHaveLength(2);
      expect(bob.state.budgetPeriods).toHaveLength(2);

      wire.heal();
      await settle();
      await sync([alice, bob], 3);

      const converged = expectConverged([alice, bob]);
      // Two windows, not three. Without a deterministic snapshot id these are two rows for
      // August; the history sort then ties and `.at(-1)` picks arbitrarily, so the *rollover*
      // differs per device — a wrong number on screen with nothing to indicate it.
      expect(converged.budgetPeriods).toHaveLength(2);
      const windows = alice.state.budgetPeriods.map((row) => `${row.budgetId}:${row.periodStart}`);
      expect(new Set(windows).size).toBe(2);

      const august = (device: VaultDevice) => {
        const status = device.repository
          .getBudgetStatuses('2026-08-03')
          .find((row) => row.budget.id === budget.id)!;
        return {
          periodStart: status.snapshot.periodStart,
          rolloverMinor: status.snapshot.rolloverMinor,
          effectiveLimitMinor: status.effectiveLimitMinor,
          spentMinor: status.spentMinor,
        };
      };
      expect(august(alice)).toEqual(august(bob));
      expect(august(alice)).toMatchObject({ periodStart: '2026-08-01', rolloverMinor: 38_000 });
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Field groups
// ---------------------------------------------------------------------------

describe('merge scenarios — co-dependent fields', () => {
  it('keeps a transaction’s amount, date, and applied rate consistent', async () => {
    const [alice, bob] = await populated();
    const wire = alice.wireTo(bob);
    const account = await alice.repository.saveAccount({
      name: 'Travel',
      type: 'checking',
      currency: 'EUR',
      openingBalanceMinor: 0,
      icon: 'wallet',
      color: '#00A58E',
      archived: false,
    });
    // Two rates, so moving the date genuinely moves the rate. With one rate the group could
    // be split down the middle and the arithmetic below would still come out right.
    await alice.repository.saveExchangeRate({
      fromCurrency: 'EUR',
      toCurrency: BASE_CURRENCY,
      rate: '1.10',
      effectiveDate: '2026-07-01',
    });
    await alice.repository.saveExchangeRate({
      fromCurrency: 'EUR',
      toCurrency: BASE_CURRENCY,
      rate: '1.25',
      effectiveDate: '2026-07-20',
    });
    const original = await alice.repository.saveTransaction({
      kind: 'expense',
      title: 'Hotel',
      localDate: TODAY,
      accountId: account.id,
      amountMinor: 40_000,
    });
    await sync([alice, bob], 3);
    expect(bob.state.transactions[0].exchangeRate).toBe('1.1');

    wire.partition();
    // Bob's clock runs ahead, so his edit wins on HLC rather than on which line of this test
    // happened to run second.
    bob.skewMs = 90_000;
    await alice.repository.saveTransaction(
      { ...inputOf(original), amountMinor: 55_000 },
      original.id,
    );
    // Written out rather than spread from the held record, because `inputOf` would carry the
    // stored `exchangeRate` forward as an explicit override and the date would stop driving
    // the rate — which is the entire thing this test is about.
    const held = bob.state.transactions[0];
    await bob.repository.saveTransaction(
      {
        kind: 'expense',
        title: held.title,
        localDate: '2026-07-25',
        accountId: held.accountId,
        amountMinor: held.amountMinor,
      },
      original.id,
    );

    wire.heal();
    await settle();
    await sync([alice, bob], 3);
    bob.skewMs = 0;

    const converged = expectConverged([alice, bob]);
    const merged = converged.transactions[0] as unknown as TransactionRecord;
    // The whole ledger group came from Bob — including the amount he did *not* touch. That is
    // the point: a merge that kept Alice's 55 000 alongside Bob's date and rate would be a
    // transaction no device ever held, and its base amount would be arithmetic nobody did.
    expect(merged).toMatchObject({
      localDate: '2026-07-25',
      amountMinor: 40_000,
      currency: 'EUR',
      exchangeRate: '1.25',
    });
    expect(merged.baseAmountMinor).toBe(
      convertMinor(merged.amountMinor, 'EUR', BASE_CURRENCY, merged.exchangeRate),
    );
    // Independently derived from the merged ledger rather than replicated, so agreement here
    // is a second check that the same group landed on both sides.
    const balances = (device: VaultDevice) =>
      device.repository
        .getDashboard('2026-07-01', '2026-07-31')
        .accountBalances.map((row) => row.balanceMinor);
    expect(balances(alice)).toEqual(balances(bob));
  });
});

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

describe('merge scenarios — repairing a jointly-invalid state', () => {
  it('leaves a merged budget saveable when filters and limits were edited apart', async () => {
    const [alice, bob] = await populated();
    const wire = alice.wireTo(bob);
    const food = await alice.repository.saveCategory({
      name: 'Food',
      kind: 'expense',
      icon: 'cart',
      color: '#5B8DEF',
      parentId: null,
      archived: false,
    });
    const travel = await alice.repository.saveCategory({
      name: 'Travel',
      kind: 'expense',
      icon: 'airplane',
      color: '#E08C5A',
      parentId: null,
      archived: false,
    });
    const budget = await alice.repository.saveBudget({
      name: 'Monthly',
      icon: 'chart.pie',
      color: '#3B9A69',
      limitMinor: 80_000,
      period: { unit: 'month', interval: 1, anchorDate: '2026-07-01', endDate: null },
      rollover: false,
      filters: { accountIds: [], categoryIds: [food.id, travel.id], tagIds: [] },
      categoryLimits: [{ categoryId: food.id, limitMinor: 30_000 }],
      archived: false,
    });
    await sync([alice, bob], 3);

    wire.partition();
    // Alice narrows the budget to food only. Bob, who cannot see that, caps travel. Both are
    // ordinary edits; together they describe a budget whose limits reference a category its
    // filters exclude — which `validateBudget` refuses, on every device, forever.
    await alice.repository.saveBudget(
      {
        ...inputOf(budget),
        filters: { accountIds: [], categoryIds: [food.id], tagIds: [] },
      },
      budget.id,
    );
    await bob.repository.saveBudget(
      {
        ...inputOf(bob.state.budgets[0]),
        categoryLimits: [
          { categoryId: food.id, limitMinor: 30_000 },
          { categoryId: travel.id, limitMinor: 25_000 },
        ],
      },
      budget.id,
    );

    wire.heal();
    await settle();
    await sync([alice, bob], 3);

    const converged = expectConverged([alice, bob]);
    const mergedBudget = converged.budgets[0] as unknown as Budget;
    // The filter is kept and the orphaned limit is dropped — the same direction
    // `deleteEntities` already takes, so the repair does not invent a third behaviour.
    expect(mergedBudget.filters.categoryIds).toEqual([food.id]);
    expect(mergedBudget.categoryLimits.map((row) => row.categoryId)).toEqual([food.id]);

    // The assertion the whole scenario exists for. A converged-but-unsavable budget passes a
    // deep equality check on both devices and then throws the first time either opens it.
    for (const device of [alice, bob]) {
      const held = device.state.budgets[0];
      await expect(
        device.repository.saveBudget(inputOf(held) as Budget, held.id),
      ).resolves.toMatchObject({ id: budget.id });
    }
    await sync([alice, bob], 3);
    expectConverged([alice, bob]);
  });

  it('resurrects an account a merged-in transaction needs, and lets it go again', async () => {
    const [alice, bob] = await populated();
    const wire = alice.wireTo(bob);
    const savings = await alice.repository.saveAccount({
      name: 'Savings',
      type: 'savings',
      currency: BASE_CURRENCY,
      openingBalanceMinor: 10_000,
      icon: 'wallet',
      color: '#3B9A69',
      archived: false,
    });
    await sync([alice, bob], 3);

    wire.partition();
    // Nothing references it on Alice's side, so this is a real tombstone rather than the
    // archive `deleteEntities` falls back to. Bob, meanwhile, books against it.
    await alice.repository.deleteEntities('accounts', [savings.id]);
    expect(alice.state.accounts.map((row) => row.id)).not.toContain(savings.id);
    const booked = await bob.repository.saveTransaction({
      kind: 'expense',
      title: 'Transfer fee',
      localDate: TODAY,
      accountId: savings.id,
      amountMinor: 250,
    });

    wire.heal();
    await settle();
    await sync([alice, bob], 3);

    const converged = expectConverged([alice, bob]);
    // Live again, and archived — an account is part of every ledger entry's identity, so a
    // transaction pointing at a row that is not there is not a state the finance core can
    // render. Archiving keeps it out of the pickers without rewriting history.
    const resurrected = converged.accounts.find((row) => row.id === savings.id);
    expect(resurrected).toMatchObject({ deletedAt: null, archived: true });

    const before = await Promise.all([opsOf(alice), opsOf(bob)]);
    await alice.repository.deleteEntities('transactions', [booked.id]);
    await sync([alice, bob], 3);

    const settled = expectConverged([alice, bob]);
    // The reason for the repair is gone, so the repair stops firing and the account returns
    // to the tombstone it never stopped having. Nothing un-deleted it; it was only ever being
    // shown because something needed it.
    expect(settled.accounts.map((row) => row.id)).not.toContain(savings.id);
    expect(live(settled.transactions as { deletedAt: string | null }[])).toHaveLength(0);

    // One op — the delete Alice actually made. The repair pass emits nothing, and that is
    // load-bearing rather than tidy: a repair that emitted even one op would work on two
    // devices and ping-pong forever on three, each reacting to the other's correction.
    const after = await Promise.all([opsOf(alice), opsOf(bob)]);
    expect(after.map((rows) => rows.length)).toEqual(before.map((rows) => rows.length + 1));
    expect(after[0].filter((row) => !before[0].some((old) => old.opId === row.opId))).toMatchObject(
      [{ entityType: 'transactions', kind: 'delete' }],
    );
  });

  it.each(['en-US', 'he-IL'])('renames colliding categories identically (%s)', async (locale) => {
    const devices = await makeVault({ count: 2 });
    const [alice, bob] = devices;
    await onboard(alice, { locale });
    await sync(devices, 3);
    expect(bob.state.settings.locale).toBe(locale);
    const wire = alice.wireTo(bob);

    // Both people add the bakery category on their own phone, offline. Whether these are the
    // *same* category is a judgement only they can make, so the automatic step keeps both and
    // makes the merged set valid; the merge review screen is where the human decides. The
    // name is deliberately not one of the seeded starter categories, which both devices
    // already share and which would collide before either of them typed anything.
    wire.partition();
    await alice.repository.saveCategory({
      name: 'Bakery',
      kind: 'expense',
      icon: 'cart',
      color: '#5B8DEF',
      parentId: null,
      archived: false,
    });
    await bob.repository.saveCategory({
      name: 'bakery',
      kind: 'expense',
      icon: 'cart',
      color: '#E08C5A',
      parentId: null,
      archived: false,
    });

    wire.heal();
    await settle();
    await sync(devices, 3);

    const converged = expectConverged(devices);
    const collided = (converged.categories as unknown as Category[])
      .filter((row) => row.name.toLowerCase().startsWith('bakery'))
      .map((row) => row.name)
      .sort();
    expect(collided).toHaveLength(2);
    // Case folding is locale-dependent — `'I'.toLocaleLowerCase()` is `'ı'` in Turkish — so a
    // repair that folded with the device's locale would compute different collision sets on
    // two paired devices and never agree. Running this under he-IL is what pins that.
    expect(collided).toEqual(['Bakery', 'bakery (duplicate)']);

    // And the merged set is still writable, which is the invariant the rename exists to keep:
    // `assertUniqueName` would reject two categories called "Bakery" on every save.
    for (const device of devices) {
      const held = named(device, 'Bakery')!;
      await expect(
        device.repository.saveCategory(inputOf(held) as Category, held.id),
      ).resolves.toBeDefined();
    }
    await sync(devices, 3);
    expectConverged(devices);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('merge scenarios — states that must not merge at all', () => {
  it('records the real base currency in the op log, not a placeholder', async () => {
    const [alice] = await makeVault({ count: 1, baseCurrency: 'ILS' });
    await onboard(alice, { baseCurrency: 'ILS' });

    const creates = (await opsOf(alice)).filter(
      (row) => row.entityType === 'settings' && row.kind === 'create',
    );

    // Exactly one, carrying the currency the user actually chose.
    //
    // `baseCurrency` is `createOnly`, so the create op is the *only* op that will ever carry
    // it — a later `set` is correctly dropped by the diff. Writing a placeholder settings row
    // at startup therefore froze the app default into the log while `records` held the real
    // choice, and the two disagreed for the life of the vault. It stayed invisible until
    // something re-projected the log over `records`, at which point a vault set up in ILS
    // silently became a USD one. Deferring the first settings write to `completeOnboarding` is
    // what makes this assertion hold, and this is the assertion that keeps it holding.
    expect(creates).toHaveLength(1);
    expect(JSON.parse(creates[0].payload)).toMatchObject({ entity: { baseCurrency: 'ILS' } });
    expect(alice.state.settings.baseCurrency).toBe('ILS');
  });

  it('refuses a batch from a device set up in a different base currency', async () => {
    const devices = await makeVault({ count: 2, currencies: ['USD', 'ILS'] });
    const [alice, bob] = devices;
    await onboard(alice, { baseCurrency: 'USD' });
    await onboard(bob, { baseCurrency: 'ILS', accountName: 'Laptop' });
    const before = normalize(bob.state);

    await sync(devices, 3);

    // Not a conflict and not repairable: every transaction's `baseAmountMinor` is snapshotted
    // against the vault's base currency, and re-basing would need the full historical rate
    // matrix for every pair — which the app does not have and never will.
    expect(normalize(bob.state)).toEqual(before);
    expect(bob.state.accounts.map((row) => row.name)).toEqual(['Laptop']);
    expect(alice.state.accounts.map((row) => row.name)).toEqual(['Everyday']);

    // Loud on both sides, and in the user's terms. A refusal nobody can see is worse than the
    // corruption it prevents: the devices simply never agree and nothing ever says why.
    expect(bob.errors.length).toBeGreaterThan(0);
    for (const error of bob.errors) {
      expect((error as Error).message).toContain('different base currencies');
    }
    const rejections = await activityOf(bob);
    expect(rejections.map((row) => row.code)).toContain('currencyMismatch');

    // Nothing was written on the refusing side — not the ops, not a partial projection. A
    // batch that half-applied here would leave totals converted against two different bases.
    const stored = await opsOf(bob);
    expect(stored.every((row) => row.deviceId === bob.deviceId)).toBe(true);
  });

  it('leaves the other device untouched when one is reset', async () => {
    const [alice, bob] = await populated();
    await alice.repository.saveTransaction({
      kind: 'expense',
      title: 'Lunch',
      localDate: TODAY,
      accountId: alice.state.accounts[0].id,
      amountMinor: 1_450,
    });
    await sync([alice, bob], 3);
    const before = normalize(bob.state);

    await alice.repository.resetAllData();

    expect(alice.state.accounts).toEqual([]);
    expect(alice.state.transactions).toEqual([]);
    // A reset is a *local* wipe and cannot be expressed as an op. "Delete everything" would
    // be a weapon: one compromised paired device could destroy every peer's data with a
    // single message. Reset unpairs this device instead, which is why the meta is gone.
    expect(await alice.session.reconcile()).toMatchObject({ sealed: 0, pushed: [] });
    await sync([alice, bob], 3);

    expect(normalize(bob.state)).toEqual(before);
    expect(bob.state.transactions).toHaveLength(1);
    expect(alice.state.transactions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Two vaults that both already have data
// ---------------------------------------------------------------------------

describe('merge scenarios — pairing two populated vaults', () => {
  it('keeps both histories and stays writable', async () => {
    const devices = await makeVault({ count: 2 });
    const [alice, bob] = devices;
    // Neither device is "the" vault. Both were set up separately and used for a while, which
    // is the situation anybody who already owns two devices is actually in.
    await onboard(alice, { accountName: 'Phone current' });
    await onboard(bob, { accountName: 'Laptop current' });
    await alice.repository.saveTransaction({
      kind: 'expense',
      title: 'Coffee',
      localDate: TODAY,
      accountId: alice.state.accounts[0].id,
      amountMinor: 450,
    });
    await bob.repository.saveTransaction({
      kind: 'income',
      title: 'Invoice',
      localDate: TODAY,
      accountId: bob.state.accounts[0].id,
      amountMinor: 250_000,
    });

    await sync(devices, 4);

    const converged = expectConverged(devices);
    expect(converged.accounts.map((row) => (row as { name: string }).name).sort()).toEqual([
      'Laptop current',
      'Phone current',
    ]);
    expect(
      converged.transactions.map((row) => (row as { title: string }).title).sort(),
    ).toEqual(['Coffee', 'Invoice']);
    // Onboarding is monotone-true. A device merging in a peer's older settings row must never
    // be sent back through the first-run flow with its data already on disk.
    expect(alice.state.settings.onboardingComplete).toBe(true);
    expect(bob.state.settings.onboardingComplete).toBe(true);
    expect(alice.state.settings.baseCurrency).toBe(BASE_CURRENCY);

    for (const device of devices) {
      for (const account of device.state.accounts) {
        await expect(
          device.repository.saveAccount(inputOf(account), account.id),
        ).resolves.toBeDefined();
      }
      await device.repository.saveTransaction({
        kind: 'expense',
        title: 'After pairing',
        localDate: TODAY,
        accountId: device.state.accounts[0].id,
        amountMinor: 99,
      });
      expect(device.errors).toEqual([]);
    }

    await sync(devices, 3);
    expect(expectConverged(devices).transactions).toHaveLength(4);
  });
});
