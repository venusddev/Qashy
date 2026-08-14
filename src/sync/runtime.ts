/**
 * The one place that turns configuration into a running sync.
 *
 * Everything below this file is deliberately incapable of starting itself. `SyncSession` is
 * handed transports and a key; `RelayTransport` is handed a bucket id it could not derive;
 * `DirectTransport` is handed a rendezvous it did not compute. That is what makes each of
 * them testable without a keystore, a network, or a clock — and it leaves exactly one file
 * that has to know how the pieces fit, which is this one.
 *
 * Three things it owns, and they are the three that were nobody else's job:
 *
 * 1. **Deriving the vault's public-facing identifiers** — bucket id, write token, route tags,
 *    rendezvous — from the root key, so no transport ever holds one. A transport that cannot
 *    reach a key cannot leak one.
 * 2. **Deciding which transports exist at all.** Direct is offered only when this build can do
 *    WebRTC and the user has not switched it off; the drop-box only when an address is
 *    configured. A user who blanks the relay address gets a device that genuinely contacts
 *    nothing but its peers, and that has to be true of the object graph, not just the UI.
 * 3. **Keeping them alive between passes.** A WebRTC data channel takes seconds and two
 *    servers' worth of round trips to establish; rebuilding the transports on every foreground
 *    to refresh a rotating rendezvous id would throw away the connection each time. The
 *    transports are cached and only rebuilt when something they were built from actually
 *    changed — see `fingerprint`.
 *
 * There are still no timers here. `reconcile()` is called from the same lifecycle seam the
 * repository's own reconcile hangs on, and the relay is contacted then and at no other moment.
 */

import type { StorageAdapter } from '@/data/storage-adapter';
import type { FinanceRepository } from '@/data/repository';
import { fetch as expoFetch } from 'expo/fetch';
import { SYNC_META, readMeta, writeMeta } from '@/data/sync-store';
import {
  deriveBucketId,
  deriveBucketToken,
  deriveContentKey,
  deriveRendezvousId,
  deriveRouteTag,
  rendezvousWindow,
  toBase64Url,
} from '@/sync/crypto';
import { KeystoreError, type StoredVault, type SyncKeystore } from '@/sync/keystore';
import { SyncSession, type ReconcileOutcome } from '@/sync/engine/session';
import type { SyncTransport } from '@/sync/engine/transport';
import { DirectTransport } from '@/sync/transport/direct';
import { readEndpoints, type SyncEndpoints } from '@/sync/transport/endpoints';
import { FileTransport, decodeBundle, encodeBundle } from '@/sync/transport/file';
import { RelayTransport } from '@/sync/transport/relay';
import {
  checkRelayHealth,
  noteRelayFailure,
  noteRelaySuccess,
  readRelayHealth,
  type RelayHealth,
} from '@/sync/transport/relay-health';
import type { RawSocket } from '@/sync/transport/signaling';
import { rtcFactory as platformRtcFactory } from '@/sync/transport/webrtc';
import type { RtcFactory } from '@/sync/transport/webrtc-core';
import { nowIso as defaultNowIso } from '@/utils/entity';

/**
 * Why a pass did nothing.
 *
 * Separated from "it ran and found nothing to do" because the two lead to opposite UI. A
 * device that is simply up to date should say so; one whose keystore is locked should be
 * offering an unlock, and one that was never paired should be offering to pair.
 */
export type SyncPassReason =
  /** The pass ran. */
  | 'ok'
  /** Sync has not been switched on. The default, and not a problem. */
  | 'disabled'
  /** Switched on, but this device holds no vault. Pairing was never completed. */
  | 'unpaired'
  /** A vault is stored behind a passphrase gate that has not been opened this session. */
  | 'locked'
  /** This platform cannot store a key safely, or what is stored is not readable. */
  | 'unavailable';

export interface SyncPass {
  readonly reason: SyncPassReason;
  /** Null unless `reason` is `'ok'`. */
  readonly outcome: ReconcileOutcome | null;
  /** Always populated — the relay's status is worth showing even when sync did not run. */
  readonly health: RelayHealth;
}

export interface BundleExport {
  readonly reason: SyncPassReason;
  /** The `.qashysync` text, or `''` when the pass did not run. */
  readonly text: string;
  readonly frames: number;
  /** How many peers the file carries something for. Zero means everyone is already current. */
  readonly peers: number;
}

