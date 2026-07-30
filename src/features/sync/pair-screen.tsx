/**
 * The pairing wizard — the only screen in Qashy where a mistake hands someone your finances.
 *
 * Everything else in the sync stack fails closed on its own: a bad signature is rejected, a
 * broken chain is refused, a stale code will not decode. This screen is the one place where
 * the security control is *a person looking at two screens*, and the entire design is in
 * service of making that comparison happen properly.
 *
 * ## Why the confirm step looks the way it does
 *
 * The six words are a Short Authentication String derived from the handshake transcript. If
 * someone photographed the QR and raced the handshake, they hold a different transcript, so
 * their words differ — and the human catches what no amount of cryptography can, because both
 * sides genuinely completed a valid handshake with *someone*. That means:
 *
 * - **Neither button is pre-selected, and neither is the default.** "They match" and "They
 *   don't match" are equally weighted, side by side. A primary-styled "Continue" would be
 *   pressed reflexively, which is precisely the failure mode.
 * - **The peer's name is never shown before confirmation.** A name is attacker-chosen; a
 *   screen reading "Pair with Ziv's iPhone?" earns a yes the fingerprint has not.
 * - **A failed or cancelled handshake is not resumable.** The pairing secret is single use,
 *   and `PairingHost` closes itself on failure. Going back mints a brand-new code, which is
 *   the correct behaviour rather than an inconvenience to work around.
 *
 * ## Why the async work lives in press handlers, never in effects
 *
 * `handshake()` blocks until the other device arrives, then resolves with words to show. Kicked
 * off from an effect it would be a bare `await` before a `setState`, which the React lint rules
 * reject and which would also make the "start over" path race its own cleanup. Started from a
 * press, the lifecycle is explicit: one live session at a time, held in a ref, closed on
 * unmount and before any new one is created.
 *
 * ## The one irreversible step
 *
 * `confirm()` on the host seals and sends the vault key. `adoptVault` on the joiner overwrites
 * whatever vault that device held. Both are gated on the SAS, and the join role is hidden
 * outright on a device that is already in a vault — otherwise "add this device" would silently
 * abandon the vault it was already part of, taking its peers with it.
 */

import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';

import { QrCode } from '@/components/sync/qr-code';
import { QrScanner } from '@/components/sync/qr-scanner';
import { SasDisplay } from '@/components/sync/sas-display';
import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { MotionPressable, MotionView } from '@/components/ui/motion';
import { StatusPill } from '@/components/ui/status-pill';
import { TextButton } from '@/components/ui/text-button';
import { useLocalization } from '@/localization/localization';
import { useSync } from '@/providers/sync-provider';
import {
  createDeviceIdentity,
  decodePairingCode,
  formatPairingCodeForTyping,
  normalizeTypedPairingCode,
} from '@/sync/crypto';
import { PairingHost, PairingJoiner } from '@/sync/pairing';
import {
  adoptVault,
  enableSync,
  readSyncStatus,
  recordPairedPeer,
  type DeviceProfile,
  type SyncStatus,
} from '@/sync/setup';
import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';
import { errorMessage } from '@/utils/confirm';
import { nowIso } from '@/utils/entity';

type Role = 'host' | 'join';
type Stage = 'role' | 'code' | 'confirm' | 'done';

const STAGES: readonly Stage[] = ['role', 'code', 'confirm', 'done'];

/** `HostPairingDeps.now` is unix **seconds**, unlike everything else in the app. */
const unixSeconds = () => Math.floor(Date.now() / 1000);

/** A first guess at a device name, so nobody has to invent one to get past the first screen. */
function defaultDeviceName() {
  switch (Platform.OS) {
    case 'ios':
      return 'My iPhone';
    case 'android':
      return 'My Android';
    default:
      return 'My browser';
  }
}

/** Whatever is currently in flight, so it can be closed exactly once. */
interface Session {
  readonly close: () => void;
  readonly abort: AbortController;
}

