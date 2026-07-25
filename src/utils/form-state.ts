function isPrimitive(value: unknown) {
  return value === null || typeof value !== 'object';
}

/**
 * Order-insensitive serialization of a form's field state, used to decide whether
 * a sheet holds unsaved edits.
 *
 * A plain `JSON.stringify` made member order count as an edit: toggling a tag off
 * and back on rebuilds `tagIds` as `[b, a]` against an `[a, b]` baseline, so the
 * sheet asked to discard changes the user never made. The budget sheet's
 * `selectedCategories` and `categoryLimits` had the same problem.
 *
 * Every array these sheets pass is a selection set, and object key order is never
 * meaningful in JSON, so both are normalized. Arrays containing objects keep their
 * order — a sheet passing one would mean an ordered list, not a set.
 */
export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    const parts = value.map(stableSerialize);
    return `[${(value.every(isPrimitive) ? parts.sort() : parts).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`)
      .sort()
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
