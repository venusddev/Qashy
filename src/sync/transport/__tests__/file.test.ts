/**
 * Sneakernet.
 *
 * The interesting property of this transport is that it is the *same* transport as the other
 * two from the engine's side — collect frames, hand them over, push arriving frames into the
 * receive path — while involving no network at all. So most of what is worth asserting is that
 * the seams line up: what `bundle()` produces is exactly what `decodeBundle` accepts, a file
 * addressed elsewhere is a no-op rather than an error, and a damaged file is refused whole
 * rather than half-applied.
 */

import { MAX_FRAME_BYTES, toBase64Url } from '@/sync/crypto';
import {
  BUNDLE_EXTENSION,
  BUNDLE_VERSION,
  BundleError,
  FileTransport,
  MAX_BUNDLE_FRAMES,
  bundleFileName,
  decodeBundle,
  encodeBundle,
  type SyncBundle,
} from '@/sync/transport/file';

const SELF = 'device-a';
const SELF_TAG = 'tag-for-a';
const PEER = { deviceId: 'device-b', name: 'Laptop' };
const PEER_TAG = 'tag-for-b';

const transportFor = (overrides: Partial<{ deviceId: string; selfTag: string }> = {}) =>
  new FileTransport({
    deviceId: overrides.deviceId ?? SELF,
    selfTag: overrides.selfTag ?? SELF_TAG,
    tagFor: (peerId) => (peerId === PEER.deviceId ? PEER_TAG : `tag-for-${peerId}`),
  });

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('FileTransport', () => {
  it('collects what the session sends, tagged for the peer it was sealed for', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);

    await channel.send(bytes(1, 2, 3), 0);
    await channel.send(bytes(4), 1);

    expect(transport.bundle()).toEqual({
      version: BUNDLE_VERSION,
      from: SELF,
      frames: [
        { to: PEER_TAG, seq: 0, frame: bytes(1, 2, 3) },
        { to: PEER_TAG, seq: 1, frame: bytes(4) },
      ],
    });
  });

  it('reuses one channel per peer, so two passes land in one file', async () => {
    const transport = transportFor();

    const first = await transport.connect(PEER);
    const second = await transport.connect(PEER);
    expect(second).toBe(first);

    await first.send(bytes(1), 0);
    await second.send(bytes(2), 1);
    expect(transport.bundle().frames).toHaveLength(2);
  });

  it('keeps each peer in its own addressed set', async () => {
    const transport = transportFor();

    await (await transport.connect(PEER)).send(bytes(1), 0);
    await (await transport.connect({ deviceId: 'device-c', name: 'Tablet' })).send(
      bytes(2),
      0,
    );

    const tags = transport.bundle().frames.map((held) => held.to);
    expect(new Set(tags)).toEqual(new Set([PEER_TAG, 'tag-for-device-c']));
  });

  it('refuses to collect more than one file can carry', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);

    for (let index = 0; index < MAX_BUNDLE_FRAMES; index += 1) {
      await channel.send(bytes(index & 0xff), index);
    }
    await expect(channel.send(bytes(0), MAX_BUNDLE_FRAMES)).rejects.toThrow(BundleError);
    expect(transport.bundle().frames).toHaveLength(MAX_BUNDLE_FRAMES);
  });

  it('reports collected, not delivered — an unopened file loses nothing', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);

    // The promise resolving means the frame is in the file. Whether the file is ever opened is
    // the outbox's problem, and the ops stay pending until the peer acks them.
    await expect(channel.send(bytes(1), 0)).resolves.toBeUndefined();
  });
});

describe('FileTransport.ingest', () => {
  it('pushes frames addressed to this device into the receive path', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);
    const heard: { frame: Uint8Array; seq: number }[] = [];
    channel.onFrame((frame, seq) => heard.push({ frame, seq }));

    const delivered = transport.ingest({
      version: BUNDLE_VERSION,
      from: PEER.deviceId,
      frames: [
        { to: SELF_TAG, seq: 4, frame: bytes(9, 9) },
        { to: SELF_TAG, seq: 5, frame: bytes(8) },
      ],
    });

    expect(delivered).toBe(2);
    expect(heard).toEqual([
      { frame: bytes(9, 9), seq: 4 },
      { frame: bytes(8), seq: 5 },
    ]);
  });

  it('carries the sequence number rather than counting arrivals', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);
    const seqs: number[] = [];
    channel.onFrame((_frame, seq) => seqs.push(seq));

    // A file written on the second day of a two-day export holds frames sealed under counters
    // that did not restart. A receiver inferring the sequence from arrival order would fail to
    // open every one of them.
    transport.ingest({
      version: BUNDLE_VERSION,
      from: PEER.deviceId,
      frames: [
        { to: SELF_TAG, seq: 11, frame: bytes(1) },
        { to: SELF_TAG, seq: 12, frame: bytes(2) },
      ],
    });

    expect(seqs).toEqual([11, 12]);
  });

  it('treats a file meant for another device as nothing to do, not as damage', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);
    const heard: Uint8Array[] = [];
    channel.onFrame((frame) => heard.push(frame));

    // A three-device vault produces one file per peer, so opening the wrong one is an ordinary
    // mistake with an obvious fix. Throwing here would read like corruption.
    const delivered = transport.ingest({
      version: BUNDLE_VERSION,
      from: PEER.deviceId,
      frames: [{ to: 'tag-for-somebody-else', seq: 0, frame: bytes(1) }],
    });

    expect(delivered).toBe(0);
    expect(heard).toHaveLength(0);
  });

  it('delivers nothing once closed', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);
    const heard: Uint8Array[] = [];
    channel.onFrame((frame) => heard.push(frame));

    await transport.close();
    const delivered = transport.ingest({
      version: BUNDLE_VERSION,
      from: PEER.deviceId,
      frames: [{ to: SELF_TAG, seq: 0, frame: bytes(1) }],
    });

    expect(delivered).toBe(0);
    expect(heard).toHaveLength(0);
  });

  it('stops delivering to an unsubscribed handler', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);
    const heard: Uint8Array[] = [];
    const stop = channel.onFrame((frame) => heard.push(frame));
    stop();

    expect(
      transport.ingest({
        version: BUNDLE_VERSION,
        from: PEER.deviceId,
        frames: [{ to: SELF_TAG, seq: 0, frame: bytes(1) }],
      }),
    ).toBe(0);
    expect(heard).toHaveLength(0);
  });
});

