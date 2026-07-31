/**
 * Backup, restore, and sneakernet.
 *
 * Three flows live on one screen because from the user's side they are one thing: getting a
 * vault off this device, and getting one back onto a device that has nothing.
 *
 * It exists to close a gap the recovery phrase cannot close alone. The phrase recovers the
 * **key**, not the data — every frame waiting in the drop-box is sealed to a specific device
 * id and would not open for a replacement device, and the drop-box holds a fortnight of
 * deltas rather than a vault. Twenty-four words and no archive restore nothing. This screen is
 * what makes writing them down worth doing.
 *
 * Two rules shape the layout, and both are load-bearing rather than cosmetic:
 *
 * - **Restore is what an unpaired device needs; export is what a paired one needs.** They are
 *   never offered together. Restoring onto a live vault would overwrite the thing being backed
 *   up, and `restoreVaultBackup` refuses it — so the screen says so up front instead of letting
 *   the user discover it from an error at the end of a long flow.
 * - **Nothing is written until it has been read.** A file is decrypted, summarized, and shown —
 *   when it was made, which device made it, how many transactions it holds — before one row is
 *   replaced. The same preview-then-commit shape the CSV screen uses, for a stronger reason:
 *   this is the one genuinely irreversible button in the whole feature.
 *
 * The `.qashysync` half is the transport that involves nobody: no relay, no signaling, no STUN.
 * It is the answer when the relay is down, when two devices are never on the same network, and
 * for anyone who would simply rather no server existed.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile, Paths } from 'expo-file-system';
import { router } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import { MotionView } from '@/components/ui/motion';
import { SectionHeader } from '@/components/ui/section-header';
import { StatusPill } from '@/components/ui/status-pill';
import { useLocalization } from '@/localization/localization';
import { useFinanceRepository } from '@/providers/finance-provider';
import { useSync } from '@/providers/sync-provider';
import {
  BACKUP_MIME,
  backupFileName,
  exportVaultBackup,
  readBackupLock,
  readVaultBackup,
  restoreVaultBackup,
  summarizeArchive,
  type BackupKeySource,
  type VaultArchive,
} from '@/sync/backup';
import {
  MIN_PASSPHRASE_LENGTH,
  RECOVERY_WORD_COUNT,
  isValidRecoveryPhrase,
} from '@/sync/crypto';
import type { BundleExport, BundleImport, SyncPassReason } from '@/sync/runtime';
import { BUNDLE_MIME, bundleFileName } from '@/sync/transport/file';
import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { todayLocal } from '@/utils/date';
import { hapticSuccess } from '@/utils/haptics';
import {
  MAX_SYNC_IMPORT_BYTES,
  MAX_VAULT_IMPORT_BYTES,
  assertFileSize,
} from '@/utils/file-size';

/**
 * Why a `.qashysync` pass did nothing, in the user's terms.
 *
 * The runtime's `SyncPassReason` is deliberately not a message — the same reason reads
 * differently on a screen offering to pair than on one offering to unlock.
 */
const BUNDLE_REASONS: Record<Exclude<SyncPassReason, 'ok'>, string> = {
  disabled: 'Sync is paused on this device. Resume it from the sync screen, then try again.',
  unpaired: 'This device is not part of a vault, so there is nothing to send or receive.',
  locked: 'This device’s key is locked. Unlock it from the sync screen and try again.',
  unavailable: 'This device can’t read its stored key, so nothing can be sealed or opened.',
};

/** Which long-running action owns the screen, so two can never be started at once. */
type Busy = 'backup' | 'open' | 'restore' | 'send' | 'receive' | null;

/** A chosen file, held between picking it and knowing the secret that opens it. */
interface PickedBackup {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly wants: BackupKeySource['kind'];
}

