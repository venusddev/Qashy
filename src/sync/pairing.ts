/**
 * Pairing — the conversation that turns two strangers into one vault.
 *
 * Every other exchange in the sync stack happens between devices that already share a root
 * key. This is the one that establishes it, which makes it the only moment an attacker gets a
 * shot at joining rather than merely at reading, and it is why the sequence below is written
 * out step by step instead of hidden behind a helper.
 *
 * The order, and what each step is for:
 *
 *   1. The host generates an ephemeral keypair and a single-use **pairing secret**, and renders
 *      both — plus its own identity — as a QR code. The secret travels optically, so a network
 *      attacker never sees it.
 *   2. Both devices meet at `derivePairingRendezvousId(pairingSecret)`. Not the vault's usual
 *      rotating rendezvous: the joining device has no vault root key yet, and that is precisely
 *      what it is here to obtain.
 *   3. They run the §1.5 handshake with the pairing secret as the PSK. Confidentiality against
 *      anyone who did not scan the QR comes from mixing that secret into the HKDF; forward
 *      secrecy comes from the ephemeral ECDH; and the signed transcript is what defeats a man
 *      in the middle.
 *   4. **Both screens show the same six words, and a human compares them.** This is the step
 *      that makes a photographed QR survivable — an attacker who raced the handshake ends up in
 *      two sessions with two transcripts, so the two screens disagree and the person stops.
 *   5. Only after *both* people have confirmed does anything of value move: the joiner sends its
 *      identity, and the host answers with the vault root key and the roster.
 *
 * Two things are deliberately *not* here. This module writes nothing to storage and touches no
 * keystore — it returns the rows and keys its caller should persist, so the whole flow is
 * testable end to end with two objects and a fake socket, and so there is no path where a
 * half-finished pairing has already half-written itself into a database. And it holds no
 * retry: a failed pairing is abandoned, never resumed, because the secret is single-use and
 * resuming one is indistinguishable from an attacker resuming it for you.
 */

import {
  PAIRING_TTL_SECONDS,
  PROTOCOL_VERSION,
  acceptPeerAuth,
  bytesToUtf8,
  completeHandshake,
  constantTimeEqual,
  createPairingSecret,
  decodeHello,
  derivePairingRendezvousId,
  encodeHello,
  encodePairingCode,
  fromBase64Url,
  open,
  restorePeerKeys,
  restoreVaultRootKey,
  seal,
  startHandshake,
  toBase64Url,
  utf8Bytes,
  zeroize,
  type DeviceIdentity,
  type EnvelopeContext,
  type HandshakeHello,
  type HandshakeSession,
  type PairingCode,
  type PairingSecret,
  type PendingHandshake,
  type SessionKey,
  type VaultRootKey,
} from '@/sync/crypto';
import type { Peer } from '@/sync/engine/roster';
import { SyncEngineError } from '@/sync/engine/types';
import {
  SignalingClient,
  platformSocket,
  type RawSocket,
} from '@/sync/transport/signaling';
import { canonicalJson } from '@/utils/canonical-json';

/**
 * The epoch the two pairing frames are sealed under.
 *
 * Zero rather than the host's real epoch, because the joiner has no way to know that number
 * until the frame it is inside arrives — and an AEAD context both sides cannot compute
 * independently is not a context, it is a guess. The vault's real epoch travels *inside* the
 * sealed payload, where it is authenticated by the tag either way.
 *
 * A live vault epoch always starts at 1, so this can never collide with a real one.
 */
export const PAIRING_EPOCH = 0;

/**
 * How long a pairing socket waits on the other device.
 *
 * Far longer than `SIGNAL_IDLE_TIMEOUT_MS`, and for a reason that only applies here: the wait
 * is not a network wait, it is two people reading six words off two screens and deciding
 * whether they match. Forty-five seconds is generous for a packet and insulting for a human.
 */
export const PAIRING_IDLE_TIMEOUT_MS = 180_000;

/** Both pairing payloads are the first and only frame in their direction. */
const FIRST_FRAME = 0;

// ---------------------------------------------------------------------------
// What the caller supplies and what it gets back
// ---------------------------------------------------------------------------

/** How this device should introduce itself to the other one. */
export interface PairingSelf {
  readonly name: string;
  readonly platform: string;
}

