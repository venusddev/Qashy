/**
 * The on-disk shape of a stored vault.
 *
 * A fixed-length binary record rather than JSON, for two reasons. The obvious one is that
 * `expo-secure-store` takes a string, so JSON would mean the three secrets exist as hex
 * substrings of a long-lived JS string — interned, immutable, and impossible to zeroize.
 * The less obvious one is that a fixed length makes a truncated or partially-written read
 * a hard failure at offset zero instead of a parse that succeeds with a missing field.
 *
 * The format is versioned. It is *not* a wire format — nothing sends this to a peer, so a
 * change here is a local migration rather than a protocol break — but the same discipline
 * applies: a record written by a newer build is refused rather than misread.
 */

import { restoreDeviceIdentity, restoreVaultRootKey } from '@/sync/crypto';

import { KeystoreError, type StoredVault } from '@/sync/keystore/types';

/** 'QSYK' — Qashy keystore. Distinct from the 'QSY' envelope magic; these never mix. */
const MAGIC = Uint8Array.from([0x51, 0x53, 0x59, 0x4b]);
const FORMAT = 1;

const KEY_BYTES = 32;
const HEADER_BYTES = MAGIC.length + 1 + 4;

/** magic ‖ format ‖ epoch ‖ vaultKey ‖ signingSecret ‖ agreementSecret */
export const VAULT_RECORD_BYTES = HEADER_BYTES + KEY_BYTES * 3;

export const encodeVaultRecord = (vault: StoredVault) => {
  if (!Number.isInteger(vault.epoch) || vault.epoch < 1 || vault.epoch > 0xffffffff) {
    throw new KeystoreError(`${vault.epoch} is not a valid vault epoch.`, 'corrupt');
  }
  const out = new Uint8Array(VAULT_RECORD_BYTES);
  out.set(MAGIC, 0);
  out[MAGIC.length] = FORMAT;
  new DataView(out.buffer).setUint32(MAGIC.length + 1, vault.epoch, false);
  out.set(vault.vaultKey, HEADER_BYTES);
  out.set(vault.identity.signing.secretKey, HEADER_BYTES + KEY_BYTES);
  out.set(vault.identity.agreement.secretKey, HEADER_BYTES + KEY_BYTES * 2);
  return out;
};

export const decodeVaultRecord = (bytes: Uint8Array): StoredVault => {
  if (bytes.length !== VAULT_RECORD_BYTES) {
    throw new KeystoreError('The stored vault record is the wrong size.', 'corrupt');
  }
  if (MAGIC.some((byte, index) => bytes[index] !== byte)) {
    throw new KeystoreError('The stored vault record is not a Qashy vault.', 'corrupt');
  }
  if (bytes[MAGIC.length] !== FORMAT) {
    throw new KeystoreError(
      'This vault was stored by a newer version of Qashy. Update the app to read it.',
      'corrupt',
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const epoch = view.getUint32(MAGIC.length + 1, false);
  if (epoch < 1) {
    throw new KeystoreError('The stored vault record has no epoch.', 'corrupt');
  }
  return {
    epoch,
    vaultKey: restoreVaultRootKey(bytes.slice(HEADER_BYTES, HEADER_BYTES + KEY_BYTES)),
    identity: restoreDeviceIdentity(
      bytes.slice(HEADER_BYTES + KEY_BYTES, HEADER_BYTES + KEY_BYTES * 2),
      bytes.slice(HEADER_BYTES + KEY_BYTES * 2),
    ),
  };
};
