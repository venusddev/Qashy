/**
 * Reading and writing the six sync tables, in one place.
 *
 * Everything here takes a `StorageTx` and does nothing else — no clock, no crypto, no
 * network — because every one of these calls happens inside a storage transaction where
 * awaiting a foreign promise would leave Dexie's zone and let IndexedDB commit underneath
 * the write. That constraint is what shapes the module: the callers do their thinking
 * first and hand the results in.
 *
 * The local write path (`SyncingStorageAdapter`) and the remote apply path (the engine)
 * both persist ops, causal state, and the chain head. They go through `recordOps` rather
 * than each writing the three tables themselves, because the *combination* is what has to
 * stay consistent: an op stored without its `sync_state` update is an edit that never
 * reaches the local projection, and a `sync_state` update without its op is an edit no
 * peer ever hears about.
 */

import type { StorageTx } from '@/data/storage-adapter';
import type {
  SyncActivityRow,
  SyncOpRow,
  SyncQuarantineRow,
  SyncStateRow,
} from '@/data/sync-tables';
import type { EntityType } from '@/domain/models';
import {
  GENESIS_HASH,
  applyOps,
  metaKey,
  type CausalMeta,
  type ChainHead,
  type HlcClock,
  type OpKind,
  type SyncOp,
} from '@/sync/oplog';
import { canonicalJson } from '@/utils/canonical-json';

/**
 * Every key `sync_meta` holds.
 *
 * Device-local and **non-secret** by construction. Key material lives in the keystore and
 * never here — a relay URL is read on every screen paint, and a table that mixed the two
 * would mean touching the Keychain to render a settings row.
 */
export const SYNC_META = {
  /** This device's identity, derived from its Ed25519 public key. */
  deviceId: 'deviceId',
  /** Bumped by a vault-key rotation; mirrors the epoch stored beside the key. */
  epoch: 'epoch',
  /** The highest `seq` this device has issued on its own chain. */
  seq: 'seq',
  /** The `opHash` of this device's newest op — what the next op chains onto. */
  headHash: 'headHash',
  hlcWall: 'hlcWall',
  hlcCounter: 'hlcCounter',
  /**
   * The vault's base currency, checked before any op is applied.
   *
   * Divergence is not merge-able: every transaction's `baseAmountMinor` is snapshotted
   * against it, and re-basing would need a historical rate matrix the app does not have.
   */
  baseCurrency: 'baseCurrency',
  /** Set once the genesis migration has converted pre-sync rows into ops. */
  genesisAt: 'genesisAt',
  /** Written by every commit so other tabs can tell a foreign write from their own echo. */
  lastWrite: 'lastWrite',
  /** `'1'` once the user has switched sync on. Absent means off, which is the default. */
  enabled: 'enabled',
  /** What this device calls itself in another device's list. Chosen by the user at pairing. */
  deviceName: 'deviceName',

  // -- Transport configuration. Non-secret by construction; see `sync/transport/endpoints.ts`.

  /** Origin of the relay and signaling service, without a trailing slash. `''` means none. */
  relayUrl: 'relayUrl',
  /** `'0'` disables the drop-box. Absent means on, because a configured relay is meant to be used. */
  relayEnabled: 'relayEnabled',
  /** `'0'` disables direct connections, leaving the drop-box. Absent means on. */
  directEnabled: 'directEnabled',
  /** Comma-separated STUN URLs. `''` means none, which still leaves LAN sync working. */
  stunUrls: 'stunUrls',
  /**
   * A user-supplied TURN server, and the credentials it issued them.
   *
   * Never defaulted and never shipped. A TURN relay sees both endpoints' addresses and every
   * byte's worth of traffic volume, which is strictly more than the drop-box sees, so it is
   * only ever something the user deliberately opts into for their own infrastructure.
   */
  turnUrl: 'turnUrl',
  turnUsername: 'turnUsername',
  turnCredential: 'turnCredential',

  // -- Relay health cache. Advisory, never consulted before syncing.

  /** The last `RelayStatus`, so the More screen reads a value rather than flickering to unknown. */
  relayStatus: 'relayStatus',
  /** When that status was measured. */
  relayCheckedAt: 'relayCheckedAt',
  /** Why it failed, in transport terms. Shown verbatim, so it may never carry finance data. */
  relayDetail: 'relayDetail',
  /** Consecutive failed pushes. Turns a reachable-but-erroring relay into `degraded`. */
  relayFailures: 'relayFailures',
  /** The highest drop-box slot this device has consumed. Blobs at or below it are never re-read. */
  relayCursor: 'relayCursor',
} as const;

