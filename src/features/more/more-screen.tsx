import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { PageHeading } from '@/components/ui/page-heading';
import { ScreenContainer } from '@/components/ui/screen-container';
import { SectionHeader } from '@/components/ui/section-header';
import { SettingsRow } from '@/components/ui/settings-row';
import { useLocalization } from '@/localization/localization';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { endOfMonth, startOfMonth } from '@/utils/date';
import { formatMoney } from '@/utils/money';

export function MoreScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { t } = useLocalization();
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
  const archivedAccounts = state.accounts.filter((item) => item.archived);
  const archivedCategories = state.categories.filter((item) => item.archived);
  const recurring = state.recurringRules;
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const restore = async (entity: 'account' | 'category', id: string) => {
    if (restoringId) return;
    setRestoringId(id);
    try {
      if (entity === 'account') {
        const account = state.accounts.find((item) => item.id === id);
        if (account) await repository.saveAccount({ ...account, archived: false }, account.id);
      } else {
        const category = state.categories.find((item) => item.id === id);
        if (category) await repository.saveCategory({ ...category, archived: false }, category.id);
      }
    } catch (reason) {
      showError('Couldn’t restore', errorMessage(reason, 'Rename the active entry using this name first.'));
    } finally {
      setRestoringId(null);
    }
  };

  const resetAllData = async () => {
    if (resetting) return;
    const confirmed = await confirmDestructive({
      title: 'Reset Qashy?',
      message: 'This permanently deletes every account, transaction, budget, goal, recurring transaction, exchange rate, category, and setting stored by Qashy on this device. This cannot be undone.',
      confirmLabel: 'Reset everything',
    });
    if (!confirmed) return;
    setResetting(true);
    try {
      await repository.resetAllData();
      router.replace('/');
    } catch (reason) {
      showError('Couldn’t finish resetting Qashy', errorMessage(reason, 'Restart the app and try again.'));
      setResetting(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }}>
      <ScreenContainer>
        <PageHeading title="More" subtitle="Accounts, categories, automation, portability, and appearance." />
        <View style={{ flexDirection: wide ? 'row' : 'column', gap: 18, alignItems: 'flex-start' }}>
          <View style={{ flex: wide ? 1 : undefined, width: '100%', gap: 14 }}>
            <SectionHeader title="Accounts" action="Add" onAction={() => router.push('/account')} />
            <Card style={{ paddingVertical: 8 }}>
              {activeAccounts.map((account) => {
                const balance = summary.accountBalances.find((item) => item.account.id === account.id)?.balanceMinor ?? account.openingBalanceMinor;
                return <SettingsRow key={account.id} literal title={account.name} subtitle={`${t(account.type)} · ${account.currency}`} value={formatMoney(balance, account.currency, state.settings.locale)} icon="wallet" color={account.color} onPress={() => router.push({ pathname: '/account', params: { id: account.id } })} />;
              })}
            </Card>

            <SectionHeader title="Categories" action="Add" onAction={() => router.push('/category')} />
            <Card style={{ paddingVertical: 8 }}>
              {state.categories.filter((item) => !item.archived).map((category) => <SettingsRow key={category.id} literal title={category.name} subtitle={t(category.kind)} icon={category.icon} color={category.color} onPress={() => router.push({ pathname: '/category', params: { id: category.id } })} />)}
            </Card>
          </View>

          <View style={{ flex: wide ? 1 : undefined, width: '100%', gap: 14 }}>
            <SectionHeader title="Automation" action="New recurring" onAction={() => router.push('/recurring')} />
            <Card style={{ paddingVertical: 8 }}>
              {recurring.length ? recurring.map((rule) => {
                const ended = Boolean(rule.endDate && rule.nextDueDate > rule.endDate);
                const status = ended ? 'Ended' : rule.active ? `Next ${rule.nextDueDate}` : 'Paused';
                const frequency = rule.interval === 1
                  ? rule.unit === 'month'
                    ? t('Monthly')
                    : t(`${rule.unit[0].toUpperCase()}${rule.unit.slice(1)}`)
                  : t(`Every ${rule.interval} ${rule.unit}s.`);
                return <SettingsRow key={rule.id} literal title={rule.template.title} subtitle={`${frequency} · ${t(status)}`} value={formatMoney(rule.template.amountMinor, rule.template.currency, state.settings.locale)} icon="repeat" onPress={() => router.push({ pathname: '/recurring', params: { id: rule.id } })} />;
              }) : <View style={{ padding: 16 }}><AppText muted>Subscriptions and scheduled income will appear here.</AppText></View>}
            </Card>

            <SectionHeader title="Exchange rates" action="Add rate" onAction={() => router.push('/exchange-rate')} />
            <Card style={{ paddingVertical: 8 }}>
              {state.exchangeRates.length ? state.exchangeRates.map((rate) => <SettingsRow key={rate.id} literal title={`${rate.fromCurrency} → ${rate.toCurrency}`} subtitle={t(`Effective ${rate.effectiveDate}`)} value={rate.rate} icon="arrow.left.arrow.right" onPress={() => router.push({ pathname: '/exchange-rate', params: { id: rate.id } })} />) : <View style={{ padding: 16 }}><AppText muted>Add a manual rate when you create an account in another currency.</AppText></View>}
            </Card>

            {archivedAccounts.length || archivedCategories.length ? (
              <>
                <SectionHeader title="Archived" />
                <Card style={{ paddingVertical: 8 }}>
                  {archivedAccounts.map((account) => <SettingsRow key={account.id} literal title={account.name} subtitle={t(`Archived account · ${account.currency}`)} value={t(restoringId === account.id ? 'Restoring…' : 'Restore')} icon="wallet" color={account.color} onPress={() => restore('account', account.id)} />)}
                  {archivedCategories.map((category) => <SettingsRow key={category.id} literal title={category.name} subtitle={t(`Archived ${category.kind} category`)} value={t(restoringId === category.id ? 'Restoring…' : 'Restore')} icon={category.icon} color={category.color} onPress={() => restore('category', category.id)} />)}
                </Card>
              </>
            ) : null}

            <SectionHeader title="Qashy" />
            <Card style={{ paddingVertical: 8 }}>
              <SettingsRow title="Appearance" subtitle="Theme, Material You, and accent" icon="paintbrush" onPress={() => router.push('/appearance')} />
              <SettingsRow title="Import & export" subtitle="CSV portability" icon="tray" onPress={() => router.push('/csv')} />
              <SettingsRow title="Reset all data" subtitle="Delete everything and return to first-time setup" icon="trash" tone="danger" value={resetting ? 'Resetting…' : undefined} disabled={resetting} onPress={resetAllData} />
              <SettingsRow title="Privacy" subtitle="Local-first · no account · no tracking" icon="checkmark" />
            </Card>
          </View>
        </View>
      </ScreenContainer>
    </ScrollView>
  );
}
