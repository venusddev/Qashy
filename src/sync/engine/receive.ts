/**
 * Accepting a batch from a peer.
 *
 * This is the only path by which somebody else's bytes become this device's ledger, so it is
 * the file where "fail closed" has to be literal rather than aspirational. Nothing is
 * believed because it arrived: the sender is checked against the roster, every op's signature
 * is checked against its *author's* key, and every chain is checked to continue exactly the
 * history we already accepted. Any one of those failing rejects the **whole** batch. Partial
 * application is precisely how a truncation attack succeeds quietly.
 *
 * The order is chosen so the cheapest refusal comes first and nothing expensive runs on
 * behalf of a peer that was never going to be trusted:
 *
 *   1. epoch and base currency — two integers and two strings, and both are unmergeable
 *   2. the sender is a live member of the roster and its batch signature authenticates the roster
 *   3. ops we already hold match what we hold, then drop them — re-delivery costs nothing
 *   4. every remaining op's author is known, is within its revocation cutoff, and its signature verifies
 *   5. every chain continues our history without a gap, a rewind, or a rewrite
 *
 * **All of that happens inside one storage transaction, and that is deliberate.** The roster
 * and the chain heads are read and acted on atomically, so a revocation committing in another
 * tab cannot land between the check and the write. Signature verification is synchronous —
 * `@noble/curves`, not WebCrypto — so it never leaves Dexie's promise zone, which is what
 * makes holding the transaction open across it legal rather than merely convenient.
 *
 * Then the two-phase split the storage contract forces: ops are stored here, and the
 * *projection* is the repository's job in its own transaction afterwards. Storing regardless
 * of whether the projection succeeds is the point — a signed, chained op must keep flowing to
 * other peers even when this device cannot render it, or one device's disagreement truncates
 * everybody's history.
 */

import type { StorageAdapter, StorageTx } from '@/data/storage-adapter';
import {
  SYNC_META,
  appendActivity,
  fromOpRow,
  readChainState,
  readHeldChains,
  readMeta,
  storeOps,
  writeMeta,
  type SyncActivityInput,
} from '@/data/sync-store';
import type { ApplyResult, FinanceRepository } from '@/data/repository';
import type { EntityType } from '@/domain/models';
import {
  GENESIS_HASH,
  MAX_CLOCK_SKEW_MS,
  OpLogError,
  hasCompleteKnownRegisters,
  isEntityType,
  metaKey,
  observe,
  parseHlc,
  pendingByDevice,
  verifyChain,
  verifyOpSignature,
  type ChainHead,
  type HlcClock,
  type SyncOp,
} from '@/sync/oplog';
import { activityEntry, rejectionEntry } from '@/sync/engine/activity';
import { verifyBatchAuthentication } from '@/sync/engine/batch';
import { describeFailure, healQuarantine, recordQuarantine } from '@/sync/engine/quarantine';
import {
  mergeAuthenticatedRoster,
  mergeHeads,
  readRoster,
  requireAuthor,
  requireAuthorSequence,
  requireSender,
  writePeers,
} from '@/sync/engine/roster';
import { SyncEngineError, type RejectionCode, type SyncBatch } from '@/sync/engine/types';
import { RevocationError, deriveRevocationState } from '@/sync/revocation';

export interface ReceiveDeps {
  readonly storage: StorageAdapter;
  /** Only `applyRemoteOps` is used; narrowed so tests can stand in a two-line double. */
  readonly repository: Pick<FinanceRepository, 'applyRemoteOps'>;
  /** Injected so a test can advance time without waiting for it. */
  readonly now: () => number;
  readonly nowIso: () => string;
}

export interface ReceiveOutcome {
  readonly peerId: string;
  /** Ops that were new to this device and are now on disk. */
  readonly stored: number;
  /** Ops the repository folded into the projection. */
  readonly applied: number;
  readonly changedTypes: readonly EntityType[];
  /** Entities held back, either by a refused merge or by a clock too far ahead to trust. */
  readonly quarantined: number;
  /** Entities a previously-refused merge no longer applies to. */
  readonly recovered: number;
  readonly activity: readonly SyncActivityInput[];
}

const EMPTY_APPLY: ApplyResult = { applied: 0, changedTypes: [], repairs: [] };