export interface HostPairingDeps {
  readonly identity: DeviceIdentity;
  readonly vaultKey: VaultRootKey;
  readonly epoch: number;
  /** `''` on a device that has not finished onboarding, which then accepts any partner. */
  readonly baseCurrency: string;
  readonly self: PairingSelf;
  /** Every other device already in this vault. `readRoster` yields exactly this set. */
  readonly roster: readonly Peer[];
  readonly relayUrl: string;
  /** Unix **seconds**. */
  readonly now: () => number;
  readonly nowIso: () => string;
  readonly openSocket?: (url: string) => RawSocket;
  readonly idleTimeoutMs?: number;
}

export interface JoinPairingDeps {
  readonly identity: DeviceIdentity;
  readonly code: PairingCode;
  /** `''` on a device that has not finished onboarding, which then accepts any partner. */
  readonly baseCurrency: string;
  readonly self: PairingSelf;
  readonly nowIso: () => string;
  readonly openSocket?: (url: string) => RawSocket;
  readonly idleTimeoutMs?: number;
}

/** What the host learned. The caller writes this row and bumps nothing else. */
export interface HostPairingResult {
  readonly peer: Peer;
}

/**
 * What the joiner learned: an entire vault.
 *
 * The caller writes the key to the keystore, the epoch and base currency to `sync_meta`, and
 * the peers to `sync_peers` — in one transaction, because a device that adopted the key but
 * not the roster would reject every batch that arrived.
 */
export interface JoinPairingResult {
  readonly vaultKey: VaultRootKey;
  readonly epoch: number;
  readonly baseCurrency: string;
  /** The host, plus every device the host already knew. Never this device. */
  readonly peers: readonly Peer[];
}

/**
 * A handshake that has succeeded cryptographically and is now waiting on a person.
 *
 * The pause is the security control, so it is modelled as one: nothing of value has moved at
 * the moment this is handed back, and nothing will until `confirm` is called. `peerDeviceId`
 * is all that is known about the other device at this point — its human-readable name has not
 * been sent yet, and deliberately so, because a name is attacker-chosen and a screen showing
 * "Pair with Ziv's iPhone?" invites a confirmation the fingerprint would not have earned.
 */
export interface PairingConfirmation<T> {
  /** The six words. Identical on both devices unless something is in the middle. */
  readonly sas: readonly string[];
  readonly peerDeviceId: string;
  /** Call once the person has tapped "They match" on *this* device. */
  confirm(signal?: AbortSignal): Promise<T>;
  /** "They don't match", a back button, or a timeout. Wipes the ephemeral material. */
  cancel(): void;
}

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

/**
 * The joiner's introduction, sealed under its send key.
 *
 * Carries only what the handshake could not already prove. The device id and signing key are
 * taken from the verified hello rather than from here, because a field a peer can choose is
 * not evidence of anything — repeating them in the payload would create a second, weaker
 * source of truth for the one fact the whole handshake exists to establish.
 */
interface JoinerHello {
  readonly name: string;
  readonly platform: string;
  readonly agreementKey: string;
  readonly baseCurrency: string;
}

/** The host's answer: the vault, or a plain-language reason there will not be one. */
type HostAnswer =
  | {
      readonly ok: true;
      readonly vaultKey: string;
      readonly epoch: number;
      readonly baseCurrency: string;
      readonly host: { readonly name: string; readonly platform: string; readonly agreementKey: string };
      readonly peers: readonly WirePeer[];
    }
  | { readonly ok: false; readonly reason: 'currencyMismatch'; readonly baseCurrency: string };

interface WirePeer {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly signingKey: string;
  readonly agreementKey: string;
  readonly epoch: number;
  readonly addedAt: string;
  readonly revokedAt: string | null;
  readonly revokedSeq: number | null;
}

const fail = (message: string): never => {
  throw new SyncEngineError(message, 'badPairing');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value) fail(`${what} is missing.`);
  return value as string;
};

const optionalText = (value: unknown, what: string): string => {
  if (typeof value !== 'string') fail(`${what} is not a string.`);
  return value as string;
};

const bytes = (value: unknown, what: string): Uint8Array => {
  const encoded = text(value, what);
  try {
    return fromBase64Url(encoded);
  } catch {
    return fail(`${what} is not readable.`);
  }
};

const parse = (payload: Uint8Array, what: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(payload));
  } catch {
    return fail(`${what} is not readable.`);
  }
  if (!isRecord(parsed)) return fail(`${what} is not an object.`);
  return parsed;
};

const encode = (payload: JoinerHello | HostAnswer) => utf8Bytes(canonicalJson(payload));

