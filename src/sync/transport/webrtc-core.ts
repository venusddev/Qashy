/**
 * The direct path: two devices, one data channel, nothing in between once it is up.
 *
 * The ordering in `connectWebRtc` is a security requirement rather than an implementation
 * detail, and it is the reason this file exists instead of a thin wrapper around
 * `RTCPeerConnection`:
 *
 * 1. **The §1.5 handshake runs first, over signaling.** Both devices exchange hellos, derive
 *    a session from an ephemeral ECDH mixed with the vault root key, and prove their identity
 *    with a signature over the transcript.
 * 2. **Only then are the SDP and ICE exchanged — sealed under those session keys.**
 *
 * Doing it the other way round, which is what every WebRTC tutorial shows, would put the DTLS
 * fingerprints in the hands of the signaling server in plaintext. A hostile server could then
 * substitute its own, terminate DTLS on both sides, and read everything — while both devices
 * showed a green "encrypted connection". Sealing the SDP means the fingerprint a device
 * accepts is one only a vault member could have sent, so DTLS becomes what it should be:
 * defence in depth beneath an already-authenticated channel.
 *
 * Op batches crossing the finished channel are sealed *again*, under the vault content key,
 * by `sealBatch`. Three independent layers protect the same bytes, and the session survives
 * any one of them failing.
 *
 * This file holds no platform code. `RTCPeerConnection` is supplied by `webrtc.web.ts` or
 * `webrtc.native.ts`, described here by the smallest interface that admits both.
 */

import {
  acceptPeerAuth,
  completeHandshake,
  decodeHello,
  encodeHello,
  open,
  seal,
  startHandshake,
  utf8Bytes,
  bytesToUtf8,
  type DeviceIdentity,
  type HandshakeSession,
  type PairingSecret,
  type VaultRootKey,
} from '@/sync/crypto';
import type { PeerDescriptor, SyncChannel } from '@/sync/engine/transport';
import type { IceServer } from '@/sync/transport/endpoints';
import { RelayError } from '@/sync/transport/http';
import type { SignalingClient } from '@/sync/transport/signaling';

/** The data channel's label. Both sides must agree; it is not secret and identifies nothing. */
export const CHANNEL_LABEL = 'qashy-sync';

/** How long to wait for ICE to find a path before giving up and letting the relay take over. */
export const CONNECT_TIMEOUT_MS = 20_000;

/**
 * The largest message accepted off the data channel.
 *
 * A peer is authenticated, but authenticated is not the same as trusted-with-your-heap: a
 * paired device running a broken build must not be able to make this one allocate without
 * bound. The sealed-batch cap is 8 MiB, and this is that plus the four-byte sequence prefix.
 */
export const MAX_CHANNEL_MESSAGE = 8 * 1024 * 1024 + 4;

// ---------------------------------------------------------------------------
// The slice of WebRTC this module uses
// ---------------------------------------------------------------------------

export interface RtcDescription {
  readonly type: string;
  readonly sdp?: string;
}

export interface RtcCandidateInit {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
}

