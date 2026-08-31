/**
 * Guards the wire format against silent drift. See the header of `wire-vectors.ts` for why
 * a failure here is a protocol change and never a reason to regenerate the fixture.
 */

import { open } from '@/sync/crypto/envelope';
import {
  acceptPeerAuth,
  completeHandshake,
  type HandshakeHello,
  type PendingHandshake,
} from '@/sync/crypto/handshake';
import {
  deriveBackupKey,
  deriveBucketId,
  deriveBucketToken,
  deriveContentKey,
  deriveRendezvousId,
  restoreDeviceIdentity,
  type DeviceIdentity,
} from '@/sync/crypto/keys';
import { PROTOCOL_VERSION } from '@/sync/crypto/labels';
import {
  agreementPublicKeyFrom,
  bytesToUtf8,
  fromHex,
  toHex,
} from '@/sync/crypto/primitives';
import {
  openPassphraseBackup,
  openVaultBundle,
  vaultKeyToRecoveryPhrase,
} from '@/sync/crypto/recovery';
import {
  brand,
  type AgreementSecretKey,
  type PairingSecret,
  type SigningSecretKey,
  type VaultRootKey,
} from '@/sync/crypto/types';
import { signBatchPayload, verifyBatchPayload } from '@/sync/crypto/batch-auth';
import { WIRE_VECTORS } from '@/sync/crypto/__tests__/wire-vectors';

const vault = brand<VaultRootKey>(fromHex(WIRE_VECTORS.vaultRootKey));
const psk = brand<PairingSecret>(fromHex(WIRE_VECTORS.pairingSecret));

/**
 * Written out rather than taken from `typeof WIRE_VECTORS.alice`: the fixture is `as const`,
 * so that would narrow `deviceId` to Alice's literal string and refuse Bob.
 */
interface Party {
  readonly signingSecret: string;
  readonly agreementSecret: string;
  readonly ephemeralSecret: string;
  readonly helloNonce: string;
  readonly deviceId: string;
}

const identityOf = (party: Party) =>
  restoreDeviceIdentity(
    brand<SigningSecretKey>(fromHex(party.signingSecret)),
    brand<AgreementSecretKey>(fromHex(party.agreementSecret)),
  );

const helloOf = (party: Party, identity: DeviceIdentity): HandshakeHello => ({
  version: PROTOCOL_VERSION,
  deviceId: identity.deviceId,
  signingPublicKey: identity.signing.publicKey,
  ephemeralPublicKey: agreementPublicKeyFrom(fromHex(party.ephemeralSecret)),
  nonce: fromHex(party.helloNonce),
});

const pendingOf = (party: Party): PendingHandshake => {
  const identity = identityOf(party);
  return {
    identity,
    ephemeralSecret: brand<AgreementSecretKey>(fromHex(party.ephemeralSecret)),
    hello: helloOf(party, identity),
  };
};

describe('device ids', () => {
  it('still derive to the committed values', () => {
    // A change here unpairs every device in the field: peers are identified by this string.
    expect(identityOf(WIRE_VECTORS.alice).deviceId).toBe(WIRE_VECTORS.alice.deviceId);
    expect(identityOf(WIRE_VECTORS.bob).deviceId).toBe(WIRE_VECTORS.bob.deviceId);
  });
});

describe('the key hierarchy', () => {
  const { derived } = WIRE_VECTORS;

  it('still derives every branch to the committed value', () => {
    // These are the HKDF labels. A typo in one is invisible until two devices that shipped
    // on different days fail to talk.
    expect(toHex(deriveContentKey(vault))).toBe(derived.contentKey);
    expect(toHex(deriveBackupKey(vault))).toBe(derived.backupKey);
    expect(toHex(deriveBucketToken(vault))).toBe(derived.bucketToken);
    expect(deriveBucketId(vault)).toBe(derived.bucketId);
    expect(deriveRendezvousId(vault, derived.rendezvousWindow)).toBe(derived.rendezvousId);
  });

  it('still encodes the vault key as the committed recovery phrase', () => {
    // The strongest compatibility guarantee in the app: a phrase on paper must restore the
    // same vault in ten years, whatever the code looks like by then.
    expect(vaultKeyToRecoveryPhrase(vault)).toBe(derived.recoveryPhrase);
  });
});

