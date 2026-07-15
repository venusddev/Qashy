import { Decimal } from 'decimal.js';

import type { CurrencyCode } from '@/domain/models';

export function currencyDigits(currency: CurrencyCode, locale = 'en-US') {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits ?? 2;
}

export function parseMoney(value: string, currency: CurrencyCode, locale = 'en-US') {
  const normalized = value.replace(/[^0-9.-]/g, '');
  const decimal = new Decimal(normalized || 0);
  return decimal.mul(new Decimal(10).pow(currencyDigits(currency, locale))).toDecimalPlaces(0).toNumber();
}

export function convertMinor(
  amountMinor: number,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rate: string,
  locale = 'en-US',
) {
  if (fromCurrency === toCurrency) return amountMinor;
  const fromScale = new Decimal(10).pow(currencyDigits(fromCurrency, locale));
  const toScale = new Decimal(10).pow(currencyDigits(toCurrency, locale));
  return new Decimal(amountMinor).div(fromScale).mul(rate).mul(toScale).toDecimalPlaces(0).toNumber();
}

export function formatMoney(
  minor: number,
  currency: CurrencyCode,
  locale = 'en-US',
  options?: { compact?: boolean; sign?: boolean },
) {
  const digits = currencyDigits(currency, locale);
  const value = minor / 10 ** digits;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: options?.compact ? 'compact' : 'standard',
    signDisplay: options?.sign ? 'exceptZero' : 'auto',
    maximumFractionDigits: options?.compact ? 1 : digits,
  }).format(value);
}

export function minorToDecimalString(minor: number, currency: CurrencyCode, locale = 'en-US') {
  const digits = currencyDigits(currency, locale);
  return new Decimal(minor).div(new Decimal(10).pow(digits)).toFixed(digits);
}

export function isSafeMinor(value: number) {
  return Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}
