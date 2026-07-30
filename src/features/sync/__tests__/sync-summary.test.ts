/**
 * The precedence rules, enumerated.
 *
 * The strings themselves are not what these assert — copy changes and a test that pins every
 * word is a test that gets updated without being read. What they pin is the *ordering*: which
 * of several simultaneously-true things the one available line is spent on. Getting that wrong
 * produces a settings row that says "3 devices · just now" while a change sits unapplied,
 * which is worse than saying nothing.
 */

import type { SyncActivityRow } from '@/data/sync-tables';
import { restorePeerKeys } from '@/sync/crypto';
import type { Peer } from '@/sync/engine';
import { ACTIVITY_KINDS } from '@/sync/engine/types';
import type { SyncStatus } from '@/sync/setup';
import type { RelayHealth, RelayStatus } from '@/sync/transport/relay-health';
import {
  describeActivity,
  describePeer,
  describeRelay,
  deviceIcon,
  livePeers,
  summarizeSync,
} from '@/features/sync/sync-summary';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');

// Lengths only — `restorePeerKeys` checks nothing else, and generating real keys for a test
// about which sentence gets shown would be a slow way to assert nothing extra.
const keys = restorePeerKeys(new Uint8Array(32), new Uint8Array(32));

const peer = (over: Partial<Peer> = {}): Peer => ({
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
  lastSeenAt: '2026-07-29T11:58:00.000Z',
  ...over,
});

const relay = (status: RelayStatus, over: Partial<RelayHealth> = {}): RelayHealth => ({
  status,
  checkedAt: '2026-07-29T11:59:00.000Z',
  detail: '',
  failures: 0,
  endpoint: 'https://relay.example.com',
  ...over,
});

const status = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  enabled: true,
  keystore: 'unlocked',
  deviceId: 'this-device',
  deviceName: 'Phone',
  epoch: 1,
  baseCurrency: 'ILS',
  peers: [peer()],
  endpoints: { relayUrl: 'https://relay.example.com', relayEnabled: true, directEnabled: true, iceServers: [] },
  relay: relay('reachable'),
  activity: [],
  quarantined: 0,
  pending: false,
  lastSyncedAt: '2026-07-29T11:55:00.000Z',
  ...over,
});

const summarize = (over: Partial<SyncStatus> = {}, health?: RelayHealth) =>
  summarizeSync(status(over), { now: NOW, relay: health });

describe('summarizeSync', () => {
  it('says nothing alarming when everything is working', () => {
    const summary = summarize();
    expect(summary.tone).toBe('positive');
    // Two devices: the peer plus this one. A count that excluded the local device would make
    // a healthy pair read as "1 device", which looks exactly like pairing having failed.
    expect(summary.subtitle).toBe('2 devices · 5 minutes ago');
    expect(summary.headline).toBe('Up to date');
  });

  it('reports being off before anything else, however broken the rest is', () => {
    // Off is not a fault, and a device with sync switched off has no business reporting a
    // relay outage — it is not using the relay.
    const summary = summarize({ enabled: false, quarantined: 4, relay: relay('unreachable') });
    expect(summary.subtitle).toBe('Off');
    expect(summary.tone).toBe('neutral');
  });

  it('puts an unusable keystore ahead of a working vault’s state', () => {
    expect(summarize({ keystore: 'unavailable' }).tone).toBe('negative');
    expect(summarize({ keystore: 'locked' }).subtitle).toBe('Locked');
  });

  it('ranks a quarantined change above every relay problem', () => {
    // The ordering that matters most in this file. A relay outage delays data; a quarantined
    // change is data that arrived and could not be applied, and only that one needs a person.
    const summary = summarize({ quarantined: 1, relay: relay('unreachable') });
    expect(summary.subtitle).toBe('1 change needs attention');
    expect(summary.tone).toBe('warning');
  });

  it('distinguishes the four ways a relay can be unavailable', () => {
    expect(summarize({ relay: relay('unreachable') }).subtitle).toBe('Relay unreachable');
    expect(summarize({ relay: relay('unauthorized') }).subtitle).toBe('Relay rejected this device');
    expect(summarize({ relay: relay('degraded') }).subtitle).toBe('Relay errors');
    expect(summarize({ relay: relay('disabled') }).subtitle).toBe('Direct only · 2 devices');
  });

  it('says a relay outage still leaves direct sync working', () => {
    // The whole reason this row is worth building: "unreachable" must not read as "broken".
    expect(summarize({ relay: relay('unreachable') }).body).toContain('still sync directly');
  });

  it('blames the network rather than the relay when this device is offline', () => {
    // Only ever reachable through a live check — the cached verdict deliberately never
    // persists `offline`, so this is the argument path, not the stored one.
    const summary = summarize({}, relay('offline'));
    expect(summary.subtitle).toBe('You’re offline');
    expect(summary.tone).toBe('neutral');
  });

  it('treats an unchecked relay as nothing to report', () => {
    // The state every launch begins in. Reporting it would make the row alarming for the
    // first second of every session.
    expect(summarize({ relay: relay('unknown') }).headline).toBe('Up to date');
  });

  it('reports a solitary vault only once nothing else is wrong', () => {
    expect(summarize({ peers: [] }).subtitle).toBe('No other devices yet');
    expect(summarize({ peers: [], relay: relay('unreachable') }).subtitle).toBe('Relay unreachable');
  });

  it('does not count a revoked device as a device', () => {
    const revoked = peer({
      deviceId: 'peer-2',
      revokedAt: '2026-07-20T00:00:00.000Z',
      revokedSeq: 0,
    });
    expect(summarize({ peers: [peer(), revoked] }).subtitle).toBe('2 devices · 5 minutes ago');
    expect(livePeers([peer(), revoked])).toHaveLength(1);
  });

  it('omits a last-synced time it does not have', () => {
    const summary = summarize({ lastSyncedAt: null });
    expect(summary.subtitle).toBe('2 devices');
    expect(summary.headline).toBe('Up to date');
  });

  it('offers to pair when sync is on but no vault was ever created', () => {
    expect(summarize({ deviceId: '', peers: [] }).subtitle).toBe('Not set up');
  });
});

