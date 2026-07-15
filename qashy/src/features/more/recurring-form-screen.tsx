import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import type { CategoryKind, RecurrenceUnit } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { todayLocal } from '@/utils/date';
import { minorToDecimalString, parseMoney } from '@/utils/money';

export function RecurringFormScreen() {
  const params = useLocalSearchParams<{ id?: string; kind?: CategoryKind; title?: string; amount?: string; accountId?: string; categoryId?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = params.id ? state.recurringRules.find((item) => item.id === params.id) : undefined;
  const initialAccount = state.accounts.find((item) => item.id === (existing?.template.accountId ?? params.accountId))
    ?? state.accounts.find((item) => !item.archived);
  const [kind, setKind] = useState<CategoryKind>(existing?.template.kind ?? params.kind ?? 'expense');
  const [title, setTitle] = useState(existing?.template.title ?? params.title ?? '');
  const [amount, setAmount] = useState(existing ? minorToDecimalString(existing.template.amountMinor, existing.template.currency, state.settings.locale) : params.amount ?? '');
  const [accountId, setAccountId] = useState(initialAccount?.id ?? '');
  const [categoryId, setCategoryId] = useState(existing?.template.categoryId ?? params.categoryId ?? '');
  const [unit, setUnit] = useState<RecurrenceUnit>(existing?.unit ?? 'month');
  const [interval, setInterval] = useState(String(existing?.interval ?? 1));
  const [startDate, setStartDate] = useState(existing?.startDate ?? todayLocal());
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  const [autoPost, setAutoPost] = useState(existing?.autoPost ?? false);
  const [busy, setBusy] = useState(false);
  const account = state.accounts.find((item) => item.id === accountId) ?? initialAccount;
  const categories = state.categories.filter((item) => item.kind === kind && !item.archived);

  const save = async () => {
    if (!account || busy) return;
    setBusy(true);
    try {
      const normalizedInterval = Math.max(1, Math.floor(Number(interval) || 1));
      const normalizedEndDate = endDate || null;
      const scheduleChanged = !!existing && (
        existing.unit !== unit ||
        existing.interval !== normalizedInterval ||
        existing.startDate !== startDate ||
        existing.endDate !== normalizedEndDate
      );
      await repository.saveRecurringRule({
        template: { kind, title: title.trim() || 'Recurring transaction', note: '', accountId: account.id, categoryId: categoryId || null, tagIds: [], amountMinor: parseMoney(amount, account.currency, state.settings.locale), currency: account.currency },
        unit,
        interval: normalizedInterval,
        startDate,
        endDate: normalizedEndDate,
        nextDueDate: !existing || scheduleChanged ? startDate : existing.nextDueDate,
        autoPost,
        active: true,
      }, existing?.id);
      await repository.generateRecurring();
      router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t save schedule', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing || busy) return;
    if (!(await confirmDestructive({ title: 'Delete this schedule?', message: 'Already generated transactions stay in your ledger.' }))) return;
    setBusy(true);
    try {
      await repository.deleteEntities('recurringRules', [existing.id]);
      router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t delete schedule', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormScreen contentContainerStyle={{ gap: 16, paddingBottom: 40 }}>
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

      <ActionButton title={busy ? 'Saving…' : existing ? 'Save schedule' : 'Create schedule'} icon="checkmark" onPress={save} disabled={busy} />
      {existing ? <ActionButton title="Delete schedule" variant="danger" onPress={remove} disabled={busy} /> : null}
    </FormScreen>
  );
}
