import { CanonicalJsonError, canonicalJson } from '@/utils/canonical-json';

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested keys too', () => {
    const first = canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const second = canonicalJson({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    expect(first).toBe(second);
  });

  it('preserves array order, which is data rather than layout', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('sorts by code unit, never by locale', () => {
    // `localeCompare` orders these differently under some collations. The hash of an op must
    // not depend on which language the user picked, so the comparator is the default one.
    const output = canonicalJson({ Z: 1, a: 2, A: 3, z: 4 });
    expect(output).toBe('{"A":3,"Z":1,"a":2,"z":4}');
  });

  it('rejects undefined anywhere, rather than silently dropping it', () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([1, undefined])).toThrow(CanonicalJsonError);
  });

  it('names the path of the offending value', () => {
    expect(() => canonicalJson({ outer: { inner: [1, undefined] } })).toThrow(/outer\.inner\[1\]/);
  });

  it('rejects non-finite numbers, which JSON.stringify turns into null', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: -Infinity })).toThrow(CanonicalJsonError);
  });

  it('rejects values that cannot round-trip', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: Symbol('x') })).toThrow(CanonicalJsonError);
  });

  it('rejects a Date rather than accepting its toJSON', () => {
    // A Date hashes as a string and round-trips as a string, so the value that was signed and
    // the value that comes back are different types. Refusing it is the only honest option.
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(CanonicalJsonError);
  });

  it('rejects circular references instead of overflowing the stack', () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrow(CanonicalJsonError);
  });

  it('handles the primitives an op payload actually contains', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson('hé"\n')).toBe('"hé\\"\\n"');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('round-trips through JSON.parse unchanged', () => {
    const value = { z: [1, { b: null, a: 'x' }], y: false };
    expect(canonicalJson(JSON.parse(canonicalJson(value)))).toBe(canonicalJson(value));
  });
});
