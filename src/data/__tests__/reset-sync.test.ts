import { LocalFinanceRepository } from '@/data/local-finance-repository';
import { MemoryStorageAdapter } from '@/data/memory-storage';
import { SyncingStorageAdapter } from '@/data/syncing-storage-adapter';
import { MemoryKeystore } from '@/sync/keystore';
import { enableSync, readSyncStatus } from '@/sync/setup';

describe('resetting finance data also leaves the sync vault', () => {
  it('erases the device-only key before wiping sync tables', async () => {
    const inner = new MemoryStorageAdapter();
    const storage = new SyncingStorageAdapter(inner, null);
    const keystore = new MemoryKeystore();
    const unregisterReset = storage.setResetHandler(() => keystore.erase());
    const repository = new LocalFinanceRepository(storage);
    await repository.initialize();

    const deps = { storage, keystore };
    const enabled = await enableSync(deps, { name: 'Phone', platform: 'ios' });
    storage.setDeviceId(enabled.deviceId);

    await repository.resetAllData();

    await expect(keystore.read()).resolves.toBeNull();
    await expect(readSyncStatus(deps)).resolves.toMatchObject({
      enabled: false,
      keystore: 'empty',
      deviceId: '',
      peers: [],
    });
    await expect(enableSync(deps, { name: 'Phone', platform: 'ios' })).resolves.toMatchObject({
      opCount: 0,
    });

    unregisterReset();
  });
});