export type SyncMetaKey = (typeof SYNC_META)[keyof typeof SYNC_META];

export async function readMeta(
  tx: StorageTx,
  keys: readonly SyncMetaKey[],
): Promise<Map<string, string>> {
  const rows = await tx.table('syncMeta').getMany(keys);
  return new Map(rows.map((row) => [row.key, row.value]));
}

export async function writeMeta(tx: StorageTx, entries: Partial<Record<SyncMetaKey, string>>) {
  const rows = Object.entries(entries)
    .filter((entry): entry is [SyncMetaKey, string] => entry[1] !== undefined)
    .map(([key, value]) => ({ key, value }));
  if (rows.length) await tx.table('syncMeta').put(rows);
}

const toInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * This device's chain position and clock.
 *
 * Read inside the transaction that will advance them, which is what makes two browser tabs
 * sharing one `deviceId` safe: IndexedDB serialises `rw` transactions over the same stores
 * across tabs, so two tabs cannot both allocate `seq = n + 1`. An in-memory counter would
 * fork the chain the first time the user had Qashy open twice.
 */
export interface LocalChainState {
  readonly clock: HlcClock;
  readonly head: ChainHead;
}

export async function readChainState(tx: StorageTx): Promise<LocalChainState> {
  const meta = await readMeta(tx, [
    SYNC_META.seq,
    SYNC_META.headHash,
    SYNC_META.hlcWall,
    SYNC_META.hlcCounter,
  ]);
  return {
    clock: {
      wall: toInt(meta.get(SYNC_META.hlcWall), 0),
      counter: toInt(meta.get(SYNC_META.hlcCounter), 0),
    },
    head: {
      seq: toInt(meta.get(SYNC_META.seq), 0),
      headHash: meta.get(SYNC_META.headHash) ?? GENESIS_HASH,
    },
  };
}

export const writeChainState = (tx: StorageTx, state: LocalChainState) =>
  writeMeta(tx, {
    [SYNC_META.seq]: String(state.head.seq),
    [SYNC_META.headHash]: state.head.headHash,
    [SYNC_META.hlcWall]: String(state.clock.wall),
    [SYNC_META.hlcCounter]: String(state.clock.counter),
  });

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

/** 0 for an op this device wrote, 1 for one it received. */
export type OpOrigin = 0 | 1;

export const toOpRow = (op: SyncOp, origin: OpOrigin): SyncOpRow => ({
  opId: op.opId,
  deviceId: op.deviceId,
  seq: op.seq,
  prevHash: op.prevHash,
  opHash: op.opHash,
  hlc: op.hlc,
  entityType: op.entityType,
  entityId: op.entityId,
  kind: op.kind,
  payload: canonicalJson(op.payload),
  schema: op.schema,
  signature: op.signature,
  sealed: op.signature ? 1 : 0,
  origin,
});

/**
 * Rebuilds an op from its row.
 *
 * `entityType` and `kind` are stored as plain strings and asserted back into their unions
 * here without validation, on purpose: an op from a newer app version naming a type this
 * build has never heard of must round-trip byte-for-byte so it can be forwarded. The merge
 * checks interpretability itself and files anything it does not recognise under
 * `CausalMeta.unknown` rather than trusting these types.
 */
export const fromOpRow = (row: SyncOpRow): SyncOp => ({
  opId: row.opId,
  deviceId: row.deviceId,
  seq: row.seq,
  prevHash: row.prevHash,
  opHash: row.opHash,
  hlc: row.hlc,
  entityType: row.entityType as EntityType,
  entityId: row.entityId,
  kind: row.kind as OpKind,
  payload: JSON.parse(row.payload) as Record<string, unknown>,
  schema: row.schema,
  signature: row.signature,
});

