/**
 * Sync by sneakernet — a `.qashysync` file you carry between two devices yourself.
 *
 * This is the transport that needs no server, no network, and no WebRTC. Export on one
 * device, move the file however you like — AirDrop, a USB stick, an email to yourself — and
 * import it on the other. It is slower and manual, and it is also the only path that is
 * unarguably private: nothing observes it because nothing is involved in it.
 *
 * It matters more than a curiosity. It is the disaster path when a relay is down and the two
 * devices are never on the same network; it is the airgap path for anyone who does not want
 * a server in the picture at all; and it is what makes "Phases 0–4 plus this file" a complete,
 * useful feature on its own.
 *
 * **Every frame in a bundle is already sealed** by `sealBatch`, under the vault content key,
 * addressed to one device, and bound to a vault epoch. So the file's own structure is plain
 * JSON: there is no second key to manage, and the wrapper reveals only what a wrapper must —
 * how many frames there are and which device they are for. A file the user is carrying
 * themselves is not a place where hiding the frame count buys anything, and pretending
 * otherwise would add a key to lose.
 *
 * The engine sees this as an ordinary `SyncTransport`. `connect` hands back a channel that
 * collects rather than transmits; `bundle()` turns what it collected into a file; `ingest()`
 * pushes an imported file's frames back through the same receive path a live connection uses.
 * One engine, one code path, three transports.
 */

import { MAX_FRAME_BYTES, fromBase64Url, toBase64Url } from '@/sync/crypto';
import type {
  PeerDescriptor,
  SyncChannel,
  SyncTransport,
  TransportKind,
} from '@/sync/engine/transport';
import { SyncEngineError } from '@/sync/engine/types';

/** Bumped only if the file's *envelope* changes. The frames inside carry their own version. */
export const BUNDLE_VERSION = 1;

export const BUNDLE_EXTENSION = '.qashysync';
export const BUNDLE_MIME = 'application/octet-stream';

/**
 * The most frames one bundle may hold.
 *
 * A cap rather than a stream, because import has to validate the whole file before applying
 * any of it — §1.9's fail-closed rule is not negotiable for a file that arrived from outside
 * the device. At `SEND_BATCH_OPS` per frame this is comfortably more than a vault's entire
 * history, and it is what stops a crafted file from being a memory exhaustion attack.
 */
export const MAX_BUNDLE_FRAMES = 512;

export interface BundleFrame {
  /** Route-blinded recipient. Which device the frame was sealed for. */
  readonly to: string;
  readonly seq: number;
  readonly frame: Uint8Array;
}

export interface SyncBundle {
  readonly version: number;
  /** The device that produced the file. Shown on the import screen; not trusted for anything. */
  readonly from: string;
  readonly frames: readonly BundleFrame[];
}

