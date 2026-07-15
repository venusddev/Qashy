import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import type { TransactionKind } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { isLocalDate, todayLocal } from '@/utils/date';
import { minorToDecimalString, parseMoney } from '@/utils/money';

export function TransactionFormScreen() {
  const { id, returnTo } = useLocalSearchParams<{ id?: string; returnTo?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.transactions.find((item) => item.id === id) : undefined;
  const defaultAccount = state.accounts.find((item) => !item.archived);
  const [kind, setKind] = useState<TransactionKind>(existing?.kind ?? 'expense');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [amount, setAmount] = useState(() => existing ? minorToDecimalString(existing.amountMinor, existing.currency, state.settings.locale) : '');
  const [date, setDate] = useState(existing?.localDate ?? todayLocal());
  const [accountId, setAccountId] = useState(existing?.accountId ?? defaultAccount?.id ?? '');
  const [destinationAccountId, setDestinationAccountId] = useState(existing?.destinationAccountId ?? '');
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [exchangeRate, setExchangeRate] = useState(existing?.exchangeRate ?? '');
  const existingDestination = state.accounts.find((item) => item.id === existing?.destinationAccountId);
  const [destinationAmount, setDestinationAmount] = useState(() =>
    existing && existing.destinationAmountMinor !== null && existingDestination
      ? minorToDecimalString(existing.destinationAmountMinor, existingDestination.currency, state.settings.locale)
      : '',
  );
  const [busy, setBusy] = useState(false);
  const account = state.accounts.find((item) => item.id === accountId) ?? defaultAccount;
  const destinationAccount = state.accounts.find((item) => item.id === destinationAccountId);
  const categories = useMemo(() => state.categories.filter((item) => !item.archived && item.kind === (kind === 'income' ? 'income' : 'expense')), [state.categories, kind]);
  const needsRate = account && account.currency !== state.settings.baseCurrency;
  // A saved transaction may reference an account that was archived later;
  // keep it visible (disabled) so the selection isn't silently blank.
  const accountChoices = useMemo(() => {
    const active = state.accounts.filter((item) => !item.archived);
    const current = state.accounts.find((item) => item.id === accountId);
    return current && current.archived ? [current, ...active] : active;
  }, [state.accounts, accountId]);

  const amountValid = useMemo(() => {
    if (!account) return false;
    try {
      parseMoney(amount, account.currency, state.settings.locale);
      return true;
    } catch {
      return false;
    }
  }, [amount, account, state.settings.locale]);
  const dateValid = isLocalDate(date);
  const canSave = Boolean(account) && amountValid && dateValid && (kind !== 'transfer' || Boolean(destinationAccountId));

  const save = async () => {
    if (!account || busy) return;
    setBusy(true);
    try {
      await repository.saveTransaction({
        kind,
        title: title || (kind === 'transfer' ? 'Transfer' : categories.find((item) => item.id === categoryId)?.name ?? 'Transaction'),
        note,
        localDate: date,
        accountId: account.id,
        destinationAccountId: kind === 'transfer' ? destinationAccountId : null,
        destinationAmountMinor: kind === 'transfer' && destinationAccount && destinationAmount.trim()
          ? parseMoney(destinationAmount, destinationAccount.currency, state.settings.locale)
          : null,
        categoryId: kind === 'transfer' ? null : categoryId || null,
        amountMinor: parseMoney(amount, account.currency, state.settings.locale),
        exchangeRate: needsRate && exchangeRate.trim() ? exchangeRate.trim() : undefined,
        status: existing?.status ?? 'posted',
      }, existing?.id);
      router.replace(returnTo === '/overview' ? '/overview' : '/transactions');
    } catch (reason) {
      showError('Couldn’t save transaction', errorMessage(reason, 'Check the form and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing || busy) return;
    if (!(await confirmDestructive({ title: 'Delete this transaction?', message: `“${existing.title}” will be removed from your ledger.` }))) return;
    setBusy(true);
    try {
      await repository.deleteEntities('transactions', [existing.id]);
      router.replace(returnTo === '/overview' ? '/overview' : '/transactions');
    } catch (reason) {
      showError('Couldn’t delete transaction', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormScreen>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['expense', 'income', 'transfer'] as TransactionKind[]).map((item) => (
          <View key={item} style={{ flex: 1 }}><ChoiceChip label={item[0].toUpperCase() + item.slice(1)} selected={kind === item} onPress={() => { setKind(item); setCategoryId(''); }} /></View>
        ))}
      </View>

      <Card style={{ gap: 16 }}>
        <FormField
          label={`Amount (${account?.currency ?? state.settings.baseCurrency})`}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          keyboardType="decimal-pad"
          autoFocus={!existing}
          hint={amount.trim() && !amountValid ? 'Enter a valid amount greater than zero.' : undefined}
          style={{ fontSize: 30, fontWeight: '700', minHeight: 68, fontVariant: ['tabular-nums'] }}
        />
        <FormField label="Title" value={title} onChangeText={setTitle} placeholder={kind === 'transfer' ? 'Transfer' : 'What was it?'} />
        <FormField label="Date" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" autoCapitalize="none" hint={date.trim() && !dateValid ? 'Use a real date in YYYY-MM-DD format.' : undefined} />
      </Card>

      <Card style={{ gap: 14 }}>
        <AppText variant="label">From account</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {accountChoices.map((item) => <ChoiceChip key={item.id} label={`${item.name} · ${item.currency}${item.archived ? ' (archived)' : ''}`} disabled={item.archived} selected={accountId === item.id} onPress={() => { setAccountId(item.id); setExchangeRate(''); setDestinationAmount(''); if (destinationAccountId === item.id) setDestinationAccountId(''); }} />)}
        </View>
        {kind === 'transfer' ? (
          <>
            <AppText variant="label">To account</AppText>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {state.accounts.filter((item) => !item.archived && item.id !== accountId).map((item) => <ChoiceChip key={item.id} label={`${item.name} · ${item.currency}`} selected={destinationAccountId === item.id} onPress={() => { setDestinationAccountId(item.id); setDestinationAmount(''); }} />)}
            </View>
            {destinationAccount ? (
              <FormField
                label={`Destination amount (${destinationAccount.currency})`}
                value={destinationAmount}
                onChangeText={setDestinationAmount}
                keyboardType="decimal-pad"
                placeholder="Calculated from saved rates"
                hint="Leave blank to calculate through your effective exchange rates."
              />
            ) : null}
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
        <Card><FormField label={`1 ${account.currency} equals how many ${state.settings.baseCurrency}?`} value={exchangeRate} onChangeText={setExchangeRate} keyboardType="decimal-pad" placeholder="Use saved effective rate" hint="Leave blank to use the saved rate for this date. The applied rate is snapshotted." /></Card>
      ) : null}

      <Card style={{ gap: 14 }}>
        <FormField label="Note" value={note} onChangeText={setNote} placeholder="Optional context" multiline style={{ minHeight: 92, textAlignVertical: 'top' }} />
        {!existing && kind !== 'transfer' ? (
          <Pressable onPress={() => router.push({ pathname: '/recurring', params: { kind, title, amount, accountId, categoryId } })}>
            <AppText variant="label" style={{ color: theme.accent }}>Make this recurring instead</AppText>
          </Pressable>
        ) : null}
      </Card>

      <ActionButton title={busy ? 'Saving…' : existing ? 'Save changes' : 'Add transaction'} icon="checkmark" onPress={save} disabled={busy || !canSave} />
      {existing ? <ActionButton title="Delete transaction" variant="danger" onPress={remove} disabled={busy} /> : null}
    </FormScreen>
  );
}
