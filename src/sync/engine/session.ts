/**
 * The thing that actually runs sync.
 *
 * Everything else in this directory is a piece: a batch decoder, a roster, a sealer, a
 * receive path. This is the part that decides *when* each of them runs, and it has exactly
 * one entry point — `reconcile()` — because the app already has exactly one moment worth
 * hanging it on. `FinanceProvider` calls `reconcile()` on `AppState` becoming active on
 * native and on the `visibilitychange`/`focus`/`pageshow` trio on web; sync attaches there
 * rather than inventing a schedule of its own.
 *
 * There are no timers in this file, and that is a privacy decision as much as a battery one.
 * A device that polls a relay on a fixed interval is emitting a traffic pattern whether or
 * not it has anything to say, and a pattern is exactly the metadata §1.8 spends so much
 * effort not producing. Sync runs when the user opens the app.
 *
 * The pass is ordered so that each step makes the next one possible:
 *
 *   1. **seal** — sign anything the write path left unsigned. Nothing can be sent until this
 *      has happened, because only sealed ops are ever transmitted.
 *   2. **reproject** — re-offer ops that are stored but not reflected on screen. This is what
 *      un-sticks a quarantined entity after a corrective edit arrives, and it runs *before*
 *      talking to peers so the merge a peer sees is the merge this device actually holds.
 *   3. **exchange** — push each peer what it lacks, and absorb whatever it pushes back.
 *
 * A failure in one peer's exchange never stops another's. Two devices being unreachable is
 * the normal state of affairs for a phone in a pocket, and treating it as an error would mean
 * sync stops working the moment it is most needed.
 */

import type { StorageAdapter } from '@/data/storage-adapter';
import {
  SYNC_META,
  appendActivity,
  findUnprojected,
  readMeta,
  type SyncActivityInput,
} from '@/data/sync-store';
import type { FinanceRepository } from '@/data/repository';
import type { SigningSecretKey } from '@/sync/crypto';
import { isEntityType, metaKey } from '@/sync/oplog';
import { activityEntry, activityCode, transportDetail } from '@/sync/engine/activity';
import { describeFailure, healQuarantine, recordQuarantine } from '@/sync/engine/quarantine';
import { openBatch, sealBatch, type FrameContext } from '@/sync/engine/frame';
import { projectableOps, receiveBatch, type ReceiveOutcome } from '@/sync/engine/receive';
import { activePeers, readRoster, type Peer } from '@/sync/engine/roster';
import { sealPending } from '@/sync/engine/sealer';
import { buildBatch, SEND_BATCH_OPS } from '@/sync/engine/send';
import type { SyncChannel, SyncTransport } from '@/sync/engine/transport';

/**
 * How many batches one peer gets in a single pass.
 *
 * A first sync of a populated vault does not finish in one foreground, and that is fine —
 * each batch commits on arrival, so progress is permanent and the next launch resumes exactly
 * where this one stopped. The cap exists so opening the app for five seconds does not turn
 * into a several-minute upload the user cannot see or cancel.
 */
export const MAX_BATCHES_PER_PASS = 20;

export interface SyncSessionDeps {
  readonly storage: StorageAdapter;
  readonly repository: Pick<FinanceRepository, 'applyRemoteOps' | 'repairProjection'>;
  readonly deviceId: string;
  /** This device's Ed25519 secret half. Used only by the sealer, never transmitted. */
  readonly signingKey: SigningSecretKey;
  readonly frame: FrameContext;
  /** Tried in order; the first that yields a channel wins. */
  readonly transports: readonly SyncTransport[];
  readonly now: () => number;
  readonly nowIso: () => string;
  /**
   * Told about anything that went wrong, because this layer must not log.
   *
   * `no-console` is enforced across `src/sync/**`, and for good reason — a log line is the
   * easiest possible way for finance data to escape into a place nobody audits. Failures that
   * matter to the user are already written to the activity log; this hook exists for the
   * provider to surface a banner, and for a test to assert nothing was swallowed.
   *
   * `peerId` is absent when the failure was not about reaching anyone — a repair sweep over
   * this device's own projection, for instance. Blaming a peer for that would read perfectly
   * plausibly in the activity list and send the user looking at the wrong device.
   */
  readonly onError?: (error: unknown, peerId?: string) => void;
}

