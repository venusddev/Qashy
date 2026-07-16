import {
  validateCurrencyCode,
  validateDateInput,
  validateMoneyInput,
  validatePositiveDecimal,
  validatePositiveInteger,
} from '@/utils/form-validation';

describe('form validation', () => {
  it('matches positive and non-negative money rules', () => {
    expect(validateMoneyInput('0', 'USD', 'en-US', { label: 'Limit', positive: true })).toContain('greater than zero');
    expect(validateMoneyInput('-1', 'USD', 'en-US', { label: 'Progress', nonNegative: true })).toContain('cannot be negative');
    expect(validateMoneyInput('-1', 'USD', 'en-US', { label: 'Opening balance' })).toBeUndefined();
  });

  it('allows optional blank values but validates populated values', () => {
    expect(validatePositiveDecimal('', 'Rate', true)).toBeUndefined();
    expect(validatePositiveDecimal('-2', 'Rate', true)).toContain('greater than zero');
    expect(validateDateInput('', { optional: true })).toBeUndefined();
    expect(validateDateInput('2026-02-30', { optional: true })).toContain('real date');
    expect(validatePositiveDecimal('1,25', 'Rate', false, 'de-DE')).toBeUndefined();
  });

  it('validates supported currencies and positive whole intervals', () => {
    expect(validateCurrencyCode('USD', 'en-US')).toBeUndefined();
    expect(validateCurrencyCode('ZZZ', 'en-US')).toContain('ISO 4217');
    expect(validateCurrencyCode('US', 'en-US')).toContain('three-letter');
    expect(validatePositiveInteger('2', 'Interval')).toBeUndefined();
    expect(validatePositiveInteger('1.5', 'Interval')).toContain('whole number');
  });
});
