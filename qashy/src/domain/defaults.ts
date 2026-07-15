import { getLocales } from 'expo-localization';

import type { AppSettings, Category, FinanceState } from '@/domain/models';
import { createEntity, makeId } from '@/utils/entity';

export const QASHY_ACCENT = '#5966E9';

export const initialSettings = (): AppSettings => {
  const locale = getLocales()[0];
  return createEntity({
    id: 'settings',
    onboardingComplete: false,
    locale: locale?.languageTag ?? 'en-US',
    baseCurrency: locale?.currencyCode ?? 'USD',
    themeMode: 'system',
    accentSource: 'system',
    accentHex: QASHY_ACCENT,
  });
};

const CATEGORY_SEEDS = [
  ['Groceries', 'cart', '#5F9F78', 'expense'],
  ['Dining', 'fork.knife', '#E08C5A', 'expense'],
  ['Transport', 'car', '#5B8DEF', 'expense'],
  ['Home', 'house', '#8B76D8', 'expense'],
  ['Health', 'heart', '#E16B75', 'expense'],
  ['Fun', 'sparkles', '#C47ED0', 'expense'],
  ['Salary', 'banknote', '#3B9A69', 'income'],
  ['Other income', 'plus.circle', '#4C9CB5', 'income'],
] as const;

export function createDefaultCategories(): Category[] {
  return CATEGORY_SEEDS.map(([name, icon, color, kind]) =>
    createEntity({
      id: makeId(),
      name,
      icon,
      color,
      kind,
      parentId: null,
      archived: false,
    }),
  );
}

export function createInitialState(): FinanceState {
  return {
    ready: false,
    settings: initialSettings(),
    accounts: [],
    categories: [],
    tags: [],
    transactions: [],
    budgets: [],
    budgetPeriods: [],
    goals: [],
    contributions: [],
    recurringRules: [],
    exchangeRates: [],
  };
}
