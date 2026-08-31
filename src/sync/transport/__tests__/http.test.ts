import {
  MAX_RESPONSE_BYTES,
  RelayError,
  requestJson,
} from '@/sync/transport/http';
import { fetchDouble } from '@/sync/transport/__tests__/http-double';

describe('bounded relay responses', () => {
  it('calls an injected browser fetch with the global receiver', async () => {
    const http = fetchDouble({ kind: 'json', body: { ok: true } });
    const browserFetch = function (this: unknown, url: string, init?: RequestInit) {
      if (this !== globalThis) return Promise.reject(new TypeError('Illegal invocation'));
      return http.fetch(url, init);
    } as unknown as typeof globalThis.fetch;

    await expect(
      requestJson<{ ok: boolean }>(
        { fetch: browserFetch },
        { method: 'GET', url: 'https://relay.example.test' },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('reads a valid JSON response incrementally', async () => {
    const http = fetchDouble({
      kind: 'stream',
      chunks: ['{"value":"', new TextEncoder().encode('שלום'), '"}'],
    });

    await expect(
      requestJson<{ value: string }>(
        { fetch: http.fetch },
        { method: 'GET', url: 'https://relay.example.test' },
      ),
    ).resolves.toEqual({ value: 'שלום' });
  });

  it('rejects a lying relay as soon as streamed bytes cross the cap', async () => {
    const half = new Uint8Array(MAX_RESPONSE_BYTES / 2);
    const http = fetchDouble({
      kind: 'stream',
      chunks: [half, half, new Uint8Array([0])],
      declaredLength: 1,
    });

    await expect(
      requestJson(
        { fetch: http.fetch },
        { method: 'GET', url: 'https://relay.example.test' },
      ),
    ).rejects.toMatchObject<Partial<RelayError>>({ code: 'tooLarge' });
  });

  it('keeps the deadline active after headers arrive', async () => {
    const http = fetchDouble({
      kind: 'stream',
      chunks: ['{"never":"finishes"'],
      hangAfter: true,
    });

    await expect(
      requestJson(
        { fetch: http.fetch, timeoutMs: 10 },
        { method: 'GET', url: 'https://relay.example.test' },
      ),
    ).rejects.toMatchObject<Partial<RelayError>>({ code: 'unreachable' });
  });

  it('rejects an oversized declared body before consuming it', async () => {
    const http = fetchDouble({
      kind: 'stream',
      chunks: ['{}'],
      declaredLength: MAX_RESPONSE_BYTES + 1,
    });

    await expect(
      requestJson(
        { fetch: http.fetch },
        { method: 'GET', url: 'https://relay.example.test' },
      ),
    ).rejects.toMatchObject<Partial<RelayError>>({ code: 'tooLarge' });
  });
});