export function PairScreen() {
  const { status, setup, refresh } = useSync();
  const theme = useQashyTheme();

  const [stage, setStage] = useState<Stage>('role');
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [role, setRole] = useState<Role>('host');
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState<{ value: string; expiresAt: number } | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [sas, setSas] = useState<readonly string[] | null>(null);
  const [outcome, setOutcome] = useState<{ headline: string; body: string } | null>(null);

  const session = useRef<Session | null>(null);
  // Held apart from `sas` because the confirmation closure differs by role while the words
  // do not, and the render only ever needs the words.
  const accept = useRef<(() => Promise<void>) | null>(null);

  /** Ends whatever is in flight. Safe to call repeatedly; that is the point of clearing it. */
  const closeSession = () => {
    session.current?.abort.abort();
    session.current?.close();
    session.current = null;
    accept.current = null;
  };

  // Unmount is a cancellation like any other: a socket left open on a rendezvous the user
  // navigated away from would keep a pairing window alive with nobody watching the words.
  useEffect(() => closeSession, []);

  // Only while a code is on screen, and only to redraw the countdown. The pairing code is the
  // one thing in the sync stack with a wall-clock deadline the user has to act inside.
  useEffect(() => {
    if (stage !== 'code' || !code) return;
    const tick = () => setRemaining(Math.max(0, code.expiresAt - unixSeconds()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [stage, code]);

  const move = (next: Stage) => {
    setDirection(STAGES.indexOf(next) >= STAGES.indexOf(stage) ? 'forward' : 'back');
    setStage(next);
    setError(null);
  };

  const restart = () => {
    closeSession();
    setCode(null);
    setSas(null);
    move('role');
  };

  const profile = (): DeviceProfile => ({
    name: deviceName.trim() || defaultDeviceName(),
    platform: Platform.OS,
  });

  // -------------------------------------------------------------------------
  // Host — this device already has the data
  // -------------------------------------------------------------------------

  const startHosting = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // A device that has never synced becomes a vault first. This is the only place a
      // `VaultRootKey` is ever minted, and doing it here rather than on the sync screen means
      // a key only exists once somebody has actually started adding a second device.
      if (!status?.deviceId) await enableSync(setup, profile());
      const vault = await setup.keystore.read();
      if (!vault) throw new Error('This device’s vault key could not be read.');
      // Read straight from storage rather than trusting `status`: `enableSync` has usually just
      // rewritten `sync_meta`, and the `status` in this closure is from the render that queued
      // this press. Hosting off a stale roster would omit a peer from the set the joiner is
      // handed, leaving that peer unable to verify anything the new device signs.
      const current = await readSyncStatus(setup);

      const host = new PairingHost({
        identity: vault.identity,
        vaultKey: vault.vaultKey,
        epoch: vault.epoch,
        baseCurrency: current.baseCurrency,
        self: profile(),
        roster: current.peers,
        relayUrl: current.endpoints.relayUrl,
        now: unixSeconds,
        nowIso,
      });

      const abort = new AbortController();
      closeSession();
      session.current = { close: () => host.close(), abort };
      setCode({ value: host.code, expiresAt: host.expiresAt });
      move('code');

      // Deliberately not awaited: the code has to be readable *while* this waits for the other
      // device to show up. Failures land in `error` on the code step, where the user is.
      host
        .handshake(abort.signal)
        .then((confirmation) => {
          accept.current = async () => {
            const { peer } = await confirmation.confirm();
            await recordPairedPeer(setup, peer);
            await refresh();
            setOutcome({
              headline: 'Device added',
              body: 'Both devices now hold the same vault key. Changes flow in both directions from here.',
            });
          };
          session.current = { close: () => confirmation.cancel(), abort };
          setSas(confirmation.sas);
          move('confirm');
        })
        .catch((reason: unknown) => {
          if (abort.signal.aborted) return;
          setError(errorMessage(reason, 'The other device did not complete pairing.'));
        });
    } catch (reason) {
      setError(errorMessage(reason, 'Sync could not be set up on this device.'));
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Joiner — this device is being added
  // -------------------------------------------------------------------------

  const startJoining = async (scanned: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Decoded before a socket is opened. A stale or malformed code is a local error with a
      // local fix, and reporting it as "the other device didn't answer" would send someone
      // debugging a network that is fine.
      const decoded = decodePairingCode(normalizeTypedPairingCode(scanned), unixSeconds());
      const identity = createDeviceIdentity();
      // The joiner never needs a configured relay: `PairingCode` carries the host's address, so
      // a brand-new device with blank endpoints can still be added, and it inherits the host's
      // relay along with the vault.
      const current = await readSyncStatus(setup);

      const joiner = new PairingJoiner({
        identity,
        code: decoded,
        baseCurrency: current.baseCurrency,
        self: profile(),
        nowIso,
      });

      const abort = new AbortController();
      closeSession();
      session.current = { close: () => joiner.close(), abort };

      const confirmation = await joiner.handshake(abort.signal);
      accept.current = async () => {
        const joined = await confirmation.confirm();
        // The identity handed to `adoptVault` must be the one that earned the handshake — the
        // host has already written these exact public keys into its roster, and a fresh
        // identity here would be a device neither side can verify.
        await adoptVault(setup, {
          identity,
          vaultKey: joined.vaultKey,
          epoch: joined.epoch,
          baseCurrency: joined.baseCurrency,
          peers: joined.peers,
          profile: profile(),
        });
        await refresh();
        setOutcome({
          headline: 'This device joined the vault',
          body: 'Your data from both devices is being combined. Anything you created on both will show up twice until you review it.',
        });
      };
      session.current = { close: () => confirmation.cancel(), abort };
      setSas(confirmation.sas);
      move('confirm');
    } catch (reason) {
      setError(errorMessage(reason, 'That code could not be used. Show a fresh one and try again.'));
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // The confirmation itself
  // -------------------------------------------------------------------------

  const confirmMatch = async () => {
    if (busy || !accept.current) return;
    setBusy(true);
    setError(null);
    try {
      await accept.current();
      session.current = null;
      accept.current = null;
      move('done');
    } catch (reason) {
      setError(errorMessage(reason, 'Pairing could not be completed.'));
    } finally {
      setBusy(false);
    }
  };

  const rejectMatch = () => {
    closeSession();
    setSas(null);
    setCode(null);
    setError(
      'Pairing was stopped and nothing was sent. Different words on the two screens can mean someone else tried to join — start again, and keep the code on screen only while the other device is scanning it.',
    );
    move('role');
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!status) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={container}>
        <AppText muted>Reading this device’s sync state…</AppText>
      </ScrollView>
    );
  }

  const blocked = blockingReason(status);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={container}>
      <View style={{ flexDirection: 'row', gap: space.sm, justifyContent: 'center' }}>
        {STAGES.map((item) => (
          <View
            key={item}
            style={{
              width: item === stage ? 26 : 8,
              height: 8,
              borderRadius: radius.pill,
              backgroundColor: item === stage ? theme.accent : theme.border,
            }}
          />
        ))}
      </View>

      {error ? (
        <MotionView variant="up" exit animateLayout>
          <Card style={{ gap: space.xs, borderColor: theme.negative }}>
            <AppText accessibilityRole="alert" variant="label" style={{ color: theme.negative }}>
              Pairing stopped
            </AppText>
            {/* `literal`: these sentences come from a caught error, so they are already the
                final copy and there is nothing in the dictionary to match them against. */}
            <AppText literal variant="caption" muted>{error}</AppText>
          </Card>
        </MotionView>
      ) : null}

      {blocked ? (
        <Card style={{ gap: space.md }}>
          <AppText variant="headline">{blocked.title}</AppText>
          <AppText muted>{blocked.body}</AppText>
          <TextButton title="Open sync settings" icon="gear" onPress={() => router.replace('/sync')} />
        </Card>
      ) : (
        <MotionView
          key={`${stage}-${direction}`}
          variant={direction === 'forward' ? 'right' : 'left'}
          exit
          animateLayout
          style={{ gap: space.lg }}>
          {stage === 'role' ? (
            <RoleStep
              role={role}
              onRole={setRole}
              canJoin={!status.deviceId}
              canHost={Boolean(status.endpoints.relayUrl)}
              deviceName={deviceName}
              onDeviceName={setDeviceName}
              busy={busy}
              onContinue={() => {
                if (role === 'host') void startHosting();
                else move('code');
              }}
            />
          ) : null}

          {stage === 'code' && role === 'host' ? (
            <HostCodeStep code={code} remaining={remaining} onRestart={restart} />
          ) : null}

          {stage === 'code' && role === 'join' ? (
            <>
              <AppText variant="title">Scan the other device</AppText>
              <AppText muted>
                Open Sync → Add device on the device that already has your data, and point this
                one at the code it shows.
              </AppText>
              <QrScanner
                onCode={(value) => void startJoining(value)}
                hint="The code works once and expires after a minute and a half."
              />
              <TextButton title="Back" tone="muted" onPress={() => move('role')} />
            </>
          ) : null}

          {stage === 'confirm' && sas ? (
            <ConfirmStep sas={sas} busy={busy} onMatch={() => void confirmMatch()} onReject={rejectMatch} />
          ) : null}

          {stage === 'done' ? <DoneStep outcome={outcome} /> : null}
        </MotionView>
      )}
    </ScrollView>
  );
}

const container = {
  padding: 18,
  paddingBottom: 40,
  gap: space.lg,
  width: '100%',
  maxWidth: 720,
  alignSelf: 'center',
} as const;

/**
 * The states in which pairing cannot start at all, with the fix.
 *
 * Checked before the wizard rather than at the point of failure, because both of these would
 * otherwise surface as a socket that never connects — which reads as "the other device is
 * broken" and sends the user to fix the wrong thing.
 *
 * A missing relay address is deliberately *not* here. It blocks hosting, because the handshake
 * runs over the rendezvous, but a joining device needs no configuration at all: the pairing
 * code carries the host's address. Blocking the whole screen on it would make a blank-endpoint
 * device unable to be added to a vault that is perfectly well configured.
 */
function blockingReason(status: SyncStatus) {
  if (status.keystore === 'unavailable') {
    return {
      title: 'This device can’t store a key safely',
      body: 'Qashy could not reach secure storage, so it has nowhere to keep the vault key. Pairing is disabled here. Your finance data is untouched.',
    };
  }
  if (status.keystore === 'locked') {
    return {
      title: 'Unlock this device first',
      body: 'The vault key on this device is behind a passphrase. Unlock it from the sync screen, then come back.',
    };
  }
  return null;
}

function RoleStep({
  role,
  onRole,
  canJoin,
  canHost,
  deviceName,
  onDeviceName,
  busy,
  onContinue,
}: {
  readonly role: Role;
  readonly onRole: (role: Role) => void;
  readonly canJoin: boolean;
  readonly canHost: boolean;
  readonly deviceName: string;
  readonly onDeviceName: (name: string) => void;
  readonly busy: boolean;
  readonly onContinue: () => void;
}) {
  const theme = useQashyTheme();
  const blockedHost = role === 'host' && !canHost;

  return (
    <>
      <AppText variant="title">Add a device</AppText>
      <AppText muted>
        Both devices end up holding the same key, and only those two can read anything. Start on
        whichever one has the data you want to keep.
      </AppText>

      <View style={{ gap: space.sm }}>
        <RoleOption
          icon="iphone"
          title="This device has my data"
          body={
            canHost
              ? 'Shows a code for the other device to scan.'
              : 'Needs a relay address first — the two devices have nowhere to meet without one.'
          }
          selected={role === 'host'}
          onPress={() => onRole('host')}
        />
        <RoleOption
          icon="qrcode.viewfinder"
          title="Add this device to a vault"
          body={
            canJoin
              ? 'Scans a code shown by a device that is already set up.'
              : 'Not available — this device is already part of a vault. Removing it from the other device is the way out.'
          }
          selected={role === 'join'}
          disabled={!canJoin}
          onPress={() => onRole('join')}
        />
      </View>

      <FormField
        label="Name this device"
        value={deviceName}
        onChangeText={onDeviceName}
        autoCapitalize="words"
        returnKeyType="done"
        hint="Only your paired devices ever see this. It is sent encrypted, and the relay never learns it."
      />

      {blockedHost ? (
        <Card style={{ gap: space.sm, borderColor: theme.warning }}>
          <AppText variant="label">Set a relay address first</AppText>
          <AppText variant="caption" muted>
            Showing a code needs somewhere the two devices can agree to meet. The relay never sees
            your data — it forwards sealed bytes between devices that already hold each other’s
            keys. Add its address under Connections in Sync settings.
          </AppText>
          <TextButton title="Open sync settings" icon="gear" onPress={() => router.replace('/sync')} />
        </Card>
      ) : null}

      <ActionButton
        title={busy ? 'Preparing…' : 'Continue'}
        icon="arrow.right"
        busy={busy}
        disabled={busy || blockedHost}
        onPress={onContinue}
      />
    </>
  );
}

function RoleOption({
  icon,
  title,
  body,
  selected,
  disabled = false,
  onPress,
}: {
  readonly icon: string;
  readonly title: string;
  readonly body: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  // A pressable rather than a `Card` with a touch handler: the choice needs press feedback and
  // a real `radio` role, and a `View` that happens to react to `onTouchEnd` gives neither — nor
  // does it respond to a keyboard, which is how this screen is used on the desktop PWA.
  return (
    <MotionPressable
      accessibilityRole="radio"
      accessibilityLabel={`${t(title)}. ${t(body)}`}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        gap: space.xs,
        padding: space.lg,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        borderWidth: 1,
        opacity: disabled ? 0.5 : 1,
        borderColor: selected && !disabled ? theme.accent : theme.border,
        backgroundColor: selected && !disabled ? theme.accentContainer : theme.surface,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <AppIcon name={icon} color={selected && !disabled ? theme.onAccentContainer : theme.textMuted} size={18} />
        <AppText variant="label">{title}</AppText>
      </View>
      <AppText variant="caption" muted>{body}</AppText>
    </MotionPressable>
  );
}

function HostCodeStep({
  code,
  remaining,
  onRestart,
}: {
  readonly code: { value: string; expiresAt: number } | null;
  readonly remaining: number;
  readonly onRestart: () => void;
}) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const [showTyped, setShowTyped] = useState(false);
  const expired = remaining <= 0;

  if (!code) return <AppText muted>Preparing a code…</AppText>;

  return (
    <>
      <AppText variant="title">Scan this on the other device</AppText>
      <AppText muted>
        Open Qashy there, go to More → Sync → Add device, and choose “Add this device to a vault”.
      </AppText>

      <Card style={{ alignItems: 'center', gap: space.md }}>
        {expired ? (
          <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xl }}>
            <AppIcon name="clock" color={theme.textMuted} size={28} />
            <AppText muted style={{ textAlign: 'center' }}>
              This code has expired. Codes are single use and short-lived on purpose.
            </AppText>
            <ActionButton title="Show a new code" icon="arrow.triangle.2.circlepath" onPress={onRestart} />
          </View>
        ) : (
          <>
            <QrCode value={code.value} label={t('Pairing code for the other device to scan')} />
            {/* Counted down rather than shown as a deadline: "44 seconds left" is actionable
                where a timestamp is arithmetic somebody has to do while holding two phones. */}
            <StatusPill
              literal
              label={t(`${remaining} seconds left`)}
              icon="clock"
              tone={remaining < 20 ? 'warning' : 'neutral'}
            />
          </>
        )}
      </Card>

      {!expired ? (
        <>
          <TextButton
            title={showTyped ? 'Hide the typed code' : 'Can’t scan?'}
            icon={showTyped ? 'eye.slash' : 'keyboard'}
            tone="muted"
            accessibilityState={{ expanded: showTyped }}
            onPress={() => setShowTyped((open) => !open)}
          />
          {showTyped ? (
            <MotionView variant="up" exit animateLayout style={{ gap: space.sm }}>
              <Card style={{ gap: space.sm }}>
                {/* Selectable, and that is the only concession made here. The code carries the
                    pairing secret, so there is no copy button and it is never persisted or
                    logged — a selection the user makes and pastes once is the shortest life
                    this string can have while still being usable on a desktop. */}
                <AppText literal selectable variant="caption" style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
                  {formatPairingCodeForTyping(code.value)}
                </AppText>
              </Card>
              <AppText variant="caption" muted>
                Type or paste this into the other device instead of scanning. Treat it like the
                code itself — it works once, and only for the next minute or so.
              </AppText>
            </MotionView>
          ) : null}
        </>
      ) : null}

      <AppText variant="caption" muted>
        Waiting for the other device. The next screen shows six words that must be identical on
        both — that comparison is what makes a photographed code useless.
      </AppText>
      <TextButton title="Start over" tone="muted" onPress={onRestart} />
    </>
  );
}