// ---------------------------------------------------------------------------
// Causal state
// ---------------------------------------------------------------------------

const toStateRow = (meta: CausalMeta): SyncStateRow => ({
  key: metaKey(meta.entityType, meta.entityId),
  type: meta.entityType,
  meta: canonicalJson(meta),
  maxHlc: meta.maxHlc,
  // Only a *live* tombstone records a reading here. A restored entity keeps its deletion
  // history inside `meta` but must not look deleted to the delta-sync query.
  deletedHlc: meta.deleted?.at ? meta.deleted.hlc : null,
});

export async function readStates(
  tx: StorageTx,
  keys: readonly string[],
): Promise<Map<string, CausalMeta>> {
  if (!keys.length) return new Map();
  const rows = await tx.table('syncState').getMany(keys);
  return new Map(rows.map((row) => [row.key, JSON.parse(row.meta) as CausalMeta]));
}

/** Every entity's causal state. Used by the full-state path and by hydration. */
export async function readAllStates(tx: StorageTx): Promise<Map<string, CausalMeta>> {
  const rows = await tx.table('syncState').all();
  return new Map(rows.map((row) => [row.key, JSON.parse(row.meta) as CausalMeta]));
}

export const writeStates = (tx: StorageTx, metas: readonly CausalMeta[]) =>
  metas.length ? tx.table('syncState').put(metas.map(toStateRow)) : Promise.resolve();

// ---------------------------------------------------------------------------
// The combined write
// ---------------------------------------------------------------------------

export interface RecordedOps {
  /** The causal state of every entity the batch touched, after folding it in. */
  readonly states: ReadonlyMap<string, CausalMeta>;
}

/**
 * Persists a batch of ops together with the causal state they produce.
 *
 * Reads only the states the batch actually touches rather than the whole table, so the cost
 * of a write is proportional to the write and not to the size of the vault.
 *
 * The chain head is advanced only for locally-originated ops. A peer's chain position is
 * tracked per peer in `sync_peers`, because `seq` here means "how many ops *this* device has
 * issued" and borrowing it for a received batch would make the next local op collide.
 */
export async function recordOps(
  tx: StorageTx,
  ops: readonly SyncOp[],
  origin: OpOrigin,
): Promise<RecordedOps> {
  if (!ops.length) return { states: new Map() };

  const keys = [...new Set(ops.map((op) => metaKey(op.entityType, op.entityId)))];
  const states = applyOps(await readStates(tx, keys), ops);

  await tx.table('syncOps').put(ops.map((op) => toOpRow(op, origin)));
  await writeStates(
    tx,
    keys.map((key) => states.get(key)!),
  );
  return { states };
}

/**
 * Stores ops **without** folding them into the causal state.
 *
 * The remote path needs this and `recordOps` would be wrong for it. A received batch is
 * verified and stored first, and only then handed to the repository, which folds it, repairs
 * the whole merged set, checks the money invariants, and writes records and causal state
 * together — or rejects the batch entirely and writes neither. Folding here would pre-commit
 * to a merge the repository may be about to refuse, and a `sync_state` that ran ahead of
 * `records` is a projection this device can never rebuild.
 *
 * Storing the ops regardless is deliberate, not a leak: they are already signed and chained,
 * so they must keep flowing to other peers even when this device cannot project them. That
 * is what stops one device's disagreement from truncating everyone else's history.
 */
export const storeOps = (tx: StorageTx, ops: readonly SyncOp[], origin: OpOrigin) =>
  ops.length ? tx.table('syncOps').put(ops.map((op) => toOpRow(op, origin))) : Promise.resolve();

export interface HeldChains {
  /** The head of every chain this device holds. */
  readonly heads: Map<string, ChainHead>;
  /**
   * `opHash` by `opId`, for the subset of `opIds` this device still holds.
   *
   * Only the asked-for subset, because the whole map would be one string per op in the vault's
   * entire history and the caller needs it for exactly the handful of ops a peer re-sent.
   * Ops that were compacted away are simply absent, which is the correct answer — this device
   * no longer holds them, so it has nothing to compare against.
   */
  readonly hashes: Map<string, string>;
}

