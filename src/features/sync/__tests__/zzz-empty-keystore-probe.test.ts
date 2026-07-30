/** Temporary adversarial probe. Delete after running. */
import { render, screen } from '@testing-library/react-native';
import { createElement } from 'react';

import { MemoryStorageAdapter } from '@/data/memory-storage';
import { SyncingStorageAdapter } from '@/data/syncing-storage-adapter';
import { SYNC_META, writeMeta } from '@/data/sync-store';
import { createDeviceIdentity } from '@/sync/crypto';
import { writePeers, type Peer } from '@/sync/engine';
import { MemoryKeystore, type MemoryKeystoreCell } from '@/sync/keystore';
import { INITIAL_EPOCH, enableSync, readSyncStatus, setEndpoints, type SyncSetupDeps } from '@/sync/setup';
import { account } from '@/sync/oplog/__tests__/helpers';
import { summarizeSync } from '@/features/sync/sync-summary';

const NOW_ISO = '2026-06-01T12:00:00.000Z';
const PROFILE = { name: 'Phone', platform: 'ios' } as const;

let mockStatus: Awaited<ReturnType<typeof readSyncStatus>> | null = null;
let mockDeps: SyncSetupDeps;

jest.mock('@/providers/sync-provider', () => ({
  useSync: () => ({
    status: mockStatus,
    syncing: false,
    error: null,
    pass: null,
    refresh: async () => {},
    reconcile: async () => {},
    checkRelay: async () => mockStatus!.relay,
    setup: mockDeps,
    runtime: {},
  }),
  useSyncState: () => null,
}));

const peerNamed = (name: string): Peer => {
  const identity = createDeviceIdentity();
  return {
    deviceId: identity.deviceId,
    name,
    platform: 'ios',
    signingKey: identity.signing.publicKey,
    agreementKey: identity.agreement.publicKey,
    epoch: INITIAL_EPOCH,
    addedAt: NOW_ISO,
    revokedAt: null,
    revokedSeq: null,
    acked: {},
    known: {},
    lastSeenAt: NOW_ISO,
  };
};

it('PROBE: sqlite survived, keychain did not', async () => {
  const storage = new MemoryStorageAdapter();
  await storage.initialize();
  const cell: MemoryKeystoreCell = { bytes: null };
  const deps: SyncSetupDeps = { storage, keystore: new MemoryKeystore(cell), nowIso: () => NOW_ISO };

  await setEndpoints(deps, { relayUrl: 'https://relay.example.com', relayEnabled: true });
  await enableSync(deps, PROFILE);
  await storage.transact(async (tx) => {
    await writePeers(tx, [peerNamed('Laptop')]);
    await writeMeta(tx, {
      [SYNC_META.relayStatus]: 'reachable',
      [SYNC_META.relayCheckedAt]: NOW_ISO,
    });
  });

  // The restore: the database came back, the `THIS_DEVICE_ONLY` keychain item did not, and the
  // app is a fresh process so nothing is cached in memory.
  cell.bytes = null;
  const restored: SyncSetupDeps = { storage, keystore: new MemoryKeystore(cell), nowIso: () => NOW_ISO };

  const status = await readSyncStatus(restored);
  // eslint-disable-next-line no-console
  console.log('RESTORED STATUS', {
    enabled: status.enabled,
    keystore: status.keystore,
    deviceId: status.deviceId,
    peers: status.peers.length,
    relay: status.relay.status,
  });

  const summary = summarizeSync(status, { now: Date.parse('2026-06-01T12:05:00.000Z') });
  // eslint-disable-next-line no-console
  console.log('SUMMARY', summary);

  mockStatus = status;
  mockDeps = restored;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SyncScreen } = require('@/features/sync/sync-screen');
  render(createElement(SyncScreen));
  // eslint-disable-next-line no-console
  console.log('SCREEN', {
    upToDate: screen.queryAllByText('Up to date').length,
    syncNow: screen.queryAllByText('Sync now').length,
    resume: screen.queryAllByText('Resume sync').length,
    setUp: screen.queryAllByText('Set up sync').length,
    restoreCard: screen.queryAllByText('Restore from a backup').length,
  });

  // The unarmed capture path: a local edit produces no op.
  const before = (await storage.transact((tx) => tx.table('syncOps').all())).length;
  const syncing = new SyncingStorageAdapter(storage, null);
  await syncing.putMany([{ type: 'accounts', entity: account({ id: 'acc-after-restore' }) }]);
  const after = (await storage.transact((tx) => tx.table('syncOps').all())).length;
  // eslint-disable-next-line no-console
  console.log('OPS', { before, after });

  expect(status.keystore).toBe('empty');
  expect(status.enabled).toBe(true);
  expect(summary.headline).toBe('Up to date');
  expect(after).toBe(before);
});
