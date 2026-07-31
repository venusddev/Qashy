/**
 * Hybrid Logical Clocks — the total order every device agrees on.
 *
 * Wall-clock timestamps alone cannot order concurrent edits: two phones disagree about the
 * time by seconds at best, and a device whose clock is wrong by a day would win or lose
 * every conflict for that day. A pure logical counter fixes ordering but loses the human
 * meaning — "which edit was actually later?" — that a person comparing two versions of a
 * transaction expects to hold.
 *
 * An HLC keeps both. It tracks a wall-clock reading that only ever moves forward, plus a
 * counter that breaks ties within the same millisecond, plus the originating device id as
 * the final tiebreak so that no two events anywhere can compare equal.
 *
 * The encoding is chosen so that **plain lexicographic string comparison is the causal
 * order**. Every field is fixed-width and hex, and the device id is a fixed 26 characters
 * (see `DEVICE_ID_LENGTH`), so `a < b` as strings means exactly `a` precedes `b`. That is
 * what lets SQLite and IndexedDB sort the op log with an ordinary index and no custom
 * collation, and it is why the format is pinned by tests.
 */

import { DEVICE_ID_LENGTH } from '@/sync/crypto';

/** `${wall}-${counter}-${deviceId}`, fixed width, lexicographically ordered. */
export type Hlc = string;

const WALL_DIGITS = 12;
const COUNTER_DIGITS = 4;

/** 2^48 ms past the epoch — the year 10889. Twelve hex digits is not a limit anyone meets. */
export const MAX_WALL_MS = 0xffffffffffff;

/** Ticks available inside one millisecond before the clock borrows from the next one. */
export const MAX_COUNTER = 0xffff;

export const HLC_LENGTH = WALL_DIGITS + 1 + COUNTER_DIGITS + 1 + DEVICE_ID_LENGTH;

/**
 * How far ahead of local time a peer's clock may be before its ops are treated as suspect.
 *
 * This bounds only how far a *remote* reading may drag the *local* clock forward. The
 * incoming HLC is still used verbatim for ordering — clamping it would make two devices
 * sort the same two ops differently, which is a permanent divergence rather than a
 * temporary annoyance. See `observe`.
 */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** The persisted half of a clock: `hlcWall` and `hlcCounter` in `sync_meta`. */
export interface HlcClock {
  readonly wall: number;
  readonly counter: number;
}

export interface HlcParts {
  readonly wall: number;
  readonly counter: number;
  readonly deviceId: string;
}

export class HlcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlcError';
  }
}

const HLC_PATTERN = new RegExp(
  `^[0-9a-f]{${WALL_DIGITS}}-[0-9a-f]{${COUNTER_DIGITS}}-[0-9A-Z]{${DEVICE_ID_LENGTH}}$`,
);

export const ZERO_CLOCK: HlcClock = { wall: 0, counter: 0 };

export function formatHlc(parts: HlcParts): Hlc {
  const { wall, counter, deviceId } = parts;
  if (!Number.isSafeInteger(wall) || wall < 0 || wall > MAX_WALL_MS) {
    throw new HlcError(`Clock reading ${wall} is out of range.`);
  }
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > MAX_COUNTER) {
    throw new HlcError(`Clock counter ${counter} is out of range.`);
  }
  if (deviceId.length !== DEVICE_ID_LENGTH) {
    throw new HlcError(`Device id must be ${DEVICE_ID_LENGTH} characters.`);
  }
  const hlc = `${wall.toString(16).padStart(WALL_DIGITS, '0')}-${counter
    .toString(16)
    .padStart(COUNTER_DIGITS, '0')}-${deviceId}`;
  // Cheap, and it catches a device id carrying characters outside the base32 alphabet
  // before that id reaches the wire and starts sorting unpredictably against the others.
  if (!HLC_PATTERN.test(hlc)) throw new HlcError('Device id is not a valid identifier.');
  return hlc;
}

export function isHlc(value: unknown): value is Hlc {
  return typeof value === 'string' && HLC_PATTERN.test(value);
}

export function parseHlc(hlc: Hlc): HlcParts {
  if (!isHlc(hlc)) throw new HlcError('Not a valid clock reading.');
  return {
    wall: Number.parseInt(hlc.slice(0, WALL_DIGITS), 16),
    counter: Number.parseInt(hlc.slice(WALL_DIGITS + 1, WALL_DIGITS + 1 + COUNTER_DIGITS), 16),
    deviceId: hlc.slice(WALL_DIGITS + COUNTER_DIGITS + 2),
  };
}

