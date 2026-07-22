import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { ActionButton } from '@/components/ui/action-button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { todayLocal } from '@/utils/date';
import {
  validateCurrencyCode,
  validateDateInput,
  validatePositiveDecimal,
} from '@/utils/form-validation';
import { hapticSuccess } from '@/utils/haptics';
import {
  localizeDecimalString,
  normalizeDecimalString,
} from '@/utils/money';

export function ExchangeRateScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const existing = id ? state.exchangeRates.find((item) => item.id === id) : undefined;
  const [expectedRevision] = useState(existing?.revision);
  const [fromCurrency, setFromCurrency] = useState(existing?.fromCurrency ?? 'EUR');
  const [rate, setRate] = useState(() => existing?.rate
    ? localizeDecimalString(existing.rate, state.settings.locale)
    : '1');
  const [effectiveDate, setEffectiveDate] = useState(existing?.effectiveDate ?? todayLocal());
  const [saving, setSaving] = useState(false);
  const currencyError = validateCurrencyCode(fromCurrency, state.settings.locale)
    ?? (fromCurrency.toUpperCase() === state.settings.baseCurrency
      ? `Choose a currency other than ${state.settings.baseCurrency}.`
      : undefined);
  const rateError = validatePositiveDecimal(rate, 'Exchange rate', false, state.settings.locale);
  const dateError = validateDateInput(effectiveDate, { label: 'Effective date' });
  const canSave = !currencyError && !rateError && !dateError;
  const save = async () => {
    if (saving || !canSave) return;
    setSaving(true);
    try {
      await repository.saveExchangeRate({
        fromCurrency: fromCurrency.toUpperCase(),
        toCurrency: state.settings.baseCurrency,
        rate: normalizeDecimalString(rate, state.settings.locale),
        effectiveDate,
      }, existing?.id, expectedRevision);
      hapticSuccess();
      router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t save rate', errorMessage(reason, 'Check the form and try again.'));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!existing || saving) return;
    if (!(await confirmDestructive({ title: `Delete the ${existing.fromCurrency} rate?`, message: 'Transactions that need this rate will report it as missing.' }))) return;
    setSaving(true);
    try {
      await repository.deleteEntities('exchangeRates', [existing.id]);
      router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t delete rate', errorMessage(reason, 'Try again.'));
    } finally {
      setSaving(false);
    }
  };
  if (id && !existing) return <Redirect href="/more" />;

  return (
    <FormScreen maxWidth={620} contentContainerStyle={{ gap: 16 }}>
      <Card style={{ gap: 16 }}>
        <FormField label="From currency" value={fromCurrency} onChangeText={setFromCurrency} autoCapitalize="characters" maxLength={3} error={currencyError} required />
        <FormField label={`1 ${fromCurrency.toUpperCase()} equals how many ${state.settings.baseCurrency}?`} value={rate} onChangeText={setRate} keyboardType="decimal-pad" error={rateError} required />
        <FormField label="Effective date" value={effectiveDate} onChangeText={setEffectiveDate} placeholder="YYYY-MM-DD" error={dateError} required />
      </Card>
      <ActionButton title={saving ? 'Saving…' : 'Save rate'} icon="checkmark" onPress={save} disabled={saving || !canSave} busy={saving} />
      {existing ? <ActionButton title="Delete rate" variant="danger" onPress={remove} disabled={saving} /> : null}
    </FormScreen>
  );
}