export function TransferScreen() {
  const { status, refresh, setup, runtime } = useSync();
  const repository = useFinanceRepository();
  // `t` is only for strings that leave React — the native share sheet's title. Everything
  // rendered through AppText, StatusPill, or the confirm helpers is translated by those.
  const { t } = useLocalization();

  const [busy, setBusy] = useState<Busy>(null);

  // Export
  const [lock, setLock] = useState<BackupKeySource['kind']>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [repeated, setRepeated] = useState('');
  const [saved, setSaved] = useState(false);

  // Restore
  const [picked, setPicked] = useState<PickedBackup | null>(null);
  const [secret, setSecret] = useState('');
  /**
   * The decrypted archive, held between "Open" and "Restore".
   *
   * This object contains the vault's private keys and every record in it, in the clear. Holding
   * it is the price of a preview step, and the preview is worth it — the alternative is a button
   * that overwrites a device with a file nobody has looked inside. It is dropped the moment the
   * restore finishes or the file is replaced, and, exactly as on the recovery screen, JS cannot
   * promise the bytes are gone.
   */
  const [archive, setArchive] = useState<VaultArchive | null>(null);

  // Sync files
  const [sent, setSent] = useState<BundleExport | null>(null);
  const [received, setReceived] = useState<BundleImport | null>(null);

  if (!status) {
    return (
      <FormScreen maxWidth={720}>
        <AppText muted>Reading this device’s sync state…</AppText>
      </FormScreen>
    );
  }

  const paired = Boolean(status.deviceId);
  const readable = status.keystore === 'unlocked';
  const passphraseReady =
    passphrase.length >= MIN_PASSPHRASE_LENGTH && passphrase === repeated;
  const secretReady =
    picked?.wants === 'recoveryPhrase' ? isValidRecoveryPhrase(secret) : secret.length > 0;

  const run = async (kind: Exclude<Busy, null>, work: () => Promise<unknown>, failure: string) => {
    if (busy) return;
    setBusy(kind);
    try {
      await work();
    } catch (reason) {
      showError(failure, errorMessage(reason, 'Nothing was changed.'));
    } finally {
      setBusy(null);
    }
  };

  // -------------------------------------------------------------------------
  // Backup
  // -------------------------------------------------------------------------

  const backup = () =>
    run(
      'backup',
      async () => {
        setSaved(false);
        const file = await exportVaultBackup(
          setup,
          lock === 'passphrase' ? { kind: 'passphrase', passphrase } : { kind: 'recoveryPhrase' },
        );
        await save(backupFileName(todayLocal()), BACKUP_MIME, file, t('Save Qashy vault backup'));
        // Cleared on success rather than kept for a second export: a passphrase sitting in a
        // form field is one screenshot, one shoulder, or one handed-over phone away from being
        // the thing that opens the file it protects.
        setPassphrase('');
        setRepeated('');
        setSaved(true);
        hapticSuccess();
      },
      'Couldn’t create the backup',
    );

  // -------------------------------------------------------------------------
  // Restore
  // -------------------------------------------------------------------------

  const choose = () =>
    run(
      'open',
      async () => {
        const file = await pickBytes();
        if (!file) return;
        // Once a new file was selected, the old archive must not remain restorable if this one
        // turns out not to be a vault backup.
        setArchive(null);
        setPicked(null);
        setSecret('');
        const wants = readBackupLock(file.bytes);
        if (!wants) {
          showError(
            'That isn’t a Qashy backup',
            'Choose the .qashyvault file you saved from Sync → Backup & transfer.',
          );
          return;
        }
        setPicked({ name: file.name, bytes: file.bytes, wants });
      },
      'Couldn’t read that file',
    );

  const open = () =>
    run(
      'open',
      async () => {
        if (!picked) return;
        const opened = await readVaultBackup(
          picked.bytes,
          picked.wants === 'passphrase'
            ? { kind: 'passphrase', passphrase: secret }
            : { kind: 'recoveryPhrase', phrase: secret },
        );
        // The secret has done its work. Keeping it would leave a recovery phrase in component
        // state for as long as the confirm step is on screen, which is exactly the window
        // somebody walks past.
        setSecret('');
        setArchive(opened);
      },
      'Couldn’t open that backup',
    );

  const restore = async () => {
    if (!archive || busy) return;
    const confirmed = await confirmDestructive({
      title: 'Restore this backup?',
      // Named plainly, because this is the one button on the screen that destroys something.
      // "Replaces everything" is the whole truth and it is short enough to read in a dialog.
      message:
        'Everything currently on this device — accounts, transactions, budgets, goals, and schedules — is replaced by what is in this file. This device then continues as the device that made the backup, so do not do this while that device is still in use.',
      confirmLabel: 'Restore',
    });
    if (!confirmed) return;
    await run(
      'restore',
      async () => {
        await restoreVaultBackup(setup, archive);
        setArchive(null);
        setPicked(null);
        // The repository is holding a snapshot of the vault that was just replaced underneath
        // it. Refreshing is not a nicety: without it every screen keeps rendering the old one.
        await repository.refresh();
        await refresh();
        hapticSuccess();
        // `showError` is the app's only cross-platform alert, and this is the one moment worth
        // interrupting for — the screen the user lands on next looks the same whether the
        // restore worked or silently did nothing.
        showError(
          'Backup restored',
          'Your data is back on this device. Your other devices already know it, so sync continues from where the backup left off.',
        );
        router.replace('/sync');
      },
      'Couldn’t restore that backup',
    );
  };

  // -------------------------------------------------------------------------
  // Sync files
  // -------------------------------------------------------------------------

  const send = () =>
    run(
      'send',
      async () => {
        setSent(null);
        const bundle = await runtime.exportBundle();
        if (bundle.reason !== 'ok') {
          showError('Nothing to send', BUNDLE_REASONS[bundle.reason]);
          return;
        }
        setSent(bundle);
        if (!bundle.frames) return;
        await save(bundleFileName(todayLocal()), BUNDLE_MIME, bundle.text, t('Send Qashy changes'));
        hapticSuccess();
      },
      'Couldn’t create the sync file',
    );

  const receive = () =>
    run(
      'receive',
      async () => {
        setReceived(null);
        const file = await pickText();
        if (!file) return;
        const outcome = await runtime.importBundle(file);
        if (outcome.reason !== 'ok') {
          showError('Nothing was applied', BUNDLE_REASONS[outcome.reason]);
          return;
        }
        setReceived(outcome);
        await refresh();
        if (outcome.applied) hapticSuccess();
      },
      'Couldn’t import that sync file',
    );

  // -------------------------------------------------------------------------

  return (
    <FormScreen maxWidth={720} contentContainerStyle={{ gap: space.lg, paddingBottom: 40 }}>
      <Card variant="hero" style={{ gap: space.md }}>
        <AppText variant="title">Backup &amp; transfer</AppText>
        <AppText muted>
          A vault backup is a complete, encrypted copy of this device — its key, its records, and
          its history — in one file you keep. It is the only thing that can put your data on a
          replacement device when every device you had is gone.
        </AppText>
      </Card>

      {paired ? (
        <>
          <SectionHeader title="Create a vault backup" />
          <Card style={{ gap: space.md }}>
            {readable ? null : (
              <StatusPill
                label="This device’s key is locked"
                icon="lock"
                tone="warning"
                style={{ borderRadius: radius.control }}
              />
            )}
            <AppText variant="caption" muted>
              Choose what opens the file later. A passphrase is right for a copy you store
              somewhere else; the recovery phrase is right if those twenty-four words are already
              written down and this file will sit beside them.
            </AppText>
            <View
              accessibilityLabel={t('How the backup is protected')}
              accessibilityRole="radiogroup"
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              <ChoiceChip
                label="A passphrase"
                icon="textformat"
                selected={lock === 'passphrase'}
                onPress={() => {
                  setLock('passphrase');
                  setSaved(false);
                }}
              />
              <ChoiceChip
                label="My recovery phrase"
                icon="key"
                selected={lock === 'recoveryPhrase'}
                onPress={() => {
                  setLock('recoveryPhrase');
                  setSaved(false);
                }}
              />
            </View>

            {lock === 'passphrase' ? (
              <MotionView variant="up" exit animateLayout style={{ gap: space.md }}>
                <FormField
                  label="Passphrase"
                  value={passphrase}
                  onChangeText={(value) => {
                    setPassphrase(value);
                    setSaved(false);
                  }}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  hint="At least 12 characters. Qashy cannot reset this — the file is unreadable without it."
                />
                <FormField
                  label="Passphrase again"
                  value={repeated}
                  onChangeText={setRepeated}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  error={
                    repeated && passphrase !== repeated
                      ? 'These two do not match.'
                      : undefined
                  }
                />
              </MotionView>
            ) : (
              <MotionView variant="up" exit animateLayout>
                <AppText variant="caption" muted>
                  Nothing to type. The file is sealed with the key this device already holds, so
                  the phrase that opens it is this vault’s own — which also means a file written
                  this way cannot be opened by a phrase you mistyped into a box.
                </AppText>
              </MotionView>
            )}

            <ActionButton
              title={busy === 'backup' ? 'Working…' : 'Create backup'}
              icon="tray"
              busy={busy === 'backup'}
              disabled={Boolean(busy) || !readable || (lock === 'passphrase' && !passphraseReady)}
              onPress={() => void backup()}
            />
            {saved ? (
              <MotionView variant="up" exit animateLayout>
                <StatusPill
                  label="Backup saved"
                  icon="checkmark.circle"
                  tone="positive"
                  style={{ borderRadius: radius.control }}
                />
              </MotionView>
            ) : null}
            <AppText variant="caption" muted>
              Treat the file exactly like the recovery phrase: whoever can open it can read every
              account, transaction, and balance you have. Storing it somewhere only you can reach
              is the whole job.
            </AppText>
          </Card>

          <SectionHeader title="Sync with a file" />
          <Card style={{ gap: space.md }}>
            <AppText variant="caption" muted>
              Carry your changes to another of your devices yourself — AirDrop, a USB stick, an
              email to yourself. No relay, no signaling, no network of any kind is involved. This
              is the path when the relay is down, or when two devices are never online together.
            </AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              <ActionButton
                title={busy === 'send' ? 'Sealing…' : 'Export changes'}
                icon="square.and.arrow.up"
                busy={busy === 'send'}
                disabled={Boolean(busy)}
                onPress={() => void send()}
              />
              <ActionButton
                title={busy === 'receive' ? 'Applying…' : 'Import a sync file'}
                icon="square.and.arrow.down"
                variant="secondary"
                busy={busy === 'receive'}
                disabled={Boolean(busy)}
                onPress={() => void receive()}
              />
            </View>

            {sent ? (
              <MotionView variant="up" exit animateLayout style={{ gap: space.sm }}>
                {sent.frames ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                    <Tally value={sent.frames} label="Sealed batches" tone="accent" />
                    <Tally value={sent.peers} label="Devices covered" />
                  </View>
                ) : (
                  <StatusPill
                    label="Every device is already up to date"
                    icon="checkmark.circle"
                    tone="positive"
                    style={{ borderRadius: radius.control }}
                  />
                )}
                {sent.frames ? (
                  <AppText variant="caption" muted>
                    Exporting again later is harmless. Changes stay queued until a device confirms
                    it received them, so a file that never arrives costs nothing but a second export.
                  </AppText>
                ) : null}
              </MotionView>
            ) : null}

            {received ? (
              <MotionView variant="up" exit animateLayout style={{ gap: space.sm }}>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                  <Tally value={received.applied} label="Changes applied" tone="accent" />
                  <Tally value={received.skipped} label="For another device" />
                  <Tally value={received.rejected} label="Refused" tone={received.rejected ? 'negative' : 'plain'} />
                </View>
                <AppText variant="caption" muted>
                  Batches meant for a different device in this vault are skipped, not lost — one
                  file carries a share for each of them. Anything refused is recorded on the sync
                  screen with the reason.
                </AppText>
              </MotionView>
            ) : null}
          </Card>

          <SectionHeader title="Restoring onto this device" />
          <Card>
            <AppText variant="caption" muted>
              Not offered here, because this device already holds a vault and restoring would
              replace it. A device that needs restoring is one with nothing on it — or one that
              has left this vault from Sync → Danger zone first.
            </AppText>
          </Card>
        </>
      ) : (
        <>
          <SectionHeader title="Restore from a backup" />
          <Card style={{ gap: space.md }}>
            <AppText variant="caption" muted>
              Everything currently on this device is replaced by what the file holds. The restored
              device carries on as the one that made the backup, so restore onto a replacement —
              never alongside a device that is still in use.
            </AppText>
            <ActionButton
              title={picked ? 'Choose a different file' : 'Choose a backup file'}
              icon="folder"
              variant={picked ? 'secondary' : 'primary'}
              busy={busy === 'open' && !picked}
              disabled={Boolean(busy)}
              onPress={() => void choose()}
            />

            {picked && !archive ? (
              <MotionView variant="up" exit animateLayout style={{ gap: space.md }}>
                <StatusPill label={picked.name} icon="doc" tone="neutral" literal style={{ borderRadius: radius.control }} />
                {picked.wants === 'passphrase' ? (
                  <FormField
                    label="Passphrase"
                    value={secret}
                    onChangeText={setSecret}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    hint="The passphrase you chose when this backup was created."
                  />
                ) : (
                  <FormField
                    label="Recovery phrase"
                    value={secret}
                    onChangeText={setSecret}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="off"
                    spellCheck={false}
                    numberOfLines={4}
                    style={{ minHeight: 96 }}
                    hint={`All ${RECOVERY_WORD_COUNT} words, separated by spaces.`}
                  />
                )}
                <ActionButton
                  title={busy === 'open' ? 'Opening…' : 'Open backup'}
                  icon="lock.open"
                  busy={busy === 'open'}
                  disabled={Boolean(busy) || !secretReady}
                  onPress={() => void open()}
                />
              </MotionView>
            ) : null}

            {archive ? <Preview archive={archive} busy={busy} onRestore={() => void restore()} /> : null}
          </Card>

          <Card>
            <AppText variant="caption" muted>
              No backup file? A device that still has your data can add this one from Sync → Add a
              device instead, which copies the vault across without a file at all.
            </AppText>
          </Card>
        </>
      )}
    </FormScreen>
  );
}

