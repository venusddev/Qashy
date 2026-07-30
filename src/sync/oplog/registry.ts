/**
 * How every field of every entity merges.
 *
 * This table is the specification. The diff reads it to decide which ops a local change
 * produces, and the merge reads it to decide which op wins — so a field that is absent
 * here is a field that never syncs, silently. That is the failure mode this file is
 * organised to prevent: `assertRegistryCoversModels` walks the real entity shapes at test
 * time and fails if anything is unaccounted for.
 *
 * ## Why groups exist
 *
 * Plain per-field last-writer-wins is wrong whenever two fields are only meaningful
 * together. Device A edits a transaction's amount while device B edits its currency; a
 * per-field merge produces A's amount with B's currency and whichever
 * `baseAmountMinor` happened to arrive last — a combination no local mutation could ever
 * have created, and one that silently corrupts every converted total because
 * `assertTransactionSetSafe` adds `amountMinor` into the account balance without checking
 * the currency at all.
 *
 * A group makes those fields one register: whichever side wrote last contributes *all* of
 * them, so the result is always a state some device actually held. The cost is that an
 * unrelated concurrent edit inside the same group is dropped rather than merged, which is
 * why groups are drawn as tightly as the invariants allow and no tighter. `categoryId`
 * sits outside the transaction `ledger` group for exactly this reason — recategorising is
 * the most common concurrent edit there is, and it must not be swallowed by someone else
 * fixing a typo in the amount.
 */

import type { EntityType } from '@/domain/models';

export type FieldStrategy =
  /** Established by the `create` op and never changed. A local change to one is a bug. */
  | { readonly kind: 'createOnly' }
  /** Computed locally from the merged set. Never travels. */
  | { readonly kind: 'derived' }
  /** Meaningful only on this device — a phone in dark mode must not darken a laptop. */
  | { readonly kind: 'deviceLocal' }
  /** Last writer wins, on its own. */
  | { readonly kind: 'lww' }
  /** Last writer wins, but every member of `group` moves together. */
  | { readonly kind: 'group'; readonly group: string }
  /** Only ever moves forward; the larger value wins regardless of clock. */
  | { readonly kind: 'monotoneMax' }
  /** Once true, true everywhere. A peer's stale `false` cannot undo it. */
  | { readonly kind: 'monotoneTrue' }
  /** An add-wins set of entity ids. */
  | { readonly kind: 'elementSet' }
  /** An array of objects behaving as a map keyed on `key`, merged per entry. */
  | { readonly kind: 'keyedMap'; readonly key: string };

/** Field paths are dotted so a nested leaf (`filters.categoryIds`) can have its own strategy. */
export type EntitySpec = Readonly<Record<string, FieldStrategy>>;

const LWW: FieldStrategy = { kind: 'lww' };
const CREATE_ONLY: FieldStrategy = { kind: 'createOnly' };
const DERIVED: FieldStrategy = { kind: 'derived' };
const ELEMENT_SET: FieldStrategy = { kind: 'elementSet' };
const group = (name: string): FieldStrategy => ({ kind: 'group', group: name });

/**
 * Shared by every entity through `SyncEntity`.
 *
 * `deletedAt` is deliberately absent: deletion is not an ordinary register. It is handled
 * by `delete`/`restore` ops against `CausalMeta.deleted`, biased to delete only on an exact
 * clock tie. An absorbing delete-wins would be simpler and wrong — §2.6's account
 * resurrection repair needs a tombstoned account to come back when a merged-in transaction
 * still references it.
 */
const SYNC_ENTITY_SPEC: EntitySpec = {
  id: CREATE_ONLY,
  createdAt: CREATE_ONLY,
  updatedAt: DERIVED,
  revision: DERIVED,
  deletedAt: DERIVED,
};

const spec = (fields: EntitySpec): EntitySpec => ({ ...SYNC_ENTITY_SPEC, ...fields });

