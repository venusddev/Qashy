/**
 * The op log's vocabulary: what a change looks like on the wire, and what a device
 * remembers about an entity so it can merge the next one.
 *
 * Two shapes matter here and they are not the same thing.
 *
 * A `SyncOp` is an *event*: "at this clock reading, this device set these fields". Ops are
 * append-only, hash-chained, signed, and forwarded verbatim — including ops this build does
 * not understand, because dropping one breaks the chain for every peer downstream of it.
 *
 * A `CausalMeta` is the *state* those events fold into: the winning clock reading for each
 * register, which set elements are present, which map keys are live. It is what makes the
 * merge converge regardless of the order ops arrive in, and it is what a peer too far
 * behind to replay a delta receives instead (see `compaction.ts`).
 */

import type { EntityType } from '@/domain/models';
import type { Hlc } from '@/sync/oplog/hlc';

export type OpKind =
  | 'create'
  | 'set'
  | 'setAdd'
  | 'setRemove'
  | 'mapUpsert'
  | 'mapRemove'
  | 'delete'
  | 'restore';

export const OP_KINDS: readonly OpKind[] = [
  'create',
  'set',
  'setAdd',
  'setRemove',
  'mapUpsert',
  'mapRemove',
  'delete',
  'restore',
];

/**
 * The signed half of an op.
 *
 * `schema` is the registry's shape version, not the app's. An op carrying a higher one is
 * stored and forwarded but not materialized — see `applyOp`.
 */
export interface SyncOpBody {
  readonly hlc: Hlc;
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly kind: OpKind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly schema: number;
}

export interface SyncOp extends SyncOpBody {
  /** `${deviceId}:${seq}` — unique by construction, and the primary key. */
  readonly opId: string;
  readonly deviceId: string;
  readonly seq: number;
  /** The `opHash` of this device's previous op; `''` for the first one. */
  readonly prevHash: string;
  readonly opHash: string;
  /** Ed25519 over `opHash`; `''` until the background sealer signs it. */
  readonly signature: string;
}

/** One last-writer-wins register. A group register holds an object of its members. */
export interface RegisterState {
  readonly hlc: Hlc;
  readonly value: unknown;
}

/**
 * One element of an add-wins set.
 *
 * Both clock readings are kept rather than a single "present" flag, because presence is
 * decided by comparing them and a later op on either side has to be able to flip it back.
 * An element that was added, removed, and added again holds only the newest of each.
 */
export interface ElementState {
  readonly addHlc: Hlc | null;
  readonly removeHlc: Hlc | null;
}

/** One entry of a keyed map, e.g. a budget's limit for one category. */
export interface MapEntryState {
  readonly hlc: Hlc;
  /** `null` means the entry was removed at `hlc`; the tombstone is what makes it converge. */
  readonly value: unknown;
}

export interface DeletionState {
  readonly hlc: Hlc;
  /** The ISO `deletedAt`, or `null` when the winning op was a `restore`. */
  readonly at: string | null;
}

/**
 * Everything this device knows about one entity's merge state.
 *
 * `created` carries the immutable fields — `id`, `createdAt`, and whatever the registry
 * marks `createOnly` — because they are established once and never compete. An entity
 * whose `create` op has not arrived yet has `created: null`: its registers accumulate, but
 * it does not materialize into a record until the create shows up. That is the fail-closed
 * choice, and it is why out-of-order delivery is safe rather than merely usually fine.
 */
export interface CausalMeta {
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly maxHlc: Hlc;
  readonly created: { readonly hlc: Hlc; readonly fields: Readonly<Record<string, unknown>> } | null;
  readonly registers: Readonly<Record<string, RegisterState>>;
  readonly sets: Readonly<Record<string, Readonly<Record<string, ElementState>>>>;
  readonly maps: Readonly<Record<string, Readonly<Record<string, MapEntryState>>>>;
  readonly deleted: DeletionState | null;
  /**
   * Ops this build could not interpret — a newer `schema`, an unknown `kind`, an unknown
   * `entityType`. Kept so that upgrading the app materializes them rather than losing an
   * edit that was faithfully stored and forwarded the whole time.
   */
  readonly unknown: readonly SyncOpBody[];
}

export const emptyMeta = (entityType: EntityType, entityId: string, hlc: Hlc): CausalMeta => ({
  entityType,
  entityId,
  maxHlc: hlc,
  created: null,
  registers: {},
  sets: {},
  maps: {},
  deleted: null,
  unknown: [],
});

/** `${entityType}:${entityId}` — the key both `records` and `sync_state` are stored under. */
export const metaKey = (entityType: EntityType, entityId: string) => `${entityType}:${entityId}`;

export class OpLogError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'malformed'
      | 'chainBreak'
      | 'chainFork'
      | 'unsignedOp'
      | 'badSignature'
      | 'immutableField',
  ) {
    super(message);
    this.name = 'OpLogError';
  }
}
