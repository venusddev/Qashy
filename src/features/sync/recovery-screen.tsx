/**
 * The twenty-four words.
 *
 * This screen shows the single most dangerous string in the app. Not "a password" and not "a
 * backup code" — the phrase *is* the vault root key in a transcribable form, and anybody who
 * reads it off a screen has everything. So the screen is built around one rule: **make it
 * hard to reveal by accident and impossible to leak by convenience.**
 *
 * What that rules out, deliberately:
 *
 * - **No copy button.** `AGENTS.md` is explicit that key material never reaches the clipboard,
 *   and the clipboard is shared with every app on the device, synced across machines on some
 *   platforms, and read by any web page on paste. A screenshot is bad; a clipboard entry is
 *   worse and lasts longer. The words are `selectable={false}` for the same reason.
 * - **No auto-reveal.** Opening this route shows nothing. Revealing takes a second, explicit
 *   confirmation that names the risk, so it cannot happen because someone mis-tapped a row.
 * - **No persistence of the revealed value.** The phrase exists only in this component's state
 *   and is dropped when hidden or when the screen unmounts. JS cannot guarantee the bytes are
 *   gone — a string is immutable and the engine may keep copies — so this is best effort, and
 *   saying so honestly is better than implying a wipe that did not happen.
 *
 * The verification field is not ceremony. A phrase transcribed with one word wrong is worth
 * nothing, and BIP39's checksum is precisely what turns "you made a typo" into something the
 * app can say out loud years before it would otherwise be discovered.
 */

import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { SasDisplay } from '@/components/sync/sas-display';
import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { MotionView } from '@/components/ui/motion';
import { SectionHeader } from '@/components/ui/section-header';
import { StatusPill } from '@/components/ui/status-pill';
import { TextButton } from '@/components/ui/text-button';
import { useSync } from '@/providers/sync-provider';
import { RECOVERY_WORD_COUNT, vaultKeyToRecoveryPhrase } from '@/sync/crypto';
import { useQashyTheme } from '@/theme/theme';
import { space } from '@/theme/tokens';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';

/** The same normalization `recoveryPhraseToVaultKey` applies, so the check matches what a restore would. */
const normalize = (phrase: string) => phrase.trim().toLowerCase().replace(/\s+/g, ' ');

