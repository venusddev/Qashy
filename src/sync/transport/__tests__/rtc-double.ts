/**
 * WebRTC, in one process, with no media stack and no network.
 *
 * Not a `.test.ts` file, so Jest's `testMatch` leaves it alone.
 *
 * This models the parts of `RTCPeerConnection` that `webrtc-core.ts` actually uses and nothing
 * else: an offer/answer exchange that carries an identifier, trickled candidates, and a data
 * channel that opens on both sides once the answer lands. That is enough to run the real
 * negotiation — the real handshake, the real sealed SDP, the real role selection — end to end,
 * which is the only way to prove the ordering claim in that file's header.
 *
 * What it deliberately does not model: ICE actually failing over between candidates, DTLS, and
 * congestion. Those are the platform's job, and a double that pretended to implement them
 * would be testing the double.
 */

import type { IceServer } from '@/sync/transport/endpoints';
import type {
  RtcCandidateInit,
  RtcConnection,
  RtcDataChannel,
  RtcDescription,
  RtcFactory,
} from '@/sync/transport/webrtc-core';

const soon = (work: () => void) => {
  void Promise.resolve().then(work);
};

export class FakeChannel implements RtcDataChannel {
  readyState = 'connecting';
  binaryType = 'blob';
  peer: FakeChannel | null = null;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  readonly sent: ArrayBuffer[] = [];

  constructor(readonly label: string) {}

  send(data: ArrayBuffer): void {
    if (this.readyState !== 'open') throw new Error('That channel is not open.');
    this.sent.push(data);
    const target = this.peer;
    if (!target) return;
    soon(() => target.onmessage?.({ data }));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.onclose?.();
    const target = this.peer;
    if (target && target.readyState !== 'closed') target.close();
  }

  markOpen(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
}

/** `offer:pc1` / `answer:pc2` — enough for the double to find the other end of the call. */
const describe_ = (kind: string, id: string) => `v=0\r\no=- ${kind}:${id} IN IP4 127.0.0.1\r\n`;
const identify = (sdp: string | undefined): string | null => {
  const match = /(?:offer|answer):(pc\d+)/.exec(sdp ?? '');
  return match ? match[1] : null;
};

export class FakeConnection implements RtcConnection {
  connectionState = 'new';
  iceConnectionState = 'new';

  onicecandidate: ((event: { candidate: RtcCandidateInit | null }) => void) | null = null;
  ondatachannel: ((event: { channel: RtcDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  /** Candidates handed to this connection by the peer, in arrival order. */
  readonly applied: RtcCandidateInit[] = [];
  /**
   * Candidates refused because no remote description was in place yet.
   *
   * `webrtc-core.ts` swallows those rejections on purpose, so this counter is the only way a
   * test can tell the difference between "the ordering rule held" and "every candidate was
   * silently dropped and the connection came up on some other path".
   */
  rejectedCandidates = 0;
  /** Whether `setRemoteDescription` has run, so a premature candidate can be rejected. */
  private remoteSet = false;
  /** Which half of the negotiation this connection performed. */
  role: 'offer' | 'answer' | null = null;
  /**
   * Whether this side called `createDataChannel`.
   *
   * Distinct from `local !== null`, which is true on both sides once the channel exists — the
   * answerer's is handed to it through `ondatachannel`, not created by it.
   */
  createdChannel = false;
  local: FakeChannel | null = null;
  closed = false;

  constructor(
    readonly id: string,
    private readonly network: FakeRtcNetwork,
    readonly iceServers: readonly IceServer[],
  ) {}

  createDataChannel(label: string): RtcDataChannel {
    this.createdChannel = true;
    this.local = new FakeChannel(label);
    return this.local;
  }

  createOffer(): Promise<RtcDescription> {
    this.role = 'offer';
    return Promise.resolve({ type: 'offer', sdp: describe_('offer', this.id) });
  }

  createAnswer(): Promise<RtcDescription> {
    this.role = 'answer';
    return Promise.resolve({ type: 'answer', sdp: describe_('answer', this.id) });
  }

  setLocalDescription(): Promise<void> {
    this.gather();
    return Promise.resolve();
  }

  setRemoteDescription(description: RtcDescription): Promise<void> {
    const peerId = identify(description.sdp);
    if (!peerId) return Promise.reject(new Error('Unparseable SDP.'));
    this.remoteSet = true;
    if (description.type === 'answer') this.network.link(this, peerId);
    return Promise.resolve();
  }

  /**
   * Rejects a candidate that arrives before the description it belongs to.
   *
   * Real `RTCPeerConnection` does exactly this, and `webrtc-core.ts` swallows the rejection
   * because ICE is a race. Reproducing the rejection is the point: without it, the double
   * would happily accept out-of-order candidates and the `IceGate` ordering rule would look
   * unnecessary in a test while being load-bearing in the field.
   */
  addIceCandidate(candidate: RtcCandidateInit): Promise<void> {
    if (!this.remoteSet) {
      this.rejectedCandidates += 1;
      return Promise.reject(new Error('No remote description.'));
    }
    this.applied.push(candidate);
    return Promise.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connectionState = 'closed';
    this.local?.close();
  }

  markConnected(): void {
    this.connectionState = 'connected';
    this.iceConnectionState = 'connected';
    this.onconnectionstatechange?.();
  }

  /**
   * A host candidate immediately, then a reflexive one, then end-of-gathering.
   *
   * The first one fires **synchronously, inside `setLocalDescription`** on purpose. That is
   * what a real connection does — a host candidate needs no network round trip, so Chrome and
   * Safari both surface one before the caller's `await` continuation resumes — and it is the
   * exact window `IceGate` exists to cover. Deferring it here instead would make the gate look
   * like dead code in a test while remaining load-bearing in the field.
   */
  private gather(): void {
    if (this.closed) return;
    this.onicecandidate?.({
      candidate: { candidate: `candidate:host ${this.id}`, sdpMid: '0', sdpMLineIndex: 0 },
    });
    soon(() => {
      if (this.closed) return;
      this.onicecandidate?.({
        candidate: { candidate: `candidate:srflx ${this.id}`, sdpMid: '0', sdpMLineIndex: 0 },
      });
      soon(() => this.onicecandidate?.({ candidate: null }));
    });
  }
}

export class FakeRtcNetwork {
  private readonly peers = new Map<string, FakeConnection>();
  private next = 0;

  readonly factory: RtcFactory = {
    available: true,
    create: (iceServers: readonly IceServer[]) => {
      this.next += 1;
      const connection = new FakeConnection(`pc${this.next}`, this, iceServers);
      this.peers.set(connection.id, connection);
      return connection;
    },
  };

  /** Every connection made through this network, in creation order. */
  get connections(): FakeConnection[] {
    return [...this.peers.values()];
  }

  /**
   * Joins the two ends once the offerer has accepted the answer.
   *
   * The answerer learns about the channel through `ondatachannel`, exactly as it would in a
   * browser — which is the branch `negotiateChannel` takes for the non-offering side, so it
   * has to be the branch the double exercises.
   */
  link(offerer: FakeConnection, answererId: string): void {
    const answerer = this.peers.get(answererId);
    if (!answerer) throw new Error(`No connection ${answererId}.`);
    const near = offerer.local;
    if (!near) throw new Error('The offerer never created a data channel.');

    const far = new FakeChannel(near.label);
    near.peer = far;
    far.peer = near;
    answerer.local = far;

    soon(() => {
      answerer.ondatachannel?.({ channel: far });
      near.markOpen();
      far.markOpen();
      offerer.markConnected();
      answerer.markConnected();
    });
  }
}
