import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import type { AccountType } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { currencyDigits, parseMoney } from '@/utils/money';

const COLORS = ['#5966E9', '#007AFF', '#00A58E', '#36A852', '#E7892C', '#E0516B', '#A95BCD'];

export function AccountFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.accounts.find((item) => item.id === id) : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [type, setType] = useState<AccountType>(existing?.type ?? 'checking');
  const [currency, setCurrency] = useState(existing?.currency ?? state.settings.baseCurrency);
  const [opening, setOpening] = useState(existing ? String(existing.openingBalanceMinor / 10 ** currencyDigits(existing.currency, state.settings.locale)) : '0');
  const [color, setColor] = useState(existing?.color ?? theme.staticAccent);
  const currencyLocked = !!existing && (
    state.transactions.some((item) => item.accountId === existing.id || item.destinationAccountId === existing.id) ||
    state.recurringRules.some((item) => item.template.accountId === existing.id)
  );

  const save = async () => {
    try {
      await repository.saveAccount({ name: name.trim() || 'Account', type, currency: currency.toUpperCase(), openingBalanceMinor: parseMoney(opening, currency, state.settings.locale), icon: 'wallet.bifold', color, archived: false }, existing?.id);
      router.replace('/more');
    } catch (reason) {
      Alert.alert('Couldn’t save account', reason instanceof Error ? reason.message : 'Try again.');
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, gap: 16, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
      <Card style={{ gap: 16 }}>
        <FormField label="Account name" value={name} onChangeText={setName} placeholder="Everyday" autoFocus={!existing} />
        <AppText variant="label">Type</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{(['checking', 'cash', 'savings', 'credit', 'wallet'] as AccountType[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={type === item} onPress={() => setType(item)} />)}</View>
        <FormField label="Currency" value={currency} onChangeText={setCurrency} maxLength={3} autoCapitalize="characters" editable={!currencyLocked} hint={currencyLocked ? 'Currency is locked because this account has transaction or schedule history.' : undefined} />
        <FormField label="Opening balance" value={opening} onChangeText={setOpening} keyboardType="decimal-pad" hint="Changing this adjusts the derived account balance." />
        <AppText variant="label">Color</AppText>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>{COLORS.map((item) => <Pressable key={item} accessibilityRole="button" accessibilityLabel={`Use ${item} account color`} onPress={() => setColor(item)} style={{ width: 44, height: 44, borderRadius: 99, backgroundColor: item, borderWidth: color === item ? 3 : 0, borderColor: theme.text }} />)}</View>
      </Card>
      <ActionButton title={existing ? 'Save account' : 'Create account'} icon="checkmark" onPress={save} />
      {existing && state.accounts.filter((item) => !item.archived).length > 1 ? <ActionButton title="Archive account" variant="danger" onPress={async () => { await repository.saveAccount({ ...existing, archived: true }, existing.id); router.replace('/more'); }} /> : null}
    </ScrollView>
  );
}
