/**
 * Who is in the vault.
 *
 * This is the list that has to be *exactly* right, because it is the answer to the only
 * question that matters about an end-to-end encrypted system: who can read this. A device on
 * this list can read every transaction, every balance, and every note, and there is no partial
 * membership to hide behind — so the screen shows the whole roster, including the ones that
 * were removed, and never abbreviates it behind a "3 devices" summary.
 *
 * Three deliberate choices:
 *
 * - **This device is first and labelled as such.** Somebody scanning for a device they no
 *   longer own must not have to work out which row is the phone in their hand.
 * - **Revoked devices stay visible.** The row is kept on disk so past history stays
 *   attributable, and hiding it here would make "did I actually remove the old laptop?"
 *   unanswerable — which is the exact question a person asks after losing one.
 * - **Removing a device says what it does not do.** Revocation is forward-only. It stops that
 *   device writing into this vault; it cannot reach across and erase what it already holds.
 *   A confirm dialog that implied otherwise would be the most consequential lie in the app.
 */

import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { MotionView } from '@/components/ui/motion';
import { SectionHeader } from '@/components/ui/section-header';
import { SettingsRow } from '@/components/ui/settings-row';
import { TextButton } from '@/components/ui/text-button';
import { describePeer, deviceIcon, livePeers } from '@/features/sync/sync-summary';
import { useLocalization } from '@/localization/localization';
import { useSync } from '@/providers/sync-provider';
import {
  renameDevice,
  revokePeer,
  setRevocationPolicy,
  transferVaultOwnership,
  type SyncStatus,
} from '@/sync/setup';
import { space } from '@/theme/tokens';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';

/** The rows are inset past a 38pt tile plus its gap, matching every other list in the app. */
const ROW_DIVIDER_INSET = 38 + space.md;

