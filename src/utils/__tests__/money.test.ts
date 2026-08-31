import {
  convertMinor,
  formatMoney,
  localizeDecimalString,
  minorToDecimalString,
  minorToLocalizedDecimalString,
  normalizeDecimalString,
  parseInvariantMoney,
  parseMoney,
} from '@/utils/money';

describe('money utilities', () => {
  it('round-trips regular and zero-decimal currencies', () => {
    expect(parseMoney('12.34', 'USD')).toBe(1234);
    expect(parseMoney('1200', 'JPY')).toBe(1200);
    expect(minorToDecimalString(1234, 'USD')).toBe('12.34');
  });

  it('converts using decimal rates and rounds at the destination currency', () => {
    expect(convertMinor(1000, 'EUR', 'USD', '1.125')).toBe(1125);
  });

  it('formats signed currency values', () => {
    expect(formatMoney(1250, 'USD', 'en-US', { sign: true })).toContain('+');
  });

  it('formats large and zero-decimal amounts exactly', () => {
    expect(formatMoney(900719925474099, 'USD')).toContain('9,007,199,254,740.99');
    expect(formatMoney(Number.MAX_SAFE_INTEGER, 'USD')).toContain('90,071,992,547,409.91');
    expect(formatMoney(1200, 'JPY')).toContain('1,200');
  });

  it('parses locale decimal separators without changing magnitude', () => {
    expect(parseMoney('12,50', 'EUR', 'de-DE')).toBe(1250);
    expect(parseMoney('1.234,56', 'EUR', 'de-DE')).toBe(123456);
    expect(minorToLocalizedDecimalString(1250, 'EUR', 'de-DE')).toBe('12,50');
  });

  it('keeps CSV amounts invariant while localizing decimal form fields', () => {
    expect(parseInvariantMoney('12.50', 'EUR', 'de-DE')).toBe(1250);
    expect(localizeDecimalString('1.125', 'de-DE')).toBe('1,125');
    expect(normalizeDecimalString('1,125', 'de-DE')).toBe('1.125');
  });

  it('rejects precision that the currency cannot persist', () => {
    expect(() => parseMoney('10.999', 'USD')).toThrow('at most 2 decimal places');
    expect(() => parseInvariantMoney('10.999', 'USD')).toThrow('at most 2 decimal places');
  });

  it('rejects malformed amounts', () => {
    expect(() => parseMoney('12,3,4', 'EUR', 'de-DE')).toThrow('valid amount');
  });
});