describe('bundle encoding', () => {
  it('round-trips exactly', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);
    await channel.send(bytes(0, 1, 127, 128, 255), 0);
    await channel.send(new Uint8Array(0), 1);

    const original = transport.bundle();
    expect(decodeBundle(encodeBundle(original))).toEqual(original);
  });

  it('survives being treated as text', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);
    await channel.send(Uint8Array.from({ length: 256 }, (_value, index) => index), 0);

    const text = encodeBundle(transport.bundle());
    // Base64url and JSON, so nothing here can be mangled by an email client, a zip, or a
    // filesystem that decides to normalise line endings.
    expect(text).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeBundle(text).frames[0].frame).toHaveLength(256);
  });

  it('names the file so a folder of them sorts by date', () => {
    expect(bundleFileName('2026-07-29T10:15:00.000Z')).toBe(`qashy-sync-2026-07-29${BUNDLE_EXTENSION}`);
  });
});

describe('decodeBundle refuses', () => {
  const bundleWith = (frames: unknown[]) =>
    JSON.stringify({ version: BUNDLE_VERSION, from: SELF, frames });

  it.each([
    ['text that is not JSON', 'not json at all'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
  ])('%s', (_label, text) => {
    expect(() => decodeBundle(text)).toThrow(BundleError);
  });

  it('a file from a newer version, by name', () => {
    const text = JSON.stringify({ version: BUNDLE_VERSION + 1, from: SELF, frames: [] });
    // The message has to say what to do about it. "Damaged" would send the user looking for a
    // problem with the file rather than at the version of the app that wrote it.
    expect(() => decodeBundle(text)).toThrow(/newer version/);
  });

  it('a file with no sender or no frame list', () => {
    expect(() => decodeBundle(JSON.stringify({ version: BUNDLE_VERSION, frames: [] }))).toThrow(
      BundleError,
    );
    expect(() => decodeBundle(JSON.stringify({ version: BUNDLE_VERSION, from: SELF }))).toThrow(
      BundleError,
    );
  });

  it('more frames than the cap', () => {
    const frames = Array.from({ length: MAX_BUNDLE_FRAMES + 1 }, (_value, index) => ({
      to: SELF_TAG,
      seq: index,
      frame: toBase64Url(bytes(1)),
    }));
    expect(() => decodeBundle(bundleWith(frames))).toThrow(/too large/);
  });

  it.each([
    ['a frame that is not an object', 7],
    ['a missing recipient', { seq: 0, frame: toBase64Url(bytes(1)) }],
    ['a missing payload', { to: SELF_TAG, seq: 0 }],
    ['a non-integer sequence', { to: SELF_TAG, seq: 1.5, frame: toBase64Url(bytes(1)) }],
    ['a negative sequence', { to: SELF_TAG, seq: -1, frame: toBase64Url(bytes(1)) }],
    ['a payload that is not base64url', { to: SELF_TAG, seq: 0, frame: '!!!!' }],
  ])('%s', (_label, entry) => {
    expect(() => decodeBundle(bundleWith([entry]))).toThrow(BundleError);
  });

  it('a frame past the envelope cap, before decoding it', () => {
    // Checked on the encoded string. A crafted file must not be able to make this device
    // allocate the megabytes the cap exists to refuse in order to discover it should not have.
    const oversized = 'A'.repeat(Math.ceil((MAX_FRAME_BYTES * 4) / 3) + 8);
    expect(() => decodeBundle(bundleWith([{ to: SELF_TAG, seq: 0, frame: oversized }]))).toThrow(
      BundleError,
    );
  });

  it('the whole file when only one frame is damaged', () => {
    const frames = [
      { to: SELF_TAG, seq: 0, frame: toBase64Url(bytes(1)) },
      { to: SELF_TAG, seq: 1, frame: '!!!!' },
      { to: SELF_TAG, seq: 2, frame: toBase64Url(bytes(3)) },
    ];
    // Not "import the two good ones". The user chose this file and is watching; a partial
    // import would leave them with no way to know which part landed.
    expect(() => decodeBundle(bundleWith(frames))).toThrow(BundleError);
  });
});

describe('what a bundle reveals', () => {
  it('carries no key material and no plaintext of its own', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);
    await channel.send(bytes(1, 2, 3), 0);

    const decoded = JSON.parse(encodeBundle(transport.bundle())) as Record<string, unknown>;

    // Every frame inside was already sealed by `sealBatch` under the vault content key, so the
    // wrapper has no second key to manage and nothing to protect. What it does expose — a
    // frame count and a route tag — is what any wrapper must, and a file the user is carrying
    // themselves is not a place where hiding either buys anything.
    expect(Object.keys(decoded).sort()).toEqual(['frames', 'from', 'version']);
  });

  it('addresses frames by route tag, not by device id', async () => {
    const transport = transportFor();
    const channel = await transport.connect(PEER);
    await channel.send(bytes(1), 0);

    const bundle: SyncBundle = transport.bundle();
    expect(bundle.frames[0].to).toBe(PEER_TAG);
    expect(bundle.frames[0].to).not.toBe(PEER.deviceId);
  });
});
