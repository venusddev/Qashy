import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import type { GoalKind } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { todayLocal } from '@/utils/date';
import { validateDateInput, validateMoneyInput } from '@/utils/form-validation';
import { minorToDecimalString, parseMoney } from '@/utils/money';

export function GoalFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.goals.find((item) => item.id === id) : undefined;
  const toMoneyText = (minor: number) => minorToDecimalString(minor, state.settings.baseCurrency, state.settings.locale);
  const [name, setName] = useState(existing?.name ?? 'Rainy day fund');
  const [kind, setKind] = useState<GoalKind>(existing?.kind ?? 'saving');
  const [target, setTarget] = useState(existing ? toMoneyText(existing.targetMinor) : '5000');
  const [initial, setInitial] = useState(existing ? toMoneyText(existing.initialMinor) : '0');
  const [targetDate, setTargetDate] = useState(existing?.targetDate ?? '');
  const [linkedAccountId, setLinkedAccountId] = useState(existing?.linkedAccountId ?? '');
  const [linkedCategoryId, setLinkedCategoryId] = useState(existing?.linkedCategoryId ?? '');
  const [contribution, setContribution] = useState('');
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
  const canSave = !targetError && !initialError && !targetDateError && !contributionError;

  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      const goal = await repository.saveGoal({
        name: name.trim() || 'Goal',
        kind,
        icon: 'target',
        color: existing?.color ?? theme.staticAccent,
        targetMinor: parseMoney(target, state.settings.baseCurrency, state.settings.locale),
        initialMinor: parseMoney(initial, state.settings.baseCurrency, state.settings.locale),
        targetDate: targetDate || null,
        linkedAccountId: linkedAccountId || null,
        linkedCategoryId: linkedCategoryId || null,
        archived: false,
      }, existing?.id);
      if (contribution.trim()) {
        await repository.saveContribution({ goalId: goal.id, amountMinor: parseMoney(contribution, state.settings.baseCurrency, state.settings.locale), localDate: todayLocal(), transactionId: null, note: 'Manual contribution' });
      }
      router.dismissTo('/plan');
    } catch (reason) {
      showError('Couldn’t save goal', errorMessage(reason, 'Try again.'));
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

  return (
    <FormScreen contentContainerStyle={{ gap: 16, paddingBottom: 40 }}>
      <Card style={{ gap: 16 }}>
        <View accessibilityLabel="Goal type" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8 }}>
          {(['saving', 'spending'] as GoalKind[]).map((item) => <View key={item} style={{ flex: 1 }}><ChoiceChip label={item === 'saving' ? 'Savings goal' : 'Planned purchase'} selected={kind === item} onPress={() => setKind(item)} /></View>)}
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
        <View accessibilityLabel="Linked account" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ChoiceChip label="None" selected={!linkedAccountId} onPress={() => setLinkedAccountId('')} />{state.accounts.filter((item) => !item.archived).map((item) => <ChoiceChip key={item.id} label={item.name} selected={linkedAccountId === item.id} onPress={() => setLinkedAccountId(item.id)} />)}</View>
        <AppText variant="label">Linked category</AppText>
        <View accessibilityLabel="Linked category" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ChoiceChip label="None" selected={!linkedCategoryId} onPress={() => setLinkedCategoryId('')} />{state.categories.filter((item) => item.kind === (kind === 'saving' ? 'income' : 'expense') && !item.archived).map((item) => <ChoiceChip key={item.id} label={item.name} selected={linkedCategoryId === item.id} onPress={() => setLinkedCategoryId(item.id)} />)}</View>
      </Card>

      {existing ? <Card><FormField label="Add a manual contribution" value={contribution} onChangeText={setContribution} keyboardType="decimal-pad" placeholder="0" error={contributionError} /></Card> : null}
      <ActionButton title={saving ? 'Saving…' : existing ? 'Save goal' : 'Create goal'} icon="checkmark" onPress={save} disabled={saving || !canSave} busy={saving} />
      {existing ? <ActionButton title="Delete goal" variant="danger" onPress={remove} disabled={saving} /> : null}
    </FormScreen>
  );
}
