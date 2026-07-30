/**
 * Where this device is willing to send bytes, and whether that place is answering.
 *
 * The user's explicit ask for this feature was "so I can understand if the relay is down",
 * and everything here follows from taking that literally. The three questions it has to
 * answer, in the order somebody asks them:
 *
 * 1. **Is it up?** — a pill with an icon and a word, plus when that verdict was measured, plus
 *    a button to measure it again now. A status with no timestamp is a status nobody can
 *    trust; a status with no way to re-check is one that makes people reload the app.
 * 2. **Does it matter?** — every failing state says what still works. A relay outage does not
 *    stop two devices on the same Wi-Fi, and a screen that implies otherwise sends the user
 *    to fix infrastructure when nothing is broken for them.
 * 3. **What do I fix?** — the raw transport error, verbatim and selectable. This is the one
 *    place in the app where an unpolished string is the right answer: whoever runs the relay
 *    needs to know whether it was DNS, TLS, a 502, or a refused write token, and a friendly
 *    paraphrase of all four is worth nothing.
 *
 * The endpoint fields are validated with the same pure functions the storage layer uses, run
 * per field before saving, so an error lands under the box that caused it rather than in one
 * combined message under the button.
 */

import { useState } from 'react';
import { Switch, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { MotionView } from '@/components/ui/motion';
import { SectionHeader } from '@/components/ui/section-header';
import { StatusPill } from '@/components/ui/status-pill';
import { TextButton } from '@/components/ui/text-button';
import { describeRelay } from '@/features/sync/sync-summary';
import { useLocalization } from '@/localization/localization';
import { useSync } from '@/providers/sync-provider';
import { setEndpoints, type SyncStatus } from '@/sync/setup';
import {
  EndpointError,
  normalizeEndpointUrl,
  normalizeTurnUrl,
  parseStunUrls,
  type EndpointPatch,
} from '@/sync/transport/endpoints';
import type { RelayHealth } from '@/sync/transport/relay-health';
import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';
import { errorMessage, showError } from '@/utils/confirm';
import { relativeTime } from '@/utils/relative-time';

/** The states where the raw transport error is worth more than the summary above it. */
const FAILING = new Set(['unreachable', 'unauthorized', 'degraded']);

export function RelayCard({
  status,
  health,
  now,
  onCheck,
  onChanged,
}: {
  readonly status: SyncStatus;
  /** The freshest verdict — a live probe if one has been taken, else the cached one. */
  readonly health: RelayHealth;
  readonly now: number;
  /**
   * Measures the relay now.
   *
   * Owned by the screen rather than by this card, because the hero above reports the same
   * verdict and the two must never disagree. A live probe is also the only way `offline` ever
   * reaches a screen — the cached verdict deliberately refuses to persist it — so the result
   * has to live somewhere both readers can see.
   */
  readonly onCheck: () => Promise<void>;
  readonly onChanged: () => Promise<void>;
}) {
  const { setup } = useSync();
  const theme = useQashyTheme();

  const [advanced, setAdvanced] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  const { endpoints } = status;
  const [relayUrl, setRelayUrl] = useState(endpoints.relayUrl);
  // Rebuilt from the parsed list rather than kept as the raw string, so what the field shows
  // is what was actually stored — an entry that failed to parse is silently dropped on read,
  // and echoing it back would make the user think it took.
  const [stunUrls, setStunUrls] = useState(() =>
    endpoints.iceServers
      .filter((server) => server.urls.startsWith('stun'))
      .map((server) => server.urls)
      .join(', '),
  );
  const turn = endpoints.iceServers.find((server) => server.urls.startsWith('turn'));
  const [turnUrl, setTurnUrl] = useState(turn?.urls ?? '');
  const [turnUsername, setTurnUsername] = useState(turn?.username ?? '');
  const [turnCredential, setTurnCredential] = useState(turn?.credential ?? '');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});

  const relay = describeRelay(health);
  const checked = relativeTime(health.checkedAt, now);

  const patch = async (change: EndpointPatch) => {
    try {
      await setEndpoints(setup, change);
      await onChanged();
    } catch (reason) {
      showError('Couldn’t save that', errorMessage(reason, 'Check the address and try again.'));
    }
  };

  const check = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await onCheck();
    } catch (reason) {
      // A failed probe is a verdict, not an error — it comes back as `unreachable` and lands in
      // the pill. Reaching here means something above the probe broke, and swallowing it would
      // leave the button looking like it did nothing at all.
      showError('Couldn’t reach the relay', errorMessage(reason, 'Try again in a moment.'));
    } finally {
      setChecking(false);
    }
  };

  /**
   * Validates each field on its own, then saves all of them together.
   *
   * Per field because `writeEndpoints` validates the whole patch and throws once, which would
   * put "that is not a STUN address" under a relay URL box. Together because a half-applied
   * endpoint change is the state that produces "it worked yesterday".
   */
  const save = async () => {
    if (saving) return;
    const next: Record<string, string | undefined> = {};
    const guard = (field: string, read: () => void) => {
      try {
        read();
      } catch (reason) {
        next[field] = reason instanceof EndpointError ? reason.message : 'That address is not valid.';
      }
    };
    guard('relayUrl', () => normalizeEndpointUrl(relayUrl));
    guard('stunUrls', () => parseStunUrls(stunUrls));
    guard('turnUrl', () => normalizeTurnUrl(turnUrl));
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    try {
      await setEndpoints(setup, {
        relayUrl,
        stunUrls,
        turnUrl,
        turnUsername,
        turnCredential,
      });
      await onChanged();
    } catch (reason) {
      showError('Couldn’t save these addresses', errorMessage(reason, 'Check them and try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SectionHeader title="Connections" />
      <Card style={{ gap: space.lg }}>
        <ToggleRow
          title="Direct connections"
          body="Devices talk to each other, encrypted end to end. On the same network this contacts no server at all."
          value={endpoints.directEnabled}
          onValueChange={(value) => void patch({ directEnabled: value })}
        />

        <View style={{ height: 1, backgroundColor: theme.border }} />

        <ToggleRow
          title="Relay server"
          body="Holds sealed changes for a device that is closed. It can never read them."
          value={endpoints.relayEnabled}
          onValueChange={(value) => void patch({ relayEnabled: value })}
        />

        {/* The answer to "is it down". Deliberately below the switch it describes, so the
            reading order is "relay: on, and it is unreachable" rather than the reverse. */}
        <View
          accessibilityLiveRegion="polite"
          style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.sm }}>
          <StatusPill label={relay.label} icon={relay.icon} tone={relay.tone} />
          {/* One assembled string, not two children: `AppText` translates whole strings, and a
              split "Checked" + time would leave the dictionary with a bare fragment to match. */}
          {checked ? <AppText variant="caption" muted>{`Checked ${checked}`}</AppText> : null}
          <View style={{ flex: 1 }} />
          <TextButton
            title={checking ? 'Checking…' : 'Check now'}
            icon="arrow.clockwise"
            disabled={checking || !endpoints.relayUrl}
            onPress={() => void check()}
          />
        </View>

        {!endpoints.relayUrl ? (
          <AppText variant="caption" muted>
            No relay address is set, so this device only syncs when another one is open at the same time.
          </AppText>
        ) : null}

        {FAILING.has(health.status) && health.detail ? (
          <MotionView key={health.detail} variant="up" exit animateLayout>
            <View style={{ backgroundColor: theme.surfaceMuted, borderRadius: radius.tile, borderCurve: 'continuous', padding: space.md, gap: space.xs }}>
              <AppText variant="caption" muted>What the server said</AppText>
              {/* Verbatim and selectable. Whoever runs this relay needs the actual error. */}
              <AppText literal selectable variant="caption">{health.detail}</AppText>
            </View>
          </MotionView>
        ) : null}

        <TextButton
          title={advanced ? 'Hide addresses' : 'Change addresses'}
          icon={advanced ? 'chevron.down' : 'chevron.right'}
          tone="muted"
          accessibilityState={{ expanded: advanced }}
          style={{ alignSelf: 'flex-start' }}
          onPress={() => setAdvanced((open) => !open)}
        />

        {advanced ? (
          <MotionView variant="up" exit animateLayout style={{ gap: space.lg }}>
            <FormField
              label="Relay address"
              value={relayUrl}
              onChangeText={setRelayUrl}
              autoCapitalize="none"
              autoCorrect={false}
              inputMode="url"
              placeholder="https://sync.example.com"
              error={errors.relayUrl}
              hint="Leave this blank to contact nothing but devices on your own network."
            />
            <FormField
              label="STUN servers"
              value={stunUrls}
              onChangeText={setStunUrls}
              autoCapitalize="none"
              autoCorrect={false}
              error={errors.stunUrls}
              hint="Used only when a direct connection fails. A STUN server learns an IP address and never sees your data."
            />
            <FormField
              label="TURN server"
              value={turnUrl}
              onChangeText={setTurnUrl}
              autoCapitalize="none"
              autoCorrect={false}
              error={errors.turnUrl}
              // The strongest warning on this screen, and it is not optional. TURN relays the
              // media path itself, so it sees both devices' addresses and every byte's timing.
              // Qashy ships none by design; one you add is one you must already trust.
              hint="Only add one you run yourself. A TURN server sees both devices’ addresses and how much data moves between them."
            />
            {turnUrl ? (
              <>
                <FormField label="TURN username" value={turnUsername} onChangeText={setTurnUsername} autoCapitalize="none" autoCorrect={false} />
                <FormField label="TURN password" value={turnCredential} onChangeText={setTurnCredential} autoCapitalize="none" autoCorrect={false} secureTextEntry />
              </>
            ) : null}
            <TextButton
              title={saving ? 'Saving…' : 'Save addresses'}
              icon="checkmark"
              disabled={saving}
              style={{ alignSelf: 'flex-start' }}
              onPress={() => void save()}
            />
          </MotionView>
        ) : null}
      </Card>
    </>
  );
}

/** A switch with its own explanation, because neither of these two is self-evident. */
function ToggleRow({
  title,
  body,
  value,
  onValueChange,
}: {
  readonly title: string;
  readonly body: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.lg }}>
      <View style={{ flex: 1, gap: space.xxs }}>
        <AppText variant="label">{title}</AppText>
        <AppText variant="caption" muted>{body}</AppText>
      </View>
      <Switch
        accessibilityLabel={t(title)}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: theme.accent }}
      />
    </View>
  );
}
