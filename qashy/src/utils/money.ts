import { Decimal } from 'decimal.js';

import type { CurrencyCode } from '@/domain/models';

export function currencyDigits(currency: CurrencyCode, locale = 'en-US') {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    throw new Error(`Unsupported currency or locale: ${currency} (${locale}).`);
  }
}

export function parseMoney(value: string, currency: CurrencyCode, locale = 'en-US') {
  const formatter = new Intl.NumberFormat(locale);
  const parts = formatter.formatToParts(-12345.6);
  const decimalSymbol = parts.find((part) => part.type === 'decimal')?.value ?? '.';
  const groupSymbol = parts.find((part) => part.type === 'group')?.value ?? ',';
  const minusSymbol = parts.find((part) => part.type === 'minusSign')?.value ?? '-';
  const digits = new Map(
    Array.from({ length: 10 }, (_, digit) => [
      new Intl.NumberFormat(locale, { useGrouping: false }).format(digit),
      String(digit),
    ]),
  );
  let normalized = value.trim();
  digits.forEach((ascii, localized) => {
    normalized = normalized.split(localized).join(ascii);
  });
  normalized = normalized
    .replace(/[\p{Sc}\s\u200E\u200F\u061C]/gu, '')
    .replace(new RegExp(currency, 'gi'), '')
    .split(groupSymbol).join('')
    .split(decimalSymbol).join('.')
    .split(minusSymbol).join('-');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    throw new Error('Enter a valid amount.');
  }
  const decimal = new Decimal(normalized);
  const minor = decimal
    .mul(new Decimal(10).pow(currencyDigits(currency, locale)))
    .toDecimalPlaces(0)
    .toNumber();
  if (!isSafeMinor(minor)) throw new Error('Amount is outside the supported range.');
  return minor;
}

export function convertMinor(
  amountMinor: number,
  fromCurrency: CurrencyCode,
  toCurrency: CurrencyCode,
  rate: string,
  locale = 'en-US',
) {
  if (fromCurrency === toCurrency) return amountMinor;
  if (!isSafeMinor(amountMinor)) throw new Error('Amount is outside the supported range.');
  const decimalRate = new Decimal(rate);
  if (!decimalRate.isFinite() || !decimalRate.isPositive()) {
    throw new Error('Exchange rate must be a positive number.');
  }
  const fromScale = new Decimal(10).pow(currencyDigits(fromCurrency, locale));
  const toScale = new Decimal(10).pow(currencyDigits(toCurrency, locale));
  const converted = new Decimal(amountMinor)
    .div(fromScale)
    .mul(decimalRate)
    .mul(toScale)
    .toDecimalPlaces(0)
    .toNumber();
  if (!isSafeMinor(converted)) throw new Error('Converted amount is outside the supported range.');
  return converted;
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