const toWirePeer = (peer: Peer): WirePeer => ({
  deviceId: peer.deviceId,
  name: peer.name,
  platform: peer.platform,
  signingKey: toBase64Url(peer.signingKey),
  agreementKey: toBase64Url(peer.agreementKey),
  epoch: peer.epoch,
  addedAt: peer.addedAt,
  revokedAt: peer.revokedAt,
  revokedSeq: peer.revokedSeq,
});

/**
 * Builds a roster row from what arrived, discarding the parts that are the receiver's to know.
 *
 * `acked`, `known`, and `lastSeenAt` are per-device bookkeeping about who holds which ops.
 * Copying the host's copy of them onto the joiner would tell the joiner it had already
 * received history it has never seen, and the first thing it would do with that belief is
 * *not* ask for it. Every new roster row starts at zero on both sides.
 */
const fromWirePeer = (value: unknown, index: number, nowIso: string): Peer => {
  if (!isRecord(value)) return fail(`Device ${index} in that roster is not an object.`);
  const keys = restorePeerKeys(
    bytes(value.signingKey, `Device ${index}'s signing key`),
    bytes(value.agreementKey, `Device ${index}'s agreement key`),
  );
  const epoch = value.epoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
    fail(`Device ${index} in that roster has no vault epoch.`);
  }
  const revokedAt = value.revokedAt;
  if (revokedAt !== null && typeof revokedAt !== 'string') {
    fail(`Device ${index} in that roster has a malformed revocation.`);
  }
  const rawRevokedSeq = value.revokedSeq;
  const revokedSeq =
    rawRevokedSeq === undefined
      ? revokedAt
        ? 0
        : null
      : rawRevokedSeq;
  if (
    (revokedAt === null && revokedSeq !== null) ||
    (revokedAt !== null &&
      (typeof revokedSeq !== 'number' || !Number.isSafeInteger(revokedSeq) || revokedSeq < 0))
  ) {
    fail(`Device ${index} in that roster has a malformed revocation cutoff.`);
  }
  return {
    deviceId: text(value.deviceId, `Device ${index}'s id`),
    name: optionalText(value.name, `Device ${index}'s name`),
    platform: optionalText(value.platform, `Device ${index}'s platform`),
    signingKey: keys.signingKey,
    agreementKey: keys.agreementKey,
    epoch: epoch as number,
    addedAt: text(value.addedAt, `Device ${index}'s join date`),
    revokedAt: revokedAt as string | null,
    revokedSeq: revokedSeq as number | null,
    acked: {},
    known: {},
    lastSeenAt: nowIso,
  };
};

/**
 * Whether two vaults can be merged at all.
 *
 * Not a merge rule and not repairable: every transaction's `baseAmountMinor` was snapshotted
 * against one of these two units, and re-basing the other side would need the full historical
 * rate matrix for every pair on every date, which the app has never had. An empty local value
 * means the device is not onboarded and has nothing to re-base, so it accepts whatever it is
 * given — the same rule `receive.ts` applies to a batch.
 */
const currenciesAgree = (mine: string, theirs: string) => !mine || !theirs || mine === theirs;

const currencyRefusal = (mine: string, theirs: string) =>
  new SyncEngineError(
    `These devices use different base currencies — ${theirs} and ${mine}. Syncing would corrupt your totals.`,
    'currencyMismatch',
  );

// ---------------------------------------------------------------------------
// The shared half of both roles
// ---------------------------------------------------------------------------

const context = (
  purpose: 'vault' | 'roster',
  senderDeviceId: string,
  recipientDeviceId: string,
): EnvelopeContext => ({
  purpose,
  senderDeviceId,
  recipientDeviceId,
  epoch: PAIRING_EPOCH,
  seq: FIRST_FRAME,
});

const sendSealed = (
  signaling: SignalingClient,
  key: SessionKey,
  envelope: EnvelopeContext,
  payload: JoinerHello | HostAnswer,
) => signaling.send(seal(key, envelope, encode(payload)));

const receiveSealed = async (
  signaling: SignalingClient,
  key: SessionKey,
  envelope: EnvelopeContext,
  what: string,
  signal?: AbortSignal,
) => {
  const frame = await signaling.receive(signal);
  let payload: Uint8Array;
  try {
    payload = open(key, envelope, frame);
  } catch {
    // Not rethrown as-is. A `SyncCryptoError` from here names the envelope's internals, and the
    // only thing the user can act on is that the exchange is not trustworthy and has to be
    // restarted — which is what this says.
    throw new SyncEngineError(
      `${what} could not be verified. Start the pairing again on both devices.`,
      'badFrame',
    );
  }
  return parse(payload, what);
};

