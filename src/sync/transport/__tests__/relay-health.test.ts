/**
 * "Is the relay down?" — the whole point of this module is that the answer is never a guess.
 *
 * Each test here pins one row of the §4.1 status table, because the distinctions are the
 * feature: "you are offline", "the host did not answer", "it refused this device", and "it is
 * up but failing" send the user to four different places, and collapsing any two of them into
 * a generic error is the failure mode the module exists to prevent.
 */

import { MemoryStorageAdapter } from '@/data/memory-storage';
import type { StorageTx } from '@/data/storage-adapter';
import { SYNC_META, readMeta } from '@/data/sync-store';
import { writeEndpoints } from '@/sync/transport/endpoints';
import { RelayError } from '@/sync/transport/http';
import {
  MAX_DETAIL_LENGTH,
  RELAY_DEGRADED_AFTER,
  checkRelayHealth,
  noteRelayFailure,
  noteRelaySuccess,
  readRelayHealth,
} from '@/sync/transport/relay-health';
import { fetchDouble, type Reply } from '@/sync/transport/__tests__/http-double';

const RELAY = 'https://relay.example.com';
const NOW = '2026-06-01T12:00:00.000Z';

async function vault(relayUrl = RELAY) {
  const adapter = new MemoryStorageAdapter();
  await adapter.initialize();
  // Always written, including the blank: a stored empty string is how a device says "no
  // relay" now that an untouched install falls back to the shipped default.
  await adapter.transact((tx) => writeEndpoints(tx, { relayUrl }));
  return adapter;
}

const deps = (adapter: MemoryStorageAdapter, ...replies: Reply[]) => {
  const http = fetchDouble(...replies);
  return {
    http,
    deps: {
      fetch: http.fetch,
      transact: <T>(work: (tx: StorageTx) => Promise<T>) => adapter.transact(work),
      nowIso: () => NOW,
    },
  };
};

/**
 * Runs `work` with the platform claiming to be offline.
 *
 * `navigator.onLine` is the one input this module cannot inject, because it is the platform's
 * own answer rather than a dependency, so it is replaced and restored around the assertion.
 */
async function offline(work: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: false },
    configurable: true,
    writable: true,
  });
  try {
    await work();
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
}

describe('checkRelayHealth', () => {
  it('reports a healthy relay and caches the verdict for the next paint', async () => {
    const adapter = await vault();
    const { deps: healthDeps, http } = deps(adapter, {
      kind: 'json',
      body: { ok: true, version: 2 },
    });

    const health = await checkRelayHealth(healthDeps);

    expect(health).toEqual({
      status: 'reachable',
      checkedAt: NOW,
      detail: '',
      failures: 0,
      endpoint: RELAY,
    });
    // A dedicated endpoint, with no bucket id and no token: checking liveness against the
    // real bucket would tell the relay which vault is asking, every time it is asked.
    expect(http.calls[0].url).toBe(`${RELAY}/health`);
    expect(http.calls[0].headers.authorization).toBeUndefined();

    const cached = await adapter.transact((tx) => readRelayHealth(tx));
    expect(cached.status).toBe('reachable');
    expect(cached.checkedAt).toBe(NOW);
  });

  it('says "not configured" rather than "broken" when there is no relay', async () => {
    const adapter = await vault('');
    const { deps: healthDeps, http } = deps(adapter, { kind: 'json', body: { ok: true } });

    const health = await checkRelayHealth(healthDeps);

    expect(health.status).toBe('disabled');
    expect(health.detail).toBe('no relay address configured');
    expect(http.calls).toHaveLength(0);
  });

  it('says "disabled" when the user switched the relay off, without forgetting the address', async () => {
    const adapter = await vault();
    await adapter.transact((tx) => writeEndpoints(tx, { relayEnabled: false }));
    const { deps: healthDeps, http } = deps(adapter, { kind: 'json', body: { ok: true } });

    const health = await checkRelayHealth(healthDeps);

    expect(health.status).toBe('disabled');
    expect(health.endpoint).toBe(RELAY);
    expect(http.calls).toHaveLength(0);
  });

  it('blames the network, not the relay, when this device is offline', async () => {
    const adapter = await vault();
    const { deps: healthDeps, http } = deps(adapter, { kind: 'throw' });

    await offline(async () => {
      const health = await checkRelayHealth(healthDeps);
      expect(health.status).toBe('offline');
      // Not attempted at all: the request would take a timeout to fail and would then be
      // recorded against the relay when the fault is a train tunnel.
      expect(http.calls).toHaveLength(0);
    });
  });

  it.each<[string, Reply, string]>([
    ['a host that does not answer', { kind: 'throw', message: 'getaddrinfo ENOTFOUND' }, 'unreachable'],
    ['a rejected token', { kind: 'status', status: 401 }, 'unauthorized'],
    ['a server that is up and broken', { kind: 'status', status: 502 }, 'degraded'],
    ['a rate limit', { kind: 'status', status: 429 }, 'degraded'],
    ['a captive portal', { kind: 'text', body: '<html>sign in</html>' }, 'unreachable'],
    ['something that is not a Qashy relay', { kind: 'json', body: { hello: 'world' } }, 'unreachable'],
  ])('classifies %s', async (_name, reply, status) => {
    const adapter = await vault();
    const { deps: healthDeps } = deps(adapter, reply);

    const health = await checkRelayHealth(healthDeps);
    expect(health.status).toBe(status);
    expect(health.endpoint).toBe(RELAY);
  });

  it('names both versions when the worker is older than the app', async () => {
    const adapter = await vault();
    const { deps: healthDeps } = deps(adapter, { kind: 'json', body: { ok: true, version: 99 } });

    const health = await checkRelayHealth(healthDeps);

    expect(health.status).toBe('degraded');
    // The difference between a five-minute fix and an afternoon is knowing which side is old.
    expect(health.detail).toContain('v99');
    expect(health.detail).toContain('v2');
  });

  it('never throws, whatever the relay does', async () => {
    const adapter = await vault();
    const exploding = {
      fetch: (() => Promise.reject(new Error('boom'))) as unknown as typeof globalThis.fetch,
      transact: <T>(work: (tx: StorageTx) => Promise<T>) => adapter.transact(work),
      nowIso: () => NOW,
    };

    await expect(checkRelayHealth(exploding)).resolves.toMatchObject({ status: 'unreachable' });
  });

  it('still calls a reachable relay degraded while a run of uploads is failing', async () => {
    const adapter = await vault();
    await adapter.transact(async (tx) => {
      for (let attempt = 0; attempt < RELAY_DEGRADED_AFTER; attempt += 1) {
        await noteRelayFailure(tx, new Error('upload rejected'), NOW);
      }
    });

    const { deps: healthDeps } = deps(adapter, { kind: 'json', body: { ok: true, version: 2 } });
    const health = await checkRelayHealth(healthDeps);

    expect(health.status).toBe('degraded');
    expect(health.detail).toContain(`${RELAY_DEGRADED_AFTER} uploads failed`);
  });
});