/**
 * The causal order. Plain string comparison, stated as a function so call sites read as
 * intent rather than as an incidental `<` that someone later "optimises" into a numeric
 * compare on the wall clock and quietly drops the tiebreaks.
 */
export function compareHlc(first: Hlc, second: Hlc): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

export const maxHlc = (first: Hlc, second: Hlc): Hlc => (first >= second ? first : second);

/** The wall-clock component as an ISO string, for `updatedAt`. */
export function hlcToIso(hlc: Hlc): string {
  return new Date(parseHlc(hlc).wall).toISOString();
}

export interface HlcTick {
  readonly clock: HlcClock;
  readonly hlc: Hlc;
}

/**
 * Stamps a locally-originated event.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so that every function in this
 * directory stays pure and the property tests can drive time directly.
 */
export function tick(clock: HlcClock, deviceId: string, nowMs: number): HlcTick {
  const wall = Math.max(clock.wall, Math.floor(nowMs));
  const next =
    wall === clock.wall
      ? // Same millisecond, so the counter is what orders these two. Exhausting it borrows
        // a millisecond from the future rather than reusing a reading: two events with the
        // same HLC from the same device would be indistinguishable, and the chain would
        // have no defined order for them.
        clock.counter >= MAX_COUNTER
        ? { wall: wall + 1, counter: 0 }
        : { wall, counter: clock.counter + 1 }
      : { wall, counter: 0 };
  return { clock: next, hlc: formatHlc({ ...next, deviceId }) };
}

export interface HlcObservation {
  readonly clock: HlcClock;
  /** True when the incoming reading was too far ahead to adopt. See `MAX_CLOCK_SKEW_MS`. */
  readonly skewed: boolean;
}

/**
 * Folds a received HLC into the local clock.
 *
 * The returned clock is what the *next* local event builds on, which is how causality is
 * preserved: an edit made after seeing a remote op sorts after it, whatever the two wall
 * clocks say.
 *
 * The skew guard is deliberately one-directional. A peer far in the future is refused
 * adoption — otherwise one device with a badly wrong clock drags every peer's clock with
 * it, permanently, and no later correction can pull it back. The op itself is *not*
 * rejected here; the caller quarantines it, keeps it in the log, forwards it, and
 * re-evaluates on every merge, so it heals by itself once local time catches up.
 */
export function observe(clock: HlcClock, incoming: Hlc, nowMs: number): HlcObservation {
  const remote = parseHlc(incoming);
  const local = Math.floor(nowMs);
  if (remote.wall > local + MAX_CLOCK_SKEW_MS) {
    // Still advance against the local reading, so a burst of skewed ops does not stall the
    // local clock at whatever it was when the first one arrived.
    return { clock: advanceToLocal(clock, local), skewed: true };
  }
  const wall = Math.max(clock.wall, remote.wall, local);
  if (wall === clock.wall && wall === remote.wall) {
    return { clock: advanceCounter(wall, Math.max(clock.counter, remote.counter)), skewed: false };
  }
  if (wall === clock.wall) return { clock: advanceCounter(wall, clock.counter), skewed: false };
  if (wall === remote.wall) return { clock: advanceCounter(wall, remote.counter), skewed: false };
  return { clock: { wall, counter: 0 }, skewed: false };
}

/** Borrow a millisecond once the four-hex-digit counter is exhausted. */
const advanceCounter = (wall: number, counter: number): HlcClock => {
  if (counter < MAX_COUNTER) return { wall, counter: counter + 1 };
  if (wall >= MAX_WALL_MS) throw new HlcError('Clock cannot advance beyond its maximum wall time.');
  return { wall: wall + 1, counter: 0 };
};

const advanceToLocal = (clock: HlcClock, local: number): HlcClock =>
  local > clock.wall ? { wall: local, counter: 0 } : advanceCounter(clock.wall, clock.counter);

/**
 * Builds an HLC for an entity that predates sync, seeded from its own `createdAt`.
 *
 * Used once, by the genesis migration that turns existing rows into `create` ops. Seeding
 * from the entity's own timestamp rather than from "now" is what gives the merged history
 * a sensible shape — two vaults paired for the first time interleave by when things
 * actually happened instead of arriving as one flat wall of simultaneous creates.
 */
export function hlcFromTimestamp(iso: string, counter: number, deviceId: string): Hlc {
  const wall = Date.parse(iso);
  return formatHlc({
    wall: Number.isFinite(wall) ? Math.min(Math.max(wall, 0), MAX_WALL_MS) : 0,
    counter: Math.min(Math.max(counter, 0), MAX_COUNTER),
    deviceId,
  });
}
