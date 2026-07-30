/**
 * The rendezvous client.
 *
 * Two things are being pinned here, and they pull in opposite directions. The first is that a
 * hostile or broken signaling server must not be able to break a pairing that would otherwise
 * succeed — junk is discarded, not thrown. The second is that a *silent* rendezvous must not
 * hang forever, because "the other device is switched off" is by far the most common reason
 * nothing arrives, and a spinner that never resolves teaches the user that sync is broken.
 */

import { fromBase64Url, toBase64Url } from '@/sync/crypto';
import { RelayError } from '@/sync/transport/http';
import { MAX_SIGNAL_BYTES, SignalingClient, signalingUrl } from '@/sync/transport/signaling';
import { FakeSocket, SocketHub, flush } from '@/sync/transport/__tests__/socket-double';

const BASE = 'https://relay.example.com';
const ID = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43UOV3HO6DZPIZQ';

const client = (hub: SocketHub, overrides: Partial<{ baseUrl: string; idleTimeoutMs: number; openTimeoutMs: number }> = {}) =>
  new SignalingClient({
    baseUrl: overrides.baseUrl ?? BASE,
    rendezvousId: ID,
    open: hub.open,
    openTimeoutMs: overrides.openTimeoutMs,
    idleTimeoutMs: overrides.idleTimeoutMs,
  });

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('signalingUrl', () => {
  it('upgrades https to wss', () => {
    expect(signalingUrl('https://relay.example.com', 'abc')).toBe(
      'wss://relay.example.com/rendezvous/abc',
    );
  });

  it('uses ws for a plaintext loopback relay, which is the only place http is allowed', () => {
    expect(signalingUrl('http://localhost:8787', 'abc')).toBe(
      'ws://localhost:8787/rendezvous/abc',
    );
  });

  it('preserves a sub-path so a relay can be mounted somewhere other than the root', () => {
    expect(signalingUrl('https://example.com/qashy', 'abc')).toBe(
      'wss://example.com/qashy/rendezvous/abc',
    );
  });

  it('encodes the id rather than trusting it to be path-safe', () => {
    expect(signalingUrl(BASE, 'a/b?c')).toBe('wss://relay.example.com/rendezvous/a%2Fb%3Fc');
  });
});

describe('SignalingClient.open', () => {
  it('resolves once the server accepts the socket', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);

    await expect(signaling.open()).resolves.toBeUndefined();
    expect(hub.sockets).toHaveLength(1);
    expect(hub.latest.url).toBe(`wss://relay.example.com/rendezvous/${ID}`);
  });

  it('opens one socket however many times it is asked', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);

    await signaling.open();
    await signaling.open();

    expect(hub.sockets).toHaveLength(1);
  });

  it('gives up on a server that accepts the connection and then says nothing', async () => {
    jest.useFakeTimers();
    try {
      const hub = new SocketHub();
      hub.autoAccept = false;
      const signaling = client(hub, { openTimeoutMs: 10_000 });

      const opening = signaling.open();
      const settled = opening.catch((error: unknown) => error);
      jest.advanceTimersByTime(10_000);

      const error = await settled;
      expect(error).toBeInstanceOf(RelayError);
      expect((error as RelayError).code).toBe('unreachable');
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a transport failure', async () => {
    const hub = new SocketHub();
    hub.autoAccept = false;
    const signaling = client(hub);

    const opening = signaling.open();
    await flush();
    hub.latest.error();

    await expect(opening).rejects.toThrow(RelayError);
  });

  it('refuses to open at all once the signal is already aborted', async () => {
    const hub = new SocketHub();
    const controller = new AbortController();
    controller.abort();

    await expect(client(hub).open(controller.signal)).rejects.toThrow(RelayError);
    expect(hub.sockets).toHaveLength(0);
  });

  it('rejects when the signal aborts mid-connection', async () => {
    const hub = new SocketHub();
    hub.autoAccept = false;
    const controller = new AbortController();

    const opening = client(hub).open(controller.signal);
    await flush();
    controller.abort();

    await expect(opening).rejects.toThrow(RelayError);
  });
});

describe('SignalingClient.send', () => {
  it('base64url-encodes the payload, because the worker relays text', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    signaling.send(bytes(1, 2, 250, 255));

    expect(hub.latest.sent).toEqual([toBase64Url(bytes(1, 2, 250, 255))]);
    expect(fromBase64Url(hub.latest.sent[0])).toEqual(bytes(1, 2, 250, 255));
  });

  it('refuses a payload past the cap before it reaches the wire', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    expect(() => signaling.send(new Uint8Array(MAX_SIGNAL_BYTES + 1))).toThrow(RelayError);
    expect(hub.latest.sent).toHaveLength(0);
  });

  it('throws before the socket is open', () => {
    expect(() => client(new SocketHub()).send(bytes(1))).toThrow(RelayError);
  });

  it('keeps throwing the original failure after the rendezvous has failed', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();
    hub.latest.hangup();

    expect(() => signaling.send(bytes(1))).toThrow(RelayError);
  });
});

