/**
 * The direct transport, as the engine sees it.
 *
 * Thin on purpose: everything interesting — the handshake, the sealed SDP exchange, the ICE
 * trickle — is in `webrtc-core.ts`, and everything platform-specific is behind `rtcFactory`.
 * What is left here is the bookkeeping the session needs: one rendezvous per pass, one
 * connection per peer, and a close that actually closes.
 *
 * A failure to connect directly is not an error the user should see. It means the two devices
 * are on different networks, or one of them is a phone in a pocket, and the drop-box exists
 * for precisely that. The session tries this first and falls through; the only case worth
 * surfacing is a *handshake* failure, which means something is intercepting the connection
 * rather than merely absent.
 */

import type { DeviceIdentity, HandshakeSession, PairingSecret, VaultRootKey } from '@/sync/crypto';
import type {
  PeerDescriptor,
  SyncChannel,
  SyncTransport,
  TransportKind,
} from '@/sync/engine/transport';
import type { IceServer } from '@/sync/transport/endpoints';
import { SignalingClient, platformSocket, type RawSocket } from '@/sync/transport/signaling';
import { rtcFactory } from '@/sync/transport/webrtc';
import { connectWebRtc, type RtcFactory, type WebRtcConnection } from '@/sync/transport/webrtc-core';

export interface DirectTransportDeps {
  readonly identity: DeviceIdentity;
  readonly psk: VaultRootKey | PairingSecret;
  readonly epoch: number;
  readonly baseUrl: string;
  /**
   * The rendezvous to meet at, or a function returning the current one.
   *
   * Pass the function form on a long-lived transport. The id rotates every five minutes (see
   * `rendezvousIds`), and a transport constructed once at startup with a fixed string would
   * keep knocking on a meeting point that expired hours ago — while a transport rebuilt every
   * pass to refresh the id would throw away the live data channels it is holding, which is the
   * one thing it exists to keep.
   *
   * Only the *current* window is used, not the three that `rendezvousIds` offers. Two devices
   * whose clocks straddle a boundary compute different ids and miss each other for that pass;
   * trying all three would cost two extra connect timeouts against an absent peer on every
   * pass, which is the overwhelmingly common case. The next foreground meets, and the relay
   * covers the gap in the meantime.
   */
  readonly rendezvousId: string | (() => string);
  readonly iceServers: readonly IceServer[];
  /** Overridden in tests and by the platform files; defaults to whatever this build has. */
  readonly factory?: RtcFactory;
  readonly openSocket?: (url: string) => RawSocket;
  readonly connectTimeoutMs?: number;
  /** Called with the SAS once a session is established, so the pairing screen can show it. */
  readonly onSession?: (peerId: string, session: HandshakeSession) => void;
}

export class DirectTransport implements SyncTransport {
  readonly kind: TransportKind = 'p2p';

  private readonly connections = new Map<string, WebRtcConnection>();

  constructor(private readonly deps: DirectTransportDeps) {}

  get available(): boolean {
    return (this.deps.factory ?? rtcFactory).available;
  }

  /**
   * Opens a fresh rendezvous per peer.
   *
   * Not shared the way the relay's poll is, and the difference is the medium: a drop-box is
   * one bucket every device reads, whereas a rendezvous is a two-party meeting point. Two
   * peers sharing one socket would interleave their hellos on the same wire, and the
   * handshake's transcript — which is what authenticates the peer — would be computed over
   * whichever hello happened to arrive first.
   */
  async connect(peer: PeerDescriptor, signal: AbortSignal): Promise<SyncChannel> {
    const existing = this.connections.get(peer.deviceId);
    if (existing) return existing.channel;

    const { rendezvousId } = this.deps;
    const signaling = new SignalingClient({
      baseUrl: this.deps.baseUrl,
      rendezvousId: typeof rendezvousId === 'function' ? rendezvousId() : rendezvousId,
      open: this.deps.openSocket ?? platformSocket,
    });

    try {
      await signaling.open(signal);
      const connection = await connectWebRtc(
        {
          identity: this.deps.identity,
          psk: this.deps.psk,
          epoch: this.deps.epoch,
          iceServers: this.deps.iceServers,
          factory: this.deps.factory ?? rtcFactory,
          signaling,
          peer,
          connectTimeoutMs: this.deps.connectTimeoutMs,
        },
        signal,
      );
      this.connections.set(peer.deviceId, connection);
      this.deps.onSession?.(peer.deviceId, connection.session);
      return connection.channel;
    } finally {
      // The rendezvous has done its whole job by this point: SDP and ICE are exchanged, and
      // everything after this crosses the data channel. Holding the socket open would keep a
      // live connection to a server the vault is meant to stop needing.
      signaling.close();
    }
  }

  close(): Promise<void> {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    return Promise.resolve();
  }
}