/**
 * Restates a chain failure in the engine's own vocabulary.
 *
 * `verifyChain` throws `OpLogError`, which is right for a pure module that knows nothing
 * about peers — but a caller two layers up should not have to know which of three error
 * classes a rejection might arrive as.
 *
 * Only a gap and a fork survive as themselves, because only those two lead the user anywhere:
 * a gap usually heals on the next full exchange, a fork never heals and means a device's log
 * was rewritten. Everything else collapses into `badBatch`, which is honest — an op whose
 * hash disagrees with its own contents and an op that was never a valid op are the same
 * problem with the same fix, which is to resend.
 */
const CHAIN_CODES: Partial<Record<OpLogError['code'], RejectionCode>> = {
  chainBreak: 'chainBreak',
  chainFork: 'chainFork',
};

function asEngineError(error: unknown, peerId: string): unknown {
  if (!(error instanceof OpLogError)) return error;
  return new SyncEngineError(error.message, CHAIN_CODES[error.code] ?? 'badBatch', peerId);
}

/**
 * Splits ops into what can be projected now and what has to wait for the clock.
 *
 * An op whose wall clock is further ahead than the tolerated skew is not evidence of an
 * attack and not evidence of corruption — it is almost always a device whose time is simply
 * wrong. Applying it would drag every subsequent local edit to sort *after* it, so a single
 * mis-set phone would push the entire vault's ordering years into the future and every real
 * edit made afterwards would silently lose to it.
 *
 * So it is held, not dropped: stored, forwarded, and re-offered on every foreground until
 * local time catches up or the other device's clock is corrected. Filtering per op rather
 * than per entity matters — an entity whose `create` is fine and whose newest `set` is skewed
 * still projects, at its previous values, instead of vanishing from the app entirely.
 */
export function projectableOps(
  ops: readonly SyncOp[],
  nowMs: number,
): { readonly ready: SyncOp[]; readonly deferred: SyncOp[] } {
  const horizon = Math.floor(nowMs) + MAX_CLOCK_SKEW_MS;
  const ready: SyncOp[] = [];
  const deferred: SyncOp[] = [];
  for (const op of ops) (parseHlc(op.hlc).wall > horizon ? deferred : ready).push(op);
  return { ready, deferred };
}

/** `{ [deviceId]: seq }`, the shape a batch header and a peer row both want. */
export const headsRecord = (heads: ReadonlyMap<string, ChainHead>): Record<string, number> =>
  Object.fromEntries([...heads].map(([deviceId, head]) => [deviceId, head.seq]));

/** Folds a batch's readings into the local clock, one op at a time. */
const clockAfter = (clock: HlcClock, ops: readonly SyncOp[], nowMs: number): HlcClock =>
  ops.reduce((current, op) => observe(current, op.hlc, nowMs).clock, clock);

/**
 * The verified half: everything that must be atomic with reading the roster.
 *
 * Returns the ops that were new, having already written them and updated the sender's row.
 * Throws — always before writing anything — if the batch is not acceptable.
 */