describe('SignalingClient.receive', () => {
  it('returns a message that arrived before anyone asked for one', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    hub.latest.emit(toBase64Url(bytes(7, 8, 9)));

    await expect(signaling.receive()).resolves.toEqual(bytes(7, 8, 9));
  });

  it('resolves a waiter when the message arrives later', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    const waiting = signaling.receive();
    hub.latest.emit(toBase64Url(bytes(42)));

    await expect(waiting).resolves.toEqual(bytes(42));
  });

  it('preserves order across a queued message and a live one', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    hub.latest.emit(toBase64Url(bytes(1)));
    hub.latest.emit(toBase64Url(bytes(2)));

    await expect(signaling.receive()).resolves.toEqual(bytes(1));
    await expect(signaling.receive()).resolves.toEqual(bytes(2));
  });

  it('gives up on a peer that never answers', async () => {
    jest.useFakeTimers();
    try {
      const hub = new SocketHub();
      const signaling = client(hub, { idleTimeoutMs: 45_000 });
      await signaling.open();

      const settled = signaling.receive().catch((error: unknown) => error);
      jest.advanceTimersByTime(45_000);

      expect(await settled).toBeInstanceOf(RelayError);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a pending waiter when the server hangs up mid-handshake', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    const waiting = signaling.receive();
    hub.latest.hangup();

    await expect(waiting).rejects.toThrow(RelayError);
  });

  it('rejects when the signal aborts', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    const controller = new AbortController();
    const waiting = signaling.receive(controller.signal);
    controller.abort();

    await expect(waiting).rejects.toThrow(RelayError);
  });

  it('rejects immediately once closed', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();
    signaling.close();

    await expect(signaling.receive()).rejects.toThrow(RelayError);
  });
});

describe('SignalingClient.waitForPeer', () => {
  it('waits for the relay to confirm both parties are connected', async () => {
    const hub = new SocketHub();
    const alice = client(hub);
    const bob = client(hub);

    await alice.open();
    const waiting = alice.waitForPeer();
    await bob.open();

    await expect(waiting).resolves.toBeUndefined();
    await expect(bob.waitForPeer()).resolves.toBeUndefined();
  });

  it('does not put the relay control frame in the application inbox', async () => {
    const hub = new SocketHub();
    const alice = client(hub);
    const bob = client(hub);

    await Promise.all([alice.open(), bob.open()]);
    await Promise.all([alice.waitForPeer(), bob.waitForPeer()]);

    expect((alice as unknown as { inbox: Uint8Array[] }).inbox).toHaveLength(0);
    expect((bob as unknown as { inbox: Uint8Array[] }).inbox).toHaveLength(0);
  });
});

describe('a hostile or broken server', () => {
  /**
   * Every one of these is silently discarded rather than thrown. Whoever else found this
   * rendezvous id — the server included — can put anything on the wire, so junk is an expected
   * input. Treating it as an error would hand a passer-by the power to abort a pairing that
   * was otherwise one message from succeeding.
   */
  it.each([
    ['a binary frame', new ArrayBuffer(8)],
    ['a number', 12],
    ['null', null],
    ['text that is not base64url', '!!! not base64 !!!'],
    ['an empty message', ''],
  ])('discards %s without failing the rendezvous', async (_label, payload) => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    const waiting = signaling.receive();
    hub.latest.emit(payload);
    hub.latest.emit(toBase64Url(bytes(5)));

    await expect(waiting).resolves.toEqual(bytes(5));
  });

  it('discards a message past the cap before decoding it', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    const waiting = signaling.receive();
    hub.latest.emit('A'.repeat(MAX_SIGNAL_BYTES * 2));
    hub.latest.emit(toBase64Url(bytes(6)));

    await expect(waiting).resolves.toEqual(bytes(6));
  });
});

describe('SignalingClient.close', () => {
  it('detaches every handler before closing, so the close is not reported as a failure', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();
    const socket = hub.latest;

    signaling.close();

    expect(socket.closed).not.toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
  });

  it('is idempotent', async () => {
    const hub = new SocketHub();
    const signaling = client(hub);
    await signaling.open();

    signaling.close();
    expect(() => signaling.close()).not.toThrow();
  });
});

describe('two clients on one rendezvous', () => {
  it('relays in both directions and to nobody else', async () => {
    const hub = new SocketHub();
    const alice = client(hub);
    const bob = client(hub);
    const elsewhere = client(hub, { baseUrl: 'https://other.example.com' });

    await Promise.all([alice.open(), bob.open(), elsewhere.open()]);

    const heard = bob.receive();
    alice.send(bytes(1, 1, 2, 3));
    await expect(heard).resolves.toEqual(bytes(1, 1, 2, 3));

    const back = alice.receive();
    bob.send(bytes(5, 8));
    await expect(back).resolves.toEqual(bytes(5, 8));

    // The third client is on a different origin and therefore a different rendezvous. It has
    // heard nothing, which is the property that makes the id — not the connection — the thing
    // that scopes a session.
    expect((elsewhere as unknown as { inbox: Uint8Array[] }).inbox).toHaveLength(0);
  });

  it('does not echo a sender its own message', async () => {
    const hub = new SocketHub();
    const alice = client(hub);
    const bob = client(hub);
    await Promise.all([alice.open(), bob.open()]);

    alice.send(bytes(9));
    await flush();

    expect((alice as unknown as { inbox: Uint8Array[] }).inbox).toHaveLength(0);
    await expect(bob.receive()).resolves.toEqual(bytes(9));
  });
});

describe('platform socket', () => {
  it('is what a real client uses, and the double is what a test does', () => {
    // A guard against the double drifting from the interface it stands in for: if `RawSocket`
    // gains a member, this stops compiling rather than failing mysteriously at runtime.
    const socket: FakeSocket = new FakeSocket('wss://example.com/rendezvous/x');
    expect(socket.url).toContain('wss://');
    expect(socket.sent).toEqual([]);
  });
});
