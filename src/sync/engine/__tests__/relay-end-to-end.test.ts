/**
 * A real session over the store-and-forward path.
 *
 * Unlike the loopback suites, this drives the timing that matters for a phone and laptop:
 * one device uploads while the other is asleep, then the other collects and projects those
 * frames in a later manual pass.
 */

import { SyncSession } from '@/sync/engine/session';
import { EPOCH, makeVault, settle, type VaultDevice } from '@/sync/engine/__tests__/vault';
import { RelayTransport } from '@/sync/transport/relay';

const BASE = 'https://relay.example.com';
const SOURCE_TAG = 'source-route-tag';
const TARGET_TAG = 'target-route-tag';

interface Blob {
  readonly slot: number;
  readonly to: string;
  readonly seq: number;
  readonly frame: string;
}

const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function inMemoryRelay() {
  const blobs: Blob[] = [];
  let nextSlot = 1;

  const fetch = (async (input, init) => {
    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl);

    if (url.pathname === '/health') return response({ ok: true, version: 1 });
    if (url.pathname !== '/bucket/bucket') return new Response(null, { status: 404 });

    if (init?.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? '0');
      return response({ blobs: blobs.filter((blob) => blob.slot > after), more: false });
    }
    if (init?.method === 'PUT' && typeof init.body === 'string') {
      const body = JSON.parse(init.body) as Omit<Blob, 'slot'>;
      blobs.push({ ...body, slot: nextSlot });
      nextSlot += 1;
      return response({ ok: true });
    }
    return new Response(null, { status: 405 });
  }) as typeof globalThis.fetch;

  return fetch;
}

function relayFor(selfTag: string, peerTag: string, fetch: typeof globalThis.fetch) {
  let cursor = 0;
  return new RelayTransport({
    fetch,
    baseUrl: BASE,
    bucketId: 'bucket',
    token: 'token',
    selfTag,
    tagFor: () => peerTag,
    readCursor: () => Promise.resolve(cursor),
    writeCursor: (next) => {
      cursor = next;
      return Promise.resolve();
    },
    jitterMs: 0,
  });
}

function sessionFor(device: VaultDevice, transport: RelayTransport) {
  return new SyncSession({
    storage: device.storage,
    repository: device.repository,
    deviceId: device.deviceId,
    signingKey: device.identity.signing.secretKey,
    frame: { key: device.contentKey, deviceId: device.deviceId, epoch: EPOCH },
    transports: [transport],
    now: () => device.now(),
    nowIso: () => new Date(device.now()).toISOString(),
    onError: (error) => device.errors.push(error),
  });
}

describe('relay sync', () => {
  it('moves an offline device’s transaction and account archive on the receiver’s later pass', async () => {
    const [source, target] = await makeVault();
    const fetch = inMemoryRelay();
    const sourceSession = sessionFor(source, relayFor(SOURCE_TAG, TARGET_TAG, fetch));
    const targetSession = sessionFor(target, relayFor(TARGET_TAG, SOURCE_TAG, fetch));

    const account = await source.repository.saveAccount({
      name: 'Duplicate account',
      type: 'checking',
      currency: 'USD',
      openingBalanceMinor: 0,
      icon: 'wallet',
      color: '#5966E9',
      archived: false,
    });
    await source.repository.saveTransaction({
      kind: 'expense',
      title: 'Synced transaction',
      localDate: '2026-07-30',
      accountId: account.id,
      amountMinor: 1250,
    });
    await source.repository.saveAccount({ ...account, archived: true }, account.id);

    const sent = await sourceSession.reconcile();
    expect(sent.pushed).toMatchObject([{ ops: 3 }]);

    await targetSession.reconcile();
    await settle(6);

    expect(target.state.transactions).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: 'Synced transaction' })]),
    );
    expect(target.state.accounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: account.id, archived: true })]),
    );
    expect([...source.errors, ...target.errors]).toEqual([]);
  });
});