/**
 * What this device holds of every chain, plus the hashes of specific ops it was asked about.
 *
 * Both answers come from one pass, and the second is what turns re-delivery into something
 * that can be *checked* rather than merely tolerated. An op at or below the head is dropped
 * as already-held — but "already held" and "claims to be already held" are different claims,
 * and the difference is whether a device rewrote its own history. Comparing the hash is the
 * only way to tell, and it costs nothing here because the scan is happening regardless.
 *
 * Derived from the op rows rather than tracked in `sync_meta`, and that is worth the scan. A
 * second copy of the heads would be a second thing to keep in step with the first, and the
 * failure when they drift is a phantom gap: the receiver believes it is missing ops that are
 * sitting in its own table, refuses every batch as a chain break, and never recovers on its
 * own.
 *
 * The rows are read but not parsed into ops — `payload` is the expensive field and nothing
 * here needs it, so a vault with a long history costs a table scan rather than a table scan
 * plus tens of thousands of `JSON.parse` calls.
 */
export async function readHeldChains(
  tx: StorageTx,
  opIds: ReadonlySet<string> = new Set(),
): Promise<HeldChains> {
  const heads = new Map<string, ChainHead>();
  const hashes = new Map<string, string>();
  for (const row of await tx.table('syncOps').all()) {
    const current = heads.get(row.deviceId);
    if (!current || row.seq > current.seq) {
      heads.set(row.deviceId, { seq: row.seq, headHash: row.opHash });
    }
    if (opIds.has(row.opId)) hashes.set(row.opId, row.opHash);
  }
  return { heads, hashes };
}

export interface Outbox {
  /** Sealed ops the peer is missing, ascending within each chain. */
  readonly ops: SyncOp[];
  /** Whether ops remain beyond `limit`, so the caller loops instead of guessing. */
  readonly more: boolean;
  readonly heads: Map<string, ChainHead>;
  /**
   * The lowest `seq` still held per chain — what compaction has already dropped.
   *
   * Derived rather than recorded, for the same reason `heads` is: a stored watermark is a
   * second copy that can disagree with the table it describes, and the disagreement presents
   * as sync that runs forever without converging.
   */
  readonly compactedBelow: Record<string, number>;
}

/**
 * Everything the send path needs, in a single scan of the op table.
 *
 * One pass rather than three separate helpers, because a first sync of a populated vault is
 * tens of thousands of ops sent in bounded batches — and scanning the table once per question
 * per batch turns a linear job into a quadratic one.
 *
 * Unsealed ops are excluded rather than skipped over: they have never been signed, so sending
 * one would hand a peer something it cannot verify, and *skipping* one would hand it a chain
 * with a hole. Both are rejections. They are simply not ready yet, and the background sealer
 * makes them ready a moment later.
 *
 * Sorted by device then `seq` so each chain arrives contiguous and ascending, which is what
 * `verifyChain` requires. `limit` bounds one batch; the remainder goes in the next exchange,
 * and because chains resume exactly where they left off there is nothing special about where
 * the boundary falls.
 */
export async function readOutbox(
  tx: StorageTx,
  acked: Readonly<Record<string, number>>,
  limit: number,
): Promise<Outbox> {
  const heads = new Map<string, ChainHead>();
  const compactedBelow: Record<string, number> = {};
  const pending: SyncOpRow[] = [];

  for (const row of await tx.table('syncOps').all()) {
    const head = heads.get(row.deviceId);
    if (!head || row.seq > head.seq) heads.set(row.deviceId, { seq: row.seq, headHash: row.opHash });
    const lowest = compactedBelow[row.deviceId];
    if (lowest === undefined || row.seq < lowest) compactedBelow[row.deviceId] = row.seq;
    if (row.sealed === 1 && row.seq > (acked[row.deviceId] ?? 0)) pending.push(row);
  }

  pending.sort((first, second) =>
    first.deviceId === second.deviceId
      ? first.seq - second.seq
      : first.deviceId < second.deviceId
        ? -1
        : 1,
  );
  return {
    ops: pending.slice(0, limit).map(fromOpRow),
    more: pending.length > limit,
    heads,
    compactedBelow,
  };
}

