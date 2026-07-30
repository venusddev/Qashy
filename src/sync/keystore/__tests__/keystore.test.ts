/**
 * The keystore lifecycle, exercised through the memory implementation.
 *
 * `BaseKeystore` holds all of the behaviour that could plausibly lose a vault or leave one
 * stored in the clear, and it is identical on every platform — so it is worth testing hard
 * here, where no Keychain and no browser are needed, rather than thinly in three places.
 */

import { SyncCryptoError, createDeviceIdentity, createVaultRootKey, toHex } from '@/sync/crypto';
import { MemoryKeystore, type MemoryKeystoreCell } from '@/sync/keystore/memory';
import { KeystoreError, type StoredVault, type SyncKeystore } from '@/sync/keystore/types';

const PASSPHRASE = 'correct horse battery';

const vault = (epoch = 1): StoredVault => ({
  vaultKey: createVaultRootKey(),
  identity: createDeviceIdentity(),
  epoch,
});

const cell = (): MemoryKeystoreCell => ({ bytes: null });

/** Stands in for iOS and Android, where the OS unlock is the gate and there is no second one. */
class KeychainLikeKeystore extends MemoryKeystore {
  override readonly kind: SyncKeystore['kind'] = 'secure-store';
  override readonly supportsPassphrase = false;
}

describe('an empty keystore', () => {
  it('reports empty and reads null', async () => {
    const keystore = new MemoryKeystore();
    expect(await keystore.status()).toBe('empty');
    expect(await keystore.read()).toBeNull();
  });

  it('has nothing to unlock or to protect', async () => {
    const keystore = new MemoryKeystore();
    await expect(keystore.unlock(PASSPHRASE)).rejects.toThrow(/no vault on this device/);
    await expect(keystore.setPassphrase(PASSPHRASE)).rejects.toThrow(/no vault on this device to protect/);
  });
});

describe('a stored vault', () => {
  it('reads back exactly what was written', async () => {
    const keystore = new MemoryKeystore();
    const original = vault(3);
    await keystore.write(original);

    const stored = await keystore.read();
    expect(stored?.identity.deviceId).toBe(original.identity.deviceId);
    expect(toHex(stored?.vaultKey ?? new Uint8Array())).toBe(toHex(original.vaultKey));
    expect(stored?.epoch).toBe(3);
    expect(await keystore.status()).toBe('unlocked');
  });

  it('survives a restart', async () => {
    // The whole point of the thing. A second instance over the same bytes is what the app
    // does on every cold start, and it must not need anything the first instance held.
    const backing = cell();
    const original = vault();
    await new MemoryKeystore(backing).write(original);

    const restarted = new MemoryKeystore(backing);
    expect(await restarted.status()).toBe('unlocked');
    expect((await restarted.read())?.identity.deviceId).toBe(original.identity.deviceId);
  });

  it('is replaced wholesale by a rotation', async () => {
    const keystore = new MemoryKeystore();
    await keystore.write(vault(1));
    const rotated = vault(2);
    await keystore.write(rotated);

    const stored = await keystore.read();
    expect(stored?.epoch).toBe(2);
    expect(toHex(stored?.vaultKey ?? new Uint8Array())).toBe(toHex(rotated.vaultKey));
  });

  it('is gone after an erase, along with the bytes that held it', async () => {
    const backing = cell();
    const keystore = new MemoryKeystore(backing);
    await keystore.write(vault());
    await keystore.erase();

    expect(await keystore.status()).toBe('empty');
    expect(await keystore.read()).toBeNull();
    expect(backing.bytes).toBeNull();
    expect(await new MemoryKeystore(backing).status()).toBe('empty');
  });

  it('hands out an independent value on every read', async () => {
    // Callers must not be able to reach in and mutate the cached record — and the cache
    // must not be reachable from a value a caller might still hold when the vault locks.
    const keystore = new MemoryKeystore();
    await keystore.write(vault());
    const first = await keystore.read();
    first?.vaultKey.fill(0);

    const second = await keystore.read();
    expect(toHex(second?.vaultKey ?? new Uint8Array())).not.toBe('00'.repeat(32));
  });
});

