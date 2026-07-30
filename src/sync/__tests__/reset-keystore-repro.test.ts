import { LocalFinanceRepository } from '@/data/local-finance-repository';
import { MemoryStorageAdapter } from '@/data/memory-storage';
import { MemoryKeystore } from '@/sync/keystore/memory';
import { enableSync, readSyncStatus } from '@/sync/setup';

describe('repro: reset leaves the keystore behind', () => {
  it('wipes sync_meta but keeps the vault, so enableSync refuses forever', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.initialize();
    const repository = new LocalFinanceRepository(storage);
    await repository.initialize();

    const keystore = new MemoryKeystore();
    const deps = { storage, keystore };

    const enabled = await enableSync(deps, { name: 'Phone', platform: 'ios' });
    expect(enabled.deviceId).toBeTruthy();

    const before = await readSyncStatus(deps);
    expect(before.deviceId).toBe(enabled.deviceId);
    expect(before.keystore).toBe('unlocked');

    await repository.resetAllData();

    const after = await readSyncStatus(deps);
    // meta is gone …
    expect(after.deviceId).toBe('');
    expect(after.enabled).toBe(false);
    expect(after.peers).toEqual([]);
    // … but the key is still on this device.
    expect(after.keystore).toBe('unlocked');
    const held = await keystore.read();
    expect(held).not.toBeNull();
    expect(held?.identity.deviceId).toBe(enabled.deviceId);

    // Which is exactly what the UI calls when `deviceId` is blank.
    await expect(enableSync(deps, { name: 'Phone', platform: 'ios' })).rejects.toThrow(
      'This device is already part of a vault.',
    );
  });
});