export const REGISTRY: Readonly<Record<EntityType, EntitySpec>> = {
  settings: spec({
    /**
     * Not merged, and not mergeable. Every transaction's `baseAmountMinor` was snapshotted
     * against this, so re-basing a vault would need the full historical rate matrix for
     * every pair — which the app does not have and never will. It is a pairing
     * precondition instead: mismatched base currencies refuse to pair at all.
     */
    baseCurrency: CREATE_ONLY,
    /** Monotone: a peer that has not finished onboarding must never un-onboard this one. */
    onboardingComplete: { kind: 'monotoneTrue' },
    locale: LWW,
    themeMode: { kind: 'deviceLocal' },
    /** `'custom'` paired with another device's system-derived hex is not a state that means anything. */
    accentSource: group('accent'),
    accentHex: group('accent'),
  }),

  accounts: spec({
    name: LWW,
    type: LWW,
    currency: LWW,
    openingBalanceMinor: LWW,
    icon: LWW,
    color: LWW,
    archived: LWW,
  }),

  categories: spec({
    name: LWW,
    kind: LWW,
    icon: LWW,
    color: LWW,
    parentId: LWW,
    archived: LWW,
  }),

  tags: spec({
    name: LWW,
    color: LWW,
  }),

  transactions: spec({
    /**
     * The ledger group. Every member is derived from or derives another:
     * `currency` is copied from the account at write time, `exchangeRate` and
     * `baseAmountMinor` are resolved for `localDate`, and `transferGroupId` legitimately
     * goes to `null` when `kind` stops being `'transfer'`. Splitting any of them produces
     * a row whose stored conversion does not describe its own amount.
     */
    kind: group('ledger'),
    localDate: group('ledger'),
    accountId: group('ledger'),
    destinationAccountId: group('ledger'),
    amountMinor: group('ledger'),
    currency: group('ledger'),
    exchangeRate: group('ledger'),
    baseAmountMinor: group('ledger'),
    destinationAmountMinor: group('ledger'),
    destinationCurrency: group('ledger'),
    destinationBaseAmountMinor: group('ledger'),
    transferGroupId: group('ledger'),
    status: LWW,
    title: LWW,
    note: LWW,
    categoryId: LWW,
    tagIds: ELEMENT_SET,
    recurringRuleId: LWW,
    /** Derived into the id itself (§2.10), so two devices generating the same occurrence collide into one row. */
    occurrenceKey: CREATE_ONLY,
  }),

  budgets: spec({
    name: LWW,
    icon: LWW,
    color: LWW,
    limitMinor: LWW,
    rollover: LWW,
    archived: LWW,
    /** Whole-object: `unit: 'custom'` requires an `endDate`, so the members cannot split. */
    period: group('period'),
    'filters.accountIds': ELEMENT_SET,
    'filters.categoryIds': ELEMENT_SET,
    'filters.tagIds': ELEMENT_SET,
    categoryLimits: { kind: 'keyedMap', key: 'categoryId' },
  }),

  budgetPeriods: spec({
    budgetId: CREATE_ONLY,
    periodStart: CREATE_ONLY,
    periodEnd: LWW,
    limitMinor: LWW,
    rolloverMinor: LWW,
    /**
     * Whole-object and atomic, unlike the live budget's element sets. These are frozen
     * *history*: a snapshot records what the budget looked like when the period closed.
     * Set semantics would let an edit to the live budget bleed backwards into a closed
     * period and silently restate a number the user already saw.
     */
    filters: group('snapshot'),
    categoryLimits: group('snapshot'),
  }),

  goals: spec({
    name: LWW,
    kind: LWW,
    icon: LWW,
    color: LWW,
    /** A target without its starting progress is a percentage that jumps for no reason. */
    targetMinor: group('money'),
    initialMinor: group('money'),
    targetDate: LWW,
    linkedAccountId: LWW,
    linkedCategoryId: LWW,
    archived: LWW,
  }),

  contributions: spec({
    goalId: CREATE_ONLY,
    amountMinor: LWW,
    localDate: LWW,
    transactionId: LWW,
    note: LWW,
  }),

  recurringRules: spec({
    /**
     * The template is one register. `kind` must agree with the linked category's kind and
     * `currency` must agree with the account's, and `deleteEntities` already rewrites the
     * whole template when a dependency goes away.
     */
    template: group('template'),
    unit: group('schedule'),
    interval: group('schedule'),
    startDate: group('schedule'),
    endDate: group('schedule'),
    /**
     * Monotone. Under plain LWW an offline device that had not yet advanced the pointer
     * would rewind it on reconnect, and `generateRecurring` would re-walk the same span on
     * every launch — producing occurrences that are then deduplicated forever.
     */
    nextDueDate: { kind: 'monotoneMax' },
    autoPost: LWW,
    active: LWW,
    /** Recomputed from the merged accounts and categories on every merge. Never travels. */
    pausedByDependency: DERIVED,
  }),

  exchangeRates: spec({
    /** Together these are the natural key; splitting them breaks `assertReciprocalRate`. */
    fromCurrency: group('pair'),
    toCurrency: group('pair'),
    effectiveDate: group('pair'),
    rate: LWW,
  }),
};

export const ENTITY_TYPES = Object.keys(REGISTRY) as EntityType[];

