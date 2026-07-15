import { addRecurrence } from '@/utils/date';
import { resolvePeriod } from '@/utils/period';

describe('calendar behavior', () => {
  it('clamps month-end recurrence without skipping February', () => {
    expect(addRecurrence('2028-01-31', 'month', 1)).toBe('2028-02-29');
    expect(addRecurrence('2027-01-31', 'month', 1)).toBe('2027-02-28');
  });

  it('resolves anchored multi-month budget periods', () => {
    expect(resolvePeriod({ unit: 'month', interval: 3, anchorDate: '2026-01-01', endDate: null }, '2026-05-15')).toEqual({
      start: '2026-04-01',
      end: '2026-06-30',
    });
  });
});
