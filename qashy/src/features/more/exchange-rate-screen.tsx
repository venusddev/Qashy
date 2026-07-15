import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { ActionButton } from '@/components/ui/action-button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { todayLocal } from '@/utils/date';

export function ExchangeRateScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const existing = id ? state.exchangeRates.find((item) => item.id === id) : undefined;
  const [fromCurrency, setFromCurrency] = useState(existing?.fromCurrency ?? 'EUR');
  const [rate, setRate] = useState(existing?.rate ?? '1');
  const [effectiveDate, setEffectiveDate] = useState(existing?.effectiveDate ?? todayLocal());
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await repository.saveExchangeRate({ fromCurrency: fromCurrency.toUpperCase(), toCurrency: state.settings.baseCurrency, rate, effectiveDate }, existing?.id);
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
  return (
    <FormScreen maxWidth={620} contentContainerStyle={{ gap: 16 }}>
      <Card style={{ gap: 16 }}>
        <FormField label="From currency" value={fromCurrency} onChangeText={setFromCurrency} autoCapitalize="characters" maxLength={3} />
        <FormField label={`1 ${fromCurrency.toUpperCase()} equals how many ${state.settings.baseCurrency}?`} value={rate} onChangeText={setRate} keyboardType="decimal-pad" />
        <FormField label="Effective date" value={effectiveDate} onChangeText={setEffectiveDate} placeholder="YYYY-MM-DD" />
      </Card>
      <ActionButton title={saving ? 'Saving…' : 'Save rate'} icon="checkmark" onPress={save} disabled={saving} />
      {existing ? <ActionButton title="Delete rate" variant="danger" onPress={remove} disabled={saving} /> : null}
    </FormScreen>
  );
}
