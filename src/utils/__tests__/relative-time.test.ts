import { relativeTime } from '@/utils/relative-time';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('reports nothing for a time that never happened', () => {
    // The distinction that matters: a device that has never synced must not read "just now".
    expect(relativeTime('', NOW)).toBe('');
    expect(relativeTime('not a date', NOW)).toBe('');
  });

  it('collapses the last minute to "just now"', () => {
    expect(relativeTime(ago(0), NOW)).toBe('just now');
    expect(relativeTime(ago(59 * 1000), NOW)).toBe('just now');
  });

  it('counts minutes, hours, and days with correct plurals', () => {
    expect(relativeTime(ago(MINUTE), NOW)).toBe('1 minute ago');
    expect(relativeTime(ago(4 * MINUTE), NOW)).toBe('4 minutes ago');
    expect(relativeTime(ago(HOUR), NOW)).toBe('1 hour ago');
    expect(relativeTime(ago(5 * HOUR + 59 * MINUTE), NOW)).toBe('5 hours ago');
    expect(relativeTime(ago(DAY), NOW)).toBe('1 day ago');
    expect(relativeTime(ago(29 * DAY), NOW)).toBe('29 days ago');
  });

  it('switches to months and then gives up counting', () => {
    expect(relativeTime(ago(30 * DAY), NOW)).toBe('1 month ago');
    expect(relativeTime(ago(200 * DAY), NOW)).toBe('6 months ago');
    expect(relativeTime(ago(400 * DAY), NOW)).toBe('over a year ago');
  });

  it('treats a future timestamp as now rather than reporting the skew', () => {
    // A peer a few seconds ahead is ordinary. Reporting "in 4 seconds" on a status row would
    // draw attention to something the engine already handles and the user cannot act on.
    expect(relativeTime(new Date(NOW + 4 * HOUR).toISOString(), NOW)).toBe('just now');
  });
});
