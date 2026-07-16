import { Decimal } from 'decimal.js';

import type { CurrencyCode } from '@/domain/models';

const SUPPORTED_CURRENCIES = new Set(
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG XDR XOF XPF XSU YER ZAR ZMW ZWG ZWL'.split(' '),
);

function localeNumberParts(locale: string) {
  const formatter = new Intl.NumberFormat(locale);
  const parts = formatter.formatToParts(-12345.6);
  const plusParts = new Intl.NumberFormat(locale, { signDisplay: 'always' }).formatToParts(1);
  return {
    decimalSymbol: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    groupSymbol: parts.find((part) => part.type === 'group')?.value ?? ',',
    minusSymbol: parts.find((part) => part.type === 'minusSign')?.value ?? '-',
    plusSymbol: plusParts.find((part) => part.type === 'plusSign')?.value ?? '+',
    digits: new Map(
      Array.from({ length: 10 }, (_, digit) => [
        new Intl.NumberFormat(locale, { useGrouping: false }).format(digit),
        String(digit),
      ]),
    ),
  };
}

function normalizeNumberInput(value: string, locale: string, currency?: CurrencyCode) {
  const { decimalSymbol, groupSymbol, minusSymbol, plusSymbol, digits } = localeNumberParts(locale);
  let normalized = value.trim();
  digits.forEach((ascii, localized) => {
    normalized = normalized.split(localized).join(ascii);
  });
  normalized = normalized
    .replace(/[\p{Sc}\s\u200E\u200F\u061C]/gu, '')
    .replace(currency ? new RegExp(currency, 'gi') : /$^/, '')
    .split(groupSymbol).join('')
    .split(decimalSymbol).join('.')
    .split(minusSymbol).join('-')
    .split(plusSymbol).join('+');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    throw new Error('Enter a valid number.');
  }
  return normalized;
}

function minorFromDecimal(decimal: Decimal, currency: CurrencyCode, locale: string) {
  const digits = currencyDigits(currency, locale);
  if (decimal.decimalPlaces() > digits) {
    throw new Error(`Amount can have at most ${digits} decimal places.`);
  }
  const minor = decimal.mul(new Decimal(10).pow(digits)).toNumber();
  if (!isSafeMinor(minor)) throw new Error('Amount is outside the supported range.');
  return minor;
}

function localizeAsciiDigits(value: string, locale: string) {
  const formatter = new Intl.NumberFormat(locale, { useGrouping: false });
  return Array.from(value, (character) =>
    /\d/.test(character) ? formatter.format(Number(character)) : character,
  ).join('');
}

export function isSupportedCurrencyCode(value: string) {
  return SUPPORTED_CURRENCIES.has(value.trim().toUpperCase());
}

export function currencyDigits(currency: CurrencyCode, locale = 'en-US') {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    throw new Error(`Unsupported currency or locale: ${currency} (${locale}).`);
  }
}

export function parseMoney(value: string, currency: CurrencyCode, locale = 'en-US') {
  try {
    return minorFromDecimal(
      new Decimal(normalizeNumberInput(value, locale, currency)),
      currency,
      locale,
    );
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith('Amount ')) throw reason;
    throw new Error('Enter a valid amount.');
  }
}

export function parseInvariantMoney(value: string, currency: CurrencyCode, locale = 'en-US') {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    throw new Error('Enter a valid amount.');
  }
  try {
    return minorFromDecimal(new Decimal(value.trim()), currency, locale);
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith('Amount ')) throw reason;
    throw new Error('Enter a valid amount.');
  }
}

export function normalizeDecimalString(value: string, locale = 'en-US') {
  try {
    const decimal = new Decimal(normalizeNumberInput(value, locale));
    if (!decimal.isFinite()) throw new Error();
    return decimal.toString();
  } catch {
    throw new Error('Enter a valid number.');
  }
}

export function localizeDecimalString(value: string, locale = 'en-US') {
  const { decimalSymbol, minusSymbol } = localeNumberParts(locale);
  const fixed = new Decimal(value).toFixed();
  const negative = fixed.startsWith('-');
  const unsigned = negative ? fixed.slice(1) : fixed;
  const localized = localizeAsciiDigits(unsigned.replace('.', decimalSymbol), locale);
  return negative ? `${minusSymbol}${localized}` : localized;
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
  if (!isSafeMinor(minor)) throw new Error('Amount is outside the supported range.');
  if (!options?.compact) {
    const fixed = minorToDecimalString(Math.abs(minor), currency, locale);
    const [integer, fraction = ''] = fixed.split('.');
    const numberParts = new Intl.NumberFormat(locale, {
      useGrouping: true,
      maximumFractionDigits: 0,
    }).formatToParts(Number(integer));
    const sample = minor < 0 ? -1 : minor > 0 ? 1 : 0;
    const pattern = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      signDisplay: options?.sign ? 'exceptZero' : 'auto',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).formatToParts(sample);
    let insertedInteger = false;
    return pattern.map((part) => {
      if (part.type === 'integer' || part.type === 'group') {
        if (insertedInteger) return '';
        insertedInteger = true;
        return numberParts
          .filter((numberPart) => numberPart.type === 'integer' || numberPart.type === 'group')
          .map((numberPart) => numberPart.value)
          .join('');
      }
      if (part.type === 'fraction') return localizeAsciiDigits(fraction, locale);
      return part.value;
    }).join('');
  }
  const value = new Decimal(minor).div(new Decimal(10).pow(digits)).toNumber();
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    notation: 'compact',
    signDisplay: options?.sign ? 'exceptZero' : 'auto',
    maximumFractionDigits: 1,
  }).format(value);
}

export function minorToDecimalString(minor: number, currency: CurrencyCode, locale = 'en-US') {
  const digits = currencyDigits(currency, locale);
  return new Decimal(minor).div(new Decimal(10).pow(digits)).toFixed(digits);
}

export function minorToLocalizedDecimalString(
  minor: number,
  currency: CurrencyCode,
  locale = 'en-US',
) {
  const { decimalSymbol, minusSymbol } = localeNumberParts(locale);
  const fixed = minorToDecimalString(minor, currency, locale);
  const negative = fixed.startsWith('-');
  const unsigned = negative ? fixed.slice(1) : fixed;
  const localized = localizeAsciiDigits(unsigned.replace('.', decimalSymbol), locale);
  return negative ? `${minusSymbol}${localized}` : localized;
}

export function isSafeMinor(value: number) {
  return Number.isSafeInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

export function addMinor(first: number, second: number, label = 'Amount') {
  if (!isSafeMinor(first) || !isSafeMinor(second)) {
    throw new Error(`${label} is outside the supported range.`);
  }
  const result = first + second;
  if (!isSafeMinor(result)) throw new Error(`${label} is outside the supported range.`);
  return result;
}

export function subtractMinor(first: number, second: number, label = 'Amount') {
  return addMinor(first, -second, label);
}

export function sumMinor(values: Iterable<number>, label = 'Amount') {
  let total = 0;
  for (const value of values) total = addMinor(total, value, label);
  return total;
}
