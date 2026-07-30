/**
 * The rendezvous — how two devices find each other without telling anyone who they are.
 *
 * WebRTC cannot start without an out-of-band exchange of connection descriptions, so
 * something in the middle has to pass a few kilobytes between two parties before they can
 * talk directly. That something is this: a WebSocket to `/rendezvous/<id>`, where the id is
 * `HKDF(vaultRootKey, "…/rendezvous" ‖ floor(unixSeconds / 300))`.
 *
 * Three properties follow from that derivation, and they are the whole reason it is a derived
 * id rather than an account:
 *
 * - **Both devices compute it independently.** Nothing is registered, nothing is looked up,
 *   and the server is never told which vault is asking — it sees an opaque string appear.
 * - **It rotates every five minutes.** A server logging every rendezvous it ever brokered
 *   cannot link Monday's session to Tuesday's, because the ids share no structure.
 * - **Holding it proves nothing.** It is a meeting point, not a credential. Everything that
 *   crosses it is either a public key or sealed, and §1.5's signed transcript is what
 *   actually authenticates the peer.
 *
 * The server relays bytes it cannot read and keeps none of them. What it can do — drop
 * messages, reorder them, inject its own — is exactly what the handshake is built to survive:
 * an injected hello produces a different transcript, a different SAS, and a signature check
 * that fails. **A hostile signaling server must be assumed, not merely tolerated.**
 */

import { fromBase64Url, toBase64Url } from '@/sync/crypto';
import { RelayError } from '@/sync/transport/http';

/**
 * The largest signaling message accepted.
 *
 * An SDP offer with a handful of ICE candidates is a few kilobytes; this is generous by two
 * orders of magnitude and still refuses a server trying to make a phone allocate megabytes on
 * behalf of a peer that may not exist.
 */
export const MAX_SIGNAL_BYTES = 64 * 1024;

/** How long to wait for the socket to open before giving up on the rendezvous. */
export const SIGNAL_OPEN_TIMEOUT_MS = 10_000;

/** How long to wait for a peer to say something. Just over one rendezvous window. */
export const SIGNAL_IDLE_TIMEOUT_MS = 45_000;

/**
 * The part of `WebSocket` this module uses.
 *
 * Declared structurally rather than imported, because the browser's `WebSocket` and React
 * Native's are different classes that happen to agree on this shape — and because a test
 * needs to supply a third implementation that is neither.
 */
