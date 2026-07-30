/**
 * Pairing, end to end, with a relay that is two objects and a promise queue.
 *
 * The interesting assertions here are not "it works". They are the ones about *when* things
 * happen: that the six words are identical on both screens before anything of value has
 * moved, that the vault key is still sitting on the host at that moment, and that a
 * precondition neither device can merge is refused before the key rather than after it.
 *
 * `SocketHub` relays between two sockets opened on the same URL, which is exactly what the
 * worker's `/rendezvous/:id` does — so the whole flow runs without a server, a network, or a
 * port, and the two devices genuinely have to find each other rather than being handed a
 * pre-wired channel.
 */

import {
  PAIRING_TTL_SECONDS,
  createDeviceIdentity,
  createVaultRootKey,
  decodePairingCode,
  derivePairingRendezvousId,
  restorePeerKeys,
  toBase64Url,
  type DeviceIdentity,
  type PairingCode,
} from '@/sync/crypto';
import type { Peer } from '@/sync/engine/roster';
import { SyncEngineError } from '@/sync/engine/types';
import { PairingHost, PairingJoiner } from '@/sync/pairing';
import { SocketHub, flush } from '@/sync/transport/__tests__/socket-double';

const RELAY = 'https://relay.example.com';
const NOW_SECONDS = 1_800_000_000;
const NOW_ISO = '2026-06-01T12:00:00.000Z';
/** Short, so a step that never completes fails in under a second instead of after three minutes. */
const IDLE_MS = 500;
/** Deliberately not 1, so "the joiner adopted the host's epoch" cannot pass by coincidence. */
const EPOCH = 3;

const vaultKey = createVaultRootKey();

interface Identities {
  readonly host: DeviceIdentity;
  readonly joiner: DeviceIdentity;
  readonly third: DeviceIdentity;
}

/** A roster row with non-empty bookkeeping, so a forwarded copy of it is visibly reset. */
const asPeer = (identity: DeviceIdentity, over: Partial<Peer> = {}): Peer => ({
  deviceId: identity.deviceId,
  name: 'Old laptop',
  platform: 'web',
  ...restorePeerKeys(identity.signing.publicKey, identity.agreement.publicKey),
  epoch: EPOCH,
  addedAt: '2026-01-01T00:00:00.000Z',
  revokedAt: null,
  revokedSeq: null,
  acked: { [identity.deviceId]: 4 },
  known: { [identity.deviceId]: 7 },
  lastSeenAt: '2026-05-01T00:00:00.000Z',
  ...over,
});

interface Options {
  readonly hostCurrency?: string;
  readonly joinerCurrency?: string;
  readonly roster?: (ids: Identities) => readonly Peer[];
  readonly tamper?: (code: PairingCode) => PairingCode;
  readonly now?: () => number;
}

interface Rig {
  readonly hub: SocketHub;
  readonly host: PairingHost;
  readonly joiner: PairingJoiner;
  readonly ids: Identities;
  /** Captured before anything can zeroize the secret it is derived from. */
  readonly rendezvousId: string;
}

const rig = (over: Options = {}): Rig => {
  const hub = new SocketHub();
  const ids: Identities = {
    host: createDeviceIdentity(),
    joiner: createDeviceIdentity(),
    third: createDeviceIdentity(),
  };

  const host = new PairingHost({
    identity: ids.host,
    vaultKey,
    epoch: EPOCH,
    baseCurrency: over.hostCurrency ?? 'USD',
    self: { name: 'Kitchen iPad', platform: 'ios' },
    roster: over.roster?.(ids) ?? [],
    relayUrl: RELAY,
    now: over.now ?? (() => NOW_SECONDS),
    nowIso: () => NOW_ISO,
    openSocket: hub.open,
    idleTimeoutMs: IDLE_MS,
  });

  const scanned = decodePairingCode(host.code, NOW_SECONDS);
  const rendezvousId = derivePairingRendezvousId(scanned.pairingSecret);

  const joiner = new PairingJoiner({
    identity: ids.joiner,
    code: over.tamper ? over.tamper(scanned) : scanned,
    baseCurrency: over.joinerCurrency ?? 'USD',
    self: { name: 'Work laptop', platform: 'web' },
    nowIso: () => NOW_ISO,
    openSocket: hub.open,
    idleTimeoutMs: IDLE_MS,
  });

  return { hub, host, joiner, ids, rendezvousId };
};

/** Both sides have to be in flight at once — the handshake is a strict alternation. */
const meet = (target: Rig) => Promise.all([target.host.handshake(), target.joiner.handshake()]);

const settle = async <T>(work: Promise<T>): Promise<unknown> => work.catch((error: unknown) => error);

