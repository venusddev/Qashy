import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { ColorSwatch } from '@/components/ui/color-swatch';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import type { AccountType } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { validateCurrencyCode, validateMoneyInput } from '@/utils/form-validation';
import { hapticSuccess } from '@/utils/haptics';
import { minorToLocalizedDecimalString, parseMoney } from '@/utils/money';

const COLORS = ['#5966E9', '#007AFF', '#00A58E', '#36A852', '#E7892C', '#E0516B', '#A95BCD'];

export function AccountFormScreen() {
  const { id, returnTo } = useLocalSearchParams<{ id?: string; returnTo?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.accounts.find((item) => item.id === id) : undefined;
  const [expectedRevision] = useState(existing?.revision);
  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<AccountType>(existing?.type ?? 'checking');
  const [currency, setCurrency] = useState(existing?.currency ?? state.settings.baseCurrency);
  const [opening, setOpening] = useState(existing ? minorToLocalizedDecimalString(existing.openingBalanceMinor, existing.currency, state.settings.locale) : '0');
  const [openingTouched, setOpeningTouched] = useState(false);
  const [color, setColor] = useState(existing?.color ?? theme.staticAccent);
  const [busy, setBusy] = useState(false);
  const currencyLocked = !!existing && (
    state.transactions.some((item) => item.accountId === existing.id || item.destinationAccountId === existing.id) ||
    state.recurringRules.some((item) => item.template.accountId === existing.id)
  );
  const currencyError = validateCurrencyCode(currency, state.settings.locale);
  const openingError = currencyError
    ? undefined
    : validateMoneyInput(opening, currency, state.settings.locale, { label: 'Opening balance' });
  const canSave = !currencyError && !openingError;

  const changeCurrency = (value: string) => {
    setCurrency(value);
    // An untouched opening balance keeps representing the stored minor amount
    // instead of being silently reinterpreted under the new currency's digits.
    if (existing && !openingTouched && /^[A-Za-z]{3}$/.test(value)) {
      try {
        setOpening(minorToLocalizedDecimalString(existing.openingBalanceMinor, value.toUpperCase(), state.settings.locale));
      } catch {
        // Unknown currency code while typing; leave the field as-is.
      }
    }
  };

  const save = async () => {
    if (busy || !canSave) return;
    setBusy(true);
    try {
      await repository.saveAccount({ name: name.trim() || 'Account', type, currency: currency.toUpperCase(), openingBalanceMinor: parseMoney(opening, currency, state.settings.locale), icon: 'wallet.bifold', color, archived: false }, existing?.id, expectedRevision);
      hapticSuccess();
      if (!existing && returnTo === '/transaction' && router.canGoBack()) router.back();
      else router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t save account', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!existing || busy) return;
    if (!(await confirmDestructive({ title: `Archive ${existing.name}?`, message: 'The account is hidden from lists and pickers. You can restore it from the Archived section in More.', confirmLabel: 'Archive' }))) return;
    setBusy(true);
    try {
      await repository.saveAccount({ ...existing, archived: true }, existing.id, expectedRevision);
      router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t archive account', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (id && !existing) return <Redirect href="/more" />;

  return (
    <FormScreen contentContainerStyle={{ gap: 16 }}>
      <Card style={{ gap: 16 }}>
        <FormField label="Account name" value={name} onChangeText={setName} placeholder="Everyday" autoFocus={!existing} />
        <AppText variant="label">Type</AppText>
        <View accessibilityLabel="Account type" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{(['checking', 'cash', 'savings', 'credit', 'wallet'] as AccountType[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={type === item} onPress={() => setType(item)} />)}</View>
        <FormField label="Currency" value={currency} onChangeText={changeCurrency} maxLength={3} autoCapitalize="characters" editable={!currencyLocked} error={currencyLocked ? undefined : currencyError} hint={currencyLocked ? 'Currency is locked because this account has transaction or schedule history.' : undefined} required />
        <FormField label="Opening balance" value={opening} onChangeText={(value) => { setOpeningTouched(true); setOpening(value); }} keyboardType="decimal-pad" error={openingError} hint="Changing this adjusts the derived account balance." required />
        <AppText variant="label">Color</AppText>
        <View accessibilityLabel="Account color" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>{COLORS.map((item) => <ColorSwatch key={item} color={item} selected={color === item} label={`Use ${item} account color`} onPress={() => setColor(item)} />)}</View>
      </Card>
      <ActionButton title={busy ? 'Saving…' : existing ? 'Save account' : 'Create account'} icon="checkmark" onPress={save} disabled={busy || !canSave} busy={busy} />
      {existing && state.accounts.filter((item) => !item.archived).length > 1 ? <ActionButton title="Archive account" variant="danger" onPress={archive} disabled={busy} /> : null}
    </FormScreen>
  );
}