export interface BundleImport {
  readonly reason: SyncPassReason;
  /** The device that wrote the file, as it claims. Shown, never trusted — see `importBundle`. */
  readonly from: string;
  /** Frames in the file addressed to this device. */
  readonly accepted: number;
  /** Frames addressed to a different device. Not an error; a three-device vault makes several. */
  readonly skipped: number;
  readonly applied: number;
  readonly rejected: number;
}

export interface SyncRuntimeDeps {
  readonly storage: StorageAdapter;
  readonly repository: Pick<FinanceRepository, 'applyRemoteOps' | 'repairProjection'>;
  readonly keystore: SyncKeystore;
  /** Injected so the whole runtime can be exercised without a network. */
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly nowIso?: () => string;
  /** Overridden in tests; on device it is whatever WebRTC this build has, or none. */
  readonly rtcFactory?: RtcFactory;
  readonly openSocket?: (url: string) => RawSocket;
  readonly requestTimeoutMs?: number;
  /** Relay upload jitter. Set to zero in tests so a pass is instant. */
  readonly uploadJitterMs?: number;
  /**
   * Told about anything that failed outside the activity log's reach.
   *
   * This layer must not log — `no-console` is enforced across `src/sync/**` — and a failure
   * swallowed here would be a device that quietly stops syncing. Everything the user needs to
   * see is already written to the activity table; this is the provider's hook for a banner.
   */
  readonly onError?: (error: unknown, peerId?: string) => void;
}

interface Wiring {
  /** What this wiring was built from. A change to any part of it invalidates the whole. */
  readonly fingerprint: string;
  readonly session: SyncSession;
  readonly transports: readonly SyncTransport[];
  readonly relay: RelayTransport | null;
}

export class SyncRuntime {
  private wiring: Wiring | null = null;

  /**
   * Health writes, serialised.
   *
   * Uploads finish concurrently across peers, and two `noteRelayFailure` transactions racing
   * each other would both read the same count and both write it plus one — turning three
   * consecutive failures into a total of two and never reaching the threshold that makes the
   * relay read as degraded.
   */
  private healthWrites: Promise<void> = Promise.resolve();

  /**
   * The last upload result written, so a clean pass writes once rather than once per frame.
   *
   * A twenty-batch first sync would otherwise open twenty transactions to record the same
   * "still fine". Failures always write, because each one carries a count.
   */
  private lastUpload: 'ok' | 'failed' | null = null;

  constructor(private readonly deps: SyncRuntimeDeps) {}

  /**
   * The transports in use right now, in the order the session tries them.
   *
   * Empty until the first pass wires anything. The sync screen reads it to say whether this
   * device can reach a peer directly or only through the drop-box, which is the difference
   * between "your laptop will pick this up in a moment" and "when you next open it".
   */
  get transports(): readonly SyncTransport[] {
    return this.wiring?.transports ?? [];
  }

  /** The cached verdict, with no network access. Safe to call on every paint. */
  health(): Promise<RelayHealth> {
    return this.deps.storage.transact((tx) => readRelayHealth(tx));
  }

  /**
   * Measures the relay now. Backs the "Check now" button.
   *
   * Never throws; a health check that can fail is a health check that produces an error banner
   * every time a laptop is opened on a train.
   */
  checkRelay(signal?: AbortSignal): Promise<RelayHealth> {
    const { storage, nowIso = defaultNowIso, requestTimeoutMs } = this.deps;
    return checkRelayHealth({
      fetch: this.deps.fetch ?? expoFetch,
      timeoutMs: requestTimeoutMs,
      transact: (work) => storage.transact(work, { silent: true }),
      nowIso,
      signal,
    });
  }

  /**
   * One full pass: seal, reproject, exchange with every peer, then measure the relay.
   *
   * Health is measured *after* the exchange rather than before, and the order is the whole
   * point: a relay that answers `/health` while refusing every upload is exactly the case a
   * pre-flight probe reports as fine. Checking afterwards folds this pass's uploads into the
   * verdict, so "relay errors" appears on the launch it happened rather than the next one.
   */
  async reconcile(signal?: AbortSignal): Promise<SyncPass> {
    const { storage } = this.deps;

    const [enabled, endpoints] = await storage.transact(async (tx) => {
      const meta = await readMeta(tx, [SYNC_META.enabled]);
      return [meta.get(SYNC_META.enabled) === '1', await readEndpoints(tx)] as const;
    });

    if (!enabled) {
      // Closed rather than left holding a data channel. "Off" that keeps a socket open to
      // another device is not off, and the switch would be a lie.
      await this.close();
      return { reason: 'disabled', outcome: null, health: await this.health() };
    }

    const vault = await this.readVault();
    if (typeof vault === 'string') {
      await this.close();
      return { reason: vault, outcome: null, health: await this.health() };
    }

    const wiring = this.wire(vault, endpoints);
    const outcome = await wiring.session.reconcile(signal);

    // Drained before measuring, so the run of upload failures this pass produced is the run
    // the verdict is computed from.
    await this.healthWrites;
    const health = endpoints.relayUrl && endpoints.relayEnabled
      ? await this.checkRelay(signal)
      : await this.health();

    return { reason: 'ok', outcome, health };
  }