describe('readRelayHealth', () => {
  it('starts out unknown rather than claiming anything it has not measured', async () => {
    const adapter = await vault();
    const health = await adapter.transact((tx) => readRelayHealth(tx));

    expect(health).toEqual({
      status: 'unknown',
      checkedAt: '',
      detail: '',
      failures: 0,
      endpoint: RELAY,
    });
  });

  it('does not replay a cached "offline" as if it were still true', async () => {
    const adapter = await vault();
    const { deps: healthDeps } = deps(adapter, { kind: 'throw' });
    await offline(async () => {
      await checkRelayHealth(healthDeps);
    });

    // The offline verdict describes a moment, not the endpoint. Reading it back on a device
    // that has since found Wi-Fi must not keep insisting the network is gone.
    const health = await adapter.transact((tx) => readRelayHealth(tx));
    expect(health.status).not.toBe('offline');
  });
});

describe('upload bookkeeping', () => {
  it('counts a run of failures before calling the relay broken', async () => {
    const adapter = await vault();

    for (let attempt = 1; attempt <= RELAY_DEGRADED_AFTER; attempt += 1) {
      const failures = await adapter.transact((tx) =>
        noteRelayFailure(tx, new RelayError('The relay answered 500.', 'server', 500), NOW),
      );
      expect(failures).toBe(attempt);

      const health = await adapter.transact((tx) => readRelayHealth(tx));
      // One failed upload is ordinary — a network changing hands mid-request. A status that
      // flips to "errors" on every one of those is a status nobody reads.
      expect(health.status).toBe(attempt >= RELAY_DEGRADED_AFTER ? 'degraded' : 'unknown');
    }
  });

  it('clears the run as soon as one upload lands', async () => {
    const adapter = await vault();
    await adapter.transact(async (tx) => {
      await noteRelayFailure(tx, new Error('nope'), NOW);
      await noteRelayFailure(tx, new Error('nope'), NOW);
      await noteRelaySuccess(tx, NOW);
    });

    const health = await adapter.transact((tx) => readRelayHealth(tx));
    expect(health).toMatchObject({ status: 'reachable', failures: 0, detail: '' });
  });

  it('bounds what a hostile relay can write into a row that is read on every paint', async () => {
    const adapter = await vault();
    await adapter.transact((tx) => noteRelayFailure(tx, new Error('x'.repeat(5000)), NOW));

    const stored = await adapter.transact((tx) => readMeta(tx, [SYNC_META.relayDetail]));
    expect(stored.get(SYNC_META.relayDetail)).toHaveLength(MAX_DETAIL_LENGTH);
  });
});
