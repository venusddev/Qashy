/**
 * The direct path, end to end, in one process.
 *
 * Two `connectWebRtc` calls run against a shared in-memory rendezvous and a shared fake WebRTC
 * network. Everything between them is real: the real §1.5 handshake, the real sealed signaling,
 * the real role selection, the real ICE gate. Only the WebSocket and `RTCPeerConnection` are
 * doubles, because those are the two things that need an operating system.
 *
 * That matters because the claims worth testing here are all about *ordering*, and ordering is
 * exactly what a unit test of any single function cannot see:
 *
 * - the handshake completes before one byte of SDP crosses the wire, and everything after it
 *   is sealed — so a hostile signaling server never sees a DTLS fingerprint it could swap;
 * - no ICE candidate is sent before the description that gives it meaning;
 * - both sides derive the same SAS, and a *different* pairing attempt derives a different one.
 */

import {
  createDeviceIdentity,
  createVaultRootKey,
  fromBase64Url,
  peekPurpose,
  type DeviceIdentity,
  type VaultRootKey,
} from '@/sync/crypto';
import type { IceServer } from '@/sync/transport/endpoints';
import { RelayError } from '@/sync/transport/http';
import { SignalingClient } from '@/sync/transport/signaling';
import {
  CHANNEL_LABEL,
  MAX_CHANNEL_MESSAGE,
  UNAVAILABLE_RTC,
  connectWebRtc,
  type WebRtcConnection,
  type WebRtcDeps,
} from '@/sync/transport/webrtc-core';
import { FakeRtcNetwork } from '@/sync/transport/__tests__/rtc-double';
import { FakeSocket, SocketHub, flush } from '@/sync/transport/__tests__/socket-double';

const BASE = 'https://relay.example.com';
const RENDEZVOUS = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43UOV3HO6DZPIZQ';
const ICE: readonly IceServer[] = [{ urls: 'stun:stun.example.com:19302' }];

/**
 * Short enough that a test which is *meant* to fail to connect does so in milliseconds.
 *
 * The production default is 20 seconds, which is right for a phone waking up on a slow network
 * and wrong for a suite that has to prove what happens when the connection never comes up.
 */
const CONNECT_TIMEOUT_MS = 50;

interface Party {
  readonly identity: DeviceIdentity;
  readonly signaling: SignalingClient;
  /** Held separately because `SocketHub.leave` removes a closed socket from its list. */
  readonly socket: FakeSocket;
}

const partyFor = async (hub: SocketHub, rendezvousId = RENDEZVOUS): Promise<Party> => {
  const signaling = new SignalingClient({ baseUrl: BASE, rendezvousId, open: hub.open });
  await signaling.open();
  return { identity: createDeviceIdentity(), signaling, socket: hub.latest };
};

const depsFor = (
  party: Party,
  peer: Party,
  psk: VaultRootKey,
  factory: FakeRtcNetwork['factory'],
): WebRtcDeps => ({
  identity: party.identity,
  psk,
  epoch: 1,
  iceServers: ICE,
  factory,
  signaling: party.signaling,
  peer: { deviceId: peer.identity.deviceId, name: 'peer' },
  connectTimeoutMs: CONNECT_TIMEOUT_MS,
});

/**
 * Runs a full pairing between two parties and returns both ends.
 *
 * Both calls are started before either is awaited. They have to be: the handshake is a strict
 * alternation, so a party that is not yet listening is a party the other one waits on forever.
 */
const pair = (
  psk: VaultRootKey,
  a: Party,
  b: Party,
  network: FakeRtcNetwork,
  signal = new AbortController().signal,
): Promise<[WebRtcConnection, WebRtcConnection]> =>
  Promise.all([
    connectWebRtc(depsFor(a, b, psk, network.factory), signal),
    connectWebRtc(depsFor(b, a, psk, network.factory), signal),
  ]);

/** Closes everything, so no idle-timeout timer outlives the test that created it. */
const teardown = (parties: readonly Party[], connections: readonly WebRtcConnection[] = []) => {
  for (const connection of connections) connection.close();
  for (const party of parties) party.signaling.close();
};

