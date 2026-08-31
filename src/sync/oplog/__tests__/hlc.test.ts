import {
  HLC_LENGTH,
  MAX_CLOCK_SKEW_MS,
  MAX_COUNTER,
  ZERO_CLOCK,
  compareHlc,
  formatHlc,
  hlcFromTimestamp,
  hlcToIso,
  isHlc,
  maxHlc,
  observe,
  parseHlc,
  tick,
} from '@/sync/oplog/hlc';
import { DEVICE_A, DEVICE_B, at } from '@/sync/oplog/__tests__/helpers';

describe('HLC format', () => {
  it('is fixed width, so string order is causal order', () => {
    expect(at(1)).toHaveLength(HLC_LENGTH);
    expect(at(0xffffffffff)).toHaveLength(HLC_LENGTH);
    expect(at(1, DEVICE_A, MAX_COUNTER)).toHaveLength(HLC_LENGTH);
  });

  it('orders lexicographically by wall, then counter, then device', () => {
    expect(at(1) < at(2)).toBe(true);
    expect(at(2, DEVICE_A, 0) < at(2, DEVICE_A, 1)).toBe(true);
    expect(at(2, DEVICE_A, 5) < at(2, DEVICE_B, 5)).toBe(true);
    // The device tie-break must outrank nothing above it: a later counter on the *lower*
    // device still wins over an earlier counter on the higher one.
    expect(at(2, DEVICE_A, 6) > at(2, DEVICE_B, 5)).toBe(true);
  });

  it('round-trips through parse', () => {
    const parts = parseHlc(at(1234, DEVICE_B, 7));
    expect(parts).toEqual({ wall: 1234, counter: 7, deviceId: DEVICE_B });
  });

  it('validates shape', () => {
    expect(isHlc(at(1))).toBe(true);
    expect(isHlc('nonsense')).toBe(false);
    expect(isHlc('')).toBe(false);
    expect(isHlc(null)).toBe(false);
    // Uppercase hex would sort differently from lowercase and must not be accepted.
    expect(isHlc(at(0xab).toUpperCase())).toBe(false);
  });

  it('rejects a device id of the wrong length', () => {
    expect(() => formatHlc({ wall: 1, counter: 0, deviceId: 'SHORT' })).toThrow();
  });

  it('projects the wall clock to ISO for updatedAt', () => {
    expect(hlcToIso(at(Date.parse('2026-03-04T05:06:07.008Z')))).toBe('2026-03-04T05:06:07.008Z');
  });

  it('compares and maxes consistently', () => {
    expect(compareHlc(at(1), at(2))).toBe(-1);
    expect(compareHlc(at(2), at(1))).toBe(1);
    expect(compareHlc(at(1), at(1))).toBe(0);
    expect(maxHlc(at(1), at(2))).toBe(at(2));
    expect(maxHlc(at(2), at(1))).toBe(at(2));
  });
});

describe('tick', () => {
  it('advances the wall clock and resets the counter', () => {
    const first = tick(ZERO_CLOCK, DEVICE_A, 1_000);
    expect(first.clock).toEqual({ wall: 1_000, counter: 0 });
    const second = tick(first.clock, DEVICE_A, 2_000);
    expect(second.clock).toEqual({ wall: 2_000, counter: 0 });
    expect(second.hlc > first.hlc).toBe(true);
  });

  it('uses the counter to order events inside one millisecond', () => {
    const first = tick(ZERO_CLOCK, DEVICE_A, 1_000);
    const second = tick(first.clock, DEVICE_A, 1_000);
    expect(second.clock).toEqual({ wall: 1_000, counter: 1 });
    expect(second.hlc > first.hlc).toBe(true);
  });

  it('never goes backwards when the system clock does', () => {
    const first = tick(ZERO_CLOCK, DEVICE_A, 5_000);
    const second = tick(first.clock, DEVICE_A, 1_000);
    expect(second.clock.wall).toBe(5_000);
    expect(second.hlc > first.hlc).toBe(true);
  });

  it('borrows a millisecond rather than reusing a reading when the counter is exhausted', () => {
    const first = tick({ wall: 1_000, counter: MAX_COUNTER }, DEVICE_A, 1_000);
    expect(first.clock).toEqual({ wall: 1_001, counter: 0 });
    expect(first.hlc > at(1_000, DEVICE_A, MAX_COUNTER)).toBe(true);
  });

  it('produces a strictly increasing sequence under a frozen clock', () => {
    let clock = ZERO_CLOCK;
    let previous = '';
    for (let index = 0; index < 500; index += 1) {
      const next = tick(clock, DEVICE_A, 1_000);
      expect(next.hlc > previous).toBe(true);
      previous = next.hlc;
      clock = next.clock;
    }
  });
});

