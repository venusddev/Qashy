/**
 * What sync's state *says*, separated from what it looks like.
 *
 * Two screens ask almost the same question and need different amounts of answer: the More
 * screen has one subtitle line to work with, and the sync screen has a hero. Deriving both
 * here — from one input, in one ordering — is what stops them disagreeing, which is the
 * failure the user notices immediately ("More says it's fine, Sync says the relay is down").
 *
 * Pure, and deliberately so. This is the file that decides whether a state is worth alarming
 * someone about, and that judgement deserves a test that can enumerate every state rather than
 * a screenshot of three of them.
 *
 * **The ordering below is the design.** Every rule is "the most actionable true thing first",
 * and the two that are easy to get backwards:
 *
 * - **Quarantine outranks any relay problem.** A relay that is down delays data; a quarantined
 *   change means data arrived and could not be applied. The second is the one that needs a
 *   person.
 * - **A relay problem outranks having no peers.** A vault with one device still wants to know
 *   the relay is unreachable, because that is the thing that will make the *next* device fail
 *   to catch up — and finding that out while pairing is much worse than finding it out now.
 *
 * Nothing here reads a finance record, and nothing here may start doing so. These strings end
 * up on a settings row and in screenshots.
 */

import type { StatusTone } from '@/components/ui/status-pill';
import type { SyncActivityRow } from '@/data/sync-tables';
import type { Peer } from '@/sync/engine';
import type { SyncStatus } from '@/sync/setup';
import type { RelayHealth } from '@/sync/transport/relay-health';
import { relativeTime } from '@/utils/relative-time';

export interface SyncSummary {
  readonly tone: StatusTone;
  /** An SF Symbol name. Every one used here is in `IONICON_BY_SF_NAME`. */
  readonly icon: string;
  /** The More-screen subtitle. One assembled string — never split across JSX children. */
  readonly subtitle: string;
  /** The sync-screen hero headline. */
  readonly headline: string;
  /** The hero body. Always says what still works, not only what does not. */
  readonly body: string;
}

export interface RelayDescription {
  readonly label: string;
  readonly tone: StatusTone;
  readonly icon: string;
}

/**
 * The relay's own state, for the pill beside it.
 *
 * Separate from the summary because the sync screen shows both at once, and they are answering
 * different questions: the hero says whether the user's devices agree, and this says whether
 * one specific piece of infrastructure is answering. Conflating them is what produces a screen
 * that shouts about a relay outage at someone whose two devices are on the same Wi-Fi and have
 * never needed it.
 */
export function describeRelay(health: RelayHealth): RelayDescription {
  switch (health.status) {
    case 'reachable':
      return { label: 'Reachable', tone: 'positive', icon: 'checkmark.circle' };
    case 'unreachable':
      return { label: 'Unreachable', tone: 'negative', icon: 'xmark.circle' };
    case 'unauthorized':
      return { label: 'Rejected this device', tone: 'negative', icon: 'lock' };
    case 'degraded':
      return { label: 'Having problems', tone: 'warning', icon: 'exclamationmark.triangle' };
    case 'offline':
      return { label: 'This device is offline', tone: 'neutral', icon: 'wifi.slash' };
    case 'disabled':
      return { label: 'Off', tone: 'neutral', icon: 'pause.circle' };
    default:
      return { label: 'Not checked yet', tone: 'neutral', icon: 'questionmark.circle' };
  }
}

/** Peers this vault still talks to. A revoked row stays on disk and is not one of them. */
export const livePeers = (peers: readonly Peer[]) => peers.filter((peer) => !peer.revokedAt);

const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

export interface SummaryOptions {
  readonly now: number;
  /**
   * A verdict measured since the status was read, if there is one.
   *
   * The cached verdict deliberately never persists `offline` — it describes this device's
   * moment rather than the endpoint, and replaying it later would blame the relay for a train
   * tunnel. So the only way "you're offline" reaches a screen is a live check handing it here.
   */
  readonly relay?: RelayHealth;
}

