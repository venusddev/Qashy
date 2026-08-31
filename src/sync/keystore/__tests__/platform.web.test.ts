/**
 * The browser keystore against a real IndexedDB implementation.
 *
 * The lifecycle itself is covered in `keystore.test.ts` through the shared base class, so
 * what is worth proving here is only what this file adds: that the record survives a round
 * trip through a non-extractable `CryptoKey`, that what lands in the database is
 * ciphertext rather than the vault, and that two instances over the same origin agree on
 * one wrapping key instead of racing each other into an undecryptable store.
 */

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { createDeviceIdentity, createVaultRootKey, toHex } from '@/sync/crypto';
import { createPlatformKeystore } from '@/sync/keystore/platform.web';
import type { StoredVault } from '@/sync/keystore/types';

// `fake-indexeddb` clones stored values with the environment's `structuredClone`, and
// jsdom's implementation does not know what a `CryptoKey` is — it returns a plain object
// that `crypto.subtle` then refuses. Every real browser clones `CryptoKey` natively; that
// is the entire premise of this file, and it is specified behaviour, not a browser quirk
// worth designing around. So the environment gap is closed here rather than in the
// implementation: pass the key through by reference. A non-extractable key exposes nothing
// mutable, so sharing the reference is indistinguishable from cloning it.
const isCryptoKey = (value: unknown): value is CryptoKey =>
  typeof value === 'object' &&
  value !== null &&
  value.constructor?.name === 'CryptoKey' &&
  'algorithm' in value &&
  'extractable' in value;

const cloneWithoutCryptoKeys = globalThis.structuredClone;
globalThis.structuredClone = ((value: unknown) => {
  if (isCryptoKey(value)) return value;
  if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
    const entries = Object.entries(value);
    if (entries.some(([, each]) => isCryptoKey(each))) {
      return Object.fromEntries(entries.map(([key, each]) => [key, globalThis.structuredClone(each)]));
    }
  }
  return cloneWithoutCryptoKeys(value);
}) as typeof structuredClone;

const vault = (epoch = 1): StoredVault => ({
  vaultKey: createVaultRootKey(),
  identity: createDeviceIdentity(),
  epoch,
});

const readRaw = (id: string) =>
  new Promise<{ iv: Uint8Array; data: Uint8Array } | undefined>((resolve, reject) => {
    const open = indexedDB.open('qashy-keystore');
    open.onsuccess = () => {
      const get = open.result.transaction('vault', 'readonly').objectStore('vault').get(id);
      get.onsuccess = () => {
        open.result.close();
        resolve(get.result);
      };
      get.onerror = () => reject(get.error);
    };
    open.onerror = () => reject(open.error);
  });

beforeEach(() => {
  // A fresh origin per test. Otherwise a vault written by one test unlocks the next.
  globalThis.indexedDB = new IDBFactory();
});

describe('the browser keystore', () => {
  it('round-trips a vault through the wrapping key', async () => {
    const keystore = createPlatformKeystore();
    expect(keystore.kind).toBe('browser');
    expect(await keystore.status()).toBe('empty');

    const original = vault(4);
    await keystore.write(original);

    const stored = await keystore.read();
    expect(stored?.identity.deviceId).toBe(original.identity.deviceId);
    expect(toHex(stored?.vaultKey ?? new Uint8Array())).toBe(toHex(original.vaultKey));
    expect(stored?.epoch).toBe(4);
  });

  it('stores ciphertext, not the vault key', async () => {
    // The assertion that matters if anyone ever opens devtools and looks at the database.
    const original = vault();
    await createPlatformKeystore().write(original);

    const row = await readRaw('container');
    expect(row).toBeDefined();
    expect(toHex(new Uint8Array(row?.data ?? []))).not.toContain(toHex(original.vaultKey));
    expect(row?.iv).toHaveLength(12);
  });

  it('keeps the wrapping key non-extractable', async () => {
    await createPlatformKeystore().write(vault());
    const wrap = (await readRaw('wrap')) as unknown as { key: CryptoKey } | undefined;

    expect(wrap?.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', wrap?.key as CryptoKey)).rejects.toThrow();
  });

  it('reads a vault a previous session wrote', async () => {
    const original = vault();
    await createPlatformKeystore().write(original);

    const reopened = createPlatformKeystore();
    expect(await reopened.status()).toBe('unlocked');
    expect((await reopened.read())?.identity.deviceId).toBe(original.identity.deviceId);
  });

  it('settles on one wrapping key when two instances start at once', async () => {
    // Two tabs opening cold is ordinary. A loser that overwrote the winner's key would
    // leave the container permanently undecryptable, which is data loss, not a hiccup.
    const original = vault();
    const [first, second] = [createPlatformKeystore(), createPlatformKeystore()];
    await Promise.all([first.write(original), second.status()]);

    expect((await second.read())?.identity.deviceId).toBe(original.identity.deviceId);
    expect((await createPlatformKeystore().read())?.identity.deviceId).toBe(original.identity.deviceId);
  });

  it('takes the wrapping key with it when the vault is erased', async () => {
    const keystore = createPlatformKeystore();
    await keystore.write(vault());
    await keystore.erase();

    expect(await readRaw('container')).toBeUndefined();
    expect(await readRaw('wrap')).toBeUndefined();
    expect(await createPlatformKeystore().status()).toBe('empty');
  });
});