export interface RtcDataChannel {
  readonly readyState: string;
  binaryType: string;
  send(data: ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface RtcConnection {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  createDataChannel(label: string, options?: { ordered?: boolean }): RtcDataChannel;
  createOffer(): Promise<RtcDescription>;
  createAnswer(): Promise<RtcDescription>;
  setLocalDescription(description: RtcDescription): Promise<void>;
  setRemoteDescription(description: RtcDescription): Promise<void>;
  addIceCandidate(candidate: RtcCandidateInit): Promise<void>;
  close(): void;
  onicecandidate: ((event: { candidate: RtcCandidateInit | null }) => void) | null;
  ondatachannel: ((event: { channel: RtcDataChannel }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
}

export interface RtcFactory {
  /** False on a platform without WebRTC — Expo Go, or a browser old enough to lack it. */
  readonly available: boolean;
  create(iceServers: readonly IceServer[]): RtcConnection;
}

// ---------------------------------------------------------------------------
// The sealed signaling messages exchanged after the handshake
// ---------------------------------------------------------------------------

type SignalBody =
  | { readonly t: 'sdp'; readonly type: string; readonly sdp: string }
  | { readonly t: 'ice'; readonly candidate: string; readonly mid: string | null; readonly index: number | null }
  | { readonly t: 'done' };

export interface WebRtcDeps {
  readonly identity: DeviceIdentity;
  /**
   * The vault root key on a reconnect, the pairing secret during pairing.
   *
   * Mixed into the handshake's HKDF, which is what stops a non-member who found the
   * rendezvous id from deriving the session at all.
   */
  readonly psk: VaultRootKey | PairingSecret;
  readonly epoch: number;
  readonly iceServers: readonly IceServer[];
  readonly factory: RtcFactory;
  readonly signaling: SignalingClient;
  readonly peer: PeerDescriptor;
  readonly connectTimeoutMs?: number;
}

export interface WebRtcConnection {
  readonly channel: SyncChannel;
  /** Exposed so the pairing screen can show the SAS the user has to compare. */
  readonly session: HandshakeSession;
  close(): void;
}

/**
 * Runs the handshake, then negotiates a data channel under it.
 *
 * Every failure path throws. There is deliberately no "connected but unauthenticated" state
 * to hand back, because a caller holding one would inevitably use it.
 */
export async function connectWebRtc(
  deps: WebRtcDeps,
  signal: AbortSignal,
): Promise<WebRtcConnection> {
  if (!deps.factory.available) {
    throw new RelayError(
      'This build cannot make a direct connection. Sync will use the relay instead.',
      'unreachable',
    );
  }

  const session = await negotiateSession(deps, signal);
  const wire = new SealedSignaling(deps, session);

  // The lower device id offers. Both sides compute the same answer from ids they already
  // hold, so there is no role negotiation to get wrong and no glare to resolve.
  const isOfferer = deps.identity.deviceId < session.peerDeviceId;
  const connection = deps.factory.create(deps.iceServers);

  try {
    const channel = await negotiateChannel(deps, connection, wire, isOfferer, signal);
    return {
      session,
      channel,
      close: () => {
        channel.close();
        connection.close();
      },
    };
  } catch (error) {
    connection.close();
    throw error;
  }
}

/** Steps 1–3 of §1.5, over the plaintext rendezvous. Nothing secret crosses it. */
async function negotiateSession(
  deps: WebRtcDeps,
  signal: AbortSignal,
): Promise<HandshakeSession> {
  await deps.signaling.waitForPeer(signal);
  const pending = startHandshake(deps.identity);
  deps.signaling.send(encodeHello(pending.hello));

  const peerHello = decodeHello(await deps.signaling.receive(signal));
  const session = completeHandshake({
    pending,
    peerHello,
    psk: deps.psk,
    // Supplying it turns a substituted peer into a failure here rather than a roster miss
    // three steps later, when the SDP has already been accepted.
    expectedPeerDeviceId: deps.peer.deviceId || undefined,
  });

  deps.signaling.send(session.auth);
  acceptPeerAuth(session, await deps.signaling.receive(signal));
  return session;
}

/**
 * The signaling channel, once it has a session key.
 *
 * Sequence numbers are per direction and start at zero, which is safe here in a way it is not
 * on the relay: a rendezvous is a live socket, so both counters begin and end with the socket
 * and neither side can be handed a frame sealed in some earlier session.
 */
class SealedSignaling {
  private sent = 0;
  private received = 0;

  constructor(
    private readonly deps: WebRtcDeps,
    private readonly session: HandshakeSession,
  ) {}

  send(body: SignalBody): void {
    const frame = seal(
      this.session.sendKey,
      {
        purpose: 'handshake',
        senderDeviceId: this.deps.identity.deviceId,
        recipientDeviceId: this.session.peerDeviceId,
        epoch: this.deps.epoch,
        seq: this.sent,
      },
      utf8Bytes(JSON.stringify(body)),
    );
    this.sent += 1;
    this.deps.signaling.send(frame);
  }

  async receive(signal: AbortSignal): Promise<SignalBody> {
    const frame = await this.deps.signaling.receive(signal);
    const plaintext = open(
      this.session.receiveKey,
      {
        purpose: 'handshake',
        senderDeviceId: this.session.peerDeviceId,
        recipientDeviceId: this.deps.identity.deviceId,
        epoch: this.deps.epoch,
        seq: this.received,
      },
      frame,
    );
    this.received += 1;
    return parseSignal(bytesToUtf8(plaintext));
  }
}

function parseSignal(text: string): SignalBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RelayError('The other device sent an unreadable message.', 'malformed');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new RelayError('The other device sent an unreadable message.', 'malformed');
  }
  const body = parsed as Record<string, unknown>;

  if (body.t === 'sdp' && typeof body.type === 'string' && typeof body.sdp === 'string') {
    return { t: 'sdp', type: body.type, sdp: body.sdp };
  }
  if (body.t === 'ice' && typeof body.candidate === 'string') {
    return {
      t: 'ice',
      candidate: body.candidate,
      mid: typeof body.mid === 'string' ? body.mid : null,
      index: typeof body.index === 'number' ? body.index : null,
    };
  }
  if (body.t === 'done') return { t: 'done' };
  throw new RelayError('The other device sent an unexpected message.', 'malformed');
}

/**
 * Offers or answers, trickles ICE, and waits for the channel to open.
 *
 * ICE candidates are sent as they are discovered rather than gathered and sent in one block.
 * On a LAN the host candidates arrive first and the connection is usually up before any STUN
 * server has been contacted at all, which is the property §1.8 claims and the one that makes
 * "two devices on the same Wi-Fi talk to nobody" literally true.
 */
async function negotiateChannel(
  deps: WebRtcDeps,
  connection: RtcConnection,
  wire: SealedSignaling,
  isOfferer: boolean,
  signal: AbortSignal,
): Promise<SyncChannel> {
  const opened = new Promise<RtcDataChannel>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RelayError('Could not open a direct connection to that device.', 'unreachable'));
    }, deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