describe('pairing', () => {
  it('puts the same six words on both screens', async () => {
    const target = rig();
    const [hostSide, joinerSide] = await meet(target);

    expect(hostSide.sas).toHaveLength(6);
    expect(hostSide.sas).toEqual(joinerSide.sas);
    // Each side learned who it is talking to from the signed transcript, not from a field the
    // other one filled in.
    expect(hostSide.peerDeviceId).toBe(target.ids.joiner.deviceId);
    expect(joinerSide.peerDeviceId).toBe(target.ids.host.deviceId);

    hostSide.cancel();
    joinerSide.cancel();
  });

  it('expires the code ninety seconds after it is rendered', () => {
    const target = rig();
    expect(target.host.expiresAt).toBe(NOW_SECONDS + PAIRING_TTL_SECONDS);
    target.host.close();
    target.joiner.close();
  });

  it('generates a fresh code when the host restarts in the same vault', () => {
    const target = rig();
    const previous = target.host.code;
    target.host.close();

    const replacement = new PairingHost({
      identity: target.ids.host,
      vaultKey,
      epoch: EPOCH,
      baseCurrency: 'USD',
      self: { name: 'Kitchen iPad', platform: 'ios' },
      roster: [],
      relayUrl: RELAY,
      now: () => NOW_SECONDS,
      nowIso: () => NOW_ISO,
      openSocket: target.hub.open,
      idleTimeoutMs: IDLE_MS,
    });

    expect(replacement.code).not.toBe(previous);
    replacement.close();
    target.joiner.close();
  });

  it('closes the host session when the advertised code deadline passes', async () => {
    jest.useFakeTimers();
    try {
      const target = rig();
      jest.advanceTimersByTime(PAIRING_TTL_SECONDS * 1000);

      await expect(target.host.handshake()).rejects.toThrow(/expired/i);
      expect(target.hub.opened).toHaveLength(0);
      target.joiner.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('will not release the vault after expiry, even when the SAS already matched', async () => {
    let now = NOW_SECONDS;
    const target = rig({ now: () => now });
    const [hostSide, joinerSide] = await meet(target);
    now += PAIRING_TTL_SECONDS;

    await expect(hostSide.confirm()).rejects.toThrow(/expired/i);
    // Only the hello and identity proof crossed the host socket; no vault frame followed.
    expect(target.hub.opened[0].sent).toHaveLength(2);
    joinerSide.cancel();
  });

  it('meets at a rendezvous derived from the pairing secret, over TLS', async () => {
    const target = rig();
    const [hostSide, joinerSide] = await meet(target);

    expect(target.hub.opened).toHaveLength(2);
    expect(new Set(target.hub.opened.map((socket) => socket.url)).size).toBe(1);
    // Not the vault's rotating rendezvous: the joining device has no vault key yet, and that
    // is the entire thing it is here to obtain.
    expect(target.hub.opened[0].url).toBe(`wss://relay.example.com/rendezvous/${target.rendezvousId}`);

    hostSide.cancel();
    joinerSide.cancel();
  });

  it('moves nothing of value before both people have confirmed', async () => {
    const target = rig();
    const [hostSide, joinerSide] = await meet(target);

    // Two messages each, and they are the handshake: a hello and a proof of identity. The
    // pause between here and `confirm` is the security control, so it has to be a real pause
    // — a key already on the wire would make the SAS comparison theatre.
    for (const socket of target.hub.opened) expect(socket.sent).toHaveLength(2);

    const secret = toBase64Url(vaultKey);
    for (const socket of target.hub.opened) {
      for (const frame of socket.sent) expect(frame).not.toContain(secret);
    }

    hostSide.cancel();
    joinerSide.cancel();
  });

  it('hands over the vault once both sides confirm', async () => {
    const target = rig();
    const [hostSide, joinerSide] = await meet(target);
    const [hostResult, joinerResult] = await Promise.all([hostSide.confirm(), joinerSide.confirm()]);

    expect(joinerResult.vaultKey).toEqual(vaultKey);
    expect(joinerResult.epoch).toBe(EPOCH);
    expect(joinerResult.baseCurrency).toBe('USD');
    expect(joinerResult.peers.map((peer) => peer.deviceId)).toEqual([target.ids.host.deviceId]);
    expect(joinerResult.peers[0].name).toBe('Kitchen iPad');
    expect(joinerResult.peers[0].platform).toBe('ios');
    expect(joinerResult.peers[0].signingKey).toEqual(target.ids.host.signing.publicKey);
    expect(joinerResult.peers[0].agreementKey).toEqual(target.ids.host.agreement.publicKey);

    expect(hostResult.peer.deviceId).toBe(target.ids.joiner.deviceId);
    expect(hostResult.peer.name).toBe('Work laptop');
    expect(hostResult.peer.platform).toBe('web');
    expect(hostResult.peer.signingKey).toEqual(target.ids.joiner.signing.publicKey);
    expect(hostResult.peer.agreementKey).toEqual(target.ids.joiner.agreement.publicKey);
    expect(hostResult.peer.epoch).toBe(EPOCH);
    expect(hostResult.peer.revokedAt).toBeNull();
    expect(hostResult.peer.revokedSeq).toBeNull();
    // Neither side has any of the other's history yet, and a row claiming otherwise would
    // stop it from ever asking for it.
    expect(hostResult.peer.acked).toEqual({});
    expect(hostResult.peer.known).toEqual({});

    await flush();
    expect(target.hub.sockets).toHaveLength(0);
  });

  it('forwards the rest of the vault so the joiner can reach every device', async () => {
    const target = rig({
      roster: (ids) => [
        asPeer(ids.third, {
          name: 'Old phone',
          revokedAt: '2026-04-01T00:00:00.000Z',
          revokedSeq: 7,
        }),
      ],
    });
    const [hostSide, joinerSide] = await meet(target);
    const [, joinerResult] = await Promise.all([hostSide.confirm(), joinerSide.confirm()]);

    expect(joinerResult.peers.map((peer) => peer.deviceId)).toEqual([
      target.ids.host.deviceId,
      target.ids.third.deviceId,
    ]);

    const third = joinerResult.peers[1];
    expect(third.name).toBe('Old phone');
    expect(third.signingKey).toEqual(target.ids.third.signing.publicKey);
    expect(third.addedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(third.revokedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(third.revokedSeq).toBe(7);
    // The host's bookkeeping is about what *the host* holds. Copying it would tell the joiner
    // it had already received history it has never seen.
    expect(third.acked).toEqual({});
    expect(third.known).toEqual({});
    expect(third.lastSeenAt).toBe(NOW_ISO);
  });

  it('never puts the joining device in the roster it sends that device', async () => {
    const target = rig({ roster: (ids) => [asPeer(ids.joiner), asPeer(ids.third)] });
    const [hostSide, joinerSide] = await meet(target);
    const [, joinerResult] = await Promise.all([hostSide.confirm(), joinerSide.confirm()]);

    // A roster that names you is a roster you will forward your own ops back into, and
    // `requireAuthor` has no way to tell that apart from a peer impersonating you.
    expect(joinerResult.peers.map((peer) => peer.deviceId)).toEqual([
      target.ids.host.deviceId,
      target.ids.third.deviceId,
    ]);
  });

  it('prefers the authenticated identity over a roster row claiming to be the same device', async () => {
    const target = rig({
      roster: (ids) => [asPeer(ids.host, { name: 'Impostor', platform: 'android' })],
    });
    const [hostSide, joinerSide] = await meet(target);
    const [, joinerResult] = await Promise.all([hostSide.confirm(), joinerSide.confirm()]);

    expect(joinerResult.peers).toHaveLength(1);
    expect(joinerResult.peers[0].name).toBe('Kitchen iPad');
  });

  it('refuses two vaults that disagree about the base currency, before the key moves', async () => {
    const target = rig({ hostCurrency: 'USD', joinerCurrency: 'ILS' });
    const [hostSide, joinerSide] = await meet(target);

    const [hostError, joinerError] = await Promise.all([
      settle(hostSide.confirm()),
      settle(joinerSide.confirm()),
    ]);

    for (const error of [hostError, joinerError]) {
      expect(error).toBeInstanceOf(SyncEngineError);
      expect((error as SyncEngineError).code).toBe('currencyMismatch');
      // Plain language, and it names both units — "sync failed" sends someone hunting for a
      // network problem they do not have.
      expect((error as SyncEngineError).message).toContain('USD');
      expect((error as SyncEngineError).message).toContain('ILS');
    }

    const secret = toBase64Url(vaultKey);
    for (const socket of target.hub.opened) {
      for (const frame of socket.sent) expect(frame).not.toContain(secret);
    }
  });

  it('lets a device that has not been onboarded adopt whatever it joins', async () => {
    const target = rig({ hostCurrency: 'ILS', joinerCurrency: '' });
    const [hostSide, joinerSide] = await meet(target);
    const [, joinerResult] = await Promise.all([hostSide.confirm(), joinerSide.confirm()]);

    expect(joinerResult.baseCurrency).toBe('ILS');
  });

  it('stops when a device other than the one on the code answers', async () => {
    const target = rig({
      tamper: (code) => ({ ...code, ephemeralPublicKey: createDeviceIdentity().agreement.publicKey }),
    });

    const hostAttempt = settle(target.host.handshake());
    const joinerError = await settle(target.joiner.handshake());

    expect(joinerError).toBeInstanceOf(SyncEngineError);
    expect((joinerError as SyncEngineError).code).toBe('badPairing');

    target.host.close();
    expect(await hostAttempt).toBeInstanceOf(Error);
    await flush();
    expect(target.hub.sockets).toHaveLength(0);
  });

  it('closes the rendezvous and sends nothing more when someone says the words differ', async () => {
    const target = rig();
    const [hostSide, joinerSide] = await meet(target);

    hostSide.cancel();
    joinerSide.cancel();
    await flush();

    expect(target.hub.sockets).toHaveLength(0);
    for (const socket of target.hub.opened) expect(socket.sent).toHaveLength(2);

    // And a confirmation that arrives after the abort cannot revive it. There is no resume
    // path: the secret is single use, and an attempt worth abandoning is one worth abandoning
    // completely.
    await expect(hostSide.confirm()).rejects.toThrow();
    await expect(joinerSide.confirm()).rejects.toThrow();
  });
});