describe('the passphrase gate', () => {
  it('locks the vault against a restart until the passphrase is given', async () => {
    const backing = cell();
    const first = new MemoryKeystore(backing);
    const original = vault();
    await first.write(original);
    await first.setPassphrase(PASSPHRASE);

    const restarted = new MemoryKeystore(backing);
    expect(await restarted.status()).toBe('locked');
    await expect(restarted.read()).rejects.toThrow(KeystoreError);
    await expect(restarted.read()).rejects.toThrow(/protected by a passphrase/);

    await restarted.unlock(PASSPHRASE);
    expect(await restarted.status()).toBe('unlocked');
    expect((await restarted.read())?.identity.deviceId).toBe(original.identity.deviceId);
  }, 30_000);

  it('refuses a wrong passphrase without saying which part was wrong', async () => {
    const backing = cell();
    const first = new MemoryKeystore(backing);
    await first.write(vault());
    await first.setPassphrase(PASSPHRASE);

    const restarted = new MemoryKeystore(backing);
    await expect(restarted.unlock('correct horse batteries')).rejects.toThrow(SyncCryptoError);
    expect(await restarted.status()).toBe('locked');
  }, 30_000);

  it('will not let a locked device overwrite the vault', async () => {
    // Without this, "pair this device again" on a locked browser would silently replace a
    // passphrase-protected vault with an unprotected one.
    const backing = cell();
    const first = new MemoryKeystore(backing);
    await first.write(vault());
    await first.setPassphrase(PASSPHRASE);

    const restarted = new MemoryKeystore(backing);
    await expect(restarted.write(vault(2))).rejects.toThrow(/Unlock this device/);
    expect(await restarted.status()).toBe('locked');
  }, 30_000);

  it('keeps protecting the vault across a rotation', async () => {
    const backing = cell();
    const keystore = new MemoryKeystore(backing);
    await keystore.write(vault(1));
    await keystore.setPassphrase(PASSPHRASE);
    await keystore.write(vault(2));

    expect(await new MemoryKeystore(backing).status()).toBe('locked');
  }, 30_000);

  it('can be removed again', async () => {
    const backing = cell();
    const keystore = new MemoryKeystore(backing);
    await keystore.write(vault());
    await keystore.setPassphrase(PASSPHRASE);
    await keystore.setPassphrase(null);

    expect(await new MemoryKeystore(backing).status()).toBe('unlocked');
  }, 30_000);

  it('does not arm itself when the passphrase is rejected as too weak', async () => {
    // The failure has to leave the instance believing exactly what is on disk. Otherwise
    // the next write seals under a passphrase the user never successfully set.
    const backing = cell();
    const keystore = new MemoryKeystore(backing);
    await keystore.write(vault());
    await expect(keystore.setPassphrase('short')).rejects.toThrow(/at least 8 characters/);

    await keystore.write(vault(2));
    expect(await new MemoryKeystore(backing).status()).toBe('unlocked');
  });

  it('is meaningless where the operating system already gates the store', async () => {
    const keystore = new KeychainLikeKeystore();
    await keystore.write(vault());
    await expect(keystore.setPassphrase(PASSPHRASE)).rejects.toThrow(/system keychain/);
  });

  it('is closed again by lock, without destroying the stored vault', async () => {
    const backing = cell();
    const keystore = new MemoryKeystore(backing);
    await keystore.write(vault());
    await keystore.setPassphrase(PASSPHRASE);

    keystore.lock();
    expect(await keystore.status()).toBe('locked');
    await expect(keystore.read()).rejects.toThrow(/protected by a passphrase/);

    await keystore.unlock(PASSPHRASE);
    expect(await keystore.status()).toBe('unlocked');
  }, 30_000);

  it('leaves an unguarded store readable after a lock', async () => {
    // There is nothing to re-lock, so `lock()` must not turn a working vault into one the
    // user is asked for a passphrase they never set.
    const keystore = new MemoryKeystore();
    await keystore.write(vault());
    keystore.lock();
    expect(await keystore.status()).toBe('unlocked');
    expect(await keystore.read()).not.toBeNull();
  });
});

describe('a device without secure storage', () => {
  it('refuses to hold a vault at all rather than falling back to something weaker', async () => {
    const keystore = new MemoryKeystore(cell(), false);
    expect(await keystore.status()).toBe('unavailable');
    await expect(keystore.write(vault())).rejects.toThrow(/no secure storage/);
    await expect(keystore.read()).rejects.toThrow(KeystoreError);
  });
});

describe('concurrent access', () => {
  it('serializes writes so the last one wins intact', async () => {
    const keystore = new MemoryKeystore();
    const vaults = [vault(1), vault(2), vault(3)];
    await Promise.all(vaults.map((each) => keystore.write(each)));

    const stored = await keystore.read();
    expect(toHex(stored?.vaultKey ?? new Uint8Array())).toBe(toHex(vaults[2].vaultKey));
    expect(stored?.epoch).toBe(3);
  });

  it('does not let one failure poison everything queued behind it', async () => {
    const keystore = new MemoryKeystore();
    const written = vault();

    const failure = keystore.unlock(PASSPHRASE); // nothing stored yet — rejects
    const write = keystore.write(written);

    await expect(failure).rejects.toThrow(KeystoreError);
    await write;
    expect((await keystore.read())?.identity.deviceId).toBe(written.identity.deviceId);
  });
});