/**
 * What the file turned out to contain, before anything is replaced.
 *
 * Deliberately concrete. "A backup from 12 March, from Laptop, with 1 482 transactions" is
 * something a person can recognise as theirs or not; "a valid archive" is not.
 */
function Preview({
  archive,
  busy,
  onRestore,
}: {
  archive: VaultArchive;
  busy: Busy;
  onRestore: () => void;
}) {
  const summary = summarizeArchive(archive);
  const theme = useQashyTheme();
  return (
    <MotionView variant="up" exit animateLayout style={{ gap: space.md }}>
      <StatusPill
        label="Backup opened"
        icon="checkmark.circle"
        tone="positive"
        style={{ borderRadius: radius.control }}
      />
      <View style={{ gap: space.xxs }}>
        <Detail label="Made on" value={summary.createdAt.slice(0, 10)} />
        <Detail label="Made by" value={summary.deviceName || '—'} />
        <Detail label="Base currency" value={summary.baseCurrency || '—'} />
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        <Tally value={summary.transactionCount} label="Transactions" tone="accent" />
        <Tally value={summary.recordCount} label="Records" />
        <Tally value={summary.peerCount} label="Other devices" />
      </View>
      <ActionButton
        title={busy === 'restore' ? 'Restoring…' : 'Replace this device with this backup'}
        icon="arrow.down.circle"
        variant="danger"
        busy={busy === 'restore'}
        disabled={Boolean(busy)}
        onPress={onRestore}
      />
      <AppText variant="caption" style={{ color: theme.negative }}>
        This cannot be undone from inside Qashy.
      </AppText>
    </MotionView>
  );
}

