/**
 * The encrypted drop-box.
 *
 * This is the transport that makes sync work when the two devices are never awake at the same
 * time — which, for a phone and a laptop, is most of the time. A device leaves sealed frames
 * in a bucket and collects whatever is addressed to it; the other device does the same hours
 * later. Nothing about it is a connection, and modelling it as one would be a lie the engine
 * would eventually trip over.
 *
 * What the relay learns, exhaustively:
 *
 * - **The bucket id.** An HKDF output of the vault root key. It identifies a vault without
 *   naming one, and it cannot be reversed into anything else derived from the same root.
 * - **A route tag per blob.** Also an HKDF output, per vault. It lets the relay group blobs by
 *   recipient — which it must, or a device would have to download every other device's traffic
 *   — while learning nothing that survives outside this vault. See `deriveRouteTag`.
 * - **A frame sequence.** A small integer, authenticated but not secret.
 * - **Padded ciphertext.** Bucketed to a power of two by the envelope, so the byte count does
 *   not read out how many transactions were added.
 * - **An IP address.** The one thing end-to-end encryption cannot hide, and the reason the
 *   direct transport is tried first and this one second.
 *
 * What it does not learn: who the devices are, how many records exist, what changed, or
 * whether two buckets belong to the same person.
 *
 * The transport holds no key and is handed no key. Route tags arrive precomputed from the
 * layer that does hold one, which is what lets this file be reviewed for correctness without
 * also having to be reviewed for confidentiality.
 */

import { MAX_FRAME_BYTES, fromBase64Url, toBase64Url } from '@/sync/crypto';
import type {
  PeerDescriptor,
  SyncChannel,
  SyncTransport,
  TransportKind,
} from '@/sync/engine/transport';
import { RelayError, requestJson, requestVoid, type HttpDeps } from '@/sync/transport/http';

/** Blobs fetched per request. Bounded so one poll cannot become an unbounded download. */
export const RELAY_PAGE_SIZE = 100;

/**
 * Pages fetched in a single pass.
 *
 * A device returning after a long absence does not have to catch up in one foreground: the
 * cursor advances page by page and is persisted, so the next launch resumes exactly where
 * this one stopped. The cap is what stops opening the app for five seconds turning into a
 * download the user can neither see nor cancel.
 */
export const MAX_RELAY_PAGES = 20;

/**
 * The longest an upload waits before it happens.
 *
 * Uploads are jittered because a relay that receives a `PUT` the instant an app is opened
 * learns the app was opened. It is a small leak and this is a small mitigation — the window
 * is deliberately short enough not to be felt in a foreground sync, which means it blurs the
 * timing rather than hiding it. Set to zero in tests, and honestly described in the threat
 * model rather than claimed as more than it is.
 */
export const UPLOAD_JITTER_MS = 400;

interface Blob {
  readonly slot: number;
  readonly to: string;
  readonly seq: number;
  readonly frame: string;
}

interface FetchResponse {
  readonly blobs?: unknown;
  readonly more?: unknown;
}

export interface RelayTransportDeps extends HttpDeps {
  /** Origin of the relay, already validated by `normalizeEndpointUrl`. */
  readonly baseUrl: string;
  /** `deriveBucketId(vrk)`. Opaque; the relay treats it as a name and nothing more. */
  readonly bucketId: string;
  /** base64url `deriveBucketToken(vrk)`. A bare write capability that identifies nobody. */
  readonly token: string;
  /** This device's route tag, so it can recognise what is addressed to it. */
  readonly selfTag: string;
  /** A peer's route tag. Precomputed by the caller, which is the layer that holds the key. */
  readonly tagFor: (peerId: string) => string;
  /** Persisted so a blob is never collected twice, and never missed after a restart. */
  readonly readCursor: () => Promise<number>;
  readonly writeCursor: (slot: number) => Promise<void>;
  /**
   * Told how each upload went — `null` for one that landed, the error for one that did not.
   *
   * This is what feeds the `degraded` verdict in `relay-health.ts`: a relay that answers
   * `/health` perfectly well while refusing every `PUT` is broken in a way a health probe
   * alone cannot see, and "relay errors" is the only honest thing to show for it.
   *
   * Deliberately synchronous and deliberately not awaited. The caller records the outcome in
   * its own transaction, and making an upload's success depend on that write landing would
   * mean a locked database turned a delivered batch into a retried one.
   */
  readonly onUpload?: (error: unknown | null) => void;
  /** Injected so tests are deterministic and instant. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly jitterMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One peer's view of the drop-box.
 *
 * Buffers what arrives before a handler is installed, which is not a nicety: the session
 * attaches its receive pump *after* `connect` resolves, and a poll that has already returned
 * would otherwise drop everything it collected on the floor.
 */
class RelayChannel implements SyncChannel {
  private readonly handlers = new Set<(frame: Uint8Array, seq: number) => void>();
  private readonly pending: { frame: Uint8Array; seq: number }[] = [];
  private closed = false;

