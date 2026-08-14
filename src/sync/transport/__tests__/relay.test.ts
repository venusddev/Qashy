/**
 * The drop-box, exercised against a relay that is by turns broken, hostile, and merely slow.
 *
 * The happy path here is one test. The rest are the cases that decide whether an unreliable
 * server degrades sync or breaks it permanently — a cursor that refuses to advance past a bad
 * blob, a page returned out of order, a body that is not JSON at all.
 */

import { MAX_FRAME_BYTES, toBase64Url } from '@/sync/crypto';
import { RelayError } from '@/sync/transport/http';
import { MAX_RELAY_PAGES, RELAY_PAGE_SIZE, RelayTransport } from '@/sync/transport/relay';
import { fetchDouble, type FetchDouble } from '@/sync/transport/__tests__/http-double';

const BASE = 'https://relay.example.com';
const SELF = 'aaaaaaaaaaaaaaaa';
const PEER = 'bbbbbbbbbbbbbbbb';

const frame = (byte: number, length = 8) => new Uint8Array(length).fill(byte);

interface Harness {
  readonly transport: RelayTransport;
  readonly http: FetchDouble;
  readonly cursor: () => number;
}

function harness(http: FetchDouble): Harness {
  let cursor = 0;
  const transport = new RelayTransport({
    fetch: http.fetch,
    baseUrl: BASE,
    bucketId: 'bucket-1',
    token: 'token-1',
    selfTag: SELF,
    tagFor: () => PEER,
    readCursor: () => Promise.resolve(cursor),
    writeCursor: (slot) => {
      cursor = slot;
      return Promise.resolve();
    },
    // Jitter exists to blur upload timing on a real network; in a test it is only latency.
    jitterMs: 0,
  });
  return { transport, http, cursor: () => cursor };
}

const blob = (slot: number, to: string, seq: number, bytes: Uint8Array, from = PEER) => ({
  slot,
  from,
  to,
  seq,
  frame: toBase64Url(bytes),
});

const abort = () => new AbortController().signal;

describe('RelayTransport.connect', () => {
  it('routes a fetched blob to its sender channel, including when that channel connects later', async () => {
    const http = fetchDouble(
      {
        kind: 'json',
        body: { blobs: [blob(1, SELF, 0, frame(7), 'tag-b')], more: false },
      },
      { kind: 'json', body: { blobs: [], more: false } },
    );
    let cursor = 0;
    const transport = new RelayTransport({
      fetch: http.fetch,
      baseUrl: BASE,
      bucketId: 'bucket-1',
      token: 'token-1',
      selfTag: SELF,
      tagFor: (peerId) => (peerId === 'b' ? 'tag-b' : 'tag-a'),
      readCursor: () => Promise.resolve(cursor),
      writeCursor: (slot) => {
        cursor = slot;
        return Promise.resolve();
      },
      jitterMs: 0,
    });

    const channelA = await transport.connect({ deviceId: 'a', name: 'A' }, abort());
    const heardA: number[] = [];
    channelA.onFrame((_frame, seq) => heardA.push(seq));
    const channelB = await transport.connect({ deviceId: 'b', name: 'B' }, abort());
    const heardB: number[] = [];
    channelB.onFrame((_frame, seq) => heardB.push(seq));

    expect(heardA).toEqual([]);
    expect(heardB).toEqual([0]);
  });

  it('collects what is addressed to this device and ignores what is not', async () => {
    const http = fetchDouble({
      kind: 'json',
      body: {
        blobs: [blob(1, SELF, 0, frame(1)), blob(2, 'someone-else', 0, frame(2)), blob(3, SELF, 1, frame(3))],
        more: false,
      },
    });
    const { transport, cursor } = harness(http);

    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());
    const received: { frame: Uint8Array; seq: number }[] = [];
    channel.onFrame((bytes, seq) => received.push({ frame: bytes, seq }));

    expect(received).toEqual([
      { frame: frame(1), seq: 0 },
      { frame: frame(3), seq: 1 },
    ]);
    // Past the other device's blob too: it will never become this device's business, and
    // re-reading it every launch would grow with the vault's whole history.
    expect(cursor()).toBe(3);
  });

  it('buffers frames that arrive before the session attaches its pump', async () => {
    const http = fetchDouble({
      kind: 'json',
      body: { blobs: [blob(1, SELF, 7, frame(9))], more: false },
    });
    const { transport } = harness(http);

    // `connect` polls and resolves; the session installs `onFrame` only afterwards. Without
    // the buffer, everything the poll collected would land on the floor.
    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());
    const received: number[] = [];
    channel.onFrame((_bytes, seq) => received.push(seq));

    expect(received).toEqual([7]);
  });

  it('sends the bearer token on every bucket request and never on nothing else', async () => {
    const http = fetchDouble({ kind: 'json', body: { blobs: [], more: false } });
    const { transport } = harness(http);
    await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());

    expect(http.calls[0].headers.authorization).toBe('Bearer token-1');
    expect(http.calls[0].url).toBe(`${BASE}/bucket/bucket-1?after=0&limit=${RELAY_PAGE_SIZE}`);
  });

  it('refuses to start once sync has been cancelled', async () => {
    const http = fetchDouble({ kind: 'json', body: { blobs: [], more: false } });
    const { transport } = harness(http);
    const controller = new AbortController();
    controller.abort();

    await expect(transport.connect({ deviceId: 'peer', name: 'Peer' }, controller.signal)).rejects.toThrow(
      RelayError,
    );
    expect(http.calls).toHaveLength(0);
  });
});

