/**
 * Duplicate review — the human half of the first pairing of two populated vaults.
 *
 * Pair two devices that both already hold data and you get two of everything the user created
 * on both. The deterministic repair pass renames the collisions ("Bakery" and "Bakery
 * (duplicate)") because renaming is a pure function of the merged set; deciding that those two
 * *are* the same category is a judgement about the world, and only the person who made them
 * can make it. This screen is where that judgement is collected.
 *
 * Three decisions worth defending:
 *
 * - **Nothing is pre-selected.** Merging rewrites a ledger — every transaction, budget filter,
 *   goal link, and recurring template that pointed at the loser is retargeted onto the winner,
 *   and the loser is tombstoned. A screen that opened with 40 boxes already ticked and a
 *   "Merge" button would make that a single mis-tap. "Select all" is one tap away for whoever
 *   wants it, which is the right ratio for an irreversible batch.
 * - **Preview before commit**, in the shape [csv-screen.tsx](../more/csv-screen.tsx) already
 *   proved: counts first, mutation only on an explicit press. The blast-radius number matters
 *   more here than in CSV import — "12 records updated" is how someone notices they ticked an
 *   account with a decade of history behind it.
 * - **Blocked groups are shown, not hidden.** Two same-named accounts in different currencies
 *   are precisely what somebody is scanning this list for. Omitting them reads as "Qashy
 *   didn't notice"; showing them with the reason reads as "this one needs a different fix".
 *
 * **Order is load-bearing and the copy says so.** Transaction matching keys on `accountId` and
 * `categoryId`, so before the accounts are merged the two vaults' copies of "Everyday" are
 * different entities and no transaction pair can ever match. Merge the named things first and
 * new transaction groups appear on their own — which is why this screen recomputes from the
 * live snapshot after every commit instead of freezing a plan at mount.
 */

import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MotionPressable, MotionView } from '@/components/ui/motion';
import { SectionHeader } from '@/components/ui/section-header';
import { StatusPill } from '@/components/ui/status-pill';
import { TextButton } from '@/components/ui/text-button';
import { useLocalization } from '@/localization/localization';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { planMerge, suggestDuplicates, type DuplicateGroup, type MergeKind } from '@/sync/engine/duplicates';
import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';

/** Named things first — see the header. The array order is the on-screen order. */
const SECTIONS: readonly { readonly kind: MergeKind; readonly title: string; readonly icon: string }[] = [
  { kind: 'accounts', title: 'Accounts', icon: 'wallet' },
  { kind: 'categories', title: 'Categories', icon: 'tag' },
  { kind: 'tags', title: 'Tags', icon: 'tag' },
  { kind: 'transactions', title: 'Transactions', icon: 'list.bullet' },
];

/** Stable across recomputes, so a selection survives the snapshot changing under it. */
const keyOf = (group: DuplicateGroup) => `${group.kind}:${group.keepId}`;

