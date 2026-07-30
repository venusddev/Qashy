import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { PageHeading } from '@/components/ui/page-heading';
import { ScreenContainer } from '@/components/ui/screen-container';
import { SectionHeader } from '@/components/ui/section-header';
import { SettingsRow } from '@/components/ui/settings-row';
import { useLocalization } from '@/localization/localization';
import { summarizeSync } from '@/features/sync/sync-summary';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useSyncState } from '@/providers/sync-provider';
import { useScreenMetrics } from '@/theme/layout';
import { useQashyTheme } from '@/theme/theme';
import { space } from '@/theme/tokens';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { endOfMonth, startOfMonth } from '@/utils/date';
import { formatMoney } from '@/utils/money';
import { useNow } from '@/utils/use-now';

// A settings row is a 38pt icon tile plus a 12pt gap, so hairlines start where
// the text does. Running them edge to edge cut the icons off from their labels
// and made one list look like several stacked ones.
const ROW_DIVIDER_INSET = 38 + space.md;

export function MoreScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const { contentWidth } = useScreenMetrics();
  const wide = contentWidth >= 860;
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

  // Deliberately not memoized: the whole point of this row is that "Relay unreachable" and
  // "Last synced 2 hours ago" are current when the screen is looked at, and a clock value in a
  // dependency array would either freeze the text or never hit. `useNow` is what makes that
  // safe to do during render — it re-reads outside render and quantizes to the minute, so this
  // recomputation is cheap and the whole app's relative times agree.
  // `useSyncState` returns null outside the provider by design, so this stays safe in any test
  // or story that renders MoreScreen on its own.
  const sync = useSyncState();
  const now = useNow();
  const syncSummary = sync?.status ? summarizeSync(sync.status, { now }) : null;

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
        <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.xl, alignItems: 'flex-start' }}>
          <View style={{ flex: wide ? 1 : undefined, width: '100%', gap: space.md }}>
            <SectionHeader title="Accounts" action="Add" onAction={() => router.push('/account')} />
            <Card variant="list" dividerInset={ROW_DIVIDER_INSET}>
              {activeAccounts.map((account) => {
                const balance = summary.accountBalances.find((item) => item.account.id === account.id)?.balanceMinor ?? account.openingBalanceMinor;
                return <SettingsRow key={account.id} literal title={account.name} subtitle={`${t(account.type)} · ${account.currency}`} value={formatMoney(balance, account.currency, state.settings.locale)} icon="wallet" color={account.color} onPress={() => router.push({ pathname: '/account', params: { id: account.id } })} />;
              })}
            </Card>

            <SectionHeader title="Categories" action="Add" onAction={() => router.push('/category')} />
            <Card variant="list" dividerInset={ROW_DIVIDER_INSET}>
              {state.categories.filter((item) => !item.archived).map((category) => <SettingsRow key={category.id} literal title={category.name} subtitle={t(category.kind)} icon={category.icon} color={category.color} onPress={() => router.push({ pathname: '/category', params: { id: category.id } })} />)}
            </Card>
          </View>

          <View style={{ flex: wide ? 1 : undefined, width: '100%', gap: space.md }}>
            <SectionHeader title="Automation" action="New recurring" onAction={() => router.push('/recurring')} />
            <Card variant="list" dividerInset={ROW_DIVIDER_INSET}>
              {recurring.length ? recurring.map((rule) => {
                const ended = Boolean(rule.endDate && rule.nextDueDate > rule.endDate);
                const status = ended ? 'Ended' : rule.active ? `Next ${rule.nextDueDate}` : 'Paused';
                const frequency = rule.interval === 1
                  ? rule.unit === 'month'
                    ? t('Monthly')
                    : t(`${rule.unit[0].toUpperCase()}${rule.unit.slice(1)}`)
                  : t(`Every ${rule.interval} ${rule.unit}s.`);
                return <SettingsRow key={rule.id} literal title={rule.template.title} subtitle={`${frequency} · ${t(status)}`} value={formatMoney(rule.template.amountMinor, rule.template.currency, state.settings.locale)} icon="repeat" onPress={() => router.push({ pathname: '/recurring', params: { id: rule.id } })} />;
              }) : <View style={{ paddingVertical: space.md }}><AppText variant="caption" muted>Subscriptions and scheduled income will appear here.</AppText></View>}
            </Card>

            <SectionHeader title="Exchange rates" action="Add rate" onAction={() => router.push('/exchange-rate')} />
            <Card variant="list" dividerInset={ROW_DIVIDER_INSET}>
              {state.exchangeRates.length ? state.exchangeRates.map((rate) => <SettingsRow key={rate.id} literal title={`${rate.fromCurrency} → ${rate.toCurrency}`} subtitle={t(`Effective ${rate.effectiveDate}`)} value={rate.rate} icon="arrow.left.arrow.right" onPress={() => router.push({ pathname: '/exchange-rate', params: { id: rate.id } })} />) : <View style={{ paddingVertical: space.md }}><AppText variant="caption" muted>Add a manual rate when you create an account in another currency.</AppText></View>}
            </Card>

            {archivedAccounts.length || archivedCategories.length ? (
              <>
                <SectionHeader title="Archived" />
                <Card variant="list" dividerInset={ROW_DIVIDER_INSET}>
                  {archivedAccounts.map((account) => <SettingsRow key={account.id} literal title={account.name} subtitle={t(`Archived account · ${account.currency}`)} value={t(restoringId === account.id ? 'Restoring…' : 'Restore')} icon="wallet" color={account.color} onPress={() => restore('account', account.id)} />)}
                  {archivedCategories.map((category) => <SettingsRow key={category.id} literal title={category.name} subtitle={t(`Archived ${category.kind} category`)} value={t(restoringId === category.id ? 'Restoring…' : 'Restore')} icon={category.icon} color={category.color} onPress={() => restore('category', category.id)} />)}
                </Card>
              </>
            ) : null}

            <SectionHeader title="Qashy" />
            <Card variant="list" dividerInset={ROW_DIVIDER_INSET}>
              <SettingsRow title="Appearance" subtitle="Theme, Material You, and accent" icon="paintbrush" onPress={() => router.push('/appearance')} />
              {/* The subtitle is the at-a-glance answer to "is the relay down?" — it reads
                  `Relay unreachable` rather than a stale last-synced time whenever the drop-box
                  is the thing that broke. The row is not `literal`, so it translates itself. */}
              <SettingsRow title="Sync" subtitle={syncSummary?.subtitle ?? 'Checking…'} icon={syncSummary?.icon ?? 'arrow.triangle.2.circlepath'} onPress={() => router.push('/sync')} />
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
