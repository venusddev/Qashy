/**
 * Fixtures for the op-log tests.
 *
 * Not a `.test.ts` file, so Jest's `testMatch` leaves it alone and it is importable from
 * every suite in this directory.
 *
 * Everything here is deliberately explicit rather than generated: an entity factory that
 * quietly filled in a default would let a merge test pass while the field it was supposed to
 * exercise was never actually set.
 */

import type {
  Account,
  AppSettings,
  Budget,
  BudgetPeriodSnapshot,
  Category,
  ExchangeRate,
  Goal,
  GoalContribution,
  RecurringRule,
  Tag,
  TransactionRecord,
} from '@/domain/models';
import { formatHlc, type Hlc } from '@/sync/oplog/hlc';

/** Device ids are 26 base32 characters; these sort A < B < C, which pins every HLC tie-break. */
export const DEVICE_A = 'A'.repeat(26);
export const DEVICE_B = 'B'.repeat(26);
export const DEVICE_C = 'C'.repeat(26);

/** A readable HLC. `at(5)` is "the fifth millisecond", which is all any of these tests need. */
export const at = (wall: number, deviceId: string = DEVICE_A, counter = 0): Hlc =>
  formatHlc({ wall, counter, deviceId });

const ORIGIN = '2026-01-01T00:00:00.000Z';

const base = (id: string, createdAt = ORIGIN) => ({
  id,
  revision: 1,
  createdAt,
  updatedAt: createdAt,
  deletedAt: null,
});

/**
 * Built by hand rather than from `initialSettings()`, which reads the device locale — a
 * fixture that changes with the environment is a fixture that fails on someone else's laptop.
 */
export const settings = (over: Partial<AppSettings> = {}): AppSettings => ({
  ...base('settings'),
  onboardingComplete: true,
  locale: 'en-US',
  baseCurrency: 'USD',
  themeMode: 'system',
  accentSource: 'system',
  accentHex: '#5966E9',
  ...over,
});

export const account = (over: Partial<Account> & { id: string }): Account => ({
  ...base(over.id),
  name: 'Cash',
  type: 'cash',
  currency: 'USD',
  openingBalanceMinor: 0,
  icon: 'banknote',
  color: '#101010',
  archived: false,
  ...over,
});

export const category = (over: Partial<Category> & { id: string }): Category => ({
  ...base(over.id),
  name: 'Groceries',
  kind: 'expense',
  icon: 'cart',
  color: '#202020',
  parentId: null,
  archived: false,
  ...over,
});

export const tag = (over: Partial<Tag> & { id: string }): Tag => ({
  ...base(over.id),
  name: 'Essential',
  color: '#303030',
  ...over,
});

export const transaction = (
  over: Partial<TransactionRecord> & { id: string },
): TransactionRecord => ({
  ...base(over.id),
  kind: 'expense',
  status: 'posted',
  title: 'Coffee',
  note: '',
  localDate: '2026-01-01',
  accountId: 'acc-1',
  destinationAccountId: null,
  categoryId: null,
  tagIds: [],
  amountMinor: 1000,
  destinationAmountMinor: null,
  destinationBaseAmountMinor: null,
  currency: 'USD',
  destinationCurrency: null,
  exchangeRate: '1',
  baseAmountMinor: 1000,
  transferGroupId: null,
  recurringRuleId: null,
  occurrenceKey: null,
  ...over,
});

export const budget = (over: Partial<Budget> & { id: string }): Budget => ({
  ...base(over.id),
  name: 'Monthly',
  icon: 'chart.pie',
  color: '#404040',
  limitMinor: 100_000,
  period: { unit: 'month', interval: 1, anchorDate: '2026-01-01', endDate: null },
  rollover: false,
  filters: { accountIds: [], categoryIds: [], tagIds: [] },
  categoryLimits: [],
  archived: false,
  ...over,
});

export const budgetPeriod = (
  over: Partial<BudgetPeriodSnapshot> & { id: string },
): BudgetPeriodSnapshot => ({
  ...base(over.id),
  budgetId: 'bud-1',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  limitMinor: 100_000,
  rolloverMinor: 0,
  filters: { accountIds: [], categoryIds: [], tagIds: [] },
  categoryLimits: [],
  ...over,
});

export const goal = (over: Partial<Goal> & { id: string }): Goal => ({
  ...base(over.id),
  name: 'Emergency fund',
  kind: 'saving',
  icon: 'flag',
  color: '#505050',
  targetMinor: 500_000,
  initialMinor: 0,
  targetDate: null,
  linkedAccountId: null,
  linkedCategoryId: null,
  archived: false,
  ...over,
});

export const contribution = (
  over: Partial<GoalContribution> & { id: string },
): GoalContribution => ({
  ...base(over.id),
  goalId: 'goal-1',
  amountMinor: 5_000,
  localDate: '2026-01-01',
  transactionId: null,
  note: '',
  ...over,
});

export const recurringRule = (over: Partial<RecurringRule> & { id: string }): RecurringRule => ({
  ...base(over.id),
  template: {
    kind: 'expense',
    title: 'Rent',
    note: '',
    accountId: 'acc-1',
    categoryId: null,
    tagIds: [],
    amountMinor: 150_000,
    currency: 'USD',
  },
  unit: 'month',
  interval: 1,
  startDate: '2026-01-01',
  endDate: null,
  nextDueDate: '2026-02-01',
  autoPost: true,
  active: true,
  pausedByDependency: false,
  ...over,
});

export const exchangeRate = (over: Partial<ExchangeRate> & { id: string }): ExchangeRate => ({
  ...base(over.id),
  fromCurrency: 'USD',
  toCurrency: 'ILS',
  rate: '3.7',
  effectiveDate: '2026-01-01',
  ...over,
});

/**
 * A seeded generator, because the property tests need a *reproducible* shuffle.
 *
 * `Math.random()` would make a failure something you see once and never again — which for a
 * convergence bug is the difference between a fix and a shrug.
 */
export function seededRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32 — not for cryptography, and it is not used for any.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/** Every ordering of `items`, for exhaustively proving commutativity on small op sets. */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}