export function MergeScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { t } = useLocalization();

  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [merged, setMerged] = useState<{ merged: number; retargeted: number } | null>(null);

  // Recomputed from the live snapshot rather than frozen at mount: a merge changes what else
  // looks like a duplicate, and a remote change arriving mid-review must not leave this list
  // describing records that no longer exist.
  // Keyed on the whole snapshot rather than the four slices it reads. The repository replaces
  // the snapshot object only when something actually changed, so this is already as tight as
  // slice-level deps would be — and a merge arriving from a peer must re-suggest, which a
  // hand-picked dependency list would eventually forget to cover.
  const groups = useMemo(() => suggestDuplicates(state), [state]);

  const mergeable = groups.filter((group) => !group.blocked);
  // Filtered against the current groups on every render, so a selection whose group vanished —
  // merged elsewhere, deleted on another device — cannot reach `mergeDuplicates` as a stale id.
  const chosen = mergeable.filter((group) => selected.includes(keyOf(group)));

  /**
   * The blast radius, or null while it cannot be computed.
   *
   * `planMerge` throws on a chain the user assembled by hand ("A into B" and "B into C"), which
   * is a legitimate state for this screen to be in mid-selection. Showing the reason and
   * disabling the button beats letting them press it and reading the same sentence in an alert.
   */
  const preview = useMemo(() => {
    if (!chosen.length) return null;
    try {
      const plan = planMerge(state, chosen);
      return { retargeted: plan.retargeted, removed: plan.removed, error: null as string | null };
    } catch (reason) {
      return { retargeted: 0, removed: 0, error: errorMessage(reason, 'These merges conflict.') };
    }
  }, [state, chosen]);

  const toggle = (group: DuplicateGroup) => {
    const key = keyOf(group);
    setSelected((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
    setMerged(null);
  };

  const commit = async () => {
    if (busy || !chosen.length || preview?.error) return;
    const confirmed = await confirmDestructive({
      title: 'Merge these records?',
      // The second sentence is the part people do not expect. Retargeting is what makes a merge
      // safe — no transaction is orphaned — and it is also what makes it wide.
      message:
        'The copies are deleted and everything that referred to them is pointed at the record you kept. Your totals do not change, but this cannot be undone from here.',
      confirmLabel: 'Merge',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const result = await repository.mergeDuplicates(chosen);
      setMerged(result);
      setSelected([]);
    } catch (reason) {
      showError('Couldn’t merge those records', errorMessage(reason, 'Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={container}>
      <Card variant="hero" style={{ gap: space.md }}>
        <AppText variant="title">Review duplicates</AppText>
        <AppText muted>
          When two devices that both already had data are paired, anything you created on both
          arrives twice. Qashy renamed the collisions rather than guessing — pick the ones that
          really are the same thing.
        </AppText>
      </Card>

      {merged ? (
        <MotionView variant="up" exit animateLayout>
          <Card style={{ gap: space.sm, borderColor: theme.positive }}>
            <StatusPill
              label={t(merged.merged === 1 ? 'Merged 1 record' : `Merged ${merged.merged} records`)}
              icon="checkmark.circle"
              tone="positive"
              literal
            />
            <AppText variant="caption" muted>
              {t(merged.retargeted === 1
                ? '1 record now points at the copy you kept.'
                : `${merged.retargeted} records now point at the copy you kept.`)}
            </AppText>
            {/* The single most useful sentence on the screen after a merge, and the one nobody
                would guess: transaction pairs only become visible once their accounts and
                categories are one record. */}
            <AppText variant="caption" muted>
              Merging accounts and categories can reveal duplicate transactions that could not be
              matched before. Check the list again below.
            </AppText>
          </Card>
        </MotionView>
      ) : null}

      {!groups.length ? (
        <EmptyState
          icon="checkmark.circle"
          title="Nothing looks duplicated"
          body="Qashy found no records that appear twice. If you have just paired a device, sync once and check again."
        >
          <TextButton title="Back to sync" icon="arrow.triangle.2.circlepath" onPress={() => router.replace('/sync')} />
        </EmptyState>
      ) : null}

      {SECTIONS.map((section) => {
        const rows = groups.filter((group) => group.kind === section.kind);
        if (!rows.length) return null;
        const selectable = rows.filter((group) => !group.blocked);
        const allChosen = selectable.length > 0 && selectable.every((group) => selected.includes(keyOf(group)));
        return (
          <View key={section.kind} style={{ gap: space.md }}>
            <SectionHeader
              title={section.title}
              action={selectable.length ? (allChosen ? 'Clear' : 'Select all') : undefined}
              onAction={() => {
                const keys = selectable.map(keyOf);
                setSelected((current) =>
                  allChosen
                    ? current.filter((key) => !keys.includes(key))
                    : [...new Set([...current, ...keys])],
                );
                setMerged(null);
              }}
            />
            <Card variant="list" dividerInset={38 + space.md}>
              {rows.map((group) => (
                <GroupRow
                  key={keyOf(group)}
                  group={group}
                  icon={section.icon}
                  checked={selected.includes(keyOf(group))}
                  onToggle={() => toggle(group)}
                />
              ))}
            </Card>
          </View>
        );
      })}

      {chosen.length ? (
        <MotionView variant="up" exit animateLayout style={{ gap: space.md }}>
          <View style={{ flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' }}>
            <Tile value={preview?.removed ?? 0} label="Copies removed" accent />
            <Tile value={preview?.retargeted ?? 0} label="Records updated" />
            <Tile value={mergeable.length - chosen.length} label="Kept separate" />
          </View>
          {preview?.error ? (
            <AppText accessibilityRole="alert" variant="caption" style={{ color: theme.negative }}>
              {preview.error}
            </AppText>
          ) : null}
          <ActionButton
            title={busy ? 'Merging…' : t(chosen.length === 1 ? 'Merge 1 group' : `Merge ${chosen.length} groups`)}
            icon="arrow.triangle.2.circlepath"
            busy={busy}
            disabled={busy || Boolean(preview?.error)}
            onPress={() => void commit()}
          />
        </MotionView>
      ) : null}

      {groups.length ? (
        <AppText variant="caption" muted>
          Skipping this is fine. Renamed duplicates are a valid resting state, and this screen
          stays available from Sync whenever you want to come back to it.
        </AppText>
      ) : null}
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
 * One suggested merge.
 *
 * A checkbox rather than a `SettingsRow`, because a row that navigates and a row that selects
 * must not look the same — `SettingsRow` always draws a chevron, which promises a screen that
 * is not there. The affordance and the accessibility contract are lifted from
 * [transaction-row.tsx](../../components/finance/transaction-row.tsx)'s selection mode so batch
 * selection behaves identically everywhere in the app.
 */
function GroupRow({
  group,
  icon,
  checked,
  onToggle,
}: {
  readonly group: DuplicateGroup;
  readonly icon: string;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const blocked = Boolean(group.blocked);
  // `group.label` is the user's own name for the record, so it is never translated. The count
  // beside it is fixed copy and is resolved here, then the whole line renders verbatim.
  const copies = group.mergeIds.length;
  const detail = blocked
    ? group.blocked!
    : t(copies === 1 ? 'Keep this one, remove 1 copy' : `Keep this one, remove ${copies} copies`);

  return (
    <MotionPressable
      accessibilityRole={blocked ? 'text' : 'checkbox'}
      accessibilityLabel={`${group.label}, ${detail}${blocked ? '' : `, ${t(checked ? 'selected' : 'not selected')}`}`}
      accessibilityState={blocked ? { disabled: true } : { checked }}
      aria-checked={blocked ? undefined : checked}
      disabled={blocked}
      onPress={onToggle}
      active={checked}
      pressedScale={0.985}
      style={({ pressed }) => ({
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        opacity: blocked ? 0.55 : pressed ? 0.62 : 1,
      })}>
      {blocked ? (
        <View style={{ width: 38, height: 38, borderRadius: radius.control, borderCurve: 'continuous', backgroundColor: theme.surfaceMuted, alignItems: 'center', justifyContent: 'center' }}>
          <AppIcon name="exclamationmark.triangle" color={theme.warning} size={18} />
        </View>
      ) : (
        <View style={{ width: 38, alignItems: 'center' }}>
          <View style={{ width: 24, height: 24, borderRadius: radius.sm, borderWidth: 2, borderColor: checked ? theme.accent : theme.border, backgroundColor: checked ? theme.accent : theme.surface, alignItems: 'center', justifyContent: 'center' }}>
            {checked ? (
              <MotionView variant="zoom" exit>
                <AppIcon name="checkmark" color={theme.onAccent} size={16} />
              </MotionView>
            ) : null}
          </View>
        </View>
      )}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flex: 1, minWidth: 0, gap: space.xxs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <AppIcon name={icon} color={theme.textMuted} size={14} />
          <AppText literal variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
            {group.label || t('Untitled')}
          </AppText>
        </View>
        <AppText literal variant="caption" muted numberOfLines={2} style={blocked ? { color: theme.warning } : undefined}>
          {detail}
        </AppText>
      </View>
    </MotionPressable>
  );
}

/** One number from the preview. Same proportions as the CSV import summary, deliberately. */
function Tile({ value, label, accent = false }: { readonly value: number; readonly label: string; readonly accent?: boolean }) {
  const theme = useQashyTheme();
  return (
    <View
      style={{
        flex: 1,
        minWidth: 120,
        padding: 14,
        borderRadius: radius.card,
        borderCurve: 'continuous',
        backgroundColor: accent ? theme.accentContainer : theme.surfaceMuted,
      }}>
      <AppText numeric variant="headline" style={accent ? { color: theme.accent } : undefined}>
        {value}
      </AppText>
      <AppText variant="caption" muted>{label}</AppText>
    </View>
  );
}
