import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import { TextButton } from '@/components/ui/text-button';
import type { GoalContribution, GoalKind } from '@/domain/models';
import { useLocalization } from '@/localization/localization';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { todayLocal } from '@/utils/date';
import { validateDateInput, validateMoneyInput } from '@/utils/form-validation';
import { hapticSuccess } from '@/utils/haptics';
import { formatMoney, minorToLocalizedDecimalString, parseMoney } from '@/utils/money';

export function GoalFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const defaultGoalName = state.settings.locale.toLocaleLowerCase().startsWith('he')
    ? 'קרן ליום גשום'
    : 'Rainy day fund';
  const existing = id ? state.goals.find((item) => item.id === id) : undefined;
  const [expectedRevision] = useState(existing?.revision);
  const toMoneyText = (minor: number) => minorToLocalizedDecimalString(minor, state.settings.baseCurrency, state.settings.locale);
  const [name, setName] = useState(existing?.name ?? defaultGoalName);
  const [kind, setKind] = useState<GoalKind>(existing?.kind ?? 'saving');
  const [target, setTarget] = useState(existing ? toMoneyText(existing.targetMinor) : '5000');
  const [initial, setInitial] = useState(existing ? toMoneyText(existing.initialMinor) : '0');
  const [targetDate, setTargetDate] = useState(existing?.targetDate ?? '');
  const [linkedAccountId, setLinkedAccountId] = useState(existing?.linkedAccountId ?? '');
  const [linkedCategoryId, setLinkedCategoryId] = useState(existing?.linkedCategoryId ?? '');
  const [contribution, setContribution] = useState('');
  const [contributionDate, setContributionDate] = useState(todayLocal());
  const [contributionNote, setContributionNote] = useState('Manual contribution');
  const [editingContributionId, setEditingContributionId] = useState<string | null>(null);
  const [editingContributionRevision, setEditingContributionRevision] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);
  const targetError = validateMoneyInput(target, state.settings.baseCurrency, state.settings.locale, {
    label: 'Target',
    positive: true,
  });
  const initialError = validateMoneyInput(initial, state.settings.baseCurrency, state.settings.locale, {
    label: 'Starting progress',
    nonNegative: true,
  });
  const targetDateError = validateDateInput(targetDate, { label: 'Target date', optional: true });
  const contributionError = validateMoneyInput(contribution, state.settings.baseCurrency, state.settings.locale, {
    label: 'Contribution',
    optional: true,
    positive: true,
  });
  const contributionDateError = validateDateInput(contributionDate, { label: 'Contribution date' });
  const canSave = !targetError && !initialError && !targetDateError;
  const canSaveContribution = Boolean(contribution.trim()) && !contributionError && !contributionDateError;
  const accountChoices = state.accounts.filter((item) =>
    !item.archived || item.id === linkedAccountId,
  );
  const categoryChoices = state.categories.filter((item) =>
    item.kind === (kind === 'saving' ? 'income' : 'expense') &&
    (!item.archived || item.id === linkedCategoryId),
  );
  const manualContributions = existing
    ? state.contributions
      .filter((item) => item.goalId === existing.id && item.transactionId === null)
      .sort((a, b) => b.localDate.localeCompare(a.localDate) || b.createdAt.localeCompare(a.createdAt))
    : [];

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      await repository.saveGoal({
        name: name.trim() || defaultGoalName,
        kind,
        icon: 'target',
        color: existing?.color ?? theme.staticAccent,
        targetMinor: parseMoney(target, state.settings.baseCurrency, state.settings.locale),
        initialMinor: parseMoney(initial, state.settings.baseCurrency, state.settings.locale),
        targetDate: targetDate || null,
        linkedAccountId: linkedAccountId || null,
        linkedCategoryId: linkedCategoryId || null,
        archived: false,
      }, existing?.id, expectedRevision);
      hapticSuccess();
      router.dismissTo('/plan');
    } catch (reason) {
      showError('Couldn’t save goal', errorMessage(reason, 'Try again.'));
    } finally {
      setSaving(false);
    }
  };

  const resetContributionForm = () => {
    setContribution('');
    setContributionDate(todayLocal());
    setContributionNote('Manual contribution');
    setEditingContributionId(null);
    setEditingContributionRevision(undefined);
  };

  const editManualContribution = (item: GoalContribution) => {
    setContribution(toMoneyText(item.amountMinor));
    setContributionDate(item.localDate);
    setContributionNote(item.note);
    setEditingContributionId(item.id);
    setEditingContributionRevision(item.revision);
  };

  const saveManualContribution = async () => {
    if (!existing || saving || !canSaveContribution) return;
    setSaving(true);
    try {
      await repository.saveContribution({
        goalId: existing.id,
        amountMinor: parseMoney(contribution, state.settings.baseCurrency, state.settings.locale),
        localDate: contributionDate,
        transactionId: null,
        note: contributionNote,
      }, editingContributionId ?? undefined, editingContributionRevision);
      resetContributionForm();
      hapticSuccess();
    } catch (reason) {
      showError('Couldn’t save contribution', errorMessage(reason, 'Check the form and try again.'));
    } finally {
      setSaving(false);
    }
  };

  const removeManualContribution = async (item: GoalContribution) => {
    if (saving) return;
    const amountLabel = formatMoney(item.amountMinor, state.settings.baseCurrency, state.settings.locale);
    if (!(await confirmDestructive({
      title: 'Delete this contribution?',
      message: `${amountLabel} from ${item.localDate} will be removed from this goal.`,
    }))) return;
    setSaving(true);
    try {
      await repository.deleteEntities('contributions', [item.id]);
      if (editingContributionId === item.id) resetContributionForm();
    } catch (reason) {
      showError('Couldn’t delete contribution', errorMessage(reason, 'Try again.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing || saving) return;
    if (!(await confirmDestructive({ title: `Delete ${existing.name}?`, message: 'Manual contributions are removed with it.' }))) return;
    setSaving(true);
    try {
      await repository.deleteEntities('goals', [existing.id]);
      router.dismissTo('/plan');
    } catch (reason) {
      showError('Couldn’t delete goal', errorMessage(reason, 'Try again.'));
    } finally {
      setSaving(false);
    }
  };

  if (id && !existing) return <Redirect href="/plan" />;

  return (
    <FormScreen contentContainerStyle={{ gap: 16, paddingBottom: 40 }}>
      <Card style={{ gap: 16 }}>
        <View accessibilityLabel="Goal type" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8 }}>
          {(['saving', 'spending'] as GoalKind[]).map((item) => <View key={item} style={{ flex: 1 }}><ChoiceChip label={item === 'saving' ? 'Savings goal' : 'Planned purchase'} selected={kind === item} onPress={() => {
            if (item === kind) return;
            setKind(item);
            setLinkedCategoryId('');
          }} /></View>)}
        </View>
        <FormField label="Goal name" value={name} onChangeText={setName} />
        <FormField label={`Target (${state.settings.baseCurrency})`} value={target} onChangeText={setTarget} keyboardType="decimal-pad" error={targetError} required />
        <FormField label="Starting progress" value={initial} onChangeText={setInitial} keyboardType="decimal-pad" error={initialError} required />
        <FormField label="Target date (optional)" value={targetDate} onChangeText={setTargetDate} placeholder="YYYY-MM-DD" error={targetDateError} />
      </Card>

      <Card style={{ gap: 14 }}>
        <AppText variant="headline">Automatic progress</AppText>
        <AppText muted>Optionally count matching posted transactions. You can still add progress manually.</AppText>
        <AppText variant="label">Linked account</AppText>
        <View accessibilityLabel="Linked account" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ChoiceChip label="None" selected={!linkedAccountId} onPress={() => setLinkedAccountId('')} />{accountChoices.map((item) => <ChoiceChip key={item.id} literal label={`${item.name}${item.archived ? ' (archived)' : ''}`} disabled={item.archived} selected={linkedAccountId === item.id} onPress={() => setLinkedAccountId(item.id)} />)}</View>
        <AppText variant="label">Linked category</AppText>
        <View accessibilityLabel="Linked category" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ChoiceChip label="None" selected={!linkedCategoryId} onPress={() => setLinkedCategoryId('')} />{categoryChoices.map((item) => <ChoiceChip key={item.id} literal label={`${item.name}${item.archived ? ' (archived)' : ''}`} disabled={item.archived} selected={linkedCategoryId === item.id} onPress={() => setLinkedCategoryId(item.id)} />)}</View>
      </Card>

      {existing ? (
        <Card style={{ gap: 14 }}>
          <AppText variant="headline">Manual contributions</AppText>
          {manualContributions.map((item) => {
            const amountLabel = formatMoney(item.amountMinor, state.settings.baseCurrency, state.settings.locale);
            return (
              <View key={item.id} style={{ gap: 6, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: theme.border }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <AppText literal variant="label">{amountLabel}</AppText>
                    <AppText literal variant="caption" muted>{`${item.localDate}${item.note ? ` · ${item.note}` : ''}`}</AppText>
                  </View>
                  <View style={{ flexDirection: 'row' }}>
                    <TextButton title="Edit" accessibilityLabel={t(`Edit contribution ${amountLabel}`)} onPress={() => editManualContribution(item)} disabled={saving} />
                    <TextButton title="Delete" tone="danger" accessibilityLabel={t(`Delete contribution ${amountLabel}`)} onPress={() => removeManualContribution(item)} disabled={saving} />
                  </View>
                </View>
              </View>
            );
          })}
          {!manualContributions.length ? <AppText muted>No manual contributions yet.</AppText> : null}
          <FormField label={editingContributionId ? 'Contribution amount' : 'Add a manual contribution'} value={contribution} onChangeText={setContribution} keyboardType="decimal-pad" placeholder="0" error={contributionError} />
          <FormField label="Contribution date" value={contributionDate} onChangeText={setContributionDate} placeholder="YYYY-MM-DD" autoCapitalize="none" error={contributionDateError} required />
          <FormField label="Contribution note" value={contributionNote} onChangeText={setContributionNote} placeholder="Optional context" />
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <ActionButton title={editingContributionId ? 'Save contribution' : 'Add contribution'} variant="secondary" onPress={saveManualContribution} disabled={saving || !canSaveContribution} />
            {editingContributionId ? <TextButton title="Cancel" onPress={resetContributionForm} disabled={saving} /> : null}
          </View>
        </Card>
      ) : null}
      <ActionButton title={saving ? 'Saving…' : existing ? 'Save goal' : 'Create goal'} icon="checkmark" onPress={save} disabled={saving || !canSave} busy={saving} />
      {existing ? <ActionButton title="Delete goal" variant="danger" onPress={remove} disabled={saving} /> : null}
    </FormScreen>
  );
}
