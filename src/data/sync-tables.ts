/**
 * The device-local sync tables.
 *
 * Deliberately separate from `records`, and deliberately not `AppSettings`. Everything here
 * is about *this* device's participation in the vault — what it has sent, what it has seen,
 * who it trusts — and none of it replicates. `AppSettings` would have been the obvious home
 * for the enable flags and endpoint URLs, and it is exactly the wrong one: that entity syncs,
 * so a paired-device list stored there would be circular and this device's private state
 * would be broadcast to every peer.
 *
 * No key material lives here. Keys live in the keystore — Keychain, Android Keystore, or a
 * non-extractable `CryptoKey` — never in a table a backup, a debugger, or an export can read.
 *
 * Byte-valued columns are base64url strings rather than blobs. SQLite and IndexedDB disagree
 * about how a `Uint8Array` round-trips, and a string is the one representation both store,
 * index, and compare identically. Booleans are `0 | 1` and absent strings are `''` for the
 * same reason: IndexedDB cannot index a boolean or a null, so a column that is ever queried
 * has to avoid both.
 */

import type { EntityType } from '@/domain/models';

/** One op in this device's outbox, or one received from a peer. */
export interface SyncOpRow {
  /** `${deviceId}:${seq}` — the chain position, and the primary key. */
  readonly opId: string;
  readonly deviceId: string;
  readonly seq: number;
  readonly prevHash: string;
  readonly opHash: string;
  readonly hlc: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly kind: string;
  /** Canonical JSON, so `opHash` is stable across platforms and JS engines. */
  readonly payload: string;
  /**
   * The registry shape version this op was written against.
   *
   * Stored rather than assumed, because `opHash` covers it: an op reloaded without its own
   * `schema` hashes differently than it did when it was signed, so it would fail its own
   * verification and could never be forwarded to a peer. That matters most for exactly the
   * ops this build does not understand — a higher `schema` is the case the column exists for.
   */
  readonly schema: number;
  /** `''` until the background sealer signs it. Only sealed ops are ever transmitted. */
  readonly signature: string;
  readonly sealed: 0 | 1;
  /** 0 local, 1 received from a peer. */
  readonly origin: 0 | 1;
}

/**
 * The authoritative merge state for one entity.
 *
 * `records.payload` is a materialized, repaired *projection* of this — which is why the local
 * view never has to replay ops, and why compaction is a retention problem rather than a
 * correctness one.
 */
export interface SyncStateRow {
  /** `${entityType}:${entityId}`, mirroring `records`. */
  readonly key: string;
  readonly type: EntityType;
  /** JSON `CausalMeta`. */
  readonly meta: string;
  readonly maxHlc: string;
  readonly deletedHlc: string | null;
}

/** A device this vault has paired with, including ones since revoked. */
export interface SyncPeerRow {
  readonly peerId: string;
  readonly name: string;
  readonly platform: string;
  /** base64url Ed25519 public key — identity and op signatures. */
  readonly signingKey: string;
  /** base64url X25519 public key — the static half of the session handshake. */
  readonly agreementKey: string;
  readonly epoch: number;
  readonly addedAt: string;
  /** Set once revoked. The row is never deleted, so its past ops stay attributable. */
  readonly revokedAt: string | null;
  /** JSON `{ [deviceId]: seq }` this peer confirmed receiving — the compaction watermark. */
  readonly acked: string;
  /** JSON `{ [deviceId]: seq }` we hold from that chain. */
  readonly known: string;
  readonly lastSeenAt: string | null;
}

/**
 * Non-secret device-local configuration and cursors.
 *
 * `deviceId`, `epoch`, `seq`, `headHash`, `hlcWall`, `hlcCounter`, `baseCurrency`,
 * `watermark`, `lastWrite`, `opSchemaVersion`, and the relay endpoint and health cache.
 */
export interface SyncMetaRow {
  readonly key: string;
  readonly value: string;
}

/**
 * An entity whose merged state the finance core would refuse.
 *
 * Local, never replicated, and self-healing: the ops stay in `sync_ops` and are still
 * forwarded to other peers, so the log never forks — only this device's projection differs.
 * Every row is re-evaluated on each merge, so a corrective op clears it automatically.
 */
export interface SyncQuarantineRow {
  readonly key: string;
  readonly reason: 'overflow' | 'clockSkew' | 'epochMismatch' | 'unknownSchema';
  readonly detail: string;
  readonly hlc: string;
  readonly recordedAt: string;
}

/**
 * One line of the sync activity log.
 *
 * Device-local, never replicated, and bounded to the most recent `ACTIVITY_LIMIT` rows. It
 * exists because a *rejected* batch must be visible: silently discarding a peer's history is
 * indistinguishable from being up to date, and "why has my laptop not changed in a week" is
 * a question the app should be able to answer without a debugger.
 *
 * Nothing here may carry finance data. `detail` is for a transport or protocol failure — a
 * DNS error, a 502, a chain gap — and is shown verbatim to someone running their own relay,
 * so an entity name or an amount leaking into it would end up on screen and in a screenshot.
 *
 * `key` is a zero-padded sequence number rather than a timestamp: two events in the same
 * millisecond are ordinary, and lexicographic order has to equal chronological order for the
 * "last N" read to mean anything.
 */
export interface SyncActivityRow {
  readonly key: string;
  readonly kind: string;
  /** The peer this concerns, or `''` for something this device did alone. */
  readonly peerId: string;
  /** Ops sent, ops received, entities quarantined — whatever the kind counts. */
  readonly count: number;
  /** Machine-readable reason, for the UI to localize. `''` when the event is not a failure. */
  readonly code: string;
  readonly detail: string;
  readonly recordedAt: string;
}

export const SYNC_TABLE_NAMES = [
  'syncOps',
  'syncState',
  'syncPeers',
  'syncMeta',
  'syncQuarantine',
  'syncActivity',
] as const;

export type SyncTableName = (typeof SYNC_TABLE_NAMES)[number];

export interface SyncRowByTable {
  readonly syncOps: SyncOpRow;
  readonly syncState: SyncStateRow;
  readonly syncPeers: SyncPeerRow;
  readonly syncMeta: SyncMetaRow;
  readonly syncQuarantine: SyncQuarantineRow;
  readonly syncActivity: SyncActivityRow;
}

export type SyncRow<Name extends SyncTableName> = SyncRowByTable[Name];

/** The primary-key field of each table, so one generic implementation can serve all five. */
export const SYNC_TABLE_KEYS = {
  syncOps: 'opId',
  syncState: 'key',
  syncPeers: 'peerId',
  syncMeta: 'key',
  syncQuarantine: 'key',
  syncActivity: 'key',
} as const satisfies { readonly [Name in SyncTableName]: keyof SyncRow<Name> & string };

export const syncRowKey = <Name extends SyncTableName>(name: Name, row: SyncRow<Name>): string =>
  (row as unknown as Record<string, unknown>)[SYNC_TABLE_KEYS[name]] as string;