async function verifyAndStore(
  tx: StorageTx,
  batch: SyncBatch,
  nowMs: number,
  nowIso: string,
): Promise<SyncOp[]> {
  const meta = await readMeta(tx, [
    SYNC_META.epoch,
    SYNC_META.baseCurrency,
    SYNC_META.deviceId,
    SYNC_META.ownerDeviceId,
    SYNC_META.revocationMode,
  ]);

  const epoch = Number(meta.get(SYNC_META.epoch) ?? '1');
  if (batch.epoch !== epoch) {
    throw new SyncEngineError(
      `That batch was sealed under an older version of this vault's key.`,
      'epochMismatch',
      batch.sender,
    );
  }

  // An empty local base currency means this device has not been onboarded or seeded yet —
  // a fresh restore from a recovery phrase, before any settings exist. There is nothing to
  // disagree with, so there is nothing to refuse; the first batch establishes it.
  const baseCurrency = meta.get(SYNC_META.baseCurrency) ?? '';
  if (baseCurrency && baseCurrency !== batch.baseCurrency) {
    throw new SyncEngineError(
      `These devices use different base currencies — ${baseCurrency} and ${batch.baseCurrency}. Syncing would corrupt your totals.`,
      'currencyMismatch',
      batch.sender,
    );
  }

  const storedRoster = await readRoster(tx);
  const sender = requireSender(storedRoster, batch.sender);
  if (!verifyBatchAuthentication(batch, sender.signingKey)) {
    throw new SyncEngineError(
      'That batch was not signed by the device it claims to come from.',
      'badSignature',
      batch.sender,
    );
  }
  const { heads: held, hashes } = await readHeldChains(
    tx,
    new Set(batch.ops.map((op) => op.opId)),
  );
  const rosterMerge = mergeAuthenticatedRoster(
    storedRoster,
    batch.roster,
    batch.epoch,
    batch.sender,
    held,
    meta.get(SYNC_META.deviceId) ?? '',
  );
  const roster = rosterMerge.roster;

  // Re-delivery is ordinary: a relay hands back overlapping ranges, and a peer that lost its
  // ack record resends from the start. Every one of those ops is dropped as already-held a
  // line below. But *identical* re-delivery and *contradictory* re-delivery are different
  // events with different consequences, and the drop alone cannot tell them apart. An op that
  // occupies a position we already filled, with different contents, means that device's log
  // was rewritten — the one failure in this whole system that never heals on its own and that
  // the user genuinely has to be told about, because the fix is to un-pair the device.
  //
  // Nothing is applied either way, so this is detection rather than defence. That is exactly
  // why it has to be explicit: silence here would be indistinguishable from working.
  for (const op of batch.ops) {
    const known = hashes.get(op.opId);
    if (known !== undefined && known !== op.opHash) {
      throw new SyncEngineError(
        `${sender.name} sent a different version of a change this vault already accepted (${op.opId}). That device's history has been rewritten.`,
        'chainFork',
        batch.sender,
      );
    }
  }

  const chains = pendingByDevice(batch.ops, held);

  const accepted: SyncOp[] = [];
  for (const [deviceId, ops] of chains) {
    // The author, not the sender. A laptop that has been closed for a week catches up on the
    // phone's history through the tablet, so these are routinely different devices — and the
    // author is allowed to be revoked, because what it wrote while it was a member is still
    // history everybody else holds.
    const author = requireAuthor(roster, deviceId, batch.sender);
    for (const op of ops) {
      requireAuthorSequence(author, op.seq);
      if (!op.signature) {
        throw new SyncEngineError(
          `Op ${op.opId} arrived without a signature.`,
          'unsignedOp',
          batch.sender,
        );
      }
      if (!verifyOpSignature(op, author.signingKey)) {
        throw new SyncEngineError(
          `Op ${op.opId} was not signed by the device it claims to come from.`,
          'badSignature',
          batch.sender,
        );
      }
      if (!hasCompleteKnownRegisters(op)) {
        throw new SyncEngineError(
          `Op ${op.opId} contains a partial field group and cannot be applied safely.`,
          'badBatch',
          batch.sender,
        );
      }
    }
    try {
      held.set(deviceId, verifyChain(ops, held.get(deviceId) ?? { seq: 0, headHash: GENESIS_HASH }));
    } catch (error) {
      throw asEngineError(error, batch.sender);
    }
    accepted.push(...ops);
  }

  // Past every refusal. From here the batch is being kept.
  let revocations: ReturnType<typeof deriveRevocationState>['revocations'];
  try {
    const existing = (await tx.table('syncOps').all()).map(fromOpRow);
    const initial = {
      ownerDeviceId: meta.get(SYNC_META.ownerDeviceId) ?? (meta.get(SYNC_META.deviceId) ?? ''),
      mode: meta.get(SYNC_META.revocationMode) === 'quorum'
        ? 'quorum' as const
        : meta.get(SYNC_META.revocationMode) === 'owner'
          ? 'owner' as const
          : 'any' as const,
    };
    revocations = deriveRevocationState([...existing, ...accepted], roster, initial, meta.get(SYNC_META.deviceId) ?? '').revocations;
  } catch (error) {
    if (error instanceof RevocationError) {
      throw new SyncEngineError(error.message, 'badBatch', batch.sender);
    }
    throw error;
  }
  await storeOps(tx, accepted, 1);

  // The local clock adopts the batch's readings so the next local edit sorts after them.
  // `observe` refuses to be dragged past the skew horizon on its own, so a device with a
  // badly wrong clock cannot push this one forward by sending a single op.
  if (accepted.length) {
    const clock = clockAfter((await readChainState(tx)).clock, accepted, nowMs);
    await writeMeta(tx, {
      [SYNC_META.hlcWall]: String(clock.wall),
      [SYNC_META.hlcCounter]: String(clock.counter),
    });
  }

  await writePeers(tx, [
    ...rosterMerge.changed.filter((peer) => peer.deviceId !== sender.deviceId),
    {
      ...(roster.get(sender.deviceId) ?? sender),
      // What the peer holds — monotone, so a blob that sat in a relay bucket for a week
      // cannot rewind the watermark compaction depends on.
      acked: mergeHeads(sender.acked, batch.heads),
      // What *we* hold, so the sync screen can say how far behind a peer is without
      // rescanning the op table on every render.
      known: headsRecord(held),
      lastSeenAt: nowIso,
    },
    ...revocations.flatMap((decision) => {
      const peer = roster.get(decision.targetId);
      return peer && !peer.revokedAt
        ? [{ ...peer, revokedAt: decision.at, revokedSeq: decision.cutoff }]
        : [];
    }),
  ]);

  return accepted;
}

