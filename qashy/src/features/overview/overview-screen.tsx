import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';

import { CategoryDonut, SpendLineChart } from '@/components/finance/charts';
import { TransactionRow } from '@/components/finance/transaction-row';
import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { GlassSurface } from '@/components/ui/glass-surface';
import { ProgressBar } from '@/components/ui/progress-bar';
import { ScreenContainer } from '@/components/ui/screen-container';
import { SectionHeader } from '@/components/ui/section-header';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { errorMessage, showError } from '@/utils/confirm';
import { endOfMonth, monthLabel, parseLocalDate, startOfMonth, toLocalDate } from '@/utils/date';
import { formatMoney } from '@/utils/money';

function moveMonth(value: string, delta: number) {
  const date = parseLocalDate(value);
  date.setMonth(date.getMonth() + delta, 1);
  return toLocalDate(date);
}

export function OverviewScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { width } = useWindowDimensions();
  const [month, setMonth] = useState(startOfMonth());
  const [pendingUpcomingId, setPendingUpcomingId] = useState<string | null>(null);

  const resolveUpcoming = async (id: string, action: 'skip' | 'confirm') => {
    if (pendingUpcomingId) return;
    setPendingUpcomingId(id);
    try {
      await (action === 'skip' ? repository.skipUpcoming(id) : repository.confirmUpcoming(id));
    } catch (reason) {
      showError(action === 'skip' ? 'Couldn’t skip this item' : 'Couldn’t mark this item paid', errorMessage(reason, 'Try again.'));
    } finally {
      setPendingUpcomingId(null);
    }
  };
  const summary = useMemo(() => {
    // Repository reads are synchronous; these references make their external-store inputs explicit.
    void state.accounts;
    void state.budgetPeriods;
    void state.budgets;
    void state.categories;
    void state.exchangeRates;
    void state.settings;
    void state.transactions;
    return repository.getDashboard(startOfMonth(month), endOfMonth(month));
  }, [repository, month, state.accounts, state.budgetPeriods, state.budgets, state.categories, state.exchangeRates, state.settings, state.transactions]);
  const wide = width >= 900;
  const currency = state.settings.baseCurrency;
  const locale = state.settings.locale;
  const budgetProgress = summary.budgetLimitMinor > 0 ? summary.budgetSpentMinor / summary.budgetLimitMinor : summary.budgetSpentMinor > 0 ? 1 : 0;

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }}>
      <ScreenContainer>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <View style={{ gap: 4 }}>
            <AppText variant="caption" muted>YOUR MONEY AT A GLANCE</AppText>
            <AppText variant="headline">A quieter view of your finances.</AppText>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: theme.surface, borderRadius: 999, padding: 4, borderWidth: 1, borderColor: theme.border }}>
            <Pressable accessibilityLabel="Previous month" onPress={() => setMonth((value) => moveMonth(value, -1))} style={{ padding: 9 }}><AppIcon name="chevron.left" color={theme.text} size={16} /></Pressable>
            <AppText variant="label" style={{ minWidth: 116, textAlign: 'center' }}>{monthLabel(month, locale)}</AppText>
            <Pressable accessibilityLabel="Next month" onPress={() => setMonth((value) => moveMonth(value, 1))} style={{ padding: 9 }}><AppIcon name="chevron.right" color={theme.text} size={16} /></Pressable>
          </View>
        </View>

        <Card style={{ padding: 24, backgroundColor: theme.accentContainer, borderColor: theme.accent, gap: 22, overflow: 'hidden' }}>
          <View style={{ position: 'absolute', width: 220, height: 220, borderRadius: 999, backgroundColor: theme.accent, opacity: 0.08, right: -70, top: -100 }} />
          <View style={{ gap: 6 }}>
            <AppText variant="caption" style={{ color: theme.accent }}>NET WORTH</AppText>
            <AppText variant="money" style={{ color: theme.onAccentContainer, fontSize: width < 520 ? 34 : 44, lineHeight: 50 }}>
              {formatMoney(summary.netWorthMinor, currency, locale)}
            </AppText>
            {summary.missingExchangeRates.length ? (
              <AppText variant="caption" style={{ color: theme.warning }}>
                Excludes {summary.missingExchangeRates.map((rate) => rate.fromCurrency).join(', ')} until an effective exchange rate is added.
              </AppText>
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
            {[
              ['Income', summary.incomeMinor, theme.positive],
              ['Spent', summary.expenseMinor, theme.negative],
              ['Net flow', summary.netFlowMinor, summary.netFlowMinor >= 0 ? theme.positive : theme.negative],
            ].map(([label, amount, color]) => (
              <View key={label as string} style={{ minWidth: 130, flex: 1, gap: 4 }}>
                <AppText variant="caption" muted>{label as string}</AppText>
                <AppText variant="headline" style={{ color: color as never, fontVariant: ['tabular-nums'] }}>{formatMoney(amount as number, currency, locale, { compact: width < 520 })}</AppText>
              </View>
            ))}
          </View>
        </Card>

        <View style={{ flexDirection: wide ? 'row' : 'column', gap: 18, alignItems: 'stretch' }}>
          <Card style={{ flex: 1, gap: 16 }}>
            <SectionHeader title="Spending rhythm" />
            <SpendLineChart points={summary.dailySpend} currency={currency} locale={locale} />
          </Card>
          <Card style={{ flex: 1, gap: 18 }}>
            <SectionHeader title="By category" />
            <CategoryDonut items={summary.categorySpend} currency={currency} locale={locale} />
          </Card>
        </View>

        <View style={{ flexDirection: wide ? 'row' : 'column', gap: 18, alignItems: 'stretch' }}>
          <Card style={{ flex: 1, gap: 14 }}>
            <SectionHeader title="Budget pulse" action="Open plan" onAction={() => router.push('/plan')} />
            {summary.budgetLimitMinor > 0 || summary.budgetSpentMinor > 0 ? (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                  <AppText variant="headline">{formatMoney(summary.budgetSpentMinor, currency, locale)}</AppText>
                  <AppText muted>of {formatMoney(summary.budgetLimitMinor, currency, locale)}</AppText>
                </View>
                <ProgressBar value={budgetProgress} color={budgetProgress > 1 ? theme.negative as string : undefined} />
                <AppText variant="caption" muted>{budgetProgress > 1 ? 'Over budget — review the categories driving it.' : `${Math.max(0, Math.round((1 - budgetProgress) * 100))}% remains in this period.`}</AppText>
              </>
            ) : (
              <View style={{ gap: 10 }}><AppText muted>Create a flexible monthly or custom budget to see your pace here.</AppText><ActionButton title="Create budget" variant="secondary" onPress={() => router.push('/budget')} /></View>
            )}
          </Card>
          <Card style={{ flex: 1, gap: 14 }}>
            <SectionHeader title="Accounts" action="Manage" onAction={() => router.push('/more')} />
            {summary.accountBalances.map(({ account, balanceMinor }) => (
              <View key={account.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 38, height: 38, borderRadius: 13, backgroundColor: account.color, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="wallet" color="#FFFFFF" size={17} /></View>
                <View style={{ flex: 1 }}><AppText variant="label">{account.name}</AppText><AppText variant="caption" muted>{account.currency} · {account.type}</AppText></View>
                <AppText variant="label" style={{ fontVariant: ['tabular-nums'] }}>{formatMoney(balanceMinor, account.currency, locale)}</AppText>
              </View>
            ))}
          </Card>
        </View>

        {summary.upcomingTransactions.length ? (
          <Card style={{ gap: 6 }}>
            <SectionHeader title="Coming up" />
            {summary.upcomingTransactions.map((transaction) => (
              <View key={transaction.id} style={{ gap: 2 }}>
                <TransactionRow transaction={transaction} compact returnTo="/overview" />
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                  <Pressable disabled={pendingUpcomingId !== null} onPress={() => resolveUpcoming(transaction.id, 'skip')} style={{ padding: 8, opacity: pendingUpcomingId === transaction.id ? 0.5 : 1 }}><AppText variant="caption" muted>Skip</AppText></Pressable>
                  <Pressable disabled={pendingUpcomingId !== null} onPress={() => resolveUpcoming(transaction.id, 'confirm')} style={{ padding: 8, opacity: pendingUpcomingId === transaction.id ? 0.5 : 1 }}><AppText variant="caption" style={{ color: theme.accent }}>Mark paid</AppText></Pressable>
                </View>
              </View>
            ))}
          </Card>
        ) : null}

        <Card style={{ gap: 4 }}>
          <SectionHeader title="Recent activity" action="See all" onAction={() => router.push('/transactions')} />
          {summary.recentTransactions.length ? summary.recentTransactions.map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} returnTo="/overview" />) : (
            <View style={{ alignItems: 'center', gap: 12, paddingVertical: 28 }}>
              <View style={{ width: 52, height: 52, borderRadius: 18, backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="arrow.left.arrow.right" color={theme.accent} size={24} /></View>
              <AppText variant="headline">Your ledger is ready</AppText>
              <AppText muted style={{ textAlign: 'center' }}>Add the first transaction and Qashy will turn it into useful context.</AppText>
              <ActionButton title="Add transaction" icon="plus" onPress={() => router.push({ pathname: '/transaction', params: { returnTo: '/overview' } })} />
            </View>
          )}
        </Card>
      </ScreenContainer>

      <GlassSurface interactive style={{ position: 'absolute', right: width < 768 ? 20 : 32, bottom: process.env.EXPO_OS === 'web' && width < 768 ? 92 : 26, borderRadius: 999, overflow: 'hidden', boxShadow: '0 14px 30px rgba(30,30,60,0.2)' }}>
        <Pressable accessibilityLabel="Add transaction" onPress={() => router.push({ pathname: '/transaction', params: { returnTo: '/overview' } })} style={{ width: 58, height: 58, alignItems: 'center', justifyContent: 'center' }}>
          <AppIcon name="plus" color={theme.accent} size={25} />
        </Pressable>
      </GlassSurface>
    </ScrollView>
  );
}