describe('connectWebRtc', () => {
  it('refuses on a platform without WebRTC rather than pretending to connect', async () => {
    const hub = new SocketHub();
    const a = await partyFor(hub);
    const b = await partyFor(hub);

    await expect(
      connectWebRtc(depsFor(a, b, createVaultRootKey(), UNAVAILABLE_RTC), new AbortController().signal),
    ).rejects.toThrow(RelayError);

    // It refused before saying anything at a rendezvous, so a build that cannot do this never
    // leaves the other device waiting on a handshake that will not arrive.
    expect(a.socket.sent).toHaveLength(0);
    teardown([a, b]);
  });

  it('connects two devices and gives both the same SAS', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);

    const [left, right] = await pair(createVaultRootKey(), a, b, network);

    expect(left.session.sas).toEqual(right.session.sas);
    expect(left.session.sas).toHaveLength(6);
    expect(left.session.peerDeviceId).toBe(b.identity.deviceId);
    expect(right.session.peerDeviceId).toBe(a.identity.deviceId);

    teardown([a, b], [left, right]);
  });

  it('carries frames and their sequence numbers in both directions', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const [left, right] = await pair(createVaultRootKey(), a, b, network);

    const heardByRight: { frame: Uint8Array; seq: number }[] = [];
    const heardByLeft: { frame: Uint8Array; seq: number }[] = [];
    right.channel.onFrame((frame, seq) => heardByRight.push({ frame, seq }));
    left.channel.onFrame((frame, seq) => heardByLeft.push({ frame, seq }));

    // Sequence 7 rather than 0: a drop-box channel is legitimately handed frames whose counter
    // did not start at zero in this session, and the transport's job is to carry the number
    // rather than to infer it from arrival order.
    await left.channel.send(Uint8Array.from([1, 2, 3]), 7);
    await right.channel.send(Uint8Array.from([9]), 0);
    await flush();

    expect(heardByRight).toEqual([{ frame: Uint8Array.from([1, 2, 3]), seq: 7 }]);
    expect(heardByLeft).toEqual([{ frame: Uint8Array.from([9]), seq: 0 }]);

    teardown([a, b], [left, right]);
  });

  it('names the peer on the channel so the engine can attribute what arrives', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const [left, right] = await pair(createVaultRootKey(), a, b, network);

    expect(left.channel.peerId).toBe(b.identity.deviceId);
    expect(right.channel.peerId).toBe(a.identity.deviceId);

    teardown([a, b], [left, right]);
  });

  it('hands an oversized frame over instead of dropping it, so the refusal can be recorded', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const [left, right] = await pair(createVaultRootKey(), a, b, network);

    const heard: { frame: Uint8Array; seq: number }[] = [];
    right.channel.onFrame((frame, seq) => heard.push({ frame, seq }));

    // Past the channel ceiling. `openBatch` is the layer that refuses it — with a recorded
    // `tooLarge` rejection — and it can only do that if the bytes actually arrive there.
    const oversized = new Uint8Array(MAX_CHANNEL_MESSAGE + 1);
    await left.channel.send(oversized, 3);
    await flush();

    expect(heard).toHaveLength(1);
    expect(heard[0].seq).toBe(3);
    expect(heard[0].frame.length).toBe(oversized.length);

    teardown([a, b], [left, right]);
  });

  it('stops sending and stops delivering once closed', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const [left, right] = await pair(createVaultRootKey(), a, b, network);

    const heard: Uint8Array[] = [];
    right.channel.onFrame((frame) => heard.push(frame));
    right.close();
    await flush();

    await expect(left.channel.send(Uint8Array.from([1]), 0)).rejects.toThrow(RelayError);
    await flush();
    expect(heard).toHaveLength(0);

    teardown([a, b], [left]);
  });
});

describe('role selection', () => {
  it('gives the offer to the lower device id, so there is nothing to negotiate', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const [left, right] = await pair(createVaultRootKey(), a, b, network);

    // Exactly one side offered and exactly one answered. Glare — both offering, or neither —
    // is the failure this rule exists to prevent, and it is invisible to any test that only
    // looks at one device.
    const offerers = network.connections.filter((connection) => connection.role === 'offer');
    const answerers = network.connections.filter((connection) => connection.role === 'answer');
    expect(offerers).toHaveLength(1);
    expect(answerers).toHaveLength(1);

    // Only the offerer creates the channel; the answerer receives it through `ondatachannel`.
    expect(offerers[0].local?.label).toBe(CHANNEL_LABEL);
    expect(network.connections.filter((connection) => connection.createdChannel)).toHaveLength(1);

    // `network.connections` is in creation order, and `pair` starts A's call first — so the
    // first connection belongs to A. Which of the two offered must match the id comparison
    // both sides computed independently.
    const aOffered = network.connections[0].role === 'offer';
    expect(aOffered).toBe(a.identity.deviceId < b.identity.deviceId);

    teardown([a, b], [left, right]);
  });
});

