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

export function addRecurrence(value: string, unit: 'day' | 'week' | 'month' | 'year', interval: number) {
  const date = parseLocalDate(value);
  const originalDay = date.getDate();
  const originalWasMonthEnd = originalDay === new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  if (unit === 'day') date.setDate(date.getDate() + interval);
  if (unit === 'week') date.setDate(date.getDate() + interval * 7);
  if (unit === 'month') {
    date.setDate(1);
    date.setMonth(date.getMonth() + interval);
    const maxDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    date.setDate(originalWasMonthEnd ? maxDay : Math.min(originalDay, maxDay));
  }
  if (unit === 'year') {
    const month = date.getMonth();
    date.setFullYear(date.getFullYear() + interval, month, 1);
    const maxDay = new Date(date.getFullYear(), month + 1, 0).getDate();
    date.setDate(originalWasMonthEnd ? maxDay : Math.min(originalDay, maxDay));
  }
  return toLocalDate(date);
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
