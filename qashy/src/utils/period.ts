import type { PeriodDefinition } from '@/domain/models';
import { parseLocalDate, toLocalDate } from '@/utils/date';

const DAY_MS = 86_400_000;

function wholeDays(from: Date, to: Date) {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.floor((b - a) / DAY_MS);
}

export function resolvePeriod(period: PeriodDefinition, onDate: string) {
  const anchor = parseLocalDate(period.anchorDate);
  const target = parseLocalDate(onDate);
  const interval = Math.max(1, period.interval);
  let start = new Date(anchor);
  let end = new Date(anchor);

  if (period.unit === 'custom') {
    return { start: period.anchorDate, end: period.endDate ?? period.anchorDate };
  }

  if (period.unit === 'day' || period.unit === 'week') {
    const cycleDays = interval * (period.unit === 'week' ? 7 : 1);
    const cycles = Math.floor(wholeDays(anchor, target) / cycleDays);
    start.setDate(anchor.getDate() + cycles * cycleDays);
    end = new Date(start);
    end.setDate(start.getDate() + cycleDays - 1);
  }

  // Month and year periods intentionally snap to calendar boundaries (day 1 /
  // Jan 1) instead of honoring the anchor's day-of-month: the budget form
  // always anchors "today", and persisted budgetPeriod snapshots are looked up
  // by exact periodStart, so shifting boundaries would orphan existing data.
  if (period.unit === 'month') {
    const months =
      (target.getFullYear() - anchor.getFullYear()) * 12 + target.getMonth() - anchor.getMonth();
    const cycles = Math.floor(months / interval);
    start = new Date(anchor.getFullYear(), anchor.getMonth() + cycles * interval, 1, 12);
    end = new Date(start.getFullYear(), start.getMonth() + interval, 0, 12);
  }

  if (period.unit === 'year') {
    const cycles = Math.floor((target.getFullYear() - anchor.getFullYear()) / interval);
    start = new Date(anchor.getFullYear() + cycles * interval, 0, 1, 12);
    end = new Date(start.getFullYear() + interval - 1, 11, 31, 12);
  }

  return { start: toLocalDate(start), end: toLocalDate(end) };
}

export function previousPeriod(period: PeriodDefinition, currentStart: string) {
  const previous = parseLocalDate(currentStart);
  if (period.unit === 'day') previous.setDate(previous.getDate() - period.interval);
  if (period.unit === 'week') previous.setDate(previous.getDate() - period.interval * 7);
  if (period.unit === 'month') previous.setMonth(previous.getMonth() - period.interval);
  if (period.unit === 'year') previous.setFullYear(previous.getFullYear() - period.interval);
  if (period.unit === 'custom') return null;
  return resolvePeriod(period, toLocalDate(previous));
}