export function RecoveryScreen() {
  const { status, setup } = useSync();
  const theme = useQashyTheme();

  const [phrase, setPhrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');

  const reveal = async () => {
    if (busy) return;
    const confirmed = await confirmDestructive({
      title: 'Show the recovery phrase?',
      // Naming the two real-world leaks — a shoulder and a recording — because "keep it secret"
      // is advice nobody acts on and "nobody is standing behind you" is.
      message:
        'These words are your entire vault. Anyone who reads them can open every account, transaction, and balance you have. Check that nobody can see your screen and that you are not sharing or recording it.',
      confirmLabel: 'Show phrase',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const vault = await setup.keystore.read();
      if (!vault) {
        showError('There is no vault on this device', 'Set up sync first, then come back.');
        return;
      }
      setPhrase(vaultKeyToRecoveryPhrase(vault.vaultKey));
    } catch (reason) {
      showError('Couldn’t read the vault key', errorMessage(reason, 'Unlock this device and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const hide = () => {
    setPhrase(null);
    setTyped('');
  };

  if (!status) {
    return (
      <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={container}>
        <AppText muted>Reading this device’s sync state…</AppText>
      </ScrollView>
    );
  }

  const locked = status.keystore === 'locked';
  const missing = status.keystore === 'empty' || status.keystore === 'unavailable';
  const matches = phrase !== null && normalize(typed) === phrase;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={container}>
      <Card variant="hero" style={{ gap: space.md }}>
        <AppText variant="title">Your recovery phrase</AppText>
        <AppText muted>
          Twenty-four words that encode this vault’s key. There is no account behind Qashy and no
          way for anyone to reset this for you — these words are the only copy of the key that
          exists outside your devices.
        </AppText>
      </Card>

      {missing ? (
        <EmptyState
          icon="key"
          title="No vault on this device"
          body="A recovery phrase exists once this device is part of a vault. Set up sync first."
        />
      ) : locked ? (
        <Card style={{ gap: space.xs, borderColor: theme.negative }}>
          <AppText variant="label" style={{ color: theme.negative }}>This device’s key is locked</AppText>
          <AppText variant="caption" muted>Unlock it from the sync screen, then come back.</AppText>
        </Card>
      ) : (
        <>
          <Card style={{ gap: space.md }}>
            <Warns title="Anyone holding these words holds your data">
              Treat them exactly like the money itself. A password manager or a piece of paper somewhere
              only you can reach are both fine. A photo in your camera roll or a note that syncs to a
              cloud account are not.
            </Warns>
            <Warns title="There is no copy button, on purpose">
              The clipboard is readable by other apps and, on some systems, by your other computers.
              Write the words down or type them straight into a password manager instead.
            </Warns>
            <Warns title="Losing them is not the same as losing a password">
              Qashy cannot reset, re-issue, or recover this. If you lose every paired device and these
              words, the data on them is gone.
            </Warns>
          </Card>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
            {phrase ? (
              <TextButton title="Hide phrase" icon="eye.slash" onPress={hide} />
            ) : (
              <ActionButton
                title={busy ? 'Reading…' : 'Show phrase'}
                icon="eye"
                busy={busy}
                disabled={busy}
                onPress={() => void reveal()}
              />
            )}
          </View>

          {phrase ? (
            <MotionView variant="up" exit animateLayout style={{ gap: space.lg }}>
              <SasDisplay words={phrase.split(' ')} />

              <SectionHeader title="Check what you wrote down" />
              <Card style={{ gap: space.md }}>
                <AppText variant="caption" muted>
                  Type the words back in order. A phrase with one word wrong looks completely
                  normal and restores nothing, and this is the only moment you can find that out
                  cheaply.
                </AppText>
                <FormField
                  label="Recovery phrase"
                  value={typed}
                  onChangeText={setTyped}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  spellCheck={false}
                  numberOfLines={4}
                  style={{ minHeight: 96 }}
                  hint={`All ${RECOVERY_WORD_COUNT} words, separated by spaces.`}
                />
                {typed.trim() ? (
                  <StatusPill
                    label={matches ? 'That matches' : 'That does not match yet'}
                    icon={matches ? 'checkmark.circle' : 'exclamationmark.triangle'}
                    tone={matches ? 'positive' : 'warning'}
                  />
                ) : null}
              </Card>
            </MotionView>
          ) : null}
        </>
      )}

      <SectionHeader title="What this phrase can do" />
      <Card style={{ gap: space.md }}>
        {/* Stated plainly rather than softened. A phrase presented as a complete disaster plan,
            when it is only half of one, is worse than no phrase at all — someone would rely on
            it and find out at the moment it matters. */}
        <AppText variant="caption" muted>
          The phrase is the key, not the data. It opens a vault backup file; on its own it
          restores nothing, because your records only ever live on your devices and in a backup
          you saved. Sealed changes waiting on the relay are addressed to specific devices, so a
          replacement device cannot read them either.
        </AppText>
        <AppText variant="caption" muted>
          So a complete plan is these words plus a backup file, kept apart from each other.
          Without a backup, a replacement device is added by pairing it with a device you still
          have — which is why a second paired device is worth keeping.
        </AppText>
        <TextButton
          title="Backup & transfer"
          icon="tray"
          onPress={() => router.push('/sync-transfer')}
        />
      </Card>
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

/** One consequence of holding the phrase, stated in the user's terms. */
function Warns({ title, children }: { title: string; children: string }) {
  return (
    <View style={{ gap: space.xxs }}>
      <AppText variant="label">{title}</AppText>
      <AppText variant="caption" muted>{children}</AppText>
    </View>
  );
}