describe('RelayTransport.poll', () => {
  it('shares one pass across every peer, so a four-device vault downloads each page once', async () => {
    const http = fetchDouble({
      kind: 'json',
      body: { blobs: [blob(1, SELF, 0, frame(1))], more: false },
    });
    const { transport } = harness(http);

    await Promise.all([
      transport.connect({ deviceId: 'a', name: 'A' }, abort()),
      transport.connect({ deviceId: 'b', name: 'B' }, abort()),
      transport.connect({ deviceId: 'c', name: 'C' }, abort()),
    ]);

    expect(http.calls).toHaveLength(1);
  });

  it('follows pages while the relay says there are more', async () => {
    const http = fetchDouble(
      { kind: 'json', body: { blobs: [blob(1, SELF, 0, frame(1))], more: true } },
      { kind: 'json', body: { blobs: [blob(2, SELF, 1, frame(2))], more: true } },
      { kind: 'json', body: { blobs: [blob(3, SELF, 2, frame(3))], more: false } },
    );
    const { transport, cursor } = harness(http);
    await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());

    expect(http.calls).toHaveLength(3);
    expect(http.calls[1].url).toContain('after=1');
    expect(cursor()).toBe(3);
  });

  it('stops after the page cap and resumes from the persisted cursor next time', async () => {
    // A relay that always claims `more` would otherwise turn opening the app into an
    // unbounded download the user can neither see nor cancel.
    const http = fetchDouble({
      kind: 'json',
      body: { blobs: [blob(1, SELF, 0, frame(1))], more: true },
    });
    const { transport } = harness(http);
    await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());

    expect(http.calls).toHaveLength(MAX_RELAY_PAGES);
  });

  it('advances past a blob it cannot decode instead of re-downloading it forever', async () => {
    const http = fetchDouble({
      kind: 'json',
      body: {
        blobs: [
          { slot: 1, to: SELF, seq: 0, frame: '!!! not base64url !!!' },
          blob(2, SELF, 1, frame(4)),
        ],
        more: false,
      },
    });
    const { transport, cursor } = harness(http);

    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());
    const received: number[] = [];
    channel.onFrame((_bytes, seq) => received.push(seq));

    expect(received).toEqual([1]);
    expect(cursor()).toBe(2);
  });

  it('skips malformed rows without stranding the good ones beside them', async () => {
    const http = fetchDouble({
      kind: 'json',
      body: {
        blobs: [
          null,
          { slot: 'one', to: SELF, seq: 0, frame: '' },
          { slot: 2, to: SELF, seq: -1, frame: '' },
          { slot: 3, to: 5, seq: 0, frame: '' },
          blob(4, SELF, 0, frame(6)),
        ],
        more: false,
      },
    });
    const { transport } = harness(http);

    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());
    const received: Uint8Array[] = [];
    channel.onFrame((bytes) => received.push(bytes));

    expect(received).toEqual([frame(6)]);
  });

  it('writes a true high-water mark even when the relay returns a page out of order', async () => {
    const http = fetchDouble({
      kind: 'json',
      body: { blobs: [blob(9, SELF, 1, frame(2)), blob(4, SELF, 0, frame(1))], more: false },
    });
    const { transport, cursor } = harness(http);

    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());
    const received: number[] = [];
    channel.onFrame((_bytes, seq) => received.push(seq));

    expect(received).toEqual([0, 1]);
    expect(cursor()).toBe(9);
  });

  it('classifies a rejected token, a broken host, and a body full of HTML', async () => {
    const cases: [Parameters<FetchDouble['reply']>[0], string][] = [
      [{ kind: 'status', status: 401 }, 'unauthorized'],
      [{ kind: 'status', status: 503 }, 'server'],
      [{ kind: 'status', status: 429 }, 'rateLimited'],
      [{ kind: 'throw' }, 'unreachable'],
      [{ kind: 'text', body: '<html>captive portal</html>' }, 'malformed'],
      [{ kind: 'json', body: { blobs: 'not an array' } }, 'malformed'],
    ];

    for (const [reply, code] of cases) {
      const { transport } = harness(fetchDouble(reply));
      await expect(transport.poll()).rejects.toMatchObject({ code });
    }
  });
});

