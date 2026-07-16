export function todayLocal() {
  const date = new Date();
  return toLocalDate(date);
}

export function toLocalDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

export function startOfMonth(value = todayLocal()) {
  const date = parseLocalDate(value);
  date.setDate(1);
  return toLocalDate(date);
}

export function endOfMonth(value = todayLocal()) {
  const date = parseLocalDate(value);
  date.setMonth(date.getMonth() + 1, 0);
  return toLocalDate(date);
}

export function isLocalDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year] = value.split('-').map(Number);
  return year >= 1000 && toLocalDate(parseLocalDate(value)) === value;
}

export function addRecurrence(
  value: string,
  unit: 'day' | 'week' | 'month' | 'year',
  interval: number,
  anchorValue = value,
) {
  const date = parseLocalDate(value);
  const anchor = parseLocalDate(anchorValue);
  const anchorDay = anchor.getDate();
  const anchorMonth = anchor.getMonth();
  // Day 31 is the explicit month-end convention. A schedule that happens to
  // start on February 28 or April 30 should keep that numbered day later.
  const anchorWasMonthEnd = anchorDay === 31;
  if (unit === 'day') date.setDate(date.getDate() + interval);
  if (unit === 'week') date.setDate(date.getDate() + interval * 7);
  if (unit === 'month') {
    date.setDate(1);
    date.setMonth(date.getMonth() + interval);
    const maxDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(anchorWasMonthEnd ? maxDay : Math.min(anchorDay, maxDay));
  }
  if (unit === 'year') {
    date.setFullYear(date.getFullYear() + interval, anchorMonth, 1);
    const maxDay = new Date(date.getFullYear(), anchorMonth + 1, 0).getDate();
    date.setDate(anchorWasMonthEnd ? maxDay : Math.min(anchorDay, maxDay));
  }
  return toLocalDate(date);
}

export function firstRecurrenceOnOrAfter(
  startValue: string,
  unit: 'day' | 'week' | 'month' | 'year',
  interval: number,
  minimumValue: string,
) {
  if (startValue >= minimumValue) return startValue;
  const start = parseLocalDate(startValue);
  const minimum = parseLocalDate(minimumValue);
  const normalizedInterval = Math.max(1, Math.floor(interval));
  let cycles = 0;
  if (unit === 'day' || unit === 'week') {
    const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const minimumUtc = Date.UTC(minimum.getFullYear(), minimum.getMonth(), minimum.getDate());
    const stepDays = normalizedInterval * (unit === 'week' ? 7 : 1);
    cycles = Math.ceil((minimumUtc - startUtc) / 86_400_000 / stepDays);
  } else if (unit === 'month') {
    const months = (minimum.getFullYear() - start.getFullYear()) * 12 +
      minimum.getMonth() - start.getMonth();
    cycles = Math.max(0, Math.floor(months / normalizedInterval));
  } else {
    cycles = Math.max(0, Math.floor(
      (minimum.getFullYear() - start.getFullYear()) / normalizedInterval,
    ));
  }
  let candidate = addRecurrence(
    startValue,
    unit,
    Math.max(0, cycles) * normalizedInterval,
    startValue,
  );
  if (candidate < minimumValue) {
    candidate = addRecurrence(candidate, unit, normalizedInterval, startValue);
  }
  return candidate;
}

export function monthLabel(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    parseLocalDate(value),
  );
}

export function shortDate(value: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
    parseLocalDate(value),
  );
}
