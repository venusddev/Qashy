/**
 * Deterministic JSON, for values whose bytes get hashed and signed.
 *
 * `JSON.stringify` is not a canonical encoding. Object key order follows insertion order,
 * so two devices that built the same op through different code paths produce different
 * bytes, different hashes, and — since the hash is chained — a fork that every peer
 * downstream must reject. `undefined` silently vanishes from objects and turns into `null`
 * inside arrays, so a payload can round-trip into something that is not what was signed.
 *
 * This encoder removes both hazards by refusing anything ambiguous rather than guessing:
 * keys are sorted, and every value that has no single obvious JSON form throws. That makes
 * "this op cannot be encoded" a loud local bug at the moment it is written, instead of a
 * chain break on someone else's phone a week later.
 *
 * Deliberately *not* honoured: `toJSON`. A `Date` serialises to an ISO string through it,
 * which looks helpful right up to the point where the value read back is a string and the
 * value hashed was a date — and the two devices disagree about which they hold. Dates must
 * be converted to strings by the caller, explicitly.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'CanonicalJsonError';
  }
}

const isPlainObject = (value: object) => {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || prototype === Object.prototype;
};

const describe = (value: unknown) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  const type = typeof value;
  if (type !== 'object') return `a ${type}`;
  const name = (value as object).constructor?.name;
  return name ? `a ${name}` : 'an object';
};

const encodeValue = (value: unknown, path: string, seen: Set<object>): string => {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      // NaN and ±Infinity stringify to `null`, which would make two structurally different
      // payloads hash identically. Money is stored in minor units precisely so this never
      // comes up in practice, and a value that reaches here is a bug worth surfacing.
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`${String(value)} has no JSON representation`, path);
      }
      return JSON.stringify(value);
    case 'undefined':
      throw new CanonicalJsonError('undefined has no JSON representation', path);
    case 'bigint':
      throw new CanonicalJsonError('bigint has no JSON representation', path);
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${describe(value)} cannot be encoded`, path);
    default:
      break;
  }

  const object = value as object;
  // A cycle would otherwise recurse until the stack gives out, which reports the wrong
  // problem in the wrong place.
  if (seen.has(object)) throw new CanonicalJsonError('a circular reference cannot be encoded', path);

  if (Array.isArray(object)) {
    seen.add(object);
    const parts = object.map((element, index) => encodeValue(element, `${path}[${index}]`, seen));
    seen.delete(object);
    return `[${parts.join(',')}]`;
  }

  if (!isPlainObject(object)) {
    throw new CanonicalJsonError(`${describe(object)} cannot be encoded; convert it first`, path);
  }

  seen.add(object);
  // Sorted by UTF-16 code unit, which is what the default comparator does and what every
  // JS engine agrees on. `localeCompare` would be a divergence bug: the app ships he-IL
  // and en-US, and locale-aware collation orders the same two keys differently.
  const keys = Object.keys(object as Record<string, unknown>).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const child = (object as Record<string, unknown>)[key];
    const childPath = path ? `${path}.${key}` : key;
    // An explicit `undefined` property is dropped by JSON.stringify without a word. Here it
    // is the difference between "this field is unset" and "this field was never in the op",
    // so it has to be a decision the caller makes with `null`.
    if (child === undefined) {
      throw new CanonicalJsonError('undefined has no JSON representation', childPath);
    }
    parts.push(`${JSON.stringify(key)}:${encodeValue(child, childPath, seen)}`);
  }
  seen.delete(object);
  return `{${parts.join(',')}}`;
};

/** Encodes `value` to the one string every Qashy device produces for it. */
export function canonicalJson(value: unknown): string {
  return encodeValue(value, '', new Set<object>());
}