export interface RawSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export interface SignalingDeps {
  /** The relay origin, already validated by `normalizeEndpointUrl`. */
  readonly baseUrl: string;
  /** The current rendezvous id. Rotates; see `rendezvousIds`. */
  readonly rendezvousId: string;
  /** Injected so tests never open a socket, and so React Native's global is not imported. */
  readonly open: (url: string) => RawSocket;
  readonly openTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

/**
 * Rewrites an https origin as its WebSocket equivalent.
 *
 * Exported because the URL is worth asserting on directly: a signaling connection that
 * silently fell back to `ws:` on a public host would hand the whole rendezvous — including
 * which id was contacted, and when — to anyone on the path.
 */
export function signalingUrl(baseUrl: string, rendezvousId: string): string {
  const scheme = baseUrl.startsWith('https:') ? 'wss:' : 'ws:';
  const rest = baseUrl.slice(baseUrl.indexOf(':') + 1);
  return `${scheme}${rest}/rendezvous/${encodeURIComponent(rendezvousId)}`;
}

type Waiter = {
  resolve: (frame: Uint8Array) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * One rendezvous, as a message queue rather than an event emitter.
 *
 * The handshake is a strict alternation — send a hello, wait for a hello, send a proof, wait
 * for a proof — and expressing that against callbacks means hand-rolling a state machine per
 * step. `await client.receive()` is the same protocol written as it reads, and the queue
 * underneath is what makes it correct when the peer's reply arrives before the request for it.
 */
export class SignalingClient {
  private socket: RawSocket | null = null;
  private readonly inbox: Uint8Array[] = [];
  private readonly waiters: Waiter[] = [];
  private failure: Error | null = null;
  private closed = false;

  constructor(private readonly deps: SignalingDeps) {}

  get url(): string {
    return signalingUrl(this.deps.baseUrl, this.deps.rendezvousId);
  }

  /** Opens the socket. Resolves once the server has accepted it, or throws. */
  open(signal?: AbortSignal): Promise<void> {
    if (this.socket) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new RelayError('Sync was cancelled.', 'unreachable'));

    const socket = this.deps.open(this.url);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      const undo: (() => void)[] = [];
      let settled = false;

      const settle = (error: Error | null) => {
        if (settled) return;
        settled = true;
        for (const step of undo) step();
        if (error) reject(error);
        else resolve();
      };

      const timer = setTimeout(
        () => {
          const error = new RelayError('The rendezvous server did not answer.', 'unreachable');
          this.fail(error);
          settle(error);
        },
        this.deps.openTimeoutMs ?? SIGNAL_OPEN_TIMEOUT_MS,
      );
      undo.push(() => clearTimeout(timer));

      const onAbort = () => {
        const error = new RelayError('Sync was cancelled.', 'unreachable');
        this.fail(error);
        settle(error);
      };
      signal?.addEventListener('abort', onAbort);
      undo.push(() => signal?.removeEventListener('abort', onAbort));

      socket.onopen = () => settle(null);
      socket.onerror = () => {
        const error = new RelayError('Could not reach the rendezvous server.', 'unreachable');
        this.fail(error);
        settle(error);
      };
      // `fail` runs whether or not the open promise is still pending. Once the session is
      // under way a close is the peer or the server hanging up, and everything waiting on a
      // reply has to be told — a closed socket will never produce the message it waits for.
      socket.onclose = () => {
        const error = new RelayError('The rendezvous connection closed.', 'unreachable');
        this.fail(error);
        settle(error);
      };
      socket.onmessage = (event) => this.absorb(event.data);
    });
  }

  send(payload: Uint8Array): void {
    if (this.failure) throw this.failure;
    if (!this.socket) throw new RelayError('That rendezvous is not open.', 'unreachable');
    if (payload.length > MAX_SIGNAL_BYTES) {
      throw new RelayError('That signaling message is too large to send.', 'tooLarge');
    }
    this.socket.send(toBase64Url(payload));
  }

  /**
   * Waits for the next message from the peer.
   *
   * Times out rather than waiting forever, because the common case for "nothing arrived" is
   * that the other device is simply not awake — and a pairing screen that spins indefinitely
   * teaches the user that sync is broken when the truth is that their laptop is shut.
   */
  receive(signal?: AbortSignal): Promise<Uint8Array> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(new RelayError('Sync was cancelled.', 'unreachable'));

    return new Promise<Uint8Array>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };

      const finish = () => {
        this.drop(waiter);
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        finish();
        reject(new RelayError('Sync was cancelled.', 'unreachable'));
      };

      waiter.timer = setTimeout(() => {
        finish();
        reject(new RelayError('The other device did not respond.', 'unreachable'));
      }, this.deps.idleTimeoutMs ?? SIGNAL_IDLE_TIMEOUT_MS);
      waiter.resolve = (frame) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(frame);
      };
      waiter.reject = (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      };

      signal?.addEventListener('abort', onAbort);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new RelayError('The rendezvous was closed.', 'unreachable'));
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
  }

  /**
   * Takes one message off the wire.
   *
   * Anything that is not a well-formed, in-budget base64url string is discarded silently.
   * The server is untrusted and so is whoever else found this rendezvous id, so junk is an
   * expected input rather than an error condition — and treating it as an error would let a
   * single malformed message abort a pairing that was otherwise about to succeed.
   */
  private absorb(data: unknown): void {
    if (typeof data !== 'string') return;
    if (data.length > Math.ceil((MAX_SIGNAL_BYTES * 4) / 3) + 4) return;

    let payload: Uint8Array;
    try {
      payload = fromBase64Url(data);
    } catch {
      return;
    }
    if (!payload.length || payload.length > MAX_SIGNAL_BYTES) return;

    const waiter = this.waiters.shift();
    if (!waiter) {
      this.inbox.push(payload);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(payload);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const waiting = this.waiters.splice(0, this.waiters.length);
    for (const waiter of waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private drop(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }
}

/**
 * The platform's WebSocket, if there is one.
 *
 * React Native provides a global `WebSocket`, and so does every browser; neither needs an
 * import. A platform without one gets a clear error at the moment sync is attempted rather
 * than a `ReferenceError` from somewhere inside the handshake.
 */
export const platformSocket = (url: string): RawSocket => {
  const ctor = (globalThis as { WebSocket?: new (url: string) => RawSocket }).WebSocket;
  if (!ctor) {
    throw new RelayError('This platform cannot open a rendezvous connection.', 'unreachable');
  }
  return new ctor(url);
};
