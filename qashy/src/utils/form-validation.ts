import { Decimal } from 'decimal.js';

import { isLocalDate } from '@/utils/date';
import { currencyDigits, parseMoney } from '@/utils/money';

export function validateCurrencyCode(value: string, locale: string) {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return 'Use a three-letter currency code such as USD.';
  try {
    currencyDigits(currency, locale);
    return undefined;
  } catch {
    return 'Use a currency supported by this device.';
  }
}

export function validateMoneyInput(
  value: string,
  currency: string,
  locale: string,
  options: {
    label?: string;
    optional?: boolean;
    positive?: boolean;
    nonNegative?: boolean;
  } = {},
) {
  const label = options.label ?? 'Amount';
  if (!value.trim()) return options.optional ? undefined : `${label} is required.`;
  try {
    const minor = parseMoney(value, currency, locale);
    if (options.positive && minor <= 0) return `${label} must be greater than zero.`;
    if (options.nonNegative && minor < 0) return `${label} cannot be negative.`;
    return undefined;
  } catch {
    return `Enter a valid ${label.toLocaleLowerCase()}.`;
  }
}

export function validateDateInput(
  value: string,
  options: { label?: string; optional?: boolean } = {},
) {
  const label = options.label ?? 'Date';
  if (!value.trim()) return options.optional ? undefined : `${label} is required.`;
  return isLocalDate(value) ? undefined : `Use a real ${label.toLocaleLowerCase()} in YYYY-MM-DD format.`;
}

export function validatePositiveDecimal(value: string, label = 'Value', optional = false) {
  if (!value.trim()) return optional ? undefined : `${label} is required.`;
  try {
    const decimal = new Decimal(value.trim());
    return decimal.isFinite() && decimal.isPositive()
      ? undefined
      : `${label} must be greater than zero.`;
  } catch {
    return `Enter a valid ${label.toLocaleLowerCase()}.`;
  }
}

export function validatePositiveInteger(value: string, label = 'Value') {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    return `${label} must be a positive whole number.`;
  }
  return undefined;
}