/**
 * Runs the handshake and hands back the six words.
 *
 * Shared by both roles because it *is* the same exchange from both ends: send a hello, take
 * one, prove who you are, check the proof. The asymmetry between host and joiner is entirely
 * in what each knows beforehand, which is why the joiner passes `expected` and the host cannot.
 */
async function negotiate(
  signaling: SignalingClient,
  pending: PendingHandshake,
  psk: PairingSecret,
  expected: { deviceId: string; ephemeralPublicKey: Uint8Array } | null,
  signal?: AbortSignal,
): Promise<HandshakeSession> {
  await signaling.open(signal);
  signaling.send(encodeHello(pending.hello));

  const frame = await signaling.receive(signal);
  let peerHello: HandshakeHello;
  try {
    peerHello = decodeHello(frame);
  } catch {
    // A broken or stale relay frame must not leak a binary-parser diagnostic into the pairing
    // screen. It is not actionable there, and the only safe recovery is to abandon this
    // single-use attempt and mint a new code on both devices.
    throw new SyncEngineError(
      'The other device sent an invalid pairing message. Start pairing again on both devices.',
      'badPairing',
    );
  }
  if (expected && !constantTimeEqual(peerHello.ephemeralPublicKey, expected.ephemeralPublicKey)) {
    // Free, and strictly narrowing: the QR named one ephemeral key, so anything else answering
    // is caught here rather than surviving to the SAS. It does not help against someone who
    // photographed the code — that is what the SAS is for — but it removes every case where the
    // rendezvous itself was the only thing substituted.
    throw new SyncEngineError(
      'A different device answered than the one on the code.',
      'badPairing',
    );
  }

  const session = completeHandshake({
    pending,
    peerHello,
    psk,
    expectedPeerDeviceId: expected?.deviceId,
  });
  signaling.send(session.auth);
  acceptPeerAuth(session, await signaling.receive(signal));
  return session;
}

/** Best-effort erasure of everything this attempt used. JS cannot guarantee it; do it anyway. */
const wipe = (pending: PendingHandshake, secret: PairingSecret) => {
  zeroize(pending.ephemeralSecret);
  zeroize(secret);
};

// ---------------------------------------------------------------------------
// Host — the device that already has the vault
// ---------------------------------------------------------------------------

/**
 * The device holding the vault, offering to let another one in.
 *
 * Constructed rather than called, because the code has to be on screen — and expiring — while
 * the handshake waits. `code` is a **secret**: it carries the pairing secret, so it is never
 * logged, never put in a URL, never persisted, and never left on the clipboard past the paste.
 */
export class PairingHost {
  private readonly secret: PairingSecret;
  private readonly pending: PendingHandshake;
  private readonly signaling: SignalingClient;
  private readonly expiryTimer: ReturnType<typeof setTimeout>;
  private expired = false;
  private closed = false;

  /** The QR payload, and what the manual-paste fallback accepts. */
  readonly code: string;
  /** Unix seconds. */
  readonly expiresAt: number;

  constructor(private readonly deps: HostPairingDeps) {
    this.secret = createPairingSecret();
    this.pending = startHandshake(deps.identity);
    this.expiresAt = deps.now() + PAIRING_TTL_SECONDS;
    this.code = encodePairingCode({
      version: PROTOCOL_VERSION,
      deviceId: deps.identity.deviceId,
      signingPublicKey: this.pending.hello.signingPublicKey,
      ephemeralPublicKey: this.pending.hello.ephemeralPublicKey,
      pairingSecret: this.secret,
      expiresAt: this.expiresAt,
      relayUrl: deps.relayUrl,
    });
    this.signaling = new SignalingClient({
      baseUrl: deps.relayUrl,
      rendezvousId: derivePairingRendezvousId(this.secret),
      open: deps.openSocket ?? platformSocket,
      idleTimeoutMs: deps.idleTimeoutMs ?? PAIRING_IDLE_TIMEOUT_MS,
    });
    this.expiryTimer = setTimeout(
      () => {
        this.expired = true;
        this.close();
      },
      Math.max(0, (this.expiresAt - deps.now()) * 1000),
    );
  }

