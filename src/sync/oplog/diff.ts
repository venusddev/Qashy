/**
 * Turning a local write into ops, without the finance core knowing sync exists.
 *
 * `StorageAdapter.putMany` already receives the complete, atomic, typed change set of every
 * mutation the repository makes — that is how cross-tab reconciliation works today. So the
 * change capture for sync is a decorator that reads the *previous* rows for the same keys
 * inside the same transaction and diffs them against what is being written. The 2 400-line
 * finance core is not touched, every mutation site is covered by construction, and there is
 * no way to add a new mutation that forgets to emit an op.
 *
 * Everything here is pure and synchronous. It has to be: it runs inside a storage
 * transaction, and awaiting anything foreign inside a Dexie transaction leaves its promise
 * zone and lets IndexedDB auto-commit underneath the write. Signing happens afterwards,
 * outside the transaction, over batches — see the sealer in the engine.
 */

import type { EntityType, FinanceEntity } from '@/domain/models';
import { OP_SCHEMA_VERSION } from '@/sync/crypto';
import { canonicalJson } from '@/utils/canonical-json';
import type { Hlc } from '@/sync/oplog/hlc';
import { registerValueOf } from '@/sync/oplog/merge';
import {
  createOnlyFieldsOf,
  elementSetsOf,
  keyedMapsOf,
  readPath,
  registersOf,
} from '@/sync/oplog/registry';
import { metaKey, type SyncOpBody } from '@/sync/oplog/types';

export interface DiffResult {
  readonly ops: readonly SyncOpBody[];
  /**
   * Immutable fields that changed locally — always a bug in the finance core, never
   * something a peer did. Surfaced rather than logged, because `src/sync/**` may not log
   * and because a silently-dropped change is exactly what this would otherwise become.
   */
  readonly warnings: readonly string[];
}

const EMPTY: DiffResult = { ops: [], warnings: [] };

const body = (
  entityType: EntityType,
  entityId: string,
  hlc: Hlc,
  kind: SyncOpBody['kind'],
  payload: Record<string, unknown>,
): SyncOpBody => ({ hlc, entityType, entityId, kind, payload, schema: OP_SCHEMA_VERSION });

const elementsAt = (source: unknown, path: string): string[] => {
  const value = readPath(source, path);
  return Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];
};

const entriesAt = (source: unknown, path: string, key: string): Map<string, unknown> => {
  const value = readPath(source, path);
  const entries = new Map<string, unknown>();
  if (!Array.isArray(value)) return entries;
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = (entry as Record<string, unknown>)[key];
    if (typeof id === 'string') entries.set(id, entry);
  }
  return entries;
};

/**
 * The ops one entity's change produces.
 *
 * All ops from a single write share one clock reading. They are one user action, and the
 * slots they land in are disjoint, so there is nothing for a finer-grained reading to
 * order that a coarser one gets wrong.
 */
export function diffEntity(
  entityType: EntityType,
  previous: FinanceEntity | null,
  next: FinanceEntity,
  hlc: Hlc,
): DiffResult {
  const entityId = next.id;

  if (!previous) {
    return { ops: [body(entityType, entityId, hlc, 'create', { entity: next })], warnings: [] };
  }

  const ops: SyncOpBody[] = [];
  const warnings: string[] = [];

  // `id` and `createdAt` are createOnly for every entity type, so they are already in here.
  for (const field of createOnlyFieldsOf(entityType)) {
    const before = readPath(previous, field) ?? null;
    const after = readPath(next, field) ?? null;
    if (canonicalJson(before) !== canonicalJson(after)) {
      // Emitting nothing is the right call: the peers' copies stay consistent with the
      // create they already agreed on, and the local row is the one that is wrong.
      warnings.push(`${entityType}.${field} changed on ${entityId} but is immutable; not synced.`);
    }
  }

  const registers: Record<string, unknown> = {};
  for (const spec of registersOf(entityType)) {
    const before = registerValueOf(spec, previous);
    const after = registerValueOf(spec, next);
    // A group emits every member whenever any one of them moved. That is the entire point
    // of grouping — half a group on the wire is half a group in the merge.
    if (canonicalJson(before) !== canonicalJson(after)) registers[spec.name] = after;
  }
  if (Object.keys(registers).length) ops.push(body(entityType, entityId, hlc, 'set', { registers }));

  for (const path of elementSetsOf(entityType)) {
    const before = new Set(elementsAt(previous, path));
    const after = new Set(elementsAt(next, path));
    const added = [...after].filter((element) => !before.has(element)).sort();
    const removed = [...before].filter((element) => !after.has(element)).sort();
    if (added.length) ops.push(body(entityType, entityId, hlc, 'setAdd', { field: path, elements: added }));
    if (removed.length) {
      ops.push(body(entityType, entityId, hlc, 'setRemove', { field: path, elements: removed }));
    }
  }

  for (const { path, key } of keyedMapsOf(entityType)) {
    const before = entriesAt(previous, path, key);
    const after = entriesAt(next, path, key);
    const entries: Record<string, unknown> = {};
    for (const [entryKey, value] of after) {
      const existing = before.get(entryKey);
      if (existing === undefined || canonicalJson(existing) !== canonicalJson(value)) {
        entries[entryKey] = value;
      }
    }
    const removed = [...before.keys()].filter((entryKey) => !after.has(entryKey)).sort();
    if (Object.keys(entries).length) {
      ops.push(body(entityType, entityId, hlc, 'mapUpsert', { field: path, entries }));
    }
    if (removed.length) {
      ops.push(body(entityType, entityId, hlc, 'mapRemove', { field: path, keys: removed }));
    }
  }

  if (next.deletedAt && !previous.deletedAt) {
    ops.push(body(entityType, entityId, hlc, 'delete', { at: next.deletedAt }));
  } else if (!next.deletedAt && previous.deletedAt) {
    ops.push(body(entityType, entityId, hlc, 'restore', {}));
  }

  return ops.length || warnings.length ? { ops, warnings } : EMPTY;
}

export interface DiffInput {
  readonly type: EntityType;
  readonly entity: FinanceEntity;
}

/**
 * The ops a whole `putMany` produces.
 *
 * `previous` is keyed by `${entityType}:${entityId}`, and a key that is absent means the
 * row genuinely does not exist yet — the decorator reads it inside the same transaction as
 * the write, so there is no window in which it could be stale.
 */
export function diffRecords(
  previous: ReadonlyMap<string, FinanceEntity>,
  incoming: readonly DiffInput[],
  hlc: Hlc,
): DiffResult {
  const ops: SyncOpBody[] = [];
  const warnings: string[] = [];
  for (const { type, entity } of incoming) {
    const result = diffEntity(type, previous.get(metaKey(type, entity.id)) ?? null, entity, hlc);
    ops.push(...result.ops);
    warnings.push(...result.warnings);
  }
  return { ops, warnings };
}