describe('observe', () => {
  it('adopts a peer reading ahead of local time, so causality survives', () => {
    const { clock, skewed } = observe(ZERO_CLOCK, at(9_000, DEVICE_B), 1_000);
    expect(skewed).toBe(false);
    expect(clock.wall).toBe(9_000);
    // The next local event must sort *after* the op that caused it.
    expect(tick(clock, DEVICE_A, 1_000).hlc > at(9_000, DEVICE_B)).toBe(true);
  });

  it('breaks a same-millisecond tie by advancing the counter past the peer', () => {
    const { clock } = observe({ wall: 1_000, counter: 3 }, at(1_000, DEVICE_B, 7), 1_000);
    expect(clock).toEqual({ wall: 1_000, counter: 8 });
  });

  it('borrows a millisecond when a received maximum counter must be observed', () => {
    const { clock } = observe(
      { wall: 1_000, counter: MAX_COUNTER },
      at(1_000, DEVICE_B, MAX_COUNTER),
      1_000,
    );
    expect(clock).toEqual({ wall: 1_001, counter: 0 });
    expect(() => tick(clock, DEVICE_A, 1_000)).not.toThrow();
  });

  it('refuses to adopt a clock beyond the skew bound', () => {
    const far = at(1_000 + MAX_CLOCK_SKEW_MS + 1, DEVICE_B);
    const { clock, skewed } = observe(ZERO_CLOCK, far, 1_000);
    expect(skewed).toBe(true);
    expect(clock.wall).toBe(1_000);
  });

  it('accepts a reading exactly at the bound', () => {
    const edge = at(1_000 + MAX_CLOCK_SKEW_MS, DEVICE_B);
    expect(observe(ZERO_CLOCK, edge, 1_000).skewed).toBe(false);
  });

  it('keeps advancing through a burst of skewed ops rather than stalling', () => {
    const far = at(9_000_000, DEVICE_B);
    let clock = ZERO_CLOCK;
    for (let index = 0; index < 5; index += 1) clock = observe(clock, far, 1_000).clock;
    expect(clock.wall).toBe(1_000);
    expect(clock.counter).toBe(4);
  });

  it('stops flagging skew once local time catches up, with no other change', () => {
    const ahead = at(1_000 + MAX_CLOCK_SKEW_MS + 60_000, DEVICE_B);
    expect(observe(ZERO_CLOCK, ahead, 1_000).skewed).toBe(true);
    expect(observe(ZERO_CLOCK, ahead, 1_000 + 120_000).skewed).toBe(false);
  });

  it('never rewinds the local clock', () => {
    const { clock } = observe({ wall: 8_000, counter: 2 }, at(1_000, DEVICE_B), 500);
    expect(clock.wall).toBe(8_000);
    expect(clock.counter).toBe(3);
  });
});

describe('hlcFromTimestamp', () => {
  it('seeds the genesis migration from an entity own createdAt', () => {
    const hlc = hlcFromTimestamp('2026-01-01T00:00:00.000Z', 0, DEVICE_A);
    expect(parseHlc(hlc).wall).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });

  it('orders genesis ops by when things actually happened', () => {
    const older = hlcFromTimestamp('2025-06-01T00:00:00.000Z', 0, DEVICE_A);
    const newer = hlcFromTimestamp('2026-06-01T00:00:00.000Z', 0, DEVICE_A);
    expect(older < newer).toBe(true);
  });

  it('clamps rather than throwing on an unparseable timestamp', () => {
    // A row this old is a data problem, not a reason to refuse to enable sync at all.
    expect(parseHlc(hlcFromTimestamp('not a date', 0, DEVICE_A)).wall).toBe(0);
    expect(parseHlc(hlcFromTimestamp('1600-01-01T00:00:00.000Z', 0, DEVICE_A)).wall).toBe(0);
  });

  it('separates two entities created in the same millisecond', () => {
    const first = hlcFromTimestamp('2026-01-01T00:00:00.000Z', 0, DEVICE_A);
    const second = hlcFromTimestamp('2026-01-01T00:00:00.000Z', 1, DEVICE_A);
    expect(first < second).toBe(true);
  });
});