/**
 * Ops that are on disk but not reflected in the causal state.
 *
 * The self-healing half of quarantine, and the reason quarantine needs no bookkeeping of its
 * own. Three separate situations leave an op stored but unprojected — a batch the money
 * invariants refused, an op whose clock is too far ahead to trust yet, and a crash between
 * storing a batch and applying it — and all three look identical here: the entity's newest
 * op is newer than the `maxHlc` its `sync_state` row records. Running this on every
 * foreground re-offers exactly those ops, so a corrective op, a corrected clock, or simply
 * restarting the app clears them without anything having had to remember why.
 *
 * Every op for an affected entity is returned, not just the newer ones. Re-folding an op the
 * state already absorbed is idempotent, and the alternative — reasoning about which subset is
 * missing — is the kind of cleverness that fails quietly on the one case nobody tested.
 */
export async function findUnprojected(tx: StorageTx): Promise<SyncOp[]> {
  const rows = await tx.table('syncOps').all();
  if (!rows.length) return [];

  const applied = new Map((await tx.table('syncState').all()).map((row) => [row.key, row.maxHlc]));
  const byKey = new Map<string, SyncOpRow[]>();
  for (const row of rows) {
    const key = `${row.entityType}:${row.entityId}`;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  const pending: SyncOp[] = [];
  for (const [key, list] of byKey) {
    const seen = applied.get(key);
    const newest = list.reduce((highest, row) => (row.hlc > highest ? row.hlc : highest), '');
    if (seen !== undefined && newest <= seen) continue;
    for (const row of list) pending.push(fromOpRow(row));
  }
  // By HLC, so a create precedes the sets that depend on it and the caller can apply the
  // result as one batch. `seq` would order each chain correctly and every chain wrongly.
  return pending.sort((first, second) => (first.hlc < second.hlc ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

export type QuarantineReason = SyncQuarantineRow['reason'];

export const readQuarantine = (tx: StorageTx) => tx.table('syncQuarantine').all();

export const writeQuarantine = (tx: StorageTx, rows: readonly SyncQuarantineRow[]) =>
  rows.length ? tx.table('syncQuarantine').put(rows) : Promise.resolve();

export const clearQuarantine = (tx: StorageTx, keys: readonly string[]) =>
  keys.length ? tx.table('syncQuarantine').delete(keys) : Promise.resolve();

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * How many events the log keeps.
 *
 * Bounded because it is a diagnostic, not a ledger: the question it answers is "what happened
 * recently, and why did that batch not land", and a log that grows without limit answers it
 * worse, not better.
 */
export const ACTIVITY_LIMIT = 200;

export type SyncActivityInput = Omit<SyncActivityRow, 'key'>;

/**
 * Appends events and trims the oldest beyond the cap.
 *
 * Keys are a zero-padded running sequence rather than the timestamp, because two events in
 * the same millisecond are ordinary and the "last N" read is a lexicographic sort. Deriving
 * the next number from the table rather than a counter in `sync_meta` keeps it correct across
 * two tabs without a second row to keep in step.
 */
export async function appendActivity(tx: StorageTx, entries: readonly SyncActivityInput[]) {
  if (!entries.length) return;
  const table = tx.table('syncActivity');
  const existing = (await table.all()).sort((first, second) =>
    first.key < second.key ? -1 : 1,
  );
  let sequence = existing.length ? Number(existing[existing.length - 1].key) : 0;
  await table.put(
    entries.map((entry) => ({ ...entry, key: String((sequence += 1)).padStart(12, '0') })),
  );
  const overflow = existing.length + entries.length - ACTIVITY_LIMIT;
  if (overflow > 0) await table.delete(existing.slice(0, overflow).map((row) => row.key));
}

/** Newest first, which is the order every surface that shows it wants. */
export async function readActivity(tx: StorageTx, limit = ACTIVITY_LIMIT) {
  const rows = await tx.table('syncActivity').all();
  return rows.sort((first, second) => (first.key < second.key ? 1 : -1)).slice(0, limit);
}
