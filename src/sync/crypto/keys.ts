/**
 * The key hierarchy.
 *
 * One root secret, everything else derived from it with a distinct HKDF label. That
 * structure is what lets the relay be handed a bucket identifier and a write token
 * without ever being handed anything that decrypts a byte: the bucket id is a one-way
 * function of the root key, so knowing it reveals nothing about the content key derived
 * from the same root under a different label.
 *
 * Device identity keys are generated *per device* and their private halves never leave
 * it. That is what makes revocation mean something — a shared symmetric key alone would
 * let any holder forge history indistinguishably from any other, and removing a device
 * from a roster would accomplish nothing.
 */

import { LABELS, RENDEZVOUS_WINDOW_SECONDS } from '@/sync/crypto/labels';
import {
  KEY_LENGTH,
  assertLength,
  concatBytes,
  hkdf,
  randomBytes,
  sha256,
  toBase32,
  u64be,
  utf8Bytes,
  agreementKeygen,
  agreementPublicKeyFrom,
  signingKeygen,
  signingPublicKeyFrom,
} from '@/sync/crypto/primitives';
import {
  brand,
  type AgreementKeyPair,
  type AgreementPublicKey,
  type AgreementSecretKey,
  type BackupKey,
  type BucketToken,
  type ContentKey,
  type PairingSecret,
  type SigningKeyPair,
  type SigningPublicKey,
  type SigningSecretKey,
  type VaultRootKey,
} from '@/sync/crypto/types';

/** Device ids are this many base32 characters — 130 bits of a SHA-256 digest. */
export const DEVICE_ID_LENGTH = 26;

const EMPTY_SALT = new Uint8Array(0);

/** Creates a brand new vault. Called exactly once, on the first device. */
export const createVaultRootKey = () => brand<VaultRootKey>(randomBytes(KEY_LENGTH));

export const deriveContentKey = (vrk: VaultRootKey) =>
  brand<ContentKey>(hkdf(vrk, EMPTY_SALT, LABELS.content));

export const deriveBackupKey = (vrk: VaultRootKey) =>
  brand<BackupKey>(hkdf(vrk, EMPTY_SALT, LABELS.backup));

/**
 * The relay addresses blobs by this. It is an HKDF output, so it is opaque to the relay
 * and uncorrelated with anything else derived from the same root.
 */
export const deriveBucketId = (vrk: VaultRootKey) =>
  toBase32(hkdf(vrk, EMPTY_SALT, LABELS.bucket)).slice(0, 52);

/** A bare write capability. It authorizes a `PUT`; it identifies nobody. */
export const deriveBucketToken = (vrk: VaultRootKey) =>
  brand<BucketToken>(hkdf(vrk, EMPTY_SALT, LABELS.bucketAuth));

/** Route tags are this many base32 characters — 80 bits, far more than routing needs. */
export const ROUTE_TAG_LENGTH = 16;

/**
 * The tag a relay blob is addressed to.
 *
 * A drop-box holds blobs for every device in the vault, so a reader has to know which ones
 * are for it. Writing the recipient's device id on the outside would answer that — and would
 * hand the relay a stable identifier derived from a public key, which is the one piece of
 * metadata that could follow a device between vaults and relays.
 *
 * This is that identifier, blinded per vault: the same device in two vaults produces two
 * unrelated tags, and the relay can group blobs by recipient without learning who the
 * recipient is. Vault members compute it from the root key; nobody else can compute it at
 * all, so it is also not something a relay operator can look up after the fact.
 *
 * Deliberately *not* rotated. Unlike the rendezvous id — which is a live meeting point and
 * gains real unlinkability from rotating — a drop-box tag has to stay readable by a device
 * that has been switched off for a fortnight, and a rotating tag would either strand those
 * blobs or need the reader to scan every past window, which reveals more than it hides.
 */
export const deriveRouteTag = (vrk: VaultRootKey, deviceId: string) =>
  toBase32(hkdf(vrk, utf8Bytes(deviceId), LABELS.route)).slice(0, ROUTE_TAG_LENGTH);

/**
 * The signaling rendezvous identifier for a given 5-minute window.
 *
 * Both devices compute this independently and never tell the server who they are, and it
 * changes every window so an observer cannot link one session to the next.
 */
export const deriveRendezvousId = (vrk: VaultRootKey, windowIndex: number) =>
  toBase32(hkdf(vrk, u64be(windowIndex), LABELS.rendezvous)).slice(0, 52);

export const rendezvousWindow = (unixSeconds: number) =>
  Math.floor(unixSeconds / RENDEZVOUS_WINDOW_SECONDS);

/**
 * The ids worth listening on right now: the current window plus its neighbours.
 *
 * Two devices whose clocks differ by seconds will land either side of a window boundary
 * and compute different ids, so a single-window implementation fails intermittently and
 * unreproducibly — the worst possible failure mode. Listening on three windows costs
 * nothing and removes the class.
 */
export const rendezvousIds = (vrk: VaultRootKey, unixSeconds: number) => {
  const current = rendezvousWindow(unixSeconds);
  return [current - 1, current, current + 1].map((index) => deriveRendezvousId(vrk, index));
};

/** A fresh single-use pairing secret. Crosses the optical channel, never the network. */
export const createPairingSecret = () => brand<PairingSecret>(randomBytes(KEY_LENGTH));