describe('ordering', () => {
  it('sends exactly two plaintext messages, then seals everything else', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const [left, right] = await pair(createVaultRootKey(), a, b, network);
    await flush();

    for (const party of [a, b]) {
      const sent = party.socket.sent.map(decode);
      expect(sent.length).toBeGreaterThan(2);

      // The hello and the auth proof are the handshake itself: a public key, a nonce, and a
      // signature. Nothing about the vault is in either, and neither is an envelope.
      expect(peekPurpose(sent[0])).toBeNull();
      expect(peekPurpose(sent[1])).toBeNull();

      // Everything from the third message on is SDP and ICE, and every one of them is sealed
      // under the session key. `peekPurpose` parses the magic, the version, and the purpose
      // byte, so a plaintext SDP would fail here rather than passing a shallow shape check.
      for (const frame of sent.slice(2)) expect(peekPurpose(frame)).toBe('handshake');
    }

    teardown([a, b], [left, right]);
  });

  it('never puts an ICE candidate on the wire before its own description', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const [left, right] = await pair(createVaultRootKey(), a, b, network);
    await flush();

    // The double rejects `addIceCandidate` before `setRemoteDescription`, exactly as a real
    // connection does — and `webrtc-core.ts` swallows that rejection, because ICE is a race
    // and losing one runner does not lose it. So a candidate that arrived too early leaves no
    // trace anywhere except this counter, which is why the counter exists.
    const applied = network.connections.reduce((total, pc) => total + pc.applied.length, 0);
    const rejected = network.connections.reduce((total, pc) => total + pc.rejectedCandidates, 0);

    expect(applied).toBeGreaterThan(0);
    expect(rejected).toBe(0);

    teardown([a, b], [left, right]);
  });
});

describe('a hostile rendezvous', () => {
  it('refuses a peer whose device id is not the one expected', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const psk = createVaultRootKey();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const controller = new AbortController();

    const impostor: WebRtcDeps = {
      ...depsFor(a, b, psk, network.factory),
      // Whoever is actually on the other end of this rendezvous, it is not this device.
      peer: { deviceId: createDeviceIdentity().deviceId, name: 'Impostor' },
    };

    const left = connectWebRtc(impostor, controller.signal).catch((error: unknown) => error);
    const right = connectWebRtc(depsFor(b, a, psk, network.factory), controller.signal).catch(
      (error: unknown) => error,
    );

    expect(await left).toBeInstanceOf(Error);
    // The rejection happens during the handshake, before a peer connection is built at all —
    // so there is nothing to leak and no half-open state to reason about.
    expect(network.connections).toHaveLength(0);

    controller.abort();
    await right;
    teardown([a, b]);
  });

  it('fails when the two sides hold different pre-shared keys', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const controller = new AbortController();

    const left = connectWebRtc(
      depsFor(a, b, createVaultRootKey(), network.factory),
      controller.signal,
    ).catch((error: unknown) => error);
    const right = connectWebRtc(
      depsFor(b, a, createVaultRootKey(), network.factory),
      controller.signal,
    ).catch((error: unknown) => error);

    // The hellos cross fine — they are plaintext — and the transcript signatures verify, since
    // the transcript covers the hellos and not the PSK. What fails is the first *sealed*
    // message: the two sides derived different session keys, so the SDP never opens and no
    // channel ever comes up. A non-member who found the rendezvous id gets exactly this far.
    const results = await Promise.all([left, right]);
    expect(results.every((result) => result instanceof RelayError)).toBe(true);

    controller.abort();
    teardown([a, b]);
  });

  it('derives a different SAS for every pairing attempt', async () => {
    const network = new FakeRtcNetwork();
    const psk = createVaultRootKey();

    const hub = new SocketHub();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const [left, right] = await pair(psk, a, b, network);
    const honest = left.session.sas;
    teardown([a, b], [left, right]);

    // The same vault key, a second time. Fresh ephemeral keys mean a fresh transcript, which
    // means a different SAS — so the words the user compares identify *this* attempt rather
    // than the vault. An attacker who raced the first one cannot replay its SAS into the
    // second, which is the property that makes a photographed QR survivable.
    const other = new SocketHub();
    const c = await partyFor(other);
    const d = await partyFor(other);
    const [third, fourth] = await pair(psk, c, d, new FakeRtcNetwork());

    expect(third.session.sas).toEqual(fourth.session.sas);
    expect(third.session.sas).not.toEqual(honest);

    teardown([c, d], [third, fourth]);
  });
});

describe('cancellation', () => {
  it('abandons a pairing nobody answered, without building a connection', async () => {
    const hub = new SocketHub();
    const network = new FakeRtcNetwork();
    const a = await partyFor(hub);
    const b = await partyFor(hub);
    const controller = new AbortController();

    const attempt = connectWebRtc(
      depsFor(a, b, createVaultRootKey(), network.factory),
      controller.signal,
    ).catch((error: unknown) => error);

    await flush();
    controller.abort();

    expect(await attempt).toBeInstanceOf(RelayError);
    expect(network.connections).toHaveLength(0);
    teardown([a, b]);
  });
});

/** The rendezvous carries base64url text; `peekPurpose` wants bytes. */
const decode = (message: string): Uint8Array => fromBase64Url(message);