export function summarizeSync(status: SyncStatus, options: SummaryOptions): SyncSummary {
  const relay = options.relay ?? status.relay;
  const peers = livePeers(status.peers);
  // Including this one. "3 devices" means the size of the vault, which is what somebody
  // checking whether their laptop is in it wants to count.
  const devices = count(peers.length + 1, 'device');

  if (!status.enabled) {
    return {
      tone: 'neutral',
      icon: 'arrow.triangle.2.circlepath',
      subtitle: 'Off',
      headline: 'Sync is off',
      body: 'Everything stays on this device. Turn sync on to keep your own devices in step, end-to-end encrypted.',
    };
  }

  if (status.keystore === 'unavailable') {
    return {
      tone: 'negative',
      icon: 'exclamationmark.triangle',
      subtitle: 'Not available on this device',
      headline: 'This device can’t store a key safely',
      body: 'Qashy could not reach secure storage, so it has nowhere to keep the vault key. Your finance data is untouched.',
    };
  }

  if (status.keystore === 'locked') {
    return {
      tone: 'warning',
      icon: 'lock',
      subtitle: 'Locked',
      headline: 'Sync is locked',
      body: 'Enter this device’s passphrase to unlock the vault key. Nothing syncs until you do.',
    };
  }

  if (!status.deviceId) {
    return {
      tone: 'neutral',
      icon: 'arrow.triangle.2.circlepath',
      subtitle: 'Not set up',
      headline: 'Sync isn’t set up yet',
      body: 'Pair a second device to start. You compare a six-word code on both screens, and nothing is sent until you confirm it matches.',
    };
  }

  if (status.quarantined > 0) {
    return {
      tone: 'warning',
      icon: 'exclamationmark.triangle',
      // Spelled out rather than composed, because the verb inflects too and
      // `${count(n, 'change')} need attention` yields "1 change need attention". It also gives
      // the Hebrew dictionary two whole patterns to match instead of a fragment.
      subtitle:
        status.quarantined === 1
          ? '1 change needs attention'
          : `${status.quarantined} changes need attention`,
      headline: 'Some changes couldn’t be applied',
      body: 'They are kept, passed on to your other devices, and retried on every sync — so a correction from any device fixes them on its own.',
    };
  }

  const relayProblem = describeRelayProblem(relay);
  if (relayProblem) return relayProblem;

  if (relay.status === 'disabled') {
    return {
      tone: 'neutral',
      icon: 'point.3.connected.trianglepath.dotted',
      subtitle: `Direct only · ${devices}`,
      headline: 'Direct connections only',
      body: 'No relay is set, so your devices sync when both are open at the same time and on a network that lets them reach each other.',
    };
  }

  if (!peers.length) {
    return {
      tone: 'neutral',
      icon: 'arrow.triangle.2.circlepath',
      subtitle: 'No other devices yet',
      headline: 'No other devices yet',
      body: 'This is the only device in the vault. Add another and Qashy keeps them in step.',
    };
  }

  const synced = relativeTime(status.lastSyncedAt ?? '', options.now);
  return {
    tone: 'positive',
    icon: 'checkmark.circle',
    subtitle: synced ? `${devices} · ${synced}` : devices,
    headline: 'Up to date',
    body: synced
      ? `Last exchanged changes ${synced}.`
      : 'Paired and ready. Nothing has needed to move between your devices yet.',
  };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * A glyph for the kind of machine a peer is.
 *
 * Matched by substring rather than by equality, because `platform` is whatever the peer's
 * build called itself at pairing time and that string is not this device's to define. A
 * future platform this version has never heard of gets the generic computer rather than a
 * question mark — the row is identifying a device the user personally paired, so admitting
 * ignorance about its shape is noise, not information.
 */
export function deviceIcon(platform: string): string {
  const value = platform.toLowerCase();
  if (value.includes('ios') || value.includes('android') || value.includes('phone')) {
    return 'iphone';
  }
  if (value.includes('web') || value.includes('browser')) return 'globe';
  if (value.includes('mac') || value.includes('laptop')) return 'laptopcomputer';
  return 'desktopcomputer';
}

export interface PeerDescription {
  readonly icon: string;
  /** Fixed copy, assembled as one string. Translate at the call site; never split in JSX. */
  readonly subtitle: string;
  readonly tone: StatusTone;
}

/**
 * A peer's row, below its name.
 *
 * "Never connected" is called out rather than left blank, because it is the one state with a
 * different fix: a device that has connected and gone quiet is a scheduling problem, and one
 * that never has is a pairing that did not finish.
 */
export function describePeer(peer: Peer, now: number): PeerDescription {
  if (peer.revokedAt) {
    return { icon: 'lock', subtitle: 'Removed from this vault', tone: 'neutral' };
  }
  const seen = relativeTime(peer.lastSeenAt ?? '', now);
  return {
    icon: deviceIcon(peer.platform),
    subtitle: seen ? `Last seen ${seen}` : 'Never connected',
    tone: seen ? 'positive' : 'warning',
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export interface ActivityDescription {
  readonly icon: string;
  readonly tone: StatusTone;
  /** One assembled string, already carrying its count. */
  readonly title: string;
}

/**
 * One line of the activity log.
 *
 * Deliberately says nothing about *what* changed — only how much, and in which direction.
 * The log is the thing a person pastes into a help request, and a line naming a category or
 * an amount would turn a debugging aid into a leak. `detail` is rendered beside this by the
 * screen and is transport-level by construction (§ the header of `engine/activity.ts`).
 */
export function describeActivity(row: SyncActivityRow): ActivityDescription {
  switch (row.kind) {
    case 'sent':
      return { icon: 'arrow.up', tone: 'neutral', title: `Sent ${count(row.count, 'change')}` };
    case 'received':
      return {
        icon: 'arrow.down',
        tone: 'positive',
        title: `Received ${count(row.count, 'change')}`,
      };
    case 'rejected':
      return { icon: 'xmark.circle', tone: 'negative', title: 'Refused a batch' };
    case 'quarantined':
      return {
        icon: 'exclamationmark.triangle',
        tone: 'warning',
        title: `Held back ${count(row.count, 'change')}`,
      };
    case 'recovered':
      return {
        icon: 'checkmark.circle',
        tone: 'positive',
        title: `Applied ${count(row.count, 'held-back change')}`,
      };
    case 'paired':
      return { icon: 'person.2', tone: 'positive', title: 'Paired a device' };
    case 'revoked':
      return { icon: 'lock', tone: 'neutral', title: 'Removed a device' };
    case 'relay':
      return { icon: 'antenna.radiowaves.left.and.right', tone: 'warning', title: 'Relay problem' };
    case 'merged':
      return {
        icon: 'arrow.triangle.2.circlepath',
        tone: 'positive',
        title: `Merged ${count(row.count, 'duplicate')}`,
      };
    case 'compacted':
      return { icon: 'clock', tone: 'neutral', title: `Cleared ${count(row.count, 'old change')}` };
    default:
      // A row written by a newer build. The log is append-only and this device must still be
      // able to render its own history after a downgrade, so the kind is shown as data.
      return { icon: 'questionmark.circle', tone: 'neutral', title: 'Sync event' };
  }
}

/**
 * The relay states worth interrupting for, or null.
 *
 * `unknown` is not one of them: a device that has not checked yet is the state every launch
 * starts in, and reporting it as a problem would mean the row said something alarming for the
 * first second of every session.
 */
function describeRelayProblem(relay: RelayHealth): SyncSummary | null {
  switch (relay.status) {
    case 'offline':
      return {
        tone: 'neutral',
        icon: 'wifi.slash',
        subtitle: 'You’re offline',
        headline: 'You’re offline',
        body: 'Nothing is wrong with sync. Your changes are saved here and will catch up when this device is back on a network.',
      };
    case 'unauthorized':
      return {
        tone: 'negative',
        icon: 'lock',
        subtitle: 'Relay rejected this device',
        headline: 'The relay rejected this device',
        body: 'It answered but refused this vault. Check the relay address in Sync settings — a relay that was replaced or redeployed is the usual cause.',
      };
    case 'unreachable':
      return {
        tone: 'negative',
        icon: 'xmark.circle',
        subtitle: 'Relay unreachable',
        headline: 'Can’t reach the relay server',
        body: 'Devices on the same network still sync directly. Only catching up while your other device is closed needs the relay.',
      };
    case 'degraded':
      return {
        tone: 'warning',
        icon: 'exclamationmark.triangle',
        subtitle: 'Relay errors',
        headline: 'The relay is having problems',
        body: 'It answers, but uploads are failing. Devices on the same network still sync directly.',
      };
    default:
      return null;
  }
}
