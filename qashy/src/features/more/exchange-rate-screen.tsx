import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { Card } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { todayLocal } from '@/utils/date';

export function ExchangeRateScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.exchangeRates.find((item) => item.id === id) : undefined;
  const [fromCurrency, setFromCurrency] = useState(existing?.fromCurrency ?? 'EUR');
  const [rate, setRate] = useState(existing?.rate ?? '1');
  const [effectiveDate, setEffectiveDate] = useState(existing?.effectiveDate ?? todayLocal());
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await repository.saveExchangeRate({ fromCurrency: fromCurrency.toUpperCase(), toCurrency: state.settings.baseCurrency, rate, effectiveDate }, existing?.id);
      router.replace('/more');
    } catch (reason) {
      Alert.alert('Couldn’t save rate', reason instanceof Error ? reason.message : 'Check the form and try again.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, gap: 16, width: '100%', maxWidth: 620, alignSelf: 'center' }}>
      <Card style={{ gap: 16 }}>
        <FormField label="From currency" value={fromCurrency} onChangeText={setFromCurrency} autoCapitalize="characters" maxLength={3} />
        <FormField label={`1 ${fromCurrency.toUpperCase()} equals how many ${state.settings.baseCurrency}?`} value={rate} onChangeText={setRate} keyboardType="decimal-pad" />
        <FormField label="Effective date" value={effectiveDate} onChangeText={setEffectiveDate} placeholder="YYYY-MM-DD" />
      </Card>
      <ActionButton title={saving ? 'Saving…' : 'Save rate'} icon="checkmark" onPress={save} disabled={saving} />
      {existing ? <ActionButton title="Delete rate" variant="danger" onPress={async () => { await repository.deleteEntities('exchangeRates', [existing.id]); router.replace('/more'); }} /> : null}
    </ScrollView>
  );
}