  /** Waits for the other device and runs the handshake. Resolves when there are words to show. */
  async handshake(signal?: AbortSignal): Promise<PairingConfirmation<HostPairingResult>> {
    let session: HandshakeSession;
    try {
      this.assertFresh();
      session = await negotiate(this.signaling, this.pending, this.secret, null, signal);
      this.assertFresh();
    } catch (error) {
      // A handshake that failed cannot be retried with this code — the secret is single use,
      // and an attempt that got far enough to fail is exactly the one worth not resuming.
      this.close();
      throw error;
    }
    return {
      sas: session.sas,
      peerDeviceId: session.peerDeviceId,
      confirm: (confirmSignal) => this.hand(session, confirmSignal),
      cancel: () => this.close(),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.expiryTimer);
    this.signaling.close();
    wipe(this.pending, this.secret);
  }

  private assertFresh(): void {
    if (!this.expired && !this.closed && this.deps.now() < this.expiresAt) return;
    this.expired = true;
    this.close();
    throw new SyncEngineError(
      'That pairing code has expired. Generate a new one and start again.',
      'badPairing',
    );
  }

  /**
   * Hands over the vault — the one irreversible step, gated on both confirmations.
   *
   * The joiner's introduction is *waited for* rather than assumed, and that wait is the second
   * gate: the joiner only sends it once its own person has tapped "They match". So the key
   * moves after two independent human confirmations, not one.
   */
  private async hand(
    session: HandshakeSession,
    signal?: AbortSignal,
  ): Promise<HostPairingResult> {
    try {
      this.assertFresh();
      const toJoiner = context('vault', this.deps.identity.deviceId, session.peerDeviceId);
      const hello = await this.readJoinerHello(session, signal);
      // The key must not leave after the advertised deadline, even if the handshake and human
      // confirmation began while the code was still fresh.
      this.assertFresh();

      if (!currenciesAgree(this.deps.baseCurrency, hello.baseCurrency)) {
        // Told, not merely refused. The joiner is sitting on a screen that will otherwise say
        // the connection dropped, and "your two devices disagree about a currency" is a
        // different problem with a different fix.
        sendSealed(this.signaling, session.sendKey, toJoiner, {
          ok: false,
          reason: 'currencyMismatch',
          baseCurrency: this.deps.baseCurrency,
        });
        throw currencyRefusal(this.deps.baseCurrency, hello.baseCurrency);
      }

      sendSealed(this.signaling, session.sendKey, toJoiner, {
        ok: true,
        vaultKey: toBase64Url(this.deps.vaultKey),
        epoch: this.deps.epoch,
        baseCurrency: this.deps.baseCurrency,
        host: {
          name: this.deps.self.name,
          platform: this.deps.self.platform,
          agreementKey: toBase64Url(this.deps.identity.agreement.publicKey),
        },
        peers: this.deps.roster
          .filter((peer) => peer.deviceId !== session.peerDeviceId)
          .map(toWirePeer),
      });

      const keys = restorePeerKeys(session.peerSigningPublicKey, hello.agreementKey);
      return {
        peer: {
          deviceId: session.peerDeviceId,
          name: hello.name,
          platform: hello.platform,
          signingKey: keys.signingKey,
          agreementKey: keys.agreementKey,
          epoch: this.deps.epoch,
          addedAt: this.deps.nowIso(),
          revokedAt: null,
          revokedSeq: null,
          acked: {},
          known: {},
          lastSeenAt: this.deps.nowIso(),
        },
      };
    } finally {
      this.close();
    }
  }

  private async readJoinerHello(session: HandshakeSession, signal?: AbortSignal) {
    const payload = await receiveSealed(
      this.signaling,
      session.receiveKey,
      context('roster', session.peerDeviceId, this.deps.identity.deviceId),
      "The other device's details",
      signal,
    );
    return {
      name: optionalText(payload.name, "The other device's name"),
      platform: optionalText(payload.platform, "The other device's platform"),
      agreementKey: bytes(payload.agreementKey, "The other device's agreement key"),
      baseCurrency: optionalText(payload.baseCurrency, "The other device's base currency"),
    };
  }
}

// ---------------------------------------------------------------------------
// Joiner — the device being added
// ---------------------------------------------------------------------------

/**
 * The device joining an existing vault.
 *
 * Takes an already-decoded `PairingCode`, so expiry and format are somebody else's failure by
 * the time this exists — `decodePairingCode` refuses a stale or malformed one without a
 * network round trip, and a scanner should be showing that error long before a socket opens.
 */
export class PairingJoiner {
  private readonly pending: PendingHandshake;
  private readonly signaling: SignalingClient;