export function DeviceCard({
  status,
  now,
  onChanged,
}: {
  readonly status: SyncStatus;
  readonly now: number;
  readonly onChanged: () => Promise<void>;
}) {
  const { setup } = useSync();
  const { t } = useLocalization();

  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(status.deviceName);
  const [saving, setSaving] = useState(false);
  const isOwner = status.revocation.ownerDeviceId === status.deviceId;

  // Newest first among the live ones, then the removed ones. Someone opening this screen after
  // pairing wants the device they just added at the top, and someone auditing it wants the
  // removals gathered at the bottom rather than interleaved by date.
  const peers = [
    ...livePeers(status.peers).sort((a, b) => b.addedAt.localeCompare(a.addedAt)),
    ...status.peers.filter((peer) => peer.revokedAt),
  ];

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      await renameDevice(setup, trimmed);
      await onChanged();
      setRenaming(false);
    } catch (reason) {
      showError('Couldn’t rename this device', errorMessage(reason, 'Try a different name.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (peerId: string, peerName: string) => {
    const confirmed = await confirmDestructive({
      title: 'Remove this device?',
      // Both halves are load-bearing. The first is what people expect; the second is the part
      // they do not, and finding it out afterwards is much worse than reading it here.
      message:
        'It stops sending and receiving changes here. It keeps the copy of your data it already has — to make that copy useless, rotate the vault key afterwards.',
      confirmLabel: 'Remove',
    });
    if (!confirmed) return;
    try {
      await revokePeer(setup, peerId);
      await onChanged();
    } catch (reason) {
      showError('Couldn’t remove that device', errorMessage(reason, `${peerName} is still paired.`));
    }
  };

  const changePolicy = async (mode: 'any' | 'quorum' | 'owner') => {
    try {
      await setRevocationPolicy(setup, mode);
      await onChanged();
    } catch (reason) {
      showError('Couldnâ€™t change removal policy', errorMessage(reason, 'Only the vault owner can change it.'));
    }
  };

  const transferOwner = async (peerId: string, peerName: string) => {
    const confirmed = await confirmDestructive({
      title: `Make ${peerName} the vault owner?`,
      message: 'That device will be the only one able to change the removal policy or transfer ownership again.',
      confirmLabel: 'Transfer ownership',
    });
    if (!confirmed) return;
    try {
      await transferVaultOwnership(setup, peerId);
      await onChanged();
    } catch (reason) {
      showError('Couldnâ€™t transfer ownership', errorMessage(reason, 'The current vault owner must make this change.'));
    }
  };

  return (
    <>
      <SectionHeader title="Devices" />
      <Card variant="list" dividerInset={ROW_DIVIDER_INSET}>
        <SettingsRow
          // `literal` covers the whole row, so the fixed half is translated here and the
          // user's own device name passes through exactly as they typed it.
          literal
          title={status.deviceName || t('Unnamed device')}
          subtitle={t('This device')}
          icon={deviceIcon(Platform.OS)}
        />
        {peers.map((peer) => {
          const described = describePeer(peer, now);
          return (
            <SettingsRow
              key={peer.deviceId}
              literal
              title={peer.name}
              subtitle={t(described.subtitle)}
              icon={described.icon}
              tone={peer.revokedAt ? 'danger' : 'default'}
              onPress={peer.revokedAt ? undefined : () => void remove(peer.deviceId, peer.name)}
            />
          );
        })}
      </Card>

      <SectionHeader title="Device removal" />
      <Card style={{ gap: space.md }}>
        <AppText variant="label">Who can remove a device</AppText>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <ChoiceChip label="Any device" selected={status.revocation.mode === 'any'} disabled={!isOwner} onPress={() => void changePolicy('any')} />
          <ChoiceChip label="Majority vote" selected={status.revocation.mode === 'quorum'} disabled={!isOwner} onPress={() => void changePolicy('quorum')} />
          <ChoiceChip label="Vault owner" selected={status.revocation.mode === 'owner'} disabled={!isOwner} onPress={() => void changePolicy('owner')} />
        </View>
        <AppText variant="caption" muted>
          {status.revocation.mode === 'any'
            ? 'Any paired device can remove another device immediately.'
            : status.revocation.mode === 'quorum'
              ? 'A removal needs approval from at least half of the devices, including the proposer. With two devices, one approval is enough.'
              : 'Only the vault owner can remove a device.'}
        </AppText>
        {!isOwner ? <AppText variant="caption" muted>Only the vault owner can change this policy.</AppText> : null}
        {isOwner && peers.filter((peer) => !peer.revokedAt).length ? (
          <View style={{ gap: space.xs }}>
            <AppText variant="caption" muted>Transfer vault ownership</AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
              {peers.filter((peer) => !peer.revokedAt).map((peer) => (
                <TextButton key={peer.deviceId} title={`Make ${peer.name} owner`} tone="muted" onPress={() => void transferOwner(peer.deviceId, peer.name)} />
              ))}
            </View>
          </View>
        ) : null}
        {status.proposals.length ? (
          <AppText variant="caption" muted>
            A removal proposal is waiting for more device approvals. Tap that device in the list to add this deviceâ€™s approval.
          </AppText>
        ) : null}
      </Card>

      {!status.peers.length ? (
        <EmptyState
          compact
          icon="person.2"
          title="No other devices yet"
          body="Pair a second device and Qashy keeps them in step. You compare a six-word code on both screens first, so nothing is sent to a device you didn’t confirm."
        />
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm }}>
        <ActionButton title="Add device" icon="plus" onPress={() => router.push('/sync-pair')} />
        <TextButton
          title="Rename this device"
          icon="pencil"
          tone="muted"
          accessibilityState={{ expanded: renaming }}
          onPress={() => {
            setName(status.deviceName);
            setRenaming((open) => !open);
          }}
        />
      </View>

      {renaming ? (
        <MotionView variant="up" exit animateLayout style={{ gap: space.md }}>
          <FormField
            label="Device name"
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            hint="Only your paired devices ever see this. It is sent encrypted, and the relay never learns it."
          />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <ActionButton
              title={saving ? 'Saving…' : 'Save'}
              icon="checkmark"
              disabled={saving || !name.trim()}
              busy={saving}
              onPress={() => void save()}
            />
            <TextButton title="Cancel" tone="muted" onPress={() => setRenaming(false)} />
          </View>
        </MotionView>
      ) : null}

      {status.peers.some((peer) => peer.revokedAt) ? (
        <AppText variant="caption" muted>
          Removed devices stay listed so your history keeps its author. They can no longer send or receive changes.
        </AppText>
      ) : null}
    </>
  );
}