describe('describeRelay', () => {
  it('gives every state an icon as well as a tone', () => {
    // AGENTS.md: never colour alone. A pill with a tone and no icon is unreadable to anyone
    // who cannot separate the hues, so the absence of an icon is a real defect, not a nit.
    const states: RelayStatus[] = [
      'unknown',
      'disabled',
      'offline',
      'reachable',
      'unreachable',
      'unauthorized',
      'degraded',
    ];
    for (const state of states) {
      const described = describeRelay(relay(state));
      expect(described.icon).not.toBe('');
      expect(described.label).not.toBe('');
    }
  });

  it('separates "the relay refused us" from "we could not reach it"', () => {
    // Different fixes: one is the address, the other is the server. A single "relay error"
    // would send a self-hoster to look in the wrong place.
    expect(describeRelay(relay('unauthorized')).label).not.toBe(
      describeRelay(relay('unreachable')).label,
    );
  });
});

describe('describePeer', () => {
  it('separates a quiet device from one that never arrived', () => {
    // Different problems with different fixes: a device that has connected and gone quiet is
    // a scheduling question, and one that never has is a pairing that did not finish.
    expect(describePeer(peer(), NOW).subtitle).toBe('Last seen 2 minutes ago');
    expect(describePeer(peer({ lastSeenAt: null }), NOW).subtitle).toBe('Never connected');
  });

  it('says a revoked device is gone rather than merely quiet', () => {
    const described = describePeer(
      peer({ revokedAt: '2026-07-20T00:00:00.000Z', revokedSeq: 0 }),
      NOW,
    );
    expect(described.subtitle).toBe('Removed from this vault');
  });

  it('gives an unrecognised platform a device glyph rather than a question mark', () => {
    // The row identifies a device the user personally paired. Admitting ignorance about its
    // shape tells them nothing they can act on.
    expect(deviceIcon('ios')).toBe('iphone');
    expect(deviceIcon('web')).toBe('globe');
    expect(deviceIcon('freebsd')).toBe('desktopcomputer');
    expect(deviceIcon('')).not.toBe('questionmark.circle');
  });
});

describe('describeActivity', () => {
  const event = (over: Partial<SyncActivityRow> = {}): SyncActivityRow => ({
    key: '1',
    kind: 'sent',
    peerId: 'peer-1',
    count: 3,
    code: '',
    detail: '',
    recordedAt: '2026-07-29T11:55:00.000Z',
    ...over,
  });

  it('describes every kind the engine can write', () => {
    // The engine's `ActivityKind` union is the contract. A kind added there and forgotten here
    // renders as "Sync event" — technically fine, and exactly the sort of quiet degradation
    // that survives a release.
    for (const kind of ACTIVITY_KINDS) {
      const described = describeActivity(event({ kind }));
      expect(described.title).not.toBe('Sync event');
      expect(described.icon).not.toBe('');
    }
  });

  it('falls back rather than throwing on a row a newer build wrote', () => {
    // The log is append-only and survives a downgrade, so an unknown kind is a row this
    // version must still be able to render.
    expect(describeActivity(event({ kind: 'teleported' })).title).toBe('Sync event');
  });

  it('carries the count inside the sentence', () => {
    expect(describeActivity(event({ kind: 'received', count: 1 })).title).toBe('Received 1 change');
    expect(describeActivity(event({ kind: 'received', count: 9 })).title).toBe('Received 9 changes');
  });

  it('marks a refusal as negative and a hold-back as something to look at', () => {
    expect(describeActivity(event({ kind: 'rejected' })).tone).toBe('negative');
    expect(describeActivity(event({ kind: 'quarantined' })).tone).toBe('warning');
  });
});