  /** Tears down every connection. Called on sign-out, reset, and when sync is switched off. */
  async close(): Promise<void> {
    const held = this.wiring;
    this.wiring = null;
    this.lastUpload = null;
    if (!held) return;
    await Promise.all(held.transports.map((transport) => transport.close()));
  }

  /**
   * Seals everything the peers are missing into one file the user carries themselves.
   *
   * The whole point of this path is that it involves nobody. No relay, no signaling, no STUN,
   * no WebRTC — export here, move the file by whatever means you like, import it there. It is
   * the answer when the relay is down, when two devices are never on the same network, and
   * when someone would simply rather no server existed at all.
   *
   * This runs a **full pass** rather than reaching into the outbox directly, so a bundle is
   * built from the same sealed, reprojected, repaired state a live sync would send. Doing it
   * by hand would be a second definition of "what does this peer still need", and the two
   * would drift.
   *
   * Exporting twice is harmless. Delivery is tracked by the peer's acknowledgement, not by
   * the act of sending, so ops stay queued until a peer confirms them and a file that is
   * never opened costs nothing but a second export.
   */
  async exportBundle(signal?: AbortSignal): Promise<BundleExport> {
    const wired = await this.fileWiring();
    if (typeof wired === 'string') return { reason: wired, text: '', frames: 0, peers: 0 };

    try {
      const outcome = await wired.session.reconcile(signal);
      const bundle = wired.file.bundle();
      return {
        reason: 'ok',
        text: encodeBundle(bundle),
        frames: bundle.frames.length,
        peers: outcome.pushed.filter((push) => push.ops > 0 || push.needsFullState.length > 0).length,
      };
    } finally {
      await wired.file.close();
    }
  }

  /**
   * Applies a `.qashysync` file exported by another device in this vault.
   *
   * `bundle.from` is used to name the channel and for nothing else, and it does not need to be
   * trusted: every frame's sender, recipient, epoch, and sequence are bound into its associated
   * data, so a file claiming to come from the wrong device produces frames that do not open.
   * The failure is a rejection, not a bad merge.
   *
   * Frames are applied **one at a time, in file order**, which is the reason this does not
   * simply hand the channel to `session.attach`. That pump is fire-and-forget — right for a
   * live transport, where frames arrive spread over a connection — but here every frame is
   * present at once, and letting a dozen `absorb` calls interleave would offer batches to the
   * chain verifier out of order. Each would then be rejected as a gap, and the import would
   * fail wholesale on a file that is perfectly good.
   */
  async importBundle(text: string): Promise<BundleImport> {
    // Decoded before anything reaches for a key, so a file that is not a bundle at all is
    // refused instantly rather than after a Keychain or passphrase prompt.
    const bundle = decodeBundle(text);

    const wired = await this.fileWiring();
    if (typeof wired === 'string') {
      return {
        reason: wired,
        from: bundle.from,
        accepted: 0,
        skipped: bundle.frames.length,
        applied: 0,
        rejected: 0,
      };
    }

    try {
      const channel = await wired.file.connect({ deviceId: bundle.from, name: '' });
      const collected: { frame: Uint8Array; seq: number }[] = [];
      const detach = channel.onFrame((frame, seq) => {
        collected.push({ frame, seq });
      });
      // `ingest` drops frames addressed to another device by comparing route tags, so what is
      // collected is exactly this device's share of the file.
      wired.file.ingest(bundle);
      detach();

      let applied = 0;
      let rejected = 0;
      for (const held of collected) {
        const outcome = await wired.session.absorb(channel, held.frame, held.seq);
        if (outcome) applied += outcome.applied;
        else rejected += 1;
      }

      return {
        reason: 'ok',
        from: bundle.from,
        accepted: collected.length,
        skipped: bundle.frames.length - collected.length,
        applied,
        rejected,
      };
    } finally {
      await wired.file.close();
    }
  }

