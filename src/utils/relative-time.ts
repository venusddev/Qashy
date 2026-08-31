/**
 * "When did that happen", in words, without a locale table.
 *
 * Sync is the first part of Qashy where a timestamp is the answer to a question the user is
 * actually asking — *is my laptop stuck, or did it just sync?* — and an ISO instant is a poor
 * answer to it. `Intl.RelativeTimeFormat` would be the obvious tool and is deliberately not
 * used: the app translates through a fixed dictionary in `localization.tsx`, so a string this
 * module invents in the platform's own idea of the locale would arrive at `translateDynamic`
 * as an unrecognised pattern and pass through untranslated. A small closed set of English
 * shapes is worth more here than a large open set of correct ones.
 *
 * Every output is therefore one of a handful of patterns, each with a matching regex entry in
 * the Hebrew dictionary, and each is built as **one** string rather than assembled from
 * fragments in JSX — a split string is untranslatable and, under RTL, reorders wrongly.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Past this, the exact count stops being informative and the shape changes. */
const DAYS_BEFORE_MONTHS = 30;
const MONTHS_BEFORE_YEARS = 12;

/** A month, for the purpose of "about two months ago". Not a calendar month, and need not be. */
const MONTH = DAYS_BEFORE_MONTHS * DAY;

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? '' : 's'} ago`;

/**
 * A past instant, described relative to now.
 *
 * `''` for a blank or unparseable input, which is the honest rendering of "this has never
 * happened" — a device that has never synced has no last-synced time, and "just now" would be
 * a confident lie about the one thing the user is trying to find out.
 *
 * A timestamp in the *future* reads as "just now" rather than being reported as such. Peers
 * carry their own clocks and a few seconds of skew is ordinary; the sync engine already
 * quarantines the genuinely wrong ones (§2.6), and this is a status line, not a detector.
 */
export function relativeTime(iso: string, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';

  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour');

  const days = Math.floor(elapsed / DAY);
  if (days < DAYS_BEFORE_MONTHS) return plural(days, 'day');

  const months = Math.floor(elapsed / MONTH);
  if (months < MONTHS_BEFORE_YEARS) return plural(months, 'month');
  return 'over a year ago';
}