  constructor(private readonly deps: JoinPairingDeps) {
    this.pending = startHandshake(deps.identity);
    this.signaling = new SignalingClient({
      baseUrl: deps.code.relayUrl,
      rendezvousId: derivePairingRendezvousId(deps.code.pairingSecret),
      open: deps.openSocket ?? platformSocket,
      idleTimeoutMs: deps.idleTimeoutMs ?? PAIRING_IDLE_TIMEOUT_MS,
    });
  }

  async handshake(signal?: AbortSignal): Promise<PairingConfirmation<JoinPairingResult>> {
    let session: HandshakeSession;
    try {
      session = await negotiate(
        this.signaling,
        this.pending,
        this.deps.code.pairingSecret,
        { deviceId: this.deps.code.deviceId, ephemeralPublicKey: this.deps.code.ephemeralPublicKey },
        signal,
      );
    } catch (error) {
      this.close();
      throw error;
    }
    return {
      sas: session.sas,
      peerDeviceId: session.peerDeviceId,
      confirm: (confirmSignal) => this.take(session, confirmSignal),
      cancel: () => this.close(),
    };
  }

  close(): void {
    this.signaling.close();
    wipe(this.pending, this.deps.code.pairingSecret);
  }

  private async take(session: HandshakeSession, signal?: AbortSignal): Promise<JoinPairingResult> {
    try {
      sendSealed(
        this.signaling,
        session.sendKey,
        context('roster', this.deps.identity.deviceId, session.peerDeviceId),
        {
          name: this.deps.self.name,
          platform: this.deps.self.platform,
          agreementKey: toBase64Url(this.deps.identity.agreement.publicKey),
          baseCurrency: this.deps.baseCurrency,
        },
      );

      const answer = await receiveSealed(
        this.signaling,
        session.receiveKey,
        context('vault', session.peerDeviceId, this.deps.identity.deviceId),
        'The vault the other device sent',
        signal,
      );
      return this.adopt(session, answer);
    } finally {
      this.close();
    }
  }

  private adopt(session: HandshakeSession, answer: Record<string, unknown>): JoinPairingResult {
    if (answer.ok !== true) {
      if (answer.reason === 'currencyMismatch') {
        throw currencyRefusal(
          this.deps.baseCurrency,
          typeof answer.baseCurrency === 'string' ? answer.baseCurrency : '',
        );
      }
      return fail('The other device refused to complete pairing.');
    }

    const epoch = answer.epoch;
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
      fail('That vault did not say which epoch it is on.');
    }
    const baseCurrency = optionalText(answer.baseCurrency, "That vault's base currency");
    // Checked again on this side even though the host checks it first. The host's check
    // protects the *host* from an older or hostile build; this one protects this device, and a
    // precondition that only one party enforces is a precondition one party can skip.
    if (!currenciesAgree(this.deps.baseCurrency, baseCurrency)) {
      throw currencyRefusal(this.deps.baseCurrency, baseCurrency);
    }

    if (!isRecord(answer.host)) fail('That vault did not identify the device that sent it.');
    const host = answer.host as Record<string, unknown>;
    const hostKeys = restorePeerKeys(
      session.peerSigningPublicKey,
      bytes(host.agreementKey, "The other device's agreement key"),
    );

    const wirePeers = answer.peers;
    if (!Array.isArray(wirePeers)) return fail('That vault sent no device list.');
    const nowIso = this.deps.nowIso();

    const peers: Peer[] = [
      {
        deviceId: session.peerDeviceId,
        name: optionalText(host.name, "The other device's name"),
        platform: optionalText(host.platform, "The other device's platform"),
        signingKey: hostKeys.signingKey,
        agreementKey: hostKeys.agreementKey,
        epoch: epoch as number,
        addedAt: nowIso,
        revokedAt: null,
        revokedSeq: null,
        acked: {},
        known: {},
        lastSeenAt: nowIso,
      },
    ];
    const seen = new Set([session.peerDeviceId, this.deps.identity.deviceId]);
    for (const [index, value] of wirePeers.entries()) {
      const peer = fromWirePeer(value, index, nowIso);
      // A roster naming this device, or naming the host twice, is either a stale row on the
      // host or a hostile one. Either way the authenticated identity wins over the list.
      if (seen.has(peer.deviceId)) continue;
      seen.add(peer.deviceId);
      peers.push(peer);
    }

    return {
      vaultKey: restoreVaultRootKey(bytes(answer.vaultKey, 'That vault key')),
      epoch: epoch as number,
      baseCurrency,
      peers,
    };
  }
}