/**
 * Verifies, stores, and projects one batch.
 *
 * Throws on a rejected batch, having recorded why, because the caller has to know it failed —
 * a transport that treats a rejection as delivery will keep sending into a wall forever. It
 * does *not* throw when the projection fails: those ops are on disk and on their way to other
 * peers, and the only thing that did not happen is a local screen update.
 */
export async function receiveBatch(
  deps: ReceiveDeps,
  batch: SyncBatch,
): Promise<ReceiveOutcome> {
  const { storage, repository, now, nowIso } = deps;
  const receivedAt = nowIso();

  let accepted: SyncOp[];
  try {
    accepted = await storage.transact((tx) => verifyAndStore(tx, batch, now(), receivedAt), {
      // Nothing a repository subscriber can observe has changed yet: `records` is untouched
      // and the projection is the next step. Notifying here would redraw every screen with
      // the same data and then redraw it again a moment later with the real merge.
      silent: true,
    });
  } catch (error) {
    const entry = rejectionEntry(error, batch.sender, receivedAt);
    await storage.transact((tx) => appendActivity(tx, [entry]), { silent: true });
    throw error;
  }

  const { ready, deferred } = projectableOps(accepted, now());

  let result = EMPTY_APPLY;
  let failure: unknown = null;
  if (ready.length) {
    try {
      result = await repository.applyRemoteOps(ready);
    } catch (error) {
      failure = error;
    }
  }

  // Only entities the repository could actually have projected count as healed. An op naming
  // an entity type this build has never heard of is stored and forwarded but not rendered,
  // so clearing a quarantine row on its behalf would claim a fix that did not happen.
  const projected = failure
    ? new Set<string>()
    : new Set(
        ready
          .filter((op) => isEntityType(op.entityType))
          .map((op) => metaKey(op.entityType, op.entityId)),
      );

  const activity: SyncActivityInput[] = [];
  const counts = await storage.transact(
    async (tx) => {
      const recovered = await healQuarantine(tx, projected);
      let quarantined = 0;
      if (failure) {
        quarantined += await recordQuarantine(
          tx,
          ready,
          'overflow',
          describeFailure(failure),
          receivedAt,
        );
      }
      if (deferred.length) {
        quarantined += await recordQuarantine(
          tx,
          deferred,
          'clockSkew',
          'clock ahead of this device',
          receivedAt,
        );
      }
      return { recovered, quarantined };
    },
    { silent: true },
  );

  if (result.applied) {
    activity.push(
      activityEntry({
        kind: 'received',
        recordedAt: receivedAt,
        peerId: batch.sender,
        count: result.applied,
      }),
    );
  }
  if (counts.quarantined) {
    activity.push(
      activityEntry({
        kind: 'quarantined',
        recordedAt: receivedAt,
        peerId: batch.sender,
        count: counts.quarantined,
        code: failure ? 'invariant' : 'clockSkew',
        detail: failure ? describeFailure(failure) : '',
      }),
    );
  }
  if (counts.recovered) {
    activity.push(
      activityEntry({
        kind: 'recovered',
        recordedAt: receivedAt,
        peerId: batch.sender,
        count: counts.recovered,
      }),
    );
  }
  if (activity.length) {
    await storage.transact((tx) => appendActivity(tx, activity), { silent: true });
  }

  return {
    peerId: batch.sender,
    stored: accepted.length,
    applied: result.applied,
    changedTypes: result.changedTypes,
    quarantined: counts.quarantined,
    recovered: counts.recovered,
    activity,
  };
}