export class BundleError extends SyncEngineError {
  constructor(message: string) {
    super(message, 'badBatch');
    this.name = 'BundleError';
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * A channel that writes to a file instead of a wire.
 *
 * `send` resolving means "collected", not "delivered" — which is the same promise every other
 * channel makes. The engine's outbox is what tracks actual delivery, through the peer's ack,
 * so a bundle that is exported and never opened simply leaves those ops pending and they go
 * out again next time. Nothing is lost by a file that never arrives.
 */
class FileChannel implements SyncChannel {
  readonly collected: BundleFrame[] = [];
  private readonly handlers = new Set<(frame: Uint8Array, seq: number) => void>();

  constructor(
    readonly peerId: string,
    private readonly tag: string,
  ) {}

  send(frame: Uint8Array, seq: number): Promise<void> {
    if (this.collected.length >= MAX_BUNDLE_FRAMES) {
      return Promise.reject(new BundleError('That is more than one file can carry.'));
    }
    this.collected.push({ to: this.tag, seq, frame });
    return Promise.resolve();
  }

  onFrame(handler: (frame: Uint8Array, seq: number) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  deliver(frame: Uint8Array, seq: number): boolean {
    if (!this.handlers.size) return false;
    for (const handler of this.handlers) handler(frame, seq);
    return true;
  }

  close(): void {
    this.handlers.clear();
  }
}

export interface FileTransportDeps {
  readonly deviceId: string;
  /** This device's route tag, so an imported bundle can be told it is for somebody else. */
  readonly selfTag: string;
  readonly tagFor: (peerId: string) => string;
}

export class FileTransport implements SyncTransport {
  readonly kind: TransportKind = 'file';

  private readonly channels = new Map<string, FileChannel>();

  constructor(private readonly deps: FileTransportDeps) {}

  connect(peer: PeerDescriptor): Promise<SyncChannel> {
    return Promise.resolve(this.channelFor(peer.deviceId));
  }

  /** Everything the session handed over, ready to be written to disk. */
  bundle(): SyncBundle {
    const frames: BundleFrame[] = [];
    for (const channel of this.channels.values()) frames.push(...channel.collected);
    return { version: BUNDLE_VERSION, from: this.deps.deviceId, frames };
  }

  /**
   * Feeds an imported bundle into the receive path.
   *
   * Returns how many frames were dispatched. A bundle addressed to a *different* device is
   * not an error — a three-device vault produces one file per peer and the user will
   * occasionally open the wrong one — so it is reported as zero and the UI says which device
   * it was for, rather than throwing something that reads like corruption.
   */
  ingest(bundle: SyncBundle): number {
    let delivered = 0;
    for (const held of bundle.frames) {
      if (held.to !== this.deps.selfTag) continue;
      for (const channel of this.channels.values()) {
        if (channel.deliver(held.frame, held.seq)) delivered += 1;
      }
    }
    return delivered;
  }

  close(): Promise<void> {
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    return Promise.resolve();
  }

  private channelFor(peerId: string): FileChannel {
    const existing = this.channels.get(peerId);
    if (existing) return existing;
    const created = new FileChannel(peerId, this.deps.tagFor(peerId));
    this.channels.set(peerId, created);
    return created;
  }
}

// ---------------------------------------------------------------------------
// File encoding
// ---------------------------------------------------------------------------

/** Serialises a bundle. UTF-8 JSON, so it survives being emailed, zipped, or renamed. */
export const encodeBundle = (bundle: SyncBundle): string =>
  JSON.stringify({
    version: BUNDLE_VERSION,
    from: bundle.from,
    frames: bundle.frames.map((held) => ({
      to: held.to,
      seq: held.seq,
      frame: toBase64Url(held.frame),
    })),
  });

/**
 * Reads a bundle, or refuses it whole.
 *
 * Unlike the relay's page parser, which skips a bad row and keeps the good ones, this rejects
 * the entire file on the first malformed entry. The asymmetry is deliberate: a relay page is
 * one arbitrary slice of a stream that will be re-offered, whereas a file is a thing the user
 * chose and is watching. Half-importing it would leave them with no way to know which half.
 */
export function decodeBundle(text: string): SyncBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BundleError('That file is not a Qashy sync file.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BundleError('That file is not a Qashy sync file.');
  }

  const body = parsed as Record<string, unknown>;
  if (body.version !== BUNDLE_VERSION) {
    throw new BundleError(
      `That file was written by a newer version of Qashy (format v${String(body.version)}). Update this device.`,
    );
  }
  if (typeof body.from !== 'string' || !Array.isArray(body.frames)) {
    throw new BundleError('That sync file is incomplete.');
  }
  if (body.frames.length > MAX_BUNDLE_FRAMES) {
    throw new BundleError('That sync file is too large to import.');
  }

  const frames: BundleFrame[] = [];
  for (const entry of body.frames) {
    if (!entry || typeof entry !== 'object') throw new BundleError('That sync file is damaged.');
    const row = entry as Record<string, unknown>;
    if (typeof row.to !== 'string' || typeof row.frame !== 'string') {
      throw new BundleError('That sync file is damaged.');
    }
    if (typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 0) {
      throw new BundleError('That sync file is damaged.');
    }
    // Checked on the *encoded* string, before decoding: a crafted file must not be able to
    // make this device allocate the megabytes the cap exists to refuse.
    if (row.frame.length > Math.ceil((MAX_FRAME_BYTES * 4) / 3) + 4) {
      throw new BundleError('That sync file is damaged.');
    }

    let frame: Uint8Array;
    try {
      frame = fromBase64Url(row.frame);
    } catch {
      throw new BundleError('That sync file is damaged.');
    }
    frames.push({ to: row.to, seq: row.seq, frame });
  }

  return { version: BUNDLE_VERSION, from: body.from, frames };
}

/** The name to suggest when saving. Dated so a folder of them is orderable by eye. */
export const bundleFileName = (isoDate: string) =>
  `qashy-sync-${isoDate.slice(0, 10)}${BUNDLE_EXTENSION}`;
