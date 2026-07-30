/**
 * The bookkeeping around the direct path.
 *
 * `webrtc.test.ts` proves the negotiation itself; what is left here is the part that is easy to
 * get subtly wrong and invisible when it is: one connection per peer rather than one per
 * attempt, a fresh rendezvous per peer rather than a shared one, and — the one that actually
 * matters for the privacy claim — a signaling socket that is closed the moment it has done its
 * job, including when the job failed.
 *
 * A relay that stays connected after the data channel is up is a live connection to a server
 * this whole design exists to stop needing.
 */

import { createDeviceIdentity, createVaultRootKey } from '@/sync/crypto';
import type { IceServer } from '@/sync/transport/endpoints';
import { DirectTransport, type DirectTransportDeps } from '@/sync/transport/direct';
import { UNAVAILABLE_RTC } from '@/sync/transport/webrtc-core';
import { FakeRtcNetwork } from '@/sync/transport/__tests__/rtc-double';
import { SocketHub, flush } from '@/sync/transport/__tests__/socket-double';

const BASE = 'https://relay.example.com';
const RENDEZVOUS = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43UOV3HO6DZPIZQ';
const ICE: readonly IceServer[] = [{ urls: 'stun:stun.example.com:19302' }];
const CONNECT_TIMEOUT_MS = 50;

const vaultKey = createVaultRootKey();

interface Rig {
  readonly hub: SocketHub;
  readonly network: FakeRtcNetwork;
  readonly a: DirectTransport;
  readonly b: DirectTransport;
  readonly aId: string;
  readonly bId: string;
  readonly sessions: { peerId: string; sas: string[] }[];
}

/** Two transports that will meet each other at the same rendezvous. */
const rig = (overrides: Partial<DirectTransportDeps> = {}): Rig => {
  const hub = new SocketHub();
  const network = new FakeRtcNetwork();
  const first = createDeviceIdentity();
  const second = createDeviceIdentity();
  const sessions: { peerId: string; sas: string[] }[] = [];

  const shape = {
    psk: vaultKey,
    epoch: 1,
    baseUrl: BASE,
    rendezvousId: RENDEZVOUS,
    iceServers: ICE,
    factory: network.factory,
    openSocket: hub.open,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    ...overrides,
  };

  return {
    hub,
    network,
    aId: first.deviceId,
    bId: second.deviceId,
    sessions,
    a: new DirectTransport({
      ...shape,
      identity: first,
      onSession: (peerId, session) => sessions.push({ peerId, sas: session.sas }),
    }),
    b: new DirectTransport({ ...shape, identity: second }),
  };
};

/** Both sides have to be connecting at once — the handshake is a strict alternation. */
const meet = (target: Rig, signal = new AbortController().signal) =>
  Promise.all([
    target.a.connect({ deviceId: target.bId, name: 'B' }, signal),
    target.b.connect({ deviceId: target.aId, name: 'A' }, signal),
  ]);