  constructor(
    readonly peerId: string,
    private readonly upload: (frame: Uint8Array, seq: number, to: string) => Promise<void>,
    private readonly tag: string,
  ) {}

  send(frame: Uint8Array, seq: number): Promise<void> {
    if (this.closed) return Promise.reject(new RelayError('That channel is closed.', 'unreachable'));
    return this.upload(frame, seq, this.tag);
  }

  onFrame(handler: (frame: Uint8Array, seq: number) => void): () => void {
    this.handlers.add(handler);
    const buffered = this.pending.splice(0, this.pending.length);
    for (const held of buffered) handler(held.frame, held.seq);
    return () => this.handlers.delete(handler);
  }

  deliver(frame: Uint8Array, seq: number) {
    if (this.closed) return;
    if (!this.handlers.size) {
      this.pending.push({ frame, seq });
      return;
    }
    for (const handler of this.handlers) handler(frame, seq);
  }

  close() {
    this.closed = true;
    this.handlers.clear();
    this.pending.length = 0;
  }
}

export class RelayTransport implements SyncTransport {
  readonly kind: TransportKind = 'relay';

  private readonly channels = new Map<string, RelayChannel>();
  /**
   * The in-flight poll, shared by every peer.
   *
   * `connect` is called once per peer but the bucket is one bucket, so without this a vault
   * with four devices would download the same page four times and race four cursor writes
   * against each other. Cleared on completion so the next foreground polls again.
   */
  private polling: Promise<number> | null = null;

  constructor(private readonly deps: RelayTransportDeps) {}

  /**
   * Hands back this peer's channel, having first collected whatever is waiting.
   *
   * Collecting inside `connect` rather than on a timer is what keeps the "no background
   * traffic" property from §1.8 true: the relay is contacted when the user opens the app and
   * at no other moment.
   *
   * A failed poll is not a failed connect. The bucket being unreachable says nothing about
   * whether this device has something to *upload* once the network recovers mid-pass, and
   * refusing the channel here would also deny the session the chance to record why.
   */
  async connect(peer: PeerDescriptor, signal: AbortSignal): Promise<SyncChannel> {
    if (signal.aborted) throw new RelayError('Sync was cancelled.', 'unreachable');
    const channel = this.channelFor(peer.deviceId);
    await this.poll(signal);
    return channel;
  }

  /**
   * Collects everything addressed to this device since the stored cursor.
   *
   * Returns the number of frames dispatched. The cursor advances past blobs addressed to
   * *other* devices as well, because they will never become this device's business and
   * re-reading them every launch would grow linearly with the vault's history.
   */
  poll(signal?: AbortSignal): Promise<number> {
    if (this.polling) return this.polling;
    const run = this.drain(signal).finally(() => {
      this.polling = null;
    });
    this.polling = run;
    return run;
  }

  private async drain(signal?: AbortSignal): Promise<number> {
    const { baseUrl, bucketId, token, selfTag, readCursor, writeCursor } = this.deps;
    let cursor = await readCursor();
    let delivered = 0;

    for (let page = 0; page < MAX_RELAY_PAGES; page += 1) {
      if (signal?.aborted) break;

      const url = `${baseUrl}/bucket/${encodeURIComponent(bucketId)}?after=${cursor}&limit=${RELAY_PAGE_SIZE}`;
      const body = await requestJson<FetchResponse>(this.deps, { method: 'GET', url, token, signal });
      const blobs = parseBlobs(body);
      if (!blobs.length) break;

      for (const blob of blobs) {
        cursor = Math.max(cursor, blob.slot);
        if (blob.to !== selfTag) continue;
        const frame = decodeFrame(blob.frame);
        // A blob that will not decode is dropped rather than allowed to stall the cursor.
        // The sender's ops are still in its outbox and unacknowledged, so they come back on
        // the next pass; a cursor that refuses to advance past one bad blob would instead
        // re-download it forever and never reach the good ones behind it.
        if (!frame) continue;
        for (const channel of this.channels.values()) channel.deliver(frame, blob.seq);
        delivered += 1;
      }

      await writeCursor(cursor);
      if (body.more !== true) break;
    }

    return delivered;
  }

