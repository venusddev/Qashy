/**
 * The endpoint parser is the one string in the app that decides where sealed vault data goes.
 *
 * These tests are mostly about refusals, and that emphasis is deliberate: an address that is
 * accepted when it should not be is a privacy failure, whereas an address that is refused when
 * it should not be is an error message.
 */

import { MemoryStorageAdapter } from '@/data/memory-storage';
import { SYNC_META, readMeta, writeMeta } from '@/data/sync-store';
import {
  DEFAULT_RELAY_URL,
  DEFAULT_STUN_URLS,
  EndpointError,
  normalizeEndpointUrl,
  normalizeTurnUrl,
  parseStunUrls,
  readEndpoints,
  writeEndpoints,
} from '@/sync/transport/endpoints';

const storage = async () => {
  const adapter = new MemoryStorageAdapter();
  await adapter.initialize();
  return adapter;
};

describe('normalizeEndpointUrl', () => {
  it('canonicalises an address so two spellings of the same host store identically', () => {
    expect(normalizeEndpointUrl('https://relay.example.com/')).toBe('https://relay.example.com');
    expect(normalizeEndpointUrl('  https://relay.example.com  ')).toBe('https://relay.example.com');
    expect(normalizeEndpointUrl('https://relay.example.com/qashy/')).toBe(
      'https://relay.example.com/qashy',
    );
  });

  it('treats a blank address as "contact nothing" rather than an error', () => {
    expect(normalizeEndpointUrl('')).toBe('');
    expect(normalizeEndpointUrl('   ')).toBe('');
  });

  it('refuses plaintext http except on loopback, where a first run legitimately lives', () => {
    expect(() => normalizeEndpointUrl('http://relay.example.com')).toThrow(EndpointError);
    expect(normalizeEndpointUrl('http://localhost:8787')).toBe('http://localhost:8787');
    expect(normalizeEndpointUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
  });

  it('refuses schemes, credentials, queries and fragments', () => {
    expect(() => normalizeEndpointUrl('ws://relay.example.com')).toThrow(EndpointError);
    expect(() => normalizeEndpointUrl('https://user:pass@relay.example.com')).toThrow(EndpointError);
    expect(() => normalizeEndpointUrl('https://relay.example.com?token=abc')).toThrow(EndpointError);
    expect(() => normalizeEndpointUrl('https://relay.example.com#x')).toThrow(EndpointError);
    expect(() => normalizeEndpointUrl('relay.example.com')).toThrow(EndpointError);
  });
});

describe('parseStunUrls and normalizeTurnUrl', () => {
  it('splits a list and rejects anything that is not a STUN address', () => {
    expect(parseStunUrls('stun:a.example:3478, stuns:b.example:5349')).toEqual([
      'stun:a.example:3478',
      'stuns:b.example:5349',
    ]);
    expect(parseStunUrls('')).toEqual([]);
    expect(() => parseStunUrls('https://a.example')).toThrow(EndpointError);
  });

  it('accepts a TURN address with an optional transport hint and nothing else', () => {
    expect(normalizeTurnUrl('turn:t.example:3478')).toBe('turn:t.example:3478');
    expect(normalizeTurnUrl('turns:t.example:5349?transport=tcp')).toBe(
      'turns:t.example:5349?transport=tcp',
    );
    expect(normalizeTurnUrl('')).toBe('');
    expect(() => normalizeTurnUrl('turn:t.example:3478?transport=quic')).toThrow(EndpointError);
  });
});

describe('readEndpoints', () => {
  it('ships pointed at the project relay, with everything else off by default', async () => {
    const adapter = await storage();
    const endpoints = await adapter.transact((tx) => readEndpoints(tx));

    expect(endpoints.relayUrl).toBe(DEFAULT_RELAY_URL);
    expect(endpoints.relayEnabled).toBe(true);
    expect(endpoints.directEnabled).toBe(true);
    expect(DEFAULT_STUN_URLS).toBe('');
    expect(endpoints.iceServers).toEqual([]);
  });

  it('lets an explicitly blanked relay win over the shipped default', async () => {
    const adapter = await storage();
    await adapter.transact((tx) => writeEndpoints(tx, { relayUrl: '' }));

    const endpoints = await adapter.transact((tx) => readEndpoints(tx));
    expect(endpoints.relayUrl).toBe('');
  });

  it('degrades a stored value that no longer parses instead of throwing on every launch', async () => {
    const adapter = await storage();
    await adapter.transact((tx) =>
      writeMeta(tx, {
        [SYNC_META.relayUrl]: 'http://not-loopback.example',
        [SYNC_META.stunUrls]: 'nonsense',
      }),
    );

    const endpoints = await adapter.transact((tx) => readEndpoints(tx));
    expect(endpoints.relayUrl).toBe('');
    expect(endpoints.iceServers).toEqual([]);
  });

  it('appends a user-supplied TURN server with its credentials', async () => {
    const adapter = await storage();
    await adapter.transact((tx) =>
      writeEndpoints(tx, {
        turnUrl: 'turn:t.example:3478',
        turnUsername: 'me',
        turnCredential: 'secret',
      }),
    );

    const endpoints = await adapter.transact((tx) => readEndpoints(tx));
    expect(endpoints.iceServers).toEqual([
      { urls: 'turn:t.example:3478', username: 'me', credential: 'secret' },
    ]);
  });
});

describe('writeEndpoints', () => {
  it('validates the whole patch before writing any of it', async () => {
    const adapter = await storage();

    await expect(
      adapter.transact((tx) =>
        writeEndpoints(tx, { relayUrl: 'https://relay.example.com', stunUrls: 'nope' }),
      ),
    ).rejects.toThrow(EndpointError);

    // Neither field landed. A half-applied endpoint change is the state that produces
    // "it worked yesterday", so the good half must not survive the bad half.
    const endpoints = await adapter.transact((tx) => readEndpoints(tx));
    expect(endpoints.relayUrl).toBe(DEFAULT_RELAY_URL);
  });

  it('clears the cached health and the cursor when the relay moves', async () => {
    const adapter = await storage();
    await adapter.transact((tx) =>
      writeMeta(tx, {
        [SYNC_META.relayStatus]: 'reachable',
        [SYNC_META.relayCheckedAt]: '2026-06-01T00:00:00.000Z',
        [SYNC_META.relayDetail]: 'fine',
        [SYNC_META.relayFailures]: '4',
        [SYNC_META.relayCursor]: '812',
      }),
    );

    await adapter.transact((tx) => writeEndpoints(tx, { relayUrl: 'https://other.example' }));

    const meta = await adapter.transact((tx) =>
      readMeta(tx, [
        SYNC_META.relayStatus,
        SYNC_META.relayCheckedAt,
        SYNC_META.relayDetail,
        SYNC_META.relayFailures,
        SYNC_META.relayCursor,
      ]),
    );
    expect(meta.get(SYNC_META.relayStatus)).toBe('');
    expect(meta.get(SYNC_META.relayCheckedAt)).toBe('');
    expect(meta.get(SYNC_META.relayDetail)).toBe('');
    expect(meta.get(SYNC_META.relayFailures)).toBe('0');
    // The old cursor counted slots in the old bucket; carrying it over would make this device
    // skip the first 812 blobs the new host ever offers it.
    expect(meta.get(SYNC_META.relayCursor)).toBe('0');
  });

  it('turns the relay off without forgetting where it was', async () => {
    const adapter = await storage();
    await adapter.transact((tx) => writeEndpoints(tx, { relayUrl: 'https://relay.example.com' }));
    await adapter.transact((tx) => writeEndpoints(tx, { relayEnabled: false }));

    const endpoints = await adapter.transact((tx) => readEndpoints(tx));
    expect(endpoints.relayUrl).toBe('https://relay.example.com');
    expect(endpoints.relayEnabled).toBe(false);
  });
});