export interface PushOutcome {
  readonly peerId: string;
  readonly batches: number;
  readonly ops: number;
  /** Chains whose history was compacted past what this peer holds. See `send.ts`. */
  readonly needsFullState: readonly string[];
  /** True when the cap stopped the pass with work still queued. */
  readonly truncated: boolean;
}

export interface ReconcileOutcome {
  readonly sealed: number;
  readonly reprojected: number;
  readonly recovered: number;
  readonly quarantined: number;
  readonly pushed: readonly PushOutcome[];
  readonly failures: number;
}

interface ChannelCounters {
  sent: number;
}

const IDLE: ReconcileOutcome = {
  sealed: 0,
  reprojected: 0,
  recovered: 0,
  quarantined: 0,
  pushed: [],
  failures: 0,
};

export class SyncSession {
  /**
   * Per-channel *send* counters, keyed weakly so a closed channel is collectable.
   *
   * Only the sending half is counted here. The receiving half is whatever sequence arrived
   * with the frame, because the transport carries it — see `SyncChannel.send`. Counting
   * arrivals instead would make a store-and-forward transport impossible and would turn a
   * single dropped frame into a channel that never opens another one.
   *
   * The counter restarting at zero on a fresh channel is safe: the sequence is authenticated
   * rather than secret, the nonce is random per frame, and replay is already a no-op because
   * the op log drops every op it already holds. See `frame.ts`.
   */
  private readonly counters = new WeakMap<SyncChannel, ChannelCounters>();

  /**
   * Channels this session is already listening to.
   *
   * A transport is free to hand back the *same* long-lived channel on every `connect` — that
   * is what a persistent data channel is — so without this, every foreground would add
   * another receive handler to it and the tenth launch of the day would apply each incoming
   * batch ten times. Idempotent by construction is better than remembering to detach.
   */
  private readonly attached = new WeakSet<SyncChannel>();

  constructor(private readonly deps: SyncSessionDeps) {}

  /**
   * Installs the receive pump on a channel.
   *
   * The handler is deliberately fire-and-forget: a transport hands over a frame and must not
   * be made to wait on a storage transaction, and it certainly must not be handed a rejected
   * promise it has no idea what to do with. Every failure path already writes to the activity
   * log inside `receiveBatch`, so what is swallowed here is the *throw*, not the information.
   */
  attach(channel: SyncChannel): () => void {
    const detach = channel.onFrame((frame, seq) => {
      void this.absorb(channel, frame, seq);
    });
    this.attached.add(channel);
    return () => {
      this.attached.delete(channel);
      detach();
    };
  }

  /**
   * Opens and applies one frame. Resolves even when the batch is refused.
   *
   * `seq` is the sequence the transport carried, not one this device counted. A transport is
   * free to lie about it and the only outcome is a frame that fails to open, because the
   * sequence is bound into the envelope's associated data.
   */
  async absorb(channel: SyncChannel, frame: Uint8Array, seq: number): Promise<ReceiveOutcome | null> {
    try {
      const batch = openBatch(this.deps.frame, frame, channel.peerId, seq);
      return await receiveBatch(this.deps, batch);
    } catch (error) {
      this.deps.onError?.(error, channel.peerId);
      return null;
    }
  }