  /**
   * Empties this vault's drop-box.
   *
   * A courtesy rather than a security measure — the blobs expire on their own and are
   * unreadable regardless — but leaving a fortnight of undeliverable ciphertext on someone
   * else's server when the vault it belongs to no longer exists is untidy in a way this app
   * should not be. Silently does nothing when no relay is configured.
   */
  async purgeRelay(): Promise<void> {
    const endpoints = await this.deps.storage.transact((tx) => readEndpoints(tx));
    if (!endpoints.relayUrl) return;
    const vault = await this.readVault();
    if (typeof vault === 'string') return;
    await this.buildRelay(vault, endpoints)?.purge();
  }

  /** The vault, or the reason there isn't one. */
  private async readVault(): Promise<StoredVault | Exclude<SyncPassReason, 'ok' | 'disabled'>> {
    try {
      const vault = await this.deps.keystore.read();
      return vault ?? 'unpaired';
    } catch (error) {
      // Narrow rather than a blanket catch: a locked keystore is an ordinary state with an
      // obvious remedy, and a corrupt one is a bug. Swallowing anything else here would hide
      // a real failure behind "not paired yet" and send the user to re-pair a working vault.
      if (error instanceof KeystoreError) {
        return error.code === 'locked' ? 'locked' : 'unavailable';
      }
      throw error;
    }
  }

  /**
   * The transports and session for this vault and configuration, reusing them when nothing
   * relevant has changed.
   *
   * The fingerprint is what makes reuse safe. Rebuilding on every pass would drop live data
   * channels; never rebuilding would leave a device uploading to a relay the user replaced
   * ten minutes ago, or sealing under a key that has since been rotated.
   */
  private wire(vault: StoredVault, endpoints: SyncEndpoints): Wiring {
    const fingerprint = [
      vault.identity.deviceId,
      vault.epoch,
      endpoints.relayUrl,
      endpoints.relayEnabled ? '1' : '0',
      endpoints.directEnabled ? '1' : '0',
      // Username and credential ride along with the URL: the transport hands them to the ICE
      // agent at connection time, so a credential-only change must rebuild the wiring or the
      // direct path would keep authenticating with the old one.
      endpoints.iceServers
        .map((server) => `${server.urls}|${server.username ?? ''}|${server.credential ?? ''}`)
        .join(' '),
    ].join('\0');

    const held = this.wiring;
    if (held?.fingerprint === fingerprint) return held;
    // Not awaited: the caller wants a session now, and the old wiring's teardown is a set of
    // channel closes with nothing to report. Errors go to `onError` rather than nowhere.
    if (held) {
      void Promise.all(held.transports.map((transport) => transport.close())).catch(
        (error: unknown) => this.deps.onError?.(error),
      );
    }

    const relay = this.buildRelay(vault, endpoints);
    const direct = this.buildDirect(vault, endpoints);

    // Direct first, always. It is the path that contacts no server once established, and the
    // drop-box exists to cover the case where it cannot be made — not to be preferred to it.
    const transports: SyncTransport[] = [];
    if (direct) transports.push(direct);
    if (relay) transports.push(relay);

    const built: Wiring = {
      fingerprint,
      session: this.buildSession(vault, transports),
      transports,
      relay,
    };
    this.wiring = built;
    this.lastUpload = null;
    return built;
  }

  /**
   * A session over the given transports.
   *
   * Shared by the cached wiring and the one-shot file path so the frame context is derived in
   * exactly one place. Two constructions of `{ key, deviceId, epoch }` could disagree about the
   * epoch after a rotation, and a bundle sealed under a stale epoch is one every peer refuses
   * for a reason nobody would think to look for in an export button.
   */
  private buildSession(vault: StoredVault, transports: readonly SyncTransport[]): SyncSession {
    return new SyncSession({
      storage: this.deps.storage,
      repository: this.deps.repository,
      deviceId: vault.identity.deviceId,
      signingKey: vault.identity.signing.secretKey,
      frame: {
        key: deriveContentKey(vault.vaultKey),
        deviceId: vault.identity.deviceId,
        epoch: vault.epoch,
      },
      transports,
      now: this.deps.now ?? Date.now,
      nowIso: this.deps.nowIso ?? defaultNowIso,
      onError: this.deps.onError,
    });
  }