function ConfirmStep({
  sas,
  busy,
  onMatch,
  onReject,
}: {
  readonly sas: readonly string[];
  readonly busy: boolean;
  readonly onMatch: () => void;
  readonly onReject: () => void;
}) {
  return (
    <>
      <AppText variant="title">Do these words match?</AppText>
      <AppText muted>
        The other device is showing six words too. Compare them now, in the same order. If even
        one differs, stop — someone else may be trying to join.
      </AppText>

      <SasDisplay words={sas} />

      {/* Equal weight, deliberately. The dangerous answer is "yes" given reflexively, so "yes"
          gets no visual advantage over "no" and neither is the default focus target. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        <ActionButton
          title={busy ? 'Pairing…' : 'They match'}
          icon="checkmark"
          busy={busy}
          disabled={busy}
          onPress={onMatch}
          style={{ flex: 1, minWidth: 160 }}
        />
        <ActionButton
          title="They don’t match"
          icon="xmark"
          variant="danger"
          disabled={busy}
          onPress={onReject}
          style={{ flex: 1, minWidth: 160 }}
        />
      </View>

      <AppText variant="caption" muted>
        Nothing has been sent yet. Your vault key only leaves this device after you confirm.
      </AppText>
    </>
  );
}

function DoneStep({ outcome }: { readonly outcome: { headline: string; body: string } | null }) {
  const theme = useQashyTheme();
  return (
    <>
      <View style={{ alignItems: 'center', gap: space.md, paddingVertical: space.lg }}>
        <View style={{ width: 56, height: 56, borderRadius: radius.card, borderCurve: 'continuous', backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}>
          <AppIcon name="checkmark" color={theme.onAccentContainer} size={24} />
        </View>
        <AppText variant="title" style={{ textAlign: 'center' }}>
          {outcome?.headline ?? 'Paired'}
        </AppText>
        <AppText muted style={{ textAlign: 'center', maxWidth: 420 }}>
          {outcome?.body ?? 'Both devices now hold the same vault key.'}
        </AppText>
      </View>

      <Card style={{ gap: space.sm }}>
        <AppText variant="label">If both devices already had data</AppText>
        <AppText variant="caption" muted>
          Anything you created on both is now in the vault twice. Qashy renamed the collisions
          rather than guessing which are the same — the review screen is where you decide.
        </AppText>
      </Card>

      <ActionButton title="Review duplicates" icon="arrow.triangle.2.circlepath" onPress={() => router.replace('/sync-merge')} />
      <TextButton title="Done" tone="muted" onPress={() => router.replace('/sync')} />
    </>
  );
}