    const settle = (channel: RtcDataChannel) => {
      clearTimeout(timer);
      resolve(channel);
    };
    const fail = (message: string) => {
      clearTimeout(timer);
      reject(new RelayError(message, 'unreachable'));
    };

    signal.addEventListener('abort', () => fail('Sync was cancelled.'));

    if (isOfferer) {
      const channel = connection.createDataChannel(CHANNEL_LABEL, { ordered: true });
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => settle(channel);
      channel.onerror = () => fail('The direct connection failed.');
    } else {
      connection.ondatachannel = (event) => {
        const channel = event.channel;
        channel.binaryType = 'arraybuffer';
        if (channel.readyState === 'open') settle(channel);
        else channel.onopen = () => settle(channel);
      };
    }

    connection.onconnectionstatechange = () => {
      const state = connection.connectionState;
      if (state === 'failed' || state === 'closed') fail('The direct connection failed.');
    };
  });

  const gate = new IceGate(wire);

  connection.onicecandidate = (event) => {
    if (!event.candidate) {
      gate.offer({ t: 'done' });
      return;
    }
    gate.offer({
      t: 'ice',
      candidate: event.candidate.candidate,
      mid: event.candidate.sdpMid ?? null,
      index: event.candidate.sdpMLineIndex ?? null,
    });
  };

  if (isOfferer) {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    wire.send({ t: 'sdp', type: offer.type, sdp: offer.sdp ?? '' });
    gate.release();
  }

  // Pumped in the background: ICE trickles for as long as the connection is being
  // established, and awaiting each message in sequence here would stall the offerer waiting
  // for an answer that cannot be produced until its own candidates have been delivered.
  const pump = drainSignals(connection, wire, gate, isOfferer, signal).catch(() => undefined);

  try {
    const channel = await opened;
    return new DataChannelWire(deps.peer.deviceId, channel);
  } finally {
    void pump;
  }
}

