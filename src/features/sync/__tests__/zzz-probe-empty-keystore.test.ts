/** Temporary adversarial probe. Delete after running. */
import { MemoryStorageAdapter } from '@/data/memory-storage';
import { SYNC_META, writeMeta } from '@/data/sync-store';
import { restorePeerKeys } from '@/sync/crypto';
import type { Peer } from '@/sync/engine';
import { MemoryKeystore, type MemoryKeystoreCell } from '@/sync/keystore';
import { enableSync, readSyncStatus, recordPairedPeer, type SyncSetupDeps } from '@/sync/setup';
import { summarizeSync } from '@/features/sync/sync-summary';

const NOW_ISO = '2026-07-29T11:55:00.000Z';
const NOW = Date.parse('2026-07-29T12:00:00.000Z');

it('PROBE: enabled meta + wiped keystore reports Up to date', async () => {
  const storage = new MemoryStorageAdapter();
  await storage.initialize();
  const cell: MemoryKeystoreCell = { bytes: null };
  const keystore = new MemoryKeystore(cell);
  const deps: SyncSetupDeps = { storage, keystore, nowIso: () => NOW_ISO };

  await enableSync(deps, { name: 'Phone', platform: 'ios' });

  const keys = restorePeerKeys(new Uint8Array(32), new Uint8Array(32));
  const peer: Peer = {
    deviceId: 'peer-1',
    name: 'Laptop',
    platform: 'web',
    ...keys,
    epoch: 1,
    addedAt: '2026-07-01T00:00:00.000Z',
    revokedAt: null,
    revokedSeq: null,
    acked: {},
    known: {},
    lastSeenAt: NOW_ISO,
  };
  await recordPairedPeer(deps, peer);

  // Fake "ops moved" so lastSyncedAt is populated, and a healthy cached relay verdict —
  // exactly what an iOS restore-from-backup hands back: every sqlite row, no keychain entry.
  await storage.transact((tx) =>
    writeMeta(tx, {
      [SYNC_META.relayStatus]: 'reachable',
      [SYNC_META.relayCheckedAt]: NOW_ISO,
      [SYNC_META.relayUrl]: 'https://relay.example.com',
      [SYNC_META.relayEnabled]: '1',
    }),
  );

  // The keychain entry did not come back with the backup. Fresh process => fresh keystore
  // instance over an empty container (a new phone booting the restored app).
  cell.bytes = null;
  const restored: SyncSetupDeps = { storage, keystore: new MemoryKeystore(cell), nowIso: () => NOW_ISO };

  const status = await readSyncStatus(restored);
  // eslint-disable-next-line no-console
  console.log('STATUS', {
    enabled: status.enabled,
    keystore: status.keystore,
    deviceId: status.deviceId,
    peers: status.peers.length,
    relay: status.relay.status,
    endpoint: status.endpoints.relayUrl,
  });
  const summary = summarizeSync(status, { now: NOW });
  // eslint-disable-next-line no-console
  console.log('SUMMARY', summary);
});
