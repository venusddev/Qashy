import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, Switch, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import type { CategoryKind, RecurrenceUnit } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { todayLocal } from '@/utils/date';
import { currencyDigits, parseMoney } from '@/utils/money';

export function RecurringFormScreen() {
  const params = useLocalSearchParams<{ id?: string; kind?: CategoryKind; title?: string; amount?: string; accountId?: string; categoryId?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = params.id ? state.recurringRules.find((item) => item.id === params.id) : undefined;
  const initialAccount = state.accounts.find((item) => item.id === (existing?.template.accountId ?? params.accountId)) ?? state.accounts[0];
  const [kind, setKind] = useState<CategoryKind>(existing?.template.kind ?? params.kind ?? 'expense');
  const [title, setTitle] = useState(existing?.template.title ?? params.title ?? '');
  const [amount, setAmount] = useState(existing ? String(existing.template.amountMinor / 10 ** currencyDigits(existing.template.currency, state.settings.locale)) : params.amount ?? '');
  const [accountId, setAccountId] = useState(initialAccount?.id ?? '');
  const [categoryId, setCategoryId] = useState(existing?.template.categoryId ?? params.categoryId ?? '');
  const [unit, setUnit] = useState<RecurrenceUnit>(existing?.unit ?? 'month');
  const [interval, setInterval] = useState(String(existing?.interval ?? 1));
  const [startDate, setStartDate] = useState(existing?.startDate ?? todayLocal());
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  const [autoPost, setAutoPost] = useState(existing?.autoPost ?? false);
  const account = state.accounts.find((item) => item.id === accountId) ?? initialAccount;
  const categories = state.categories.filter((item) => item.kind === kind && !item.archived);

  const save = async () => {
    if (!account) return;
    try {
      await repository.saveRecurringRule({
        template: { kind, title: title.trim() || 'Recurring transaction', note: '', accountId: account.id, categoryId: categoryId || null, tagIds: [], amountMinor: parseMoney(amount, account.currency, state.settings.locale), currency: account.currency },
        unit,
        interval: Math.max(1, Number(interval) || 1),
        startDate,
        endDate: endDate || null,
        nextDueDate: existing?.nextDueDate ?? startDate,
        autoPost,
        active: true,
      }, existing?.id);
      await repository.generateRecurring();
      router.replace('/more');
    } catch (reason) {
      Alert.alert('Couldn’t save schedule', reason instanceof Error ? reason.message : 'Try again.');
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, paddingBottom: 40, gap: 16, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
      <Card style={{ gap: 16 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>{(['expense', 'income'] as CategoryKind[]).map((item) => <View key={item} style={{ flex: 1 }}><ChoiceChip label={item[0].toUpperCase() + item.slice(1)} selected={kind === item} onPress={() => { setKind(item); setCategoryId(''); }} /></View>)}</View>
        <FormField label="Title" value={title} onChangeText={setTitle} placeholder="Rent, salary, subscription…" />
        <FormField label={`Amount (${account?.currency ?? state.settings.baseCurrency})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
        <AppText variant="label">Account</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{state.accounts.filter((item) => !item.archived).map((item) => <ChoiceChip key={item.id} label={item.name} selected={accountId === item.id} onPress={() => setAccountId(item.id)} />)}</View>
        <AppText variant="label">Category</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{categories.map((item) => <ChoiceChip key={item.id} label={item.name} selected={categoryId === item.id} onPress={() => setCategoryId(item.id)} />)}</View>
      </Card>

      <Card style={{ gap: 16 }}>
        <AppText variant="label">Repeats</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{(['day', 'week', 'month', 'year'] as RecurrenceUnit[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={unit === item} onPress={() => setUnit(item)} />)}</View>
        <FormField label="Every" value={interval} onChangeText={setInterval} keyboardType="number-pad" hint={`Every ${interval || '1'} ${unit}${Number(interval) === 1 ? '' : 's'}.`} />
        <FormField label="Starts" value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" />
        <FormField label="Ends (optional)" value={endDate} onChangeText={setEndDate} placeholder="YYYY-MM-DD" />
        <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
          <View style={{ flex: 1, gap: 2 }}><AppText variant="label">Post automatically</AppText><AppText variant="caption" muted>Off by default. Upcoming items wait for your review.</AppText></View>
          <Switch value={autoPost} onValueChange={setAutoPost} trackColor={{ true: theme.staticAccent }} />
        </View>
      </Card>

      <ActionButton title={existing ? 'Save schedule' : 'Create schedule'} icon="checkmark" onPress={save} />
      {existing ? <ActionButton title="Delete schedule" variant="danger" onPress={async () => { await repository.deleteEntities('recurringRules', [existing.id]); router.replace('/more'); }} /> : null}
    </ScrollView>
  );
}
