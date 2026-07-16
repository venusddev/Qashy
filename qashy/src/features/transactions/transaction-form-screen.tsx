import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import { TextButton } from '@/components/ui/text-button';
import type { TransactionKind } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { todayLocal } from '@/utils/date';
import {
  validateDateInput,
  validateMoneyInput,
  validatePositiveDecimal,
} from '@/utils/form-validation';
import {
  localizeDecimalString,
  minorToLocalizedDecimalString,
  normalizeDecimalString,
  parseMoney,
} from '@/utils/money';

export function TransactionFormScreen() {
  const { id, returnTo } = useLocalSearchParams<{ id?: string; returnTo?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.transactions.find((item) => item.id === id) : undefined;
  const defaultAccount = state.accounts.find((item) => !item.archived);
  const [kind, setKind] = useState<TransactionKind>(existing?.kind ?? 'expense');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [amount, setAmount] = useState(() => existing
    ? minorToLocalizedDecimalString(existing.amountMinor, existing.currency, state.settings.locale)
    : '');
  const [date, setDate] = useState(existing?.localDate ?? todayLocal());
  const [accountId, setAccountId] = useState(existing?.accountId ?? defaultAccount?.id ?? '');
  const [destinationAccountId, setDestinationAccountId] = useState(existing?.destinationAccountId ?? '');
  const [categoryId, setCategoryId] = useState(existing?.categoryId ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [exchangeRate, setExchangeRate] = useState(() => existing?.exchangeRate
    ? localizeDecimalString(existing.exchangeRate, state.settings.locale)
    : '');
  const existingDestination = state.accounts.find((item) => item.id === existing?.destinationAccountId);
  const [destinationAmount, setDestinationAmount] = useState(() =>
    existing && existing.destinationAmountMinor !== null && existingDestination
      ? minorToLocalizedDecimalString(existing.destinationAmountMinor, existingDestination.currency, state.settings.locale)
      : '',
  );
  const [busy, setBusy] = useState(false);
  const account = state.accounts.find((item) => item.id === accountId) ?? defaultAccount;
  const destinationAccount = state.accounts.find((item) => item.id === destinationAccountId);
  const categories = useMemo(() => state.categories.filter((item) => !item.archived && item.kind === (kind === 'income' ? 'income' : 'expense')), [state.categories, kind]);
  const needsRate = account && account.currency !== state.settings.baseCurrency;
  const destinationChoices = useMemo(() => {
    const active = state.accounts.filter((item) => !item.archived && item.id !== accountId);
    const current = state.accounts.find((item) => item.id === destinationAccountId);
    return current && current.archived && current.id !== accountId ? [current, ...active] : active;
  }, [state.accounts, accountId, destinationAccountId]);
  // A saved transaction may reference an account that was archived later;
  // keep it visible (disabled) so the selection isn't silently blank.
  const accountChoices = useMemo(() => {
    const active = state.accounts.filter((item) => !item.archived);
    const current = state.accounts.find((item) => item.id === accountId);
    return current && current.archived ? [current, ...active] : active;
  }, [state.accounts, accountId]);

  const amountError = account
    ? validateMoneyInput(amount, account.currency, state.settings.locale, { label: 'Amount', positive: true })
    : 'Choose an account before entering an amount.';
  const dateError = validateDateInput(date);
  const sameCurrencyTransfer = kind === 'transfer' &&
    !!account &&
    !!destinationAccount &&
    account.currency === destinationAccount.currency;
  const destinationAmountError = kind === 'transfer' && destinationAccount && !sameCurrencyTransfer
    ? validateMoneyInput(destinationAmount, destinationAccount.currency, state.settings.locale, {
      label: 'Destination amount',
      optional: true,
      positive: true,
    })
    : undefined;
  const exchangeRateError = needsRate
    ? validatePositiveDecimal(exchangeRate, 'Exchange rate', true, state.settings.locale)
    : undefined;
  const destinationError = kind === 'transfer' && !destinationAccountId
    ? 'Choose a destination account.'
    : undefined;
  const canSave = Boolean(account)
    && !amountError
    && !dateError
    && !destinationAmountError
    && !exchangeRateError
    && !destinationError;

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
        destinationAmountMinor: kind === 'transfer' &&
          destinationAccount &&
          !sameCurrencyTransfer &&
          destinationAmount.trim()
          ? parseMoney(destinationAmount, destinationAccount.currency, state.settings.locale)
          : null,
        categoryId: kind === 'transfer' ? null : categoryId || null,
        amountMinor: parseMoney(amount, account.currency, state.settings.locale),
        exchangeRate: needsRate && exchangeRate.trim()
          ? normalizeDecimalString(exchangeRate, state.settings.locale)
          : undefined,
        status: existing?.status ?? 'posted',
      }, existing?.id);
      router.dismissTo(returnTo === '/overview' ? '/overview' : '/transactions');
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
      router.dismissTo(returnTo === '/overview' ? '/overview' : '/transactions');
    } catch (reason) {
      showError('Couldn’t delete transaction', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormScreen>
      <View accessibilityLabel="Transaction kind" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8 }}>
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
          error={amountError}
          required
          style={{ fontSize: 30, fontWeight: '700', minHeight: 68, fontVariant: ['tabular-nums'] }}
        />
        <FormField label="Title" value={title} onChangeText={setTitle} placeholder={kind === 'transfer' ? 'Transfer' : 'What was it?'} />
        <FormField label="Date" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" autoCapitalize="none" error={dateError} required />
      </Card>

      <Card style={{ gap: 14 }}>
        <AppText variant="label">From account</AppText>
        <View accessibilityLabel="From account" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {accountChoices.map((item) => <ChoiceChip key={item.id} label={`${item.name} · ${item.currency}${item.archived ? ' (archived)' : ''}`} disabled={item.archived} selected={accountId === item.id} onPress={() => { setAccountId(item.id); setExchangeRate(''); setDestinationAmount(''); if (destinationAccountId === item.id) setDestinationAccountId(''); }} />)}
        </View>
        {kind === 'transfer' ? (
          <>
            <AppText variant="label">To account</AppText>
            {destinationChoices.length ? (
              <View accessibilityLabel="To account" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {destinationChoices.map((item) => <ChoiceChip key={item.id} label={`${item.name} · ${item.currency}${item.archived ? ' (archived)' : ''}`} disabled={item.archived} selected={destinationAccountId === item.id} onPress={() => { setDestinationAccountId(item.id); setDestinationAmount(''); }} />)}
              </View>
            ) : (
              <View role="alert" style={{ gap: 10, padding: 14, borderRadius: 14, backgroundColor: theme.surfaceMuted }}>
                <AppText variant="label">Transfers need two accounts</AppText>
                <AppText variant="caption" muted>Add another account, then return here to finish this transfer. Your draft will stay open.</AppText>
                <ActionButton
                  title="Add another account"
                  variant="secondary"
                  onPress={() => router.push({ pathname: '/account', params: { returnTo: '/transaction' } })}
                />
              </View>
            )}
            {destinationError && destinationChoices.length ? <AppText accessibilityRole="alert" variant="caption" style={{ color: theme.negative }}>{destinationError}</AppText> : null}
            {destinationAccount && !sameCurrencyTransfer ? (
              <FormField
                label={`Destination amount (${destinationAccount.currency})`}
                value={destinationAmount}
                onChangeText={setDestinationAmount}
                keyboardType="decimal-pad"
                placeholder="Calculated from saved rates"
                error={destinationAmountError}
                hint="Leave blank to calculate through your effective exchange rates."
              />
            ) : sameCurrencyTransfer ? (
              <AppText variant="caption" muted>The destination receives the same amount; same-currency transfers always conserve value.</AppText>
            ) : null}
          </>
        ) : (
          <>
            <AppText variant="label">Category</AppText>
            <View accessibilityLabel="Category" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {categories.map((item) => <ChoiceChip key={item.id} label={item.name} selected={categoryId === item.id} onPress={() => setCategoryId(item.id)} />)}
            </View>
          </>
        )}
      </Card>

      {needsRate ? (
        <Card><FormField label={`1 ${account.currency} equals how many ${state.settings.baseCurrency}?`} value={exchangeRate} onChangeText={setExchangeRate} keyboardType="decimal-pad" placeholder="Use saved effective rate" error={exchangeRateError} hint="Leave blank to use the saved rate for this date. The applied rate is snapshotted." /></Card>
      ) : null}

      <Card style={{ gap: 14 }}>
        <FormField label="Note" value={note} onChangeText={setNote} placeholder="Optional context" multiline style={{ minHeight: 92, textAlignVertical: 'top' }} />
        {!existing && kind !== 'transfer' ? (
          <TextButton title="Make this recurring instead" onPress={() => router.push({ pathname: '/recurring', params: { kind, title, amount, accountId, categoryId } })} style={{ alignSelf: 'flex-start' }} />
        ) : null}
      </Card>

      <ActionButton title={busy ? 'Saving…' : existing ? 'Save changes' : 'Add transaction'} icon="checkmark" onPress={save} disabled={busy || !canSave} busy={busy} />
      {existing ? <ActionButton title="Delete transaction" variant="danger" onPress={remove} disabled={busy} /> : null}
    </FormScreen>
  );
}