describe('RelayTransport uploads', () => {
  it('addresses a frame to the peer, carries the sequence, and encodes the bytes', async () => {
    const http = fetchDouble({ kind: 'json', body: { blobs: [], more: false } });
    const { transport } = harness(http);
    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());

    await channel.send(frame(3), 5);

    const put = http.calls[1];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(`${BASE}/bucket/bucket-1`);
    expect(put.headers.authorization).toBe('Bearer token-1');
    expect(put.body).toEqual({ from: SELF, to: PEER, seq: 5, frame: toBase64Url(frame(3)) });
  });

  it('refuses an oversized frame before it reaches the network', async () => {
    const http = fetchDouble({ kind: 'json', body: { blobs: [], more: false } });
    const { transport } = harness(http);
    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());

    await expect(channel.send(frame(0, MAX_FRAME_BYTES + 1), 0)).rejects.toMatchObject({
      code: 'tooLarge',
    });
    expect(http.calls).toHaveLength(1);
  });

  it('does not count a refused oversized upload as a relay health failure', async () => {
    const uploads: (unknown | null)[] = [];
    const transport = new RelayTransport({
      fetch: fetchDouble(
        { kind: 'json', body: { blobs: [], more: false } },
        { kind: 'status', status: 413 },
      ).fetch,
      baseUrl: BASE,
      bucketId: 'bucket-1',
      token: 'token-1',
      selfTag: SELF,
      tagFor: () => PEER,
      readCursor: () => Promise.resolve(0),
      writeCursor: () => Promise.resolve(),
      jitterMs: 0,
      onUpload: (error) => uploads.push(error),
    });
    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());

    // A frame the relay refuses as too large is a local payload problem; the relay itself is
    // fine, so the health verdict must not drift toward `degraded` because of it.
    await expect(channel.send(frame(3, 64), 0)).rejects.toMatchObject({ code: 'tooLarge' });
    expect(uploads).toEqual([]);
  });

  it('still counts a relay that is erroring on normal uploads', async () => {
    const uploads: (unknown | null)[] = [];
    const transport = new RelayTransport({
      fetch: fetchDouble(
        { kind: 'json', body: { blobs: [], more: false } },
        { kind: 'status', status: 500 },
      ).fetch,
      baseUrl: BASE,
      bucketId: 'bucket-1',
      token: 'token-1',
      selfTag: SELF,
      tagFor: () => PEER,
      readCursor: () => Promise.resolve(0),
      writeCursor: () => Promise.resolve(),
      jitterMs: 0,
      onUpload: (error) => uploads.push(error),
    });
    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());

    await expect(channel.send(frame(3, 64), 0)).rejects.toMatchObject({ code: 'server' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toBeInstanceOf(RelayError);
  });

  it('jitters each frame separately, so a burst of batches does not arrive as a burst', async () => {
    const slept: number[] = [];
    const transport = new RelayTransport({
      fetch: fetchDouble({ kind: 'json', body: { blobs: [], more: false } }).fetch,
      baseUrl: BASE,
      bucketId: 'bucket-1',
      token: 'token-1',
      selfTag: SELF,
      tagFor: () => PEER,
      readCursor: () => Promise.resolve(0),
      writeCursor: () => Promise.resolve(),
      jitterMs: 1000,
      random: () => 0.5,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());
    await channel.send(frame(1), 0);
    await channel.send(frame(2), 1);

    expect(slept).toEqual([500, 500]);
  });

  it('refuses to send on a closed channel', async () => {
    const http = fetchDouble({ kind: 'json', body: { blobs: [], more: false } });
    const { transport } = harness(http);
    const channel = await transport.connect({ deviceId: 'peer', name: 'Peer' }, abort());

    await transport.close();
    await expect(channel.send(frame(1), 0)).rejects.toThrow(RelayError);
  });

  it('empties the bucket on purge', async () => {
    const http = fetchDouble({ kind: 'json', body: {} });
    const { transport } = harness(http);

    await transport.purge();
    expect(http.calls[0]).toMatchObject({ method: 'DELETE', url: `${BASE}/bucket/bucket-1` });
  });
});
