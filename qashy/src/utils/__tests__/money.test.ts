import { convertMinor, formatMoney, minorToDecimalString, parseMoney } from '@/utils/money';

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

  it('parses locale decimal separators without changing magnitude', () => {
    expect(parseMoney('12,50', 'EUR', 'de-DE')).toBe(1250);
    expect(parseMoney('1.234,56', 'EUR', 'de-DE')).toBe(123456);
  });

  it('rejects malformed amounts', () => {
    expect(() => parseMoney('12,3,4', 'EUR', 'de-DE')).toThrow('valid amount');
  });
});