  /**
   * Sends a peer everything it is missing, in bounded batches.
   *
   * Loops on the sender's own `more` flag rather than on the peer's acknowledgements, because
   * an acknowledgement only arrives on the peer's next batch and waiting for one would make a
   * first sync take as many app launches as it takes batches.
   */
  async push(peer: Peer, channel: SyncChannel, limit = SEND_BATCH_OPS): Promise<PushOutcome> {
    const { storage, deviceId, signingKey, frame } = this.deps;
    const counters = this.countersFor(channel);
    let batches = 0;
    let ops = 0;
    let more = true;
    let needsFullState: readonly string[] = [];

    // A local copy of what the peer holds, advanced as each batch goes out. Without it every
    // iteration would rebuild the same batch from the same stale `acked` and send it forever.
    const acked: Record<string, number> = { ...peer.acked };

    while (more && batches < MAX_BATCHES_PER_PASS) {
      const outgoing = await buildBatch(
        { storage, deviceId, signingKey, limit },
        { ...peer, acked },
      );
      needsFullState = outgoing.needsFullState;
      if (!outgoing.batch.ops.length) {
        // Still worth one frame: the header is this device's acknowledgement, and a peer that
        // never hears our position is a peer whose compaction can never advance.
        if (!batches) {
          await channel.send(
            sealBatch(frame, outgoing.batch, peer.deviceId, counters.sent),
            counters.sent,
          );
          counters.sent += 1;
          batches += 1;
        }
        more = false;
        break;
      }

      await channel.send(
        sealBatch(frame, outgoing.batch, peer.deviceId, counters.sent),
        counters.sent,
      );
      counters.sent += 1;
      batches += 1;
      ops += outgoing.batch.ops.length;
      for (const op of outgoing.batch.ops) {
        acked[op.deviceId] = Math.max(acked[op.deviceId] ?? 0, op.seq);
      }
      more = outgoing.more;
    }

    return { peerId: peer.deviceId, batches, ops, needsFullState, truncated: more };
  }

  /**
   * One full foreground pass.
   *
   * Returns rather than throws on a peer failure. The caller is a lifecycle hook, and a hook
   * that rejects because a laptop was closed is a hook that produces an error banner every
   * single morning.
   */
  async reconcile(signal?: AbortSignal): Promise<ReconcileOutcome> {
    const { storage, deviceId, signingKey, nowIso, onError } = this.deps;

    const meta = await storage.transact((tx) => readMeta(tx, [SYNC_META.enabled]));
    if (meta.get(SYNC_META.enabled) !== '1') return IDLE;

    const sealed = await sealPending({ storage, deviceId, signingKey });
    const repair = await this.reproject();

    const roster = await storage.transact((tx) => readRoster(tx));
    const peers = activePeers(roster).filter((peer) => peer.deviceId !== deviceId);

    const pushed: PushOutcome[] = [];
    const activity: SyncActivityInput[] = [];
    let failures = 0;

    for (const peer of peers) {
      if (signal?.aborted) break;
      const channel = await this.reach(peer, signal);
      if (!channel) {
        failures += 1;
        continue;
      }
      try {
        const outcome = await this.push(peer, channel);
        pushed.push(outcome);
        if (outcome.ops) {
          activity.push(
            activityEntry({
              kind: 'sent',
              recordedAt: nowIso(),
              peerId: peer.deviceId,
              count: outcome.ops,
            }),
          );
        }
        if (outcome.needsFullState.length) {
          // Recorded rather than left implicit: this peer is behind by more than the log can
          // express, and the reason is that retention dropped the ops that would bridge it.
          activity.push(
            activityEntry({
              kind: 'compacted',
              recordedAt: nowIso(),
              peerId: peer.deviceId,
              count: outcome.needsFullState.length,
              code: 'needsFullState',
            }),
          );
        }
      } catch (error) {
        failures += 1;
        onError?.(error, peer.deviceId);
        activity.push(
          activityEntry({
            kind: 'relay',
            recordedAt: nowIso(),
            peerId: peer.deviceId,
            code: activityCode(error),
            detail: transportDetail(error),
          }),
        );
      }
    }

    if (activity.length) {
      await storage.transact((tx) => appendActivity(tx, activity), { silent: true });
    }

    return {
      sealed,
      reprojected: repair.reprojected,
      recovered: repair.recovered,
      quarantined: repair.quarantined,
      pushed,
      failures,
    };
  }