/** One fact about the archive. The value is data, so it is never translated. */
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: space.sm }}>
      <AppText variant="label">{label}</AppText>
      <AppText literal variant="caption" muted>{value}</AppText>
    </View>
  );
}

/**
 * A count and what it counts.
 *
 * Built as two nodes rather than one interpolated sentence on purpose: the number is data and
 * the label is a fixed string, so this needs no dynamic-translation entry and reads correctly
 * in Hebrew without a reordered sentence template.
 */
function Tally({
  value,
  label,
  tone = 'plain',
}: {
  value: number;
  label: string;
  tone?: 'accent' | 'negative' | 'plain';
}) {
  const theme = useQashyTheme();
  return (
    <View
      style={{
        flex: 1,
        minWidth: 108,
        padding: space.md,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        backgroundColor: tone === 'accent' ? theme.accentContainer : theme.surfaceMuted,
      }}>
      <AppText
        literal
        variant="headline"
        style={{
          color:
            tone === 'accent' ? theme.onAccentContainer : tone === 'negative' ? theme.negative : theme.text,
        }}>
        {String(value)}
      </AppText>
      <AppText variant="caption" muted>{label}</AppText>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Writes a file out, by whichever mechanism the platform has.
 *
 * The same branch [csv-screen.tsx](src/features/more/csv-screen.tsx) already uses, kept
 * identical rather than abstracted: two call sites is not enough to justify a shared helper
 * whose whole body is a platform check, and the CSV one is the version that has been through
 * real devices.
 *
 * The native copy is left in the cache directory afterwards. Both file kinds are ciphertext —
 * one sealed to a passphrase or the vault key, the other a set of frames sealed per device —
 * so what is left behind is not readable by whatever else can see the cache.
 */
async function save(name: string, mime: string, data: string | Uint8Array, dialogTitle: string) {
  if (process.env.EXPO_OS === 'web') {
    // `Blob` rejects a view that might be backed by a SharedArrayBuffer, which is what a bare
    // `Uint8Array` widens to. Copying into a fresh view is the type-safe way to say it is not —
    // one extra copy of a file that is about to be written to disk anyway.
    const part: BlobPart = typeof data === 'string' ? data : new Uint8Array(data);
    const url = URL.createObjectURL(new Blob([part], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    window.setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 1000);
    return;
  }
  const file = new ExpoFile(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(data);
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: mime, dialogTitle });
}

/**
 * Any file at all, because the extensions are Qashy's own.
 *
 * A MIME filter would hide `.qashyvault` behind "no compatible files" on both platforms —
 * iOS resolves a UTI it has never heard of to nothing, and Android's picker filters on the
 * type the provider reports, which for an unknown extension is frequently blank. The file's
 * own magic bytes are what decides whether it is one of ours, one step later.
 */
const PICKER = { type: '*/*', copyToCacheDirectory: true, base64: false } as const;

async function pickBytes(): Promise<{ name: string; bytes: Uint8Array } | null> {
  const result = await DocumentPicker.getDocumentAsync(PICKER);
  if (result.canceled) return null;
  const asset = result.assets[0];
  const nativeFile = asset.file ? null : new ExpoFile(asset.uri);
  assertFileSize(
    asset.size ?? asset.file?.size ?? nativeFile?.size,
    MAX_VAULT_IMPORT_BYTES,
    'Vault backup',
  );
  const bytes = asset.file
    ? new Uint8Array(await asset.file.arrayBuffer())
    : await nativeFile!.bytes();
  return { name: asset.name, bytes };
}

async function pickText(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync(PICKER);
  if (result.canceled) return null;
  const asset = result.assets[0];
  const nativeFile = asset.file ? null : new ExpoFile(asset.uri);
  assertFileSize(
    asset.size ?? asset.file?.size ?? nativeFile?.size,
    MAX_SYNC_IMPORT_BYTES,
    'Sync file',
  );
  return asset.file ? await asset.file.text() : await nativeFile!.text();
}