export const isEntityType = (value: unknown): value is EntityType =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(REGISTRY, value);

const NO_SPEC: EntitySpec = {};

/**
 * An unknown entity type yields an empty spec rather than throwing.
 *
 * A peer running a newer build can legitimately send ops for a type this one has never
 * heard of. Those ops are kept and forwarded verbatim, which means their causal state gets
 * carried through the same merge paths as everything else — so every lookup here has to
 * answer "nothing to merge" instead of taking the app down.
 */
export const specFor = (entityType: EntityType): EntitySpec => REGISTRY[entityType] ?? NO_SPEC;

/**
 * The register a field contributes to: its group name, or its own path.
 *
 * Returns `null` for anything that does not travel as a register — immutables, derived
 * fields, device-local fields, sets, and maps all have their own paths through the merge.
 */
export function registerOf(strategy: FieldStrategy, path: string): string | null {
  switch (strategy.kind) {
    case 'lww':
    case 'monotoneMax':
    case 'monotoneTrue':
      return path;
    case 'group':
      return strategy.group;
    default:
      return null;
  }
}

export interface RegisterSpec {
  readonly name: string;
  /** Field paths this register carries, in a stable order. A single-field register has one. */
  readonly fields: readonly string[];
  readonly strategy: FieldStrategy;
}

const registerCache = new Map<EntityType, readonly RegisterSpec[]>();

/** Every register of an entity type, in a deterministic order. */
export function registersOf(entityType: EntityType): readonly RegisterSpec[] {
  const cached = registerCache.get(entityType);
  if (cached) return cached;
  const byName = new Map<string, { fields: string[]; strategy: FieldStrategy }>();
  for (const path of Object.keys(specFor(entityType)).sort()) {
    const strategy = specFor(entityType)[path];
    const name = registerOf(strategy, path);
    if (!name) continue;
    const entry = byName.get(name);
    if (entry) entry.fields.push(path);
    else byName.set(name, { fields: [path], strategy });
  }
  const registers = [...byName.entries()]
    .map(([name, entry]) => ({ name, fields: entry.fields, strategy: entry.strategy }))
    .sort((first, second) => (first.name < second.name ? -1 : first.name > second.name ? 1 : 0));
  registerCache.set(entityType, registers);
  return registers;
}

/** Field paths carrying an add-wins set, in a deterministic order. */
export const elementSetsOf = (entityType: EntityType): readonly string[] =>
  Object.keys(specFor(entityType))
    .filter((path) => specFor(entityType)[path].kind === 'elementSet')
    .sort();

export interface KeyedMapSpec {
  readonly path: string;
  readonly key: string;
}

export const keyedMapsOf = (entityType: EntityType): readonly KeyedMapSpec[] =>
  Object.keys(specFor(entityType))
    .flatMap((path) => {
      const strategy = specFor(entityType)[path];
      return strategy.kind === 'keyedMap' ? [{ path, key: strategy.key }] : [];
    })
    .sort((first, second) => (first.path < second.path ? -1 : first.path > second.path ? 1 : 0));

/** Field paths pinned by the `create` op. */
export const createOnlyFieldsOf = (entityType: EntityType): readonly string[] =>
  Object.keys(specFor(entityType))
    .filter((path) => specFor(entityType)[path].kind === 'createOnly')
    .sort();

/**
 * Field paths that mean something only on the device holding them.
 *
 * They are pinned by the `create` op like an immutable, but for the opposite reason: not so
 * that every device agrees on the value, but so that a device receiving an entity it has
 * never held has *a* value to start from. Once a local copy exists it always wins, and no
 * remote write can move it — see `materialize`.
 */
export const deviceLocalFieldsOf = (entityType: EntityType): readonly string[] =>
  Object.keys(specFor(entityType))
    .filter((path) => specFor(entityType)[path].kind === 'deviceLocal')
    .sort();

// ---------------------------------------------------------------------------
// Dotted-path access
// ---------------------------------------------------------------------------

/** Reads `filters.categoryIds` out of an entity. Returns `undefined` for a missing branch. */
export function readPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Writes `value` at `path`, creating intermediate objects, without mutating `target`.
 *
 * Structural sharing is not an optimisation here — materialization builds an entity by
 * writing every register in turn, and mutating in place would let a later write leak into
 * the previously-materialized value a caller is still holding.
 */
export function writePath<T extends object>(target: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  if (!rest.length) return { ...target, [head]: value };
  const child = (target as Record<string, unknown>)[head];
  const base = typeof child === 'object' && child !== null ? (child as object) : {};
  return { ...target, [head]: writePath(base, rest.join('.'), value) };
}