  /**
   * Re-offers ops that are on disk but not on screen.
   *
   * The self-healing half of quarantine. Three unrelated situations land here — a merge the
   * money invariants refused, an op whose clock was too far ahead to trust, and a crash
   * between storing a batch and applying it — and none of them needs to be told apart,
   * because the fix for all three is the same: try again now that something has changed.
   */
  private async reproject(): Promise<{
    readonly reprojected: number;
    readonly recovered: number;
    readonly quarantined: number;
  }> {
    const { storage, repository, now, nowIso, onError } = this.deps;
    const stored = await storage.transact((tx) => findUnprojected(tx));
    if (!stored.length) {
      // Nothing new to project, but the repair pass still has to run. Repairs are a pure
      // function of the merged op log and are re-derived every pass so that they can *un*-
      // apply — and the edit that removes a repair's cause is very often local. Delete the
      // last transaction holding a merged-in account alive and every peer that receives that
      // delete drops the resurrection, while the device that made it keeps one, because
      // nothing remote ever arrived to trigger a recompute. Sweeping here is what stops the
      // author of an edit from being the one device that disagrees about its consequences.
      try {
        await repository.repairProjection();
      } catch (error) {
        onError?.(error);
      }
      return { reprojected: 0, recovered: 0, quarantined: 0 };
    }

    const { ready, deferred } = projectableOps(stored, now());
    let applied = 0;
    let failure: unknown = null;
    if (ready.length) {
      try {
        applied = (await repository.applyRemoteOps(ready)).applied;
      } catch (error) {
        failure = error;
      }
    }

    const recordedAt = nowIso();
    const projected = failure
      ? new Set<string>()
      : new Set(
          ready
            .filter((op) => isEntityType(op.entityType))
            .map((op) => metaKey(op.entityType, op.entityId)),
        );

    return storage.transact(
      async (tx) => {
        const recovered = await healQuarantine(tx, projected);
        let quarantined = 0;
        if (failure) {
          quarantined += await recordQuarantine(
            tx,
            ready,
            'overflow',
            describeFailure(failure),
            recordedAt,
          );
        }
        if (deferred.length) {
          quarantined += await recordQuarantine(
            tx,
            deferred,
            'clockSkew',
            'clock ahead of this device',
            recordedAt,
          );
        }

        // Logged here as well as in `receiveBatch`, and it is not duplication: this is the
        // half nobody is watching. A quarantine cleared on arrival has an obvious cause — a
        // batch just landed — while one cleared here was fixed by time passing or by an app
        // restart, with nothing on screen to connect it to. "Recovered 3 records" is the only
        // answer the user will ever get to "why is it right now when it was wrong yesterday".
        //
        // No `peerId`: nothing arrived from anyone. Attributing it to a peer would be a lie
        // that reads perfectly plausibly in the activity list.
        const activity: SyncActivityInput[] = [];
        if (quarantined) {
          activity.push(
            activityEntry({
              kind: 'quarantined',
              recordedAt,
              count: quarantined,
              code: failure ? 'invariant' : 'clockSkew',
              detail: failure ? describeFailure(failure) : '',
            }),
          );
        }
        if (recovered) {
          activity.push(activityEntry({ kind: 'recovered', recordedAt, count: recovered }));
        }
        await appendActivity(tx, activity);

        return { reprojected: applied, recovered, quarantined };
      },
      { silent: true },
    );
  }

  /** The first transport that yields a channel, or null when the peer is simply not there. */
  private async reach(peer: Peer, signal?: AbortSignal): Promise<SyncChannel | null> {
    const effective = signal ?? new AbortController().signal;
    for (const transport of this.deps.transports) {
      try {
        const channel = await transport.connect(
          { deviceId: peer.deviceId, name: peer.name },
          effective,
        );
        if (!this.attached.has(channel)) this.attach(channel);
        return channel;
      } catch {
        // Unreachable over this transport is not a failure worth reporting on its own — that
        // is what a relay is the fallback *for*. Only exhausting every transport is news.
        continue;
      }
    }
    return null;
  }

  private countersFor(channel: SyncChannel): ChannelCounters {
    const existing = this.counters.get(channel);
    if (existing) return existing;
    const created: ChannelCounters = { sent: 0 };
    this.counters.set(channel, created);
    return created;
  }
}
