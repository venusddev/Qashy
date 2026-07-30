/**
 * A WebSocket that is not one.
 *
 * Not a `.test.ts` file, so Jest's `testMatch` leaves it alone.
 *
 * `SignalingClient` takes its socket constructor as a dependency for exactly this reason: the
 * behaviours worth testing — a server that never answers, one that hangs up mid-handshake, one
 * that injects junk, one that relays perfectly — are all trivial here and all miserable to
 * produce against a real server.
 *
 * Delivery is deferred through `Promise.resolve().then(...)` rather than `queueMicrotask`,
 * which matters more than it looks: Jest's modern fake timers replace `queueMicrotask`, so a
 * suite that called `jest.useFakeTimers()` would deadlock waiting for a message that only
 * arrives when a timer runs. Promise continuations are never faked.
 */

import type { RawSocket } from '@/sync/transport/signaling';

const soon = (work: () => void) => {
  void Promise.resolve().then(work);
};

export class FakeSocket implements RawSocket {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    private readonly hub?: SocketHub,
  ) {}

  send(data: string): void {
    if (this.closed) throw new Error('That socket is closed.');
    this.sent.push(data);
    this.hub?.route(this, data);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.hub?.leave(this);
    this.onclose?.({ code, reason });
  }

  // --- test controls -------------------------------------------------------

  /** Completes the connection, as a server accepting the upgrade would. */
  accept(): void {
    this.onopen?.({});
  }

  /** Pushes a message down as if the peer had sent it. */
  emit(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** A transport-level failure: DNS, TLS, a refused connection. */
  error(): void {
    this.onerror?.({});
  }

  /** The server hanging up without this side asking it to. */
  hangup(code = 1006): void {
    if (this.closed) return;
    this.closed = { code };
    this.hub?.leave(this);
    this.onclose?.({ code });
  }
}

/**
 * A rendezvous, in-process.
 *
 * Two sockets opened on the same URL relay to each other and to nobody else, which is exactly
 * the contract the real worker implements — and it means a whole pairing handshake can be run
 * end to end without a server, a network, or a port.
 */
export class SocketHub {
  /** Sockets that are open right now. A closed socket leaves, as it would leave a server. */
  readonly sockets: FakeSocket[] = [];
  /**
   * Every socket ever handed out, including closed ones.
   *
   * Kept separately because the two questions are different and both get asked: "is anything
   * still connected to the relay?" is answered by `sockets`, and "did this open one rendezvous
   * or two?" is answered here — and a test using the live list for the second question would
   * pass for the wrong reason as soon as the code under test closed up after itself.
   */
  readonly opened: FakeSocket[] = [];
  /** Set to false to model a server that accepts the TCP connection and then says nothing. */
  autoAccept = true;

  open = (url: string): RawSocket => {
    const socket = new FakeSocket(url, this);
    this.sockets.push(socket);
    this.opened.push(socket);
    // Deferred, because `SignalingClient.open` attaches its handlers *after* calling this.
    if (this.autoAccept) soon(() => socket.accept());
    return socket;
  };

  route(from: FakeSocket, data: string): void {
    for (const peer of this.sockets) {
      if (peer === from || peer.url !== from.url || peer.closed) continue;
      soon(() => peer.emit(data));
    }
  }

  leave(socket: FakeSocket): void {
    const index = this.sockets.indexOf(socket);
    if (index >= 0) this.sockets.splice(index, 1);
  }

  /** The socket most recently handed out, which is the one a single-client test wants. */
  get latest(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error('No socket has been opened.');
    return socket;
  }
}

/** Lets a pending promise's continuations run without advancing any timer. */
export const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};