/**
 * Holds local ICE candidates until the description that gives them meaning has been sent.
 *
 * The signaling client is strictly FIFO, so this one rule — a device never puts a candidate on
 * the wire before its own SDP — is what makes the *other* side's ordering a guarantee rather
 * than a timing accident: the peer always has a remote description in place before the first
 * candidate reaches it. `addIceCandidate` before `setRemoteDescription` rejects, and a
 * rejected candidate is swallowed on purpose (ICE is a race), so without this the failure mode
 * is a connection that silently only ever succeeds on the fastest networks.
 *
 * A send that throws is discarded rather than propagated. Gathering continues after the
 * rendezvous has served its purpose and been closed, and a candidate arriving then has simply
 * missed a window that is already over — it is not an error, and letting it escape an event
 * handler would turn it into an unhandled rejection.
 */
class IceGate {
  private released = false;
  private readonly held: SignalBody[] = [];

  constructor(private readonly wire: SealedSignaling) {}

  offer(body: SignalBody): void {
    if (!this.released) {
      this.held.push(body);
      return;
    }
    this.push(body);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const body of this.held.splice(0, this.held.length)) this.push(body);
  }

  private push(body: SignalBody): void {
    try {
      this.wire.send(body);
    } catch {
      // The rendezvous is gone. Nothing to retry and nobody left to tell.
    }
  }
}

async function drainSignals(
  connection: RtcConnection,
  wire: SealedSignaling,
  gate: IceGate,
  isOfferer: boolean,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    if (signal.aborted) return;
    const body = await wire.receive(signal);

    if (body.t === 'done') continue;
    if (body.t === 'ice') {
      // A candidate that the platform rejects is one path among several, not a failure:
      // ICE is a race and losing one runner does not lose the race.
      await connection
        .addIceCandidate({ candidate: body.candidate, sdpMid: body.mid, sdpMLineIndex: body.index })
        .catch(() => undefined);
      continue;
    }

    await connection.setRemoteDescription({ type: body.type, sdp: body.sdp });
    if (!isOfferer && body.type === 'offer') {
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      wire.send({ t: 'sdp', type: answer.type, sdp: answer.sdp ?? '' });
      gate.release();
    }
  }
}

/**
 * A data channel, as the engine sees it.
 *
 * The four-byte prefix carries the AEAD sequence the frame was sealed under. It is not
 * secret — it is bound into the frame's associated data, so altering it produces a frame that
 * will not open — and carrying it explicitly is what lets a dropped or reordered message be
 * merely late rather than the end of the channel.
 */
class DataChannelWire implements SyncChannel {
  private readonly handlers = new Set<(frame: Uint8Array, seq: number) => void>();

  constructor(
    readonly peerId: string,
    private readonly channel: RtcDataChannel,
  ) {
    channel.onmessage = (event) => this.absorb(event.data);
  }

  send(frame: Uint8Array, seq: number): Promise<void> {
    if (this.channel.readyState !== 'open') {
      return Promise.reject(new RelayError('That connection is closed.', 'unreachable'));
    }
    const message = new Uint8Array(frame.length + 4);
    new DataView(message.buffer).setUint32(0, seq, false);
    message.set(frame, 4);
    this.channel.send(message.buffer as ArrayBuffer);
    return Promise.resolve();
  }

  onFrame(handler: (frame: Uint8Array, seq: number) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    this.handlers.clear();
    this.channel.onmessage = null;
    this.channel.close();
  }

  private absorb(data: unknown): void {
    const bytes = toBytes(data);
    if (!bytes || bytes.length < 4 || bytes.length > MAX_CHANNEL_MESSAGE) return;
    const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
    const frame = bytes.slice(4);
    for (const handler of this.handlers) handler(frame, seq);
  }
}

/**
 * Normalises whatever the platform hands back for a binary message.
 *
 * The browser gives an `ArrayBuffer` when `binaryType` is set; `react-native-webrtc` has been
 * known to give a `Uint8Array` directly. Accepting both is cheaper than depending on which.
 */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/** A factory for a platform that cannot do WebRTC, so callers get a reason rather than a crash. */
export const UNAVAILABLE_RTC: RtcFactory = {
  available: false,
  create: () => {
    throw new RelayError('This build cannot make a direct connection.', 'unreachable');
  },
};
