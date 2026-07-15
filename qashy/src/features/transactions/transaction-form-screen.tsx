import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import type { TransactionKind } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { todayLocal } from '@/utils/date';
import { currencyDigits, parseMoney } from '@/utils/money';

export function TransactionFormScreen() {
  const { id, returnTo } = useLocalSearchParams<{ id?: string; returnTo?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.transactions.find((item) => item.id === id) : undefined;
  const defaultAccount = state.accounts.find((item) => !item.archived);
  const [kind, setKind] = useState<TransactionKind>(existing?.kind ?? 'expense');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [amount, setAmount] = useState(() => existing ? String(existing.amountMinor / 10 ** currencyDigits(existing.currency, state.settings.locale)) : '');
  const [date, setDate] = useState(existing?.localDate ?? todayLocal());
  const [accountId, setAccountId] = useState(existing?.accountId ?? defaultAccount?.id ?? '');
  const [destinationAccountId, setDestinationAccountId] = useState(existing?.destinationAccountId ?? '');
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [exchangeRate, setExchangeRate] = useState(existing?.exchangeRate ?? '1');
  const [saving, setSaving] = useState(false);
  const account = state.accounts.find((item) => item.id === accountId) ?? defaultAccount;
  const categories = useMemo(() => state.categories.filter((item) => !item.archived && item.kind === (kind === 'income' ? 'income' : 'expense')), [state.categories, kind]);
  const needsRate = account && account.currency !== state.settings.baseCurrency;

  const save = async () => {
    if (!account) return;
    setSaving(true);
    try {
      await repository.saveTransaction({
        kind,
        title: title || (kind === 'transfer' ? 'Transfer' : categories.find((item) => item.id === categoryId)?.name ?? 'Transaction'),
        note,
        localDate: date,
        accountId: account.id,
        destinationAccountId: kind === 'transfer' ? destinationAccountId : null,
        categoryId: kind === 'transfer' ? null : categoryId || null,
        amountMinor: parseMoney(amount, account.currency, state.settings.locale),
        exchangeRate: needsRate ? exchangeRate : '1',
        status: existing?.status ?? 'posted',
      }, existing?.id);
      router.replace(returnTo === '/overview' ? '/overview' : '/transactions');
    } catch (reason) {
      Alert.alert('Couldn’t save transaction', reason instanceof Error ? reason.message : 'Check the form and try again.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    await repository.deleteEntities('transactions', [existing.id]);
    router.replace(returnTo === '/overview' ? '/overview' : '/transactions');
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, paddingBottom: 44, gap: 18, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['expense', 'income', 'transfer'] as TransactionKind[]).map((item) => (
          <View key={item} style={{ flex: 1 }}><ChoiceChip label={item[0].toUpperCase() + item.slice(1)} selected={kind === item} onPress={() => setKind(item)} /></View>
        ))}
      </View>

      <Card style={{ gap: 16 }}>
        <FormField label={`Amount (${account?.currency ?? state.settings.baseCurrency})`} value={amount} onChangeText={setAmount} placeholder="0.00" keyboardType="decimal-pad" autoFocus={!existing} style={{ fontSize: 30, fontWeight: '700', minHeight: 68, fontVariant: ['tabular-nums'] }} />
        <FormField label="Title" value={title} onChangeText={setTitle} placeholder={kind === 'transfer' ? 'Transfer' : 'What was it?'} />
        <FormField label="Date" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" autoCapitalize="none" />
      </Card>

      <Card style={{ gap: 14 }}>
        <AppText variant="label">From account</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {state.accounts.filter((item) => !item.archived).map((item) => <ChoiceChip key={item.id} label={`${item.name} · ${item.currency}`} selected={accountId === item.id} onPress={() => { setAccountId(item.id); if (destinationAccountId === item.id) setDestinationAccountId(''); }} />)}
        </View>
        {kind === 'transfer' ? (
          <>
            <AppText variant="label">To account</AppText>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {state.accounts.filter((item) => !item.archived && item.id !== accountId).map((item) => <ChoiceChip key={item.id} label={`${item.name} · ${item.currency}`} selected={destinationAccountId === item.id} onPress={() => setDestinationAccountId(item.id)} />)}
            </View>
          </>
        ) : (
          <>
            <AppText variant="label">Category</AppText>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {categories.map((item) => <ChoiceChip key={item.id} label={item.name} selected={categoryId === item.id} onPress={() => setCategoryId(item.id)} />)}
            </View>
          </>
        )}
      </Card>

      {needsRate ? (
        <Card><FormField label={`1 ${account.currency} equals how many ${state.settings.baseCurrency}?`} value={exchangeRate} onChangeText={setExchangeRate} keyboardType="decimal-pad" hint="The rate is saved on this transaction so old reports stay stable." /></Card>
      ) : null}

      <Card style={{ gap: 14 }}>
        <FormField label="Note" value={note} onChangeText={setNote} placeholder="Optional context" multiline style={{ minHeight: 92, textAlignVertical: 'top' }} />
        {!existing && kind !== 'transfer' ? (
          <Pressable onPress={() => router.push({ pathname: '/recurring', params: { kind, title, amount, accountId, categoryId } })}>
            <AppText variant="label" style={{ color: theme.accent }}>Make this recurring instead</AppText>
          </Pressable>
        ) : null}
      </Card>

      <ActionButton title={saving ? 'Saving…' : existing ? 'Save changes' : 'Add transaction'} icon="checkmark" onPress={save} disabled={saving} />
      {existing ? <ActionButton title="Delete transaction" variant="danger" onPress={remove} /> : null}
    </ScrollView>
  );
}
