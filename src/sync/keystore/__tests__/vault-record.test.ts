import { createDeviceIdentity, createVaultRootKey, toHex } from '@/sync/crypto';
import { KeystoreError } from '@/sync/keystore/types';
import {
  VAULT_RECORD_BYTES,
  decodeVaultRecord,
  encodeVaultRecord,
} from '@/sync/keystore/vault-record';
import type { StoredVault } from '@/sync/keystore/types';

const vault = (epoch = 1): StoredVault => ({
  vaultKey: createVaultRootKey(),
  identity: createDeviceIdentity(),
  epoch,
});

describe('a stored vault record', () => {
  it('round-trips every secret and the epoch', () => {
    const original = vault(7);
    const decoded = decodeVaultRecord(encodeVaultRecord(original));

    expect(toHex(decoded.vaultKey)).toBe(toHex(original.vaultKey));
    expect(toHex(decoded.identity.signing.secretKey)).toBe(toHex(original.identity.signing.secretKey));
    expect(toHex(decoded.identity.agreement.secretKey)).toBe(toHex(original.identity.agreement.secretKey));
    expect(decoded.epoch).toBe(7);
  });

  it('rebuilds the public halves and the device id rather than storing them', () => {
    // Storing what can be derived is how two fields disagree. The device id in particular
    // is the peer's whole notion of who this is, so it has to come from the key every time.
    const original = vault();
    const decoded = decodeVaultRecord(encodeVaultRecord(original));

    expect(decoded.identity.deviceId).toBe(original.identity.deviceId);
    expect(toHex(decoded.identity.signing.publicKey)).toBe(toHex(original.identity.signing.publicKey));
    expect(toHex(decoded.identity.agreement.publicKey)).toBe(toHex(original.identity.agreement.publicKey));
  });

  it('is a fixed 105 bytes, so a partial write cannot decode', () => {
    expect(VAULT_RECORD_BYTES).toBe(105);
    expect(encodeVaultRecord(vault())).toHaveLength(105);
  });
});

describe('a stored vault record that should be refused', () => {
  const record = () => encodeVaultRecord(vault());

  it('is truncated', () => {
    expect(() => decodeVaultRecord(record().slice(0, 104))).toThrow(/wrong size/);
  });

  it('is something else entirely', () => {
    expect(() => decodeVaultRecord(new Uint8Array(VAULT_RECORD_BYTES))).toThrow(/not a Qashy vault/);
  });

  it('was written by a newer build', () => {
    // The point of the format byte: a build that cannot represent a future record must say
    // so, not read three keys out of a layout that has since moved.
    const bytes = record();
    bytes[4] = 2;
    expect(() => decodeVaultRecord(bytes)).toThrow(/newer version of Qashy/);
  });

  it('carries no epoch', () => {
    const bytes = record();
    new DataView(bytes.buffer).setUint32(5, 0, false);
    expect(() => decodeVaultRecord(bytes)).toThrow(/no epoch/);
  });

  it('claims an epoch that is not a whole number', () => {
    expect(() => encodeVaultRecord({ ...vault(), epoch: 1.5 })).toThrow(KeystoreError);
    expect(() => encodeVaultRecord({ ...vault(), epoch: 0 })).toThrow(/not a valid vault epoch/);
  });
});