/**
 * The rendezvous a pairing pair meets at.
 *
 * Separate from `deriveRendezvousId` for a structural reason rather than a stylistic one: that
 * one is keyed on the vault root key, and the entire point of pairing is that the joining
 * device does not have it yet. The pairing secret is the only thing both devices hold at this
 * moment, and it reached the second device optically, so an id derived from it is one a network
 * observer cannot compute.
 *
 * Deliberately **not** windowed. A rotating id exists to stop a server linking one session to
 * the next, which needs the id to outlive a session; this one lives ninety seconds and is used
 * once, so rotation would buy nothing and would reintroduce the clock-straddling failure that
 * `rendezvousIds` has to spend three lookups working around.
 */
export const derivePairingRendezvousId = (pairingSecret: PairingSecret) =>
  toBase32(hkdf(pairingSecret, EMPTY_SALT, LABELS.pairingRendezvous)).slice(0, 52);

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly signing: SigningKeyPair;
  readonly agreement: AgreementKeyPair;
}

/**
 * Derives a device id from its signing public key.
 *
 * Because the id is a function of the key, a peer can check that a claimed id matches
 * the key presented in the handshake. An attacker cannot claim someone else's id without
 * also holding their private key, so identity spoofing is caught before the roster is
 * even consulted.
 */
export const deriveDeviceId = (signingPublicKey: SigningPublicKey | Uint8Array) =>
  toBase32(sha256(utf8Bytes(LABELS.device), signingPublicKey)).slice(0, DEVICE_ID_LENGTH);

export const createDeviceIdentity = (): DeviceIdentity => {
  const signing = signingKeygen();
  const agreement = agreementKeygen();
  return {
    deviceId: deriveDeviceId(signing.publicKey),
    signing: {
      publicKey: brand<SigningPublicKey>(signing.publicKey),
      secretKey: brand<SigningSecretKey>(signing.secretKey),
    },
    agreement: {
      publicKey: brand<AgreementPublicKey>(agreement.publicKey),
      secretKey: brand<AgreementSecretKey>(agreement.secretKey),
    },
  };
};

/**
 * Rebuilds an identity from the two secret keys the keystore holds.
 *
 * Takes plain bytes rather than branded keys on purpose: the keystore reads a byte range
 * out of a stored record and has no legitimate way to brand it itself — `brand` is
 * deliberately not exported past this directory. Both halves are length-checked by the
 * public-key derivations below, so a truncated or corrupted read fails here rather than
 * producing an identity with a silently wrong device id.
 */
export const restoreDeviceIdentity = (
  signingSecret: Uint8Array,
  agreementSecret: Uint8Array,
): DeviceIdentity => {
  const signingPublic = brand<SigningPublicKey>(signingPublicKeyFrom(signingSecret));
  return {
    deviceId: deriveDeviceId(signingPublic),
    signing: { publicKey: signingPublic, secretKey: brand<SigningSecretKey>(signingSecret) },
    agreement: {
      publicKey: brand<AgreementPublicKey>(agreementPublicKeyFrom(agreementSecret)),
      secretKey: brand<AgreementSecretKey>(agreementSecret),
    },
  };
};

/**
 * Brands the public halves of a peer's identity.
 *
 * The counterpart to `restoreDeviceIdentity`, for the keys that arrive from somewhere else:
 * a roster row read back out of `sync_peers`, or a handshake hello. Neither the storage
 * layer nor the engine can brand them itself — `brand` deliberately stops at this directory
 * — and neither should be trusted to have got the length right.
 *
 * The length check is the substance. `sharedSecret` and `verify` both accept a short key by
 * throwing somewhere deep inside a curve implementation, which surfaces as "authentication
 * failed" and sends a user hunting for a pairing problem that does not exist. Failing here
 * says what is actually wrong: the stored row is corrupt.
 */
export const restorePeerKeys = (signingPublic: Uint8Array, agreementPublic: Uint8Array) => ({
  signingKey: brand<SigningPublicKey>(
    assertLength(signingPublic, KEY_LENGTH, "A peer's signing key"),
  ),
  agreementKey: brand<AgreementPublicKey>(
    assertLength(agreementPublic, KEY_LENGTH, "A peer's agreement key"),
  ),
});

/**
 * Brands bytes the keystore just read back as the vault root key.
 *
 * The length check is the whole point. Every other key in the system is derived from this
 * one, so a short read here would propagate into an HKDF call that happily accepts it and
 * yields a content key that decrypts nothing, with the failure surfacing several layers
 * away as "authentication failed".
 */
export const restoreVaultRootKey = (bytes: Uint8Array) =>
  brand<VaultRootKey>(assertLength(bytes, KEY_LENGTH, 'Vault root key'));

/**
 * Formats a device id for display in groups of seven, the way a fingerprint should be
 * shown: humans compare grouped strings far more reliably than a 26-character run.
 */
export const formatDeviceId = (deviceId: string) =>
  (deviceId.match(/.{1,7}/g) ?? [deviceId]).join('-');

/** The bytes a roster entry commits to. Exported so `handshake.ts` and the engine agree exactly. */
export const deviceIdentityBytes = (
  deviceId: string,
  signingPublicKey: Uint8Array,
  agreementPublicKey: Uint8Array,
) => concatBytes(utf8Bytes(deviceId), signingPublicKey, agreementPublicKey);
