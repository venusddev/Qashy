/**
 * Every sentence sync can put on a screen has a Hebrew translation.
 *
 * This does not assert the wording — `localization.test.ts` and `sync-summary.test.ts` cover
 * what the strings say. What it pins is *coverage*, which is the failure mode this layer
 * actually has: `translateMessage` falls through to the English original when a key is
 * missing, so a forgotten entry ships silently and looks like working software in every
 * English test run. A Hebrew user sees one line of English in the middle of a paragraph.
 *
 * The generated half is driven off the same functions the screens call, so a new relay
 * status, activity kind, or keystore state fails here the moment it is added rather than the
 * moment somebody switches the app to Hebrew. The listed half is the composed strings the
 * screens build inline; those cannot be enumerated from code, so they are written out, and
 * `assembled` doubles as the record of which shapes `translateDynamic` must keep matching.
 */

import type { SyncActivityRow } from '@/data/sync-tables';
import { translateMessage } from '@/localization/localization';
import { restorePeerKeys } from '@/sync/crypto';
import type { Peer } from '@/sync/engine';
import { ACTIVITY_KINDS } from '@/sync/engine/types';
import type { KeystoreStatus } from '@/sync/keystore/types';
import type { SyncStatus } from '@/sync/setup';
import type { RelayHealth, RelayStatus } from '@/sync/transport/relay-health';
import { relativeTime } from '@/utils/relative-time';
import {
  describeActivity,
  describePeer,
  describeRelay,
  summarizeSync,
} from '@/features/sync/sync-summary';

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const keys = restorePeerKeys(new Uint8Array(32), new Uint8Array(32));

const peer = (over: Partial<Peer> = {}): Peer => ({
  deviceId: 'peer-1',
  name: 'Laptop',
  platform: 'web',
  ...keys,
  epoch: 1,
  addedAt: '2026-07-01T00:00:00.000Z',
  revokedAt: null,
  acked: {},
  known: {},
  lastSeenAt: ago(2 * MINUTE),
  ...over,
});

const relay = (status: RelayStatus, over: Partial<RelayHealth> = {}): RelayHealth => ({
  status,
  checkedAt: ago(MINUTE),
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
  lastSyncedAt: ago(5 * MINUTE),
  ...over,
});

const RELAY_STATUSES: readonly RelayStatus[] = [
  'unknown',
  'reachable',
  'unreachable',
  'unauthorized',
  'degraded',
  'offline',
  'disabled',
];

const KEYSTORE_STATUSES: readonly KeystoreStatus[] = ['empty', 'unlocked', 'locked', 'unavailable'];

/** Collects a string for checking. Empty is a legitimate output and is not a missing key. */
const collect = (into: Set<string>, ...values: readonly string[]) => {
  for (const value of values) if (value) into.add(value);
};

function generatedCopy(): Set<string> {
  const strings = new Set<string>();

  // Every branch of the hero and the More-screen subtitle. Zero, one, and several peers,
  // because the device count is the one place a plural is assembled.
  for (const keystore of KEYSTORE_STATUSES) {
    for (const relayStatus of RELAY_STATUSES) {
      for (const peers of [[], [peer()], [peer(), peer({ deviceId: 'peer-2' })]]) {
        for (const quarantined of [0, 1, 4]) {
          for (const lastSyncedAt of [null, ago(5 * MINUTE)]) {
            for (const enabled of [true, false]) {
              const summary = summarizeSync(
                status({ enabled, keystore, peers, quarantined, lastSyncedAt }),
                { now: NOW, relay: relay(relayStatus) },
              );
              collect(strings, summary.subtitle, summary.headline, summary.body);
            }
          }
        }
      }
    }
  }

  for (const relayStatus of RELAY_STATUSES) collect(strings, describeRelay(relay(relayStatus)).label);

  collect(
    strings,
    describePeer(peer(), NOW).subtitle,
    describePeer(peer({ lastSeenAt: null }), NOW).subtitle,
    describePeer(peer({ revokedAt: ago(DAY) }), NOW).subtitle,
  );

  // Including a kind this build does not know, which is the downgrade path.
  for (const kind of [...ACTIVITY_KINDS, 'invented-by-a-newer-build']) {
    for (const count of [1, 7]) {
      const row = { kind, count, recordedAt: ago(HOUR), detail: '' } as unknown as SyncActivityRow;
      collect(strings, describeActivity(row).title);
    }
  }

  // Every shape `relative-time.ts` can emit. These reach the screen through activity rows,
  // the relay's last-checked line, and per-peer last-seen.
  for (const elapsed of [0, MINUTE, 4 * MINUTE, HOUR, 5 * HOUR, DAY, 29 * DAY, 30 * DAY, 200 * DAY, 400 * DAY]) {
    collect(strings, relativeTime(ago(elapsed), NOW));
  }

  return strings;
}

/**
 * Strings the screens assemble inline, so they cannot be reached by calling anything.
 *
 * Only the *shapes* matter — one singular and one plural of each is enough to prove the
 * `translateDynamic` pattern exists and that the singular has its own entry.
 */
const assembled: readonly string[] = [
  // /sync-pair — the pairing-code countdown.
  '1 second left',
  '89 seconds left',
  // /sync-recovery — the confirmation field's hint, and the SAS grid's per-word label.
  'All 24 words, separated by spaces.',
  'Word 1: abandon',
  'Word 6: zoo',
  // /sync-merge — the post-merge summary and the commit button.
  'Merged 1 record',
  'Merged 12 records',
  '1 record now points at the copy you kept.',
  '30 records now point at the copy you kept.',
  'Merge 1 group',
  'Merge 3 groups',
  'Keep this one, remove 1 copy',
  'Keep this one, remove 4 copies',
  // /sync → Connections, and the failure a device removal can report.
  'Checked 4 minutes ago',
  'Laptop is still paired.',
];

describe('sync copy is fully localized', () => {
  it('translates every string the summary layer can produce', () => {
    const strings = generatedCopy();
    // A coverage test that stops generating anything still passes, silently. The floor is
    // well under the ~80 the sweep produces today, so it catches a collapse without
    // objecting every time a line of copy is reworded.
    expect(strings.size).toBeGreaterThan(60);

    const untranslated = [...strings].filter((value) => translateMessage(value, 'he') === value);
    expect(untranslated).toEqual([]);
  });

  it('translates every string the sync screens assemble inline', () => {
    const untranslated = assembled.filter((value) => translateMessage(value, 'he') === value);
    expect(untranslated).toEqual([]);
  });

  it('leaves the data inside an assembled string alone', () => {
    // The words are compared against another screen, so a translated wordlist would read to
    // the user as exactly the substitution attack the SAS exists to catch.
    expect(translateMessage('Word 3: abandon', 'he')).toBe('מילה 3: abandon');
    // A device name is whatever its owner typed, including Latin text in a Hebrew UI.
    expect(translateMessage('Laptop is still paired.', 'he')).toBe('Laptop עדיין מחובר.');
  });

  it('inflects the device count rather than emitting a bare number', () => {
    const one = summarizeSync(status({ peers: [], lastSyncedAt: null }), { now: NOW });
    const many = summarizeSync(status({ peers: [peer(), peer({ deviceId: 'peer-2' })] }), { now: NOW });
    expect(translateMessage(one.subtitle, 'he')).toBe('אין עדיין מכשירים אחרים');
    expect(translateMessage(many.subtitle, 'he')).toBe('3 מכשירים · לפני 5 דקות');
  });

  it('leaves English alone', () => {
    expect(translateMessage('Relay unreachable', 'en')).toBe('Relay unreachable');
  });
});
