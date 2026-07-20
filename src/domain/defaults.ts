import { getLocales } from 'expo-localization';

import type { AppSettings, Category, FinanceState } from '@/domain/models';
import { createEntity, makeId } from '@/utils/entity';
import { validateLocale } from '@/utils/form-validation';
import { isSupportedCurrencyCode } from '@/utils/money';

export const QASHY_ACCENT = '#5966E9';

export function initialLocalePreferences(
  saved?: Pick<AppSettings, 'locale' | 'baseCurrency'>,
) {
  const deviceLocale = getLocales()[0];
  const detectedLocale = validateLocale(deviceLocale?.languageTag ?? '')
    ? 'en-US'
    : deviceLocale.languageTag;
  const detectedCurrency = deviceLocale?.currencyCode?.toUpperCase() ?? '';
  const fallbackCurrency = isSupportedCurrencyCode(detectedCurrency) ? detectedCurrency : 'USD';
  const savedLocale = saved?.locale.trim() ?? '';
  const savedCurrency = saved?.baseCurrency.trim().toUpperCase() ?? '';
  return {
    locale: validateLocale(savedLocale) ? detectedLocale : savedLocale,
    baseCurrency: isSupportedCurrencyCode(savedCurrency) ? savedCurrency : fallbackCurrency,
  };
}

export const initialSettings = (): AppSettings => {
  const { locale, baseCurrency } = initialLocalePreferences();
  return createEntity({
    id: 'settings',
    onboardingComplete: false,
    locale,
    baseCurrency,
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
  const firstTimestamp = Date.now() - CATEGORY_SEEDS.length;
  return CATEGORY_SEEDS.map(([name, icon, color, kind], index) => {
    const entity = createEntity({
      id: makeId(),
      name,
      icon,
      color,
      kind,
      parentId: null,
      archived: false,
    });
    const timestamp = new Date(firstTimestamp + index).toISOString();
    return { ...entity, createdAt: timestamp, updatedAt: timestamp };
  });
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
