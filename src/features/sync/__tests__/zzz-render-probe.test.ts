/** Temporary probe. Delete after running. */
import { MemoryStorageAdapter } from '@/data/memory-storage';
import { summarizeSync } from '@/features/sync/sync-summary';
import { MemoryKeystore, type MemoryKeystoreCell } from '@/sync/keystore';
import {
  disableSync,
  enableSync,
  readSyncStatus,
  setEndpoints,
  type SyncSetupDeps,
} from '@/sync/setup';

const PROFILE = { name: 'Phone', platform: 'ios' } as const;

it('PROBE: the exact render-body predicates of every sync screen, post-leave', async () => {
  const storage = new MemoryStorageAdapter();
  await storage.initialize();
  const cell: MemoryKeystoreCell = { bytes: null };
  const deps: SyncSetupDeps = { storage, keystore: new MemoryKeystore(cell) };

  await setEndpoints(deps, { relayUrl: 'https://relay.example.com', relayEnabled: true });
  await enableSync(deps, PROFILE);
  await disableSync(deps, { forget: true });

  const status = await readSyncStatus(deps);

  // sync-screen.tsx:92 / :91
  const paired = Boolean(status.deviceId);
  const summary = summarizeSync(status, { now: Date.now(), relay: status.relay });
  // pair-screen.tsx:384 / :385 / :177
  const canJoin = !status.deviceId;
  const canHost = Boolean(status.endpoints.relayUrl);
  const pairSkipsEnable = Boolean(status.deviceId);
  // recovery-screen.tsx:98
  const recoveryMissing = status.keystore === 'empty' || status.keystore === 'unavailable';

  // eslint-disable-next-line no-console
  console.log('PREDICATES', {
    paired,
    heroHeadline: summary.headline,
    heroButton: paired && status.enabled ? 'Sync now' : paired ? 'Resume sync' : 'Set up sync',
    restoreCardShown: !paired, // sync-screen.tsx:204
    dangerZoneShown: paired, // sync-screen.tsx:233
    transferPaired: Boolean(status.deviceId), // transfer-screen.tsx:141
    canJoin,
    canHost,
    pairSkipsEnable,
    recoveryMissing,
  });

  expect(paired).toBe(true);
  expect(summary.headline).toBe('Sync is off');
  expect(canJoin).toBe(false);
  expect(pairSkipsEnable).toBe(true);
  expect(await deps.keystore.read()).toBeNull();
  expect(recoveryMissing).toBe(true);
});
