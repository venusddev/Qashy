import { router } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ScreenContainer } from '@/components/ui/screen-container';
import { SectionHeader } from '@/components/ui/section-header';
import { SettingsRow } from '@/components/ui/settings-row';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { endOfMonth, startOfMonth } from '@/utils/date';
import { formatMoney } from '@/utils/money';

export function MoreScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 860;
  const summary = useMemo(() => {
    void state.accounts;
    void state.budgetPeriods;
    void state.budgets;
    void state.categories;
    void state.exchangeRates;
    void state.settings;
    void state.transactions;
    return repository.getDashboard(startOfMonth(), endOfMonth());
  }, [repository, state.accounts, state.budgetPeriods, state.budgets, state.categories, state.exchangeRates, state.settings, state.transactions]);
  const activeAccounts = state.accounts.filter((item) => !item.archived);
  const recurring = state.recurringRules.filter((item) => item.active);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }}>
      <ScreenContainer>
        <View style={{ flexDirection: wide ? 'row' : 'column', gap: 18, alignItems: 'flex-start' }}>
          <View style={{ flex: 1, width: '100%', gap: 14 }}>
            <SectionHeader title="Accounts" action="Add" onAction={() => router.push('/account')} />
            <Card style={{ paddingVertical: 8 }}>
              {activeAccounts.map((account) => {
                const balance = summary.accountBalances.find((item) => item.account.id === account.id)?.balanceMinor ?? account.openingBalanceMinor;
                return <SettingsRow key={account.id} title={account.name} subtitle={`${account.type} · ${account.currency}`} value={formatMoney(balance, account.currency, state.settings.locale)} icon="wallet" color={account.color} onPress={() => router.push({ pathname: '/account', params: { id: account.id } })} />;
              })}
            </Card>

            <SectionHeader title="Categories" action="Add" onAction={() => router.push('/category')} />
            <Card style={{ paddingVertical: 8 }}>
              {state.categories.filter((item) => !item.archived).map((category) => <SettingsRow key={category.id} title={category.name} subtitle={category.kind} icon={category.kind === 'income' ? 'arrow.down' : 'arrow.up'} color={category.color} onPress={() => router.push({ pathname: '/category', params: { id: category.id } })} />)}
            </Card>
          </View>

          <View style={{ flex: 1, width: '100%', gap: 14 }}>
            <SectionHeader title="Automation" action="New recurring" onAction={() => router.push('/recurring')} />
            <Card style={{ paddingVertical: 8 }}>
              {recurring.length ? recurring.map((rule) => <SettingsRow key={rule.id} title={rule.template.title} subtitle={`${rule.unit === 'month' ? 'Monthly' : rule.unit} · next ${rule.nextDueDate}`} value={formatMoney(rule.template.amountMinor, rule.template.currency, state.settings.locale)} icon="repeat" onPress={() => router.push({ pathname: '/recurring', params: { id: rule.id } })} />) : <View style={{ padding: 16 }}><AppText muted>Subscriptions and scheduled income will appear here.</AppText></View>}
            </Card>

            <SectionHeader title="Exchange rates" action="Add rate" onAction={() => router.push('/exchange-rate')} />
            <Card style={{ paddingVertical: 8 }}>
              {state.exchangeRates.length ? state.exchangeRates.map((rate) => <SettingsRow key={rate.id} title={`${rate.fromCurrency} → ${rate.toCurrency}`} subtitle={`Effective ${rate.effectiveDate}`} value={rate.rate} icon="arrow.left.arrow.right" onPress={() => router.push({ pathname: '/exchange-rate', params: { id: rate.id } })} />) : <View style={{ padding: 16 }}><AppText muted>Add a manual rate when you create an account in another currency.</AppText></View>}
            </Card>

            <SectionHeader title="Qashy" />
            <Card style={{ paddingVertical: 8 }}>
              <SettingsRow title="Appearance" subtitle="Theme, Material You, and accent" icon="paintbrush" onPress={() => router.push('/appearance')} />
              <SettingsRow title="Import & export" subtitle="CSV portability" icon="tray" onPress={() => router.push('/csv')} />
              <SettingsRow title="Privacy" subtitle="Local-first · no account · no tracking" icon="checkmark" />
            </Card>
          </View>
        </View>
      </ScreenContainer>
    </ScrollView>
  );
}