describe('the handshake', () => {
  const pendingA = pendingOf(WIRE_VECTORS.alice);
  const pendingB = pendingOf(WIRE_VECTORS.bob);
  const a = completeHandshake({ pending: pendingA, peerHello: pendingB.hello, psk });
  const b = completeHandshake({ pending: pendingB, peerHello: pendingA.hello, psk });

  it('still produces the committed transcript', () => {
    expect(toHex(a.transcript)).toBe(WIRE_VECTORS.handshake.transcript);
    expect(toHex(b.transcript)).toBe(WIRE_VECTORS.handshake.transcript);
  });

  it('still shows the committed six words', () => {
    // If this drifts, two devices on different builds show different words and a correct
    // user aborts a legitimate pairing — a security control failing safe, but still failing.
    expect(a.sas).toEqual(WIRE_VECTORS.handshake.sas);
  });

  it('still splits the directional keys the same way round', () => {
    expect(toHex(a.sendKey)).toBe(WIRE_VECTORS.handshake.aliceSendKey);
    expect(toHex(a.receiveKey)).toBe(WIRE_VECTORS.handshake.aliceReceiveKey);
    expect(toHex(b.sendKey)).toBe(WIRE_VECTORS.handshake.aliceReceiveKey);
  });

  it('still signs the transcript the same way', () => {
    expect(toHex(a.auth)).toBe(WIRE_VECTORS.handshake.aliceAuth);
    expect(toHex(b.auth)).toBe(WIRE_VECTORS.handshake.bobAuth);
  });

  it('accepts the committed proofs', () => {
    expect(() => acceptPeerAuth(a, fromHex(WIRE_VECTORS.handshake.bobAuth))).not.toThrow();
    expect(() => acceptPeerAuth(b, fromHex(WIRE_VECTORS.handshake.aliceAuth))).not.toThrow();
  });
});

describe('authenticated batches', () => {
  it('still signs the canonical v2 payload to the committed value', () => {
    const alice = identityOf(WIRE_VECTORS.alice);
    const { payload, signature } = WIRE_VECTORS.batchAuth;

    expect(signBatchPayload(payload, alice.signing.secretKey)).toBe(signature);
    expect(verifyBatchPayload(payload, signature, alice.signing.publicKey)).toBe(true);
    expect(
      verifyBatchPayload({ ...payload, epoch: payload.epoch + 1 }, signature, alice.signing.publicKey),
    ).toBe(false);
  });
});

describe('frames sealed by an earlier build', () => {
  it('still open, so a device that has not updated is still understood', () => {
    const frame = WIRE_VECTORS.frames.batch;
    const opened = open(
      deriveContentKey(vault),
      {
        purpose: 'batch',
        senderDeviceId: frame.senderDeviceId,
        recipientDeviceId: frame.recipientDeviceId,
        epoch: frame.epoch,
        seq: frame.seq,
      },
      fromHex(frame.hex),
    );
    expect(bytesToUtf8(opened)).toBe(frame.plaintext);
  });

  it('still open as hand-carried bundles', () => {
    const bundle = WIRE_VECTORS.frames.vaultBundle;
    expect(
      bytesToUtf8(
        openVaultBundle(vault, bundle.senderDeviceId, bundle.epoch, bundle.seq, fromHex(bundle.hex)),
      ),
    ).toBe(bundle.plaintext);
  });

  it('still open as passphrase backups, including the scrypt parameters in the header', () => {
    // The header records the parameters precisely so raising the default later does not
    // orphan the backups a user already made. This vector is what proves it.
    const backup = WIRE_VECTORS.frames.passphraseBackup;
    expect(bytesToUtf8(openPassphraseBackup(backup.passphrase, fromHex(backup.hex)))).toBe(
      backup.plaintext,
    );
  });

  it('are padded, so their size reveals nothing about their contents', () => {
    // Ten bytes of plaintext, a kilobyte on the wire. That is the design working.
    expect(WIRE_VECTORS.frames.batch.plaintext.length).toBeLessThan(64);
    expect(fromHex(WIRE_VECTORS.frames.batch.hex)).toHaveLength(1024 + 29 + 16);
  });
});