describe('DirectTransport', () => {
  it('is a p2p transport', () => {
    expect(rig().a.kind).toBe('p2p');
  });

  it('reports whether this build can do it at all', () => {
    expect(rig().a.available).toBe(true);
    expect(rig({ factory: UNAVAILABLE_RTC }).a.available).toBe(false);
  });

  it('connects two devices and hands back a channel for each', async () => {
    const target = rig();
    const [left, right] = await meet(target);

    expect(left.peerId).toBe(target.bId);
    expect(right.peerId).toBe(target.aId);

    await Promise.all([target.a.close(), target.b.close()]);
  });

  it('reports the SAS so the pairing screen can show it', async () => {
    const target = rig();
    await meet(target);

    expect(target.sessions).toHaveLength(1);
    expect(target.sessions[0].peerId).toBe(target.bId);
    expect(target.sessions[0].sas).toHaveLength(6);

    await Promise.all([target.a.close(), target.b.close()]);
  });

  it('reuses the connection for a peer it already reached', async () => {
    const target = rig();
    const [left] = await meet(target);

    const again = await target.a.connect({ deviceId: target.bId, name: 'B' }, new AbortController().signal);
    expect(again).toBe(left);
    // No second rendezvous, and no second SAS to confuse the user with.
    expect(target.sessions).toHaveLength(1);

    await Promise.all([target.a.close(), target.b.close()]);
  });

  it('closes the rendezvous once it has served its purpose', async () => {
    const target = rig();
    await meet(target);
    await flush();

    // Every socket the hub handed out is closed. From here on the two devices talk over the
    // data channel and the relay is not in the picture — which is the property that makes
    // "LAN sync contacts nothing" true after the first few kilobytes rather than never.
    expect(target.hub.sockets).toHaveLength(0);

    await Promise.all([target.a.close(), target.b.close()]);
  });

  it('closes the rendezvous even when the connection fails', async () => {
    const target = rig();
    const controller = new AbortController();

    const attempt = target.a
      .connect({ deviceId: target.bId, name: 'B' }, controller.signal)
      .catch((error: unknown) => error);
    await flush();
    controller.abort();

    expect(await attempt).toBeInstanceOf(Error);
    expect(target.hub.sockets).toHaveLength(0);
  });

  it('does not cache a failed attempt', async () => {
    const target = rig();
    const controller = new AbortController();

    const failed = target.a
      .connect({ deviceId: target.bId, name: 'B' }, controller.signal)
      .catch((error: unknown) => error);
    await flush();
    controller.abort();
    expect(await failed).toBeInstanceOf(Error);

    // A cached failure would mean one flaky attempt permanently poisoned the peer until the
    // app restarted. The second attempt gets a fresh rendezvous and succeeds.
    const [left, right] = await meet(target);
    expect(left.peerId).toBe(target.bId);
    expect(right.peerId).toBe(target.aId);

    await Promise.all([target.a.close(), target.b.close()]);
  });

  it('gives each peer its own rendezvous rather than sharing one socket', async () => {
    const target = rig();
    const signal = new AbortController().signal;

    // Two peers on one wire would interleave their hellos, and the transcript — which is the
    // only thing that authenticates a peer — would be computed over whichever arrived first.
    const first = target.a.connect({ deviceId: target.bId, name: 'B' }, signal).catch(() => null);
    const second = target.a.connect({ deviceId: 'device-c', name: 'C' }, signal).catch(() => null);
    await flush();

    expect(target.hub.opened).toHaveLength(2);
    // The rendezvous *id* is shared — it is a function of the vault key and the clock, not of
    // the peer — so both sockets address the same meeting point. The connection is what must
    // not be shared.
    expect(new Set(target.hub.opened.map((socket) => socket.url)).size).toBe(1);
    expect(target.hub.opened[0]).not.toBe(target.hub.opened[1]);

    await target.a.close();
    await Promise.all([first, second]);
  });

  it('carries frames over the channel it returned', async () => {
    const target = rig();
    const [left, right] = await meet(target);

    const heard: { frame: Uint8Array; seq: number }[] = [];
    right.onFrame((frame, seq) => heard.push({ frame, seq }));
    await left.send(Uint8Array.from([4, 5, 6]), 3);
    await flush();

    expect(heard).toEqual([{ frame: Uint8Array.from([4, 5, 6]), seq: 3 }]);

    await Promise.all([target.a.close(), target.b.close()]);
  });

  it('closes every connection it holds', async () => {
    const target = rig();
    const [left] = await meet(target);

    await target.a.close();
    await expect(left.send(Uint8Array.from([1]), 0)).rejects.toThrow();

    // And closing twice is not an error — the session calls it on teardown regardless of
    // whether anything ever connected.
    await expect(target.a.close()).resolves.toBeUndefined();
    await target.b.close();
  });

  it('refuses on a build without WebRTC without opening a rendezvous', async () => {
    const target = rig({ factory: UNAVAILABLE_RTC });

    await expect(
      target.a.connect({ deviceId: target.bId, name: 'B' }, new AbortController().signal),
    ).rejects.toThrow();

    // It opened the socket to reach the rendezvous and closed it again on the way out; what it
    // must not do is leave one behind.
    expect(target.hub.sockets).toHaveLength(0);
  });
});
