/**
 * How bytes get from one device to another — and the deliberate smallness of that question.
 *
 * The engine never opens a socket. It asks a transport for a channel, writes frames to it,
 * and reads frames off it, and that is the entire contract. Three very different things
 * satisfy it — a WebRTC data channel, an HTTP drop-box on a relay, and a file the user carries
 * on a USB stick — and none of them can behave differently in any way the engine can observe,
 * which is what makes "sync over a file" a real feature rather than a special case bolted on
 * afterwards.
 *
 * The interface is deliberately *not* request/response. A relay drop-box is fundamentally
 * one-way and asynchronous: you leave a blob and somebody collects it hours later. Modelling
 * the channel as a pair of independent streams means the same engine code drives a live
 * connection and a store-and-forward one, instead of the second having to fake a reply that
 * never comes.
 *
 * Frames are opaque here. A transport receives sealed bytes and hands back sealed bytes; it
 * is never given a key, an op, or a device roster. That is not politeness — it is what lets a
 * relay transport be reviewed for correctness without also having to be reviewed for
 * confidentiality.
 */

export type TransportKind = 'p2p' | 'relay' | 'file';

/** What a transport needs to know about who it is reaching. Deliberately not a `Peer`. */
export interface PeerDescriptor {
  readonly deviceId: string;
  /** Display only, for error messages a person has to read. */
  readonly name: string;
}

export interface SyncChannel {
  readonly peerId: string;
  /**
   * Resolves once the frame has been handed off, not once the peer has processed it.
   *
   * `seq` is the counter the frame was sealed under, and the transport's job is to carry it
   * alongside the bytes. It is not secret — it is bound into the frame's associated data, so
   * a relay that alters it produces a frame that will not open — and carrying it is what lets
   * a store-and-forward transport work at all. A drop-box outlives the process: a phone that
   * uploads three frames on Monday and two on Tuesday leaves five blobs sealed under 0,1,2,0,1,
   * and a receiver counting arrivals from zero would fail to open the fourth and every frame
   * after it, permanently. Carrying the sequence also makes a reordered or dropped frame a
   * frame that is simply late rather than one that desynchronises the whole channel.
   */
  send(frame: Uint8Array, seq: number): Promise<void>;
  /** Returns an unsubscribe function, matching the convention used across this codebase. */
  onFrame(handler: (frame: Uint8Array, seq: number) => void): () => void;
  close(): void;
}

export interface SyncTransport {
  readonly kind: TransportKind;
  /**
   * Opens a channel to a peer.
   *
   * `signal` is not optional and not decorative: a WebRTC connection attempt against a device
   * that is simply switched off will otherwise sit in ICE gathering until it times out on its
   * own schedule, and the app has to be able to give up when the user backgrounds it.
   */
  connect(peer: PeerDescriptor, signal: AbortSignal): Promise<SyncChannel>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Loopback
// ---------------------------------------------------------------------------

/**
 * Two channels wired to each other, in one process.
 *
 * This is what makes the convergence suite possible. Two whole engines — real storage, real
 * signatures, real envelopes — talk through this and nothing is stubbed except the network
 * itself, so a test proves the actual code path rather than a rehearsal of it. Partitions are
 * modelled by simply not delivering, which is exactly what a partition is.
 *
 * Delivery is asynchronous (`queueMicrotask`) rather than a direct call, on purpose. A
 * synchronous hand-off would let the receiving engine run *inside* the sender's `await`,
 * which no real transport does, and would hide reentrancy bugs that only appear in the field.
 */
export class LoopbackChannel implements SyncChannel {
  private readonly handlers = new Set<(frame: Uint8Array, seq: number) => void>();
  private peer: LoopbackChannel | null = null;
  private closed = false;
  /** Frames dropped while partitioned, so a test can assert what a heal has to redeliver. */
  private readonly held: { frame: Uint8Array; seq: number }[] = [];
  partitioned = false;

  constructor(readonly peerId: string) {}

  static pair(firstId: string, secondId: string): [LoopbackChannel, LoopbackChannel] {
    // Each channel is named for the device on the *other* end, which is the id the engine
    // needs when it opens a frame.
    const first = new LoopbackChannel(secondId);
    const second = new LoopbackChannel(firstId);
    first.peer = second;
    second.peer = first;
    return [first, second];
  }

  send(frame: Uint8Array, seq: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('That channel is closed.'));
    const target = this.peer;
    if (!target) return Promise.resolve();
    if (this.partitioned || target.partitioned) {
      target.held.push({ frame, seq });
      return Promise.resolve();
    }
    queueMicrotask(() => target.deliver(frame, seq));
    return Promise.resolve();
  }

  /** Delivers everything withheld during a partition, in the order it was sent. */
  heal(): number {
    const pending = this.held.splice(0, this.held.length);
    for (const held of pending) queueMicrotask(() => this.deliver(held.frame, held.seq));
    return pending.length;
  }

  onFrame(handler: (frame: Uint8Array, seq: number) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close() {
    this.closed = true;
    this.handlers.clear();
  }

  private deliver(frame: Uint8Array, seq: number) {
    if (this.closed) return;
    for (const handler of this.handlers) handler(frame, seq);
  }
}

/**
 * A transport that hands out pre-wired loopback channels.
 *
 * Registered by device id rather than discovered, because discovery is the one thing a
 * loopback genuinely cannot model and pretending otherwise would test nothing.
 */
export class LoopbackTransport implements SyncTransport {
  readonly kind: TransportKind = 'p2p';
  private readonly channels = new Map<string, LoopbackChannel>();

  register(peerId: string, channel: LoopbackChannel) {
    this.channels.set(peerId, channel);
  }

  connect(peer: PeerDescriptor, signal: AbortSignal): Promise<SyncChannel> {
    if (signal.aborted) return Promise.reject(new Error('Connection cancelled.'));
    const channel = this.channels.get(peer.deviceId);
    if (!channel) return Promise.reject(new Error(`No loopback channel for ${peer.deviceId}.`));
    return Promise.resolve(channel);
  }

  close(): Promise<void> {
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    return Promise.resolve();
  }
}
