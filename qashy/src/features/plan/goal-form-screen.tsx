import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import type { GoalKind } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { todayLocal } from '@/utils/date';
import { currencyDigits, parseMoney } from '@/utils/money';

export function GoalFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.goals.find((item) => item.id === id) : undefined;
  const scale = 10 ** currencyDigits(state.settings.baseCurrency, state.settings.locale);
  const [name, setName] = useState(existing?.name ?? 'Rainy day fund');
  const [kind, setKind] = useState<GoalKind>(existing?.kind ?? 'saving');
  const [target, setTarget] = useState(existing ? String(existing.targetMinor / scale) : '5000');
  const [initial, setInitial] = useState(existing ? String(existing.initialMinor / scale) : '0');
  const [targetDate, setTargetDate] = useState(existing?.targetDate ?? '');
  const [linkedAccountId, setLinkedAccountId] = useState(existing?.linkedAccountId ?? '');
  const [linkedCategoryId, setLinkedCategoryId] = useState(existing?.linkedCategoryId ?? '');
  const [contribution, setContribution] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
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
      if (contribution && Number(contribution) > 0) {
        await repository.saveContribution({ goalId: goal.id, amountMinor: parseMoney(contribution, state.settings.baseCurrency, state.settings.locale), localDate: todayLocal(), transactionId: null, note: 'Manual contribution' });
      }
      router.replace('/plan');
    } catch (reason) {
      Alert.alert('Couldn’t save goal', reason instanceof Error ? reason.message : 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, paddingBottom: 40, gap: 16, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
      <Card style={{ gap: 16 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['saving', 'spending'] as GoalKind[]).map((item) => <View key={item} style={{ flex: 1 }}><ChoiceChip label={item === 'saving' ? 'Savings goal' : 'Planned purchase'} selected={kind === item} onPress={() => setKind(item)} /></View>)}
        </View>
        <FormField label="Goal name" value={name} onChangeText={setName} />
        <FormField label={`Target (${state.settings.baseCurrency})`} value={target} onChangeText={setTarget} keyboardType="decimal-pad" />
        <FormField label="Starting progress" value={initial} onChangeText={setInitial} keyboardType="decimal-pad" />
        <FormField label="Target date (optional)" value={targetDate} onChangeText={setTargetDate} placeholder="YYYY-MM-DD" />
      </Card>

      <Card style={{ gap: 14 }}>
        <AppText variant="headline">Automatic progress</AppText>
        <AppText muted>Optionally count matching posted transactions. You can still add progress manually.</AppText>
        <AppText variant="label">Linked account</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ChoiceChip label="None" selected={!linkedAccountId} onPress={() => setLinkedAccountId('')} />{state.accounts.filter((item) => !item.archived).map((item) => <ChoiceChip key={item.id} label={item.name} selected={linkedAccountId === item.id} onPress={() => setLinkedAccountId(item.id)} />)}</View>
        <AppText variant="label">Linked category</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ChoiceChip label="None" selected={!linkedCategoryId} onPress={() => setLinkedCategoryId('')} />{state.categories.filter((item) => item.kind === (kind === 'saving' ? 'income' : 'expense') && !item.archived).map((item) => <ChoiceChip key={item.id} label={item.name} selected={linkedCategoryId === item.id} onPress={() => setLinkedCategoryId(item.id)} />)}</View>
      </Card>

      {existing ? <Card><FormField label="Add a manual contribution" value={contribution} onChangeText={setContribution} keyboardType="decimal-pad" placeholder="0" /></Card> : null}
      <ActionButton title={saving ? 'Saving…' : existing ? 'Save goal' : 'Create goal'} icon="checkmark" onPress={save} disabled={saving} />
      {existing ? <ActionButton title="Delete goal" variant="danger" onPress={async () => { await repository.deleteEntities('goals', [existing.id]); router.replace('/plan'); }} /> : null}
    </ScrollView>
  );
}