  /**
   * Leaves one frame in the bucket.
   *
   * The jitter is applied here rather than once per pass so that a burst of batches does not
   * arrive as a burst — which would restore exactly the timing signal the jitter exists to
   * blur.
   */
  private async upload(frame: Uint8Array, seq: number, to: string): Promise<void> {
    const { baseUrl, bucketId, token } = this.deps;
    if (frame.length > MAX_FRAME_BYTES) {
      throw new RelayError('That batch is too large to upload.', 'tooLarge');
    }

    const window = this.deps.jitterMs ?? UPLOAD_JITTER_MS;
    if (window > 0) {
      const sleep = this.deps.sleep ?? defaultSleep;
      const random = this.deps.random ?? Math.random;
      await sleep(Math.floor(random() * window));
    }

    try {
      await requestVoid(this.deps, {
        method: 'PUT',
        url: `${baseUrl}/bucket/${encodeURIComponent(bucketId)}`,
        token,
        body: { to, seq, frame: toBase64Url(frame) },
      });
    } catch (error) {
      this.deps.onUpload?.(error);
      throw error;
    }
    this.deps.onUpload?.(null);
  }

  /**
   * Empties the bucket.
   *
   * Called when the user unpairs this device or resets the vault. It is a courtesy rather
   * than a security measure — the blobs expire on their own and are unreadable regardless —
   * but leaving a fortnight of undeliverable ciphertext on someone else's server when the
   * vault it belongs to no longer exists is untidy in a way this app should not be.
   */
  async purge(): Promise<void> {
    const { baseUrl, bucketId, token } = this.deps;
    await requestVoid(this.deps, {
      method: 'DELETE',
      url: `${baseUrl}/bucket/${encodeURIComponent(bucketId)}`,
      token,
    });
  }

  close(): Promise<void> {
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    return Promise.resolve();
  }

  private channelFor(peerId: string): RelayChannel {
    const existing = this.channels.get(peerId);
    if (existing) return existing;
    const created = new RelayChannel(
      peerId,
      (frame, seq, to) => this.upload(frame, seq, to),
      this.deps.tagFor(peerId),
    );
    this.channels.set(peerId, created);
    return created;
  }
}

/**
 * Reads a page out of whatever the relay actually sent.
 *
 * Every field is checked, and a malformed entry is skipped rather than throwing, because the
 * page it arrived in may also hold perfectly good blobs and one bad row must not strand them.
 * The relay is not trusted to be well-behaved — it is not trusted at all — so "the server
 * sent nonsense" has to be an ordinary, survivable outcome rather than an exception.
 */
function parseBlobs(body: FetchResponse): Blob[] {
  if (!Array.isArray(body.blobs)) {
    throw new RelayError('The relay sent something that is not a Qashy relay response.', 'malformed');
  }
  const blobs: Blob[] = [];
  for (const entry of body.blobs) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.slot !== 'number' || !Number.isSafeInteger(row.slot) || row.slot < 0) continue;
    if (typeof row.to !== 'string' || typeof row.frame !== 'string') continue;
    if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 0) continue;
    blobs.push({ slot: row.slot, to: row.to, seq: row.seq, frame: row.frame });
  }
  // Ascending, so the cursor written after the page is a true high-water mark even if the
  // relay returned the page in some other order.
  return blobs.sort((first, second) => first.slot - second.slot);
}

/**
 * Decodes a frame, refusing before allocating.
 *
 * The length check is on the *encoded* string. Checking after decoding would mean a relay
 * could make this device allocate the very megabytes the cap exists to refuse, simply by
 * sending them.
 */
function decodeFrame(encoded: string): Uint8Array | null {
  if (encoded.length > Math.ceil((MAX_FRAME_BYTES * 4) / 3) + 4) return null;
  try {
    return fromBase64Url(encoded);
  } catch {
    return null;
  }
}