  /**
   * A throwaway file transport and the session that drives it, or why there isn't one.
   *
   * Deliberately not cached alongside `this.wiring`. A `FileTransport` accumulates the frames
   * it was handed so it can write them out, so a cached one would grow for the life of the app
   * and a second export would contain the first export's frames as well. It is also the one
   * transport with nothing to keep alive — there is no connection to preserve between passes.
   */
  private async fileWiring(): Promise<
    { readonly file: FileTransport; readonly session: SyncSession } | Exclude<SyncPassReason, 'ok'>
  > {
    const enabled = await this.deps.storage.transact(async (tx) => {
      const meta = await readMeta(tx, [SYNC_META.enabled]);
      return meta.get(SYNC_META.enabled) === '1';
    });
    // Checked rather than inferred from an empty bundle. Change capture is armed only while
    // sync is on, so exporting with it off would produce a valid, empty, entirely misleading
    // file, and importing would apply frames this device has no op log to reconcile against.
    if (!enabled) return 'disabled';

    const vault = await this.readVault();
    if (typeof vault === 'string') return vault;

    const file = new FileTransport({
      deviceId: vault.identity.deviceId,
      selfTag: deriveRouteTag(vault.vaultKey, vault.identity.deviceId),
      tagFor: (peerId) => deriveRouteTag(vault.vaultKey, peerId),
    });
    return { file, session: this.buildSession(vault, [file]) };
  }

  private buildRelay(vault: StoredVault, endpoints: SyncEndpoints): RelayTransport | null {
    if (!endpoints.relayUrl || !endpoints.relayEnabled) return null;
    const { storage } = this.deps;

    return new RelayTransport({
      fetch: this.deps.fetch ?? expoFetch,
      timeoutMs: this.deps.requestTimeoutMs,
      baseUrl: endpoints.relayUrl,
      bucketId: deriveBucketId(vault.vaultKey),
      token: toBase64Url(deriveBucketToken(vault.vaultKey)),
      selfTag: deriveRouteTag(vault.vaultKey, vault.identity.deviceId),
      tagFor: (peerId) => deriveRouteTag(vault.vaultKey, peerId),
      // The cursor is device-local and non-secret: it counts slots in the bucket, and a
      // reader who knew it would learn how far behind this device is and nothing else.
      readCursor: () =>
        storage.transact(async (tx) => {
          const meta = await readMeta(tx, [SYNC_META.relayCursor]);
          const stored = Number(meta.get(SYNC_META.relayCursor));
          return Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
        }),
      writeCursor: (slot) =>
        storage.transact((tx) => writeMeta(tx, { [SYNC_META.relayCursor]: String(slot) }), {
          silent: true,
        }),
      onUpload: (error) => this.noteUpload(error),
      jitterMs: this.deps.uploadJitterMs,
    });
  }

  private buildDirect(vault: StoredVault, endpoints: SyncEndpoints): DirectTransport | null {
    // A rendezvous is the one thing the direct path cannot do without. Two devices have to
    // agree on a meeting point before they can describe a connection to each other, and this
    // build has nowhere else to meet — which is why blanking the relay address turns off
    // automatic sync entirely and leaves the manual bundle as the only path.
    if (!endpoints.directEnabled || !endpoints.relayUrl) return null;

    const factory = this.deps.rtcFactory ?? platformRtcFactory;
    if (!factory.available) return null;

    const now = this.deps.now ?? Date.now;
    return new DirectTransport({
      identity: vault.identity,
      psk: vault.vaultKey,
      epoch: vault.epoch,
      baseUrl: endpoints.relayUrl,
      // A function, not a value: the id rotates every five minutes and this transport
      // outlives several windows.
      rendezvousId: () => deriveRendezvousId(vault.vaultKey, rendezvousWindow(now() / 1000)),
      iceServers: endpoints.iceServers,
      factory,
      openSocket: this.deps.openSocket,
    });
  }

  private noteUpload(error: unknown | null): void {
    const result = error ? 'failed' : 'ok';
    if (result === 'ok' && this.lastUpload === 'ok') return;
    this.lastUpload = result;

    const { storage, nowIso = defaultNowIso, onError } = this.deps;
    this.healthWrites = this.healthWrites
      .then(async () => {
        const at = nowIso();
        await storage.transact(
          async (tx) => {
            if (error) await noteRelayFailure(tx, error, at);
            else await noteRelaySuccess(tx, at);
          },
          { silent: true },
        );
      })
      .catch((failure: unknown) => {
        // Not rethrown: this chain is shared by every subsequent upload, and a rejection left
        // on it would make each later one fail for a reason that has nothing to do with it.
        onError?.(failure);
      });
  }
}
