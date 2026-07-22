import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View, useWindowDimensions } from 'react-native';

import { AnimatedMoney } from '@/components/finance/animated-money';
import { CategoryDonut, SpendLineChart } from '@/components/finance/charts';
import { TransactionRow } from '@/components/finance/transaction-row';
import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { FloatingActionButton } from '@/components/ui/floating-action-button';
import { IconButton } from '@/components/ui/icon-button';
import { MotionView } from '@/components/ui/motion';
import { PageHeading } from '@/components/ui/page-heading';
import { ProgressBar } from '@/components/ui/progress-bar';
import { ScreenContainer } from '@/components/ui/screen-container';
import { SectionHeader } from '@/components/ui/section-header';
import { TextButton } from '@/components/ui/text-button';
import { useScrollHide } from '@/components/ui/use-scroll-hide';
import { useLocalization } from '@/localization/localization';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { radius, readableTextColor } from '@/theme/tokens';
import { errorMessage, showError } from '@/utils/confirm';
import { endOfMonth, monthLabel, parseLocalDate, startOfMonth, toLocalDate } from '@/utils/date';
import { hapticSelection, hapticSuccess } from '@/utils/haptics';
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
  const { t } = useLocalization();
  const { width } = useWindowDimensions();
  const [month, setMonth] = useState(startOfMonth());
  // Which way the month content slides: forward months push in from the
  // right, previous months from the left.
  const [monthDirection, setMonthDirection] = useState<'left' | 'right'>('right');
  const [pendingUpcomingId, setPendingUpcomingId] = useState<string | null>(null);
  const { visibility: fabVisibility, onScroll } = useScrollHide();

  const changeMonth = (delta: number) => {
    hapticSelection();
    setMonthDirection(delta > 0 ? 'right' : 'left');
    setMonth((value) => moveMonth(value, delta));
  };

  const resolveUpcoming = async (id: string, action: 'skip' | 'confirm') => {
    if (pendingUpcomingId) return;
    setPendingUpcomingId(id);
    try {
      await (action === 'skip' ? repository.skipUpcoming(id) : repository.confirmUpcoming(id));
      if (action === 'confirm') hapticSuccess();
      else hapticSelection();
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
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" onScroll={onScroll} scrollEventThrottle={16} style={{ flex: 1, backgroundColor: theme.background }}>
        <ScreenContainer>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          {process.env.EXPO_OS === 'web' ? (
            <View style={{ flexShrink: 1, minWidth: 200 }}>
              <PageHeading title="Overview" subtitle="A quieter view of your finances." eyebrow="YOUR MONEY AT A GLANCE" />
            </View>
          ) : (
            <View style={{ gap: 4, flexShrink: 1, minWidth: 200 }}>
              <AppText variant="caption" muted>YOUR MONEY AT A GLANCE</AppText>
              <AppText variant="headline">A quieter view of your finances.</AppText>
            </View>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: theme.surface, borderRadius: 999, padding: 4, borderWidth: 1, borderColor: theme.border }}>
            <IconButton label="Previous month" icon="chevron.left" iconSize={16} onPress={() => changeMonth(-1)} />
            <MotionView key={month} variant={monthDirection} duration={180} style={{ minWidth: 116 }}>
              <AppText literal variant="label" style={{ textAlign: 'center' }}>{monthLabel(month, locale)}</AppText>
            </MotionView>
            <IconButton label="Next month" icon="chevron.right" iconSize={16} onPress={() => changeMonth(1)} />
          </View>
        </View>

        <Card style={{ padding: 24, backgroundColor: theme.surfaceElevated }}>
          <MotionView key={month} variant={monthDirection} exit animateLayout style={{ gap: 22 }}>
            <View style={{ gap: 6 }}>
              <AppText variant="caption" style={{ color: theme.accent }}>CURRENT NET WORTH</AppText>
              <AnimatedMoney
                minor={summary.netWorthMinor}
                currency={currency}
                locale={locale}
                variant="money"
                style={{ fontSize: 34, lineHeight: 40 }}
              />
              {summary.missingExchangeRates.length ? (
                <AppText literal variant="caption" style={{ color: theme.warning }}>
                  {`Excludes ${summary.missingExchangeRates.map((rate) => rate.fromCurrency).join(', ')} until an effective exchange rate is added.`}
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
                  <AnimatedMoney
                    minor={amount as number}
                    currency={currency}
                    locale={locale}
                    compact={width < 520}
                    variant="headline"
                    style={{ color: color as never, fontVariant: ['tabular-nums'] }}
                  />
                </View>
              ))}
            </View>
          </MotionView>
        </Card>

        <View style={{ flexDirection: wide ? 'row' : 'column', gap: 18, alignItems: 'stretch' }}>
          <Card style={{ flex: 1, gap: 16 }}>
            <SectionHeader title="Spending rhythm" />
            <MotionView key={`spend-${month}`} variant={monthDirection} exit>
              <SpendLineChart points={summary.dailySpend} currency={currency} locale={locale} />
            </MotionView>
          </Card>
          <Card style={{ flex: 1, gap: 18 }}>
            <SectionHeader title="By category" />
            <MotionView key={`categories-${month}`} variant={monthDirection} exit>
              <CategoryDonut items={summary.categorySpend} currency={currency} locale={locale} />
            </MotionView>
          </Card>
        </View>

        <View style={{ flexDirection: wide ? 'row' : 'column', gap: 18, alignItems: 'stretch' }}>
          <Card style={{ flex: 1, gap: 14 }}>
            <SectionHeader title="Budget pulse" action="Open plan" onAction={() => router.push('/plan')} />
            {summary.budgetLimitMinor > 0 || summary.budgetSpentMinor > 0 ? (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                  <AnimatedMoney minor={summary.budgetSpentMinor} currency={currency} locale={locale} variant="headline" />
                  <AppText literal muted>{`${t('of')} ${formatMoney(summary.budgetLimitMinor, currency, locale)}`}</AppText>
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
            {summary.accountBalances.map(({ account, balanceMinor }, index) => (
              <MotionView key={account.id} delay={Math.min(index, 5) * 35} variant="right">
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <View style={{ width: 38, height: 38, borderRadius: radius.control, backgroundColor: account.color, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="wallet" color={readableTextColor(account.color)} size={17} /></View>
                  <View style={{ flex: 1 }}><AppText literal variant="label">{account.name}</AppText><AppText literal variant="caption" muted>{`${account.currency} · ${t(account.type)}`}</AppText></View>
                  <AnimatedMoney minor={balanceMinor} currency={account.currency} locale={locale} variant="label" style={{ fontVariant: ['tabular-nums'] }} />
                </View>
              </MotionView>
            ))}
          </Card>
        </View>

        {summary.upcomingTransactions.length ? (
          <Card style={{ gap: 6 }}>
            <SectionHeader title="Coming up" />
            {summary.upcomingTransactions.map((transaction, index) => (
              <MotionView key={transaction.id} delay={Math.min(index, 4) * 35} animateLayout exit style={{ gap: 2 }}>
                <TransactionRow transaction={transaction} compact returnTo="/overview" />
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                  <TextButton title="Skip" tone="muted" disabled={pendingUpcomingId !== null} onPress={() => resolveUpcoming(transaction.id, 'skip')} />
                  <TextButton title="Mark paid" disabled={pendingUpcomingId !== null} onPress={() => resolveUpcoming(transaction.id, 'confirm')} />
                </View>
              </MotionView>
            ))}
          </Card>
        ) : null}

        <Card style={{ gap: 4 }}>
          <SectionHeader title="Recent activity" action="See all" onAction={() => router.push('/transactions')} />
          {summary.recentTransactions.length ? summary.recentTransactions.map((transaction, index) => (
            <MotionView key={transaction.id} delay={Math.min(index, 5) * 30} variant="right">
              <TransactionRow transaction={transaction} returnTo="/overview" />
            </MotionView>
          )) : (
            <MotionView variant="zoom" style={{ alignItems: 'center', gap: 12, paddingVertical: 28 }}>
              <View style={{ width: 52, height: 52, borderRadius: radius.card, backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="arrow.left.arrow.right" color={theme.onAccentContainer} size={24} /></View>
              <AppText variant="headline">{state.transactions.length ? `No activity in ${monthLabel(month, locale)}` : 'Your ledger is ready'}</AppText>
              <AppText muted style={{ textAlign: 'center' }}>{state.transactions.length ? 'Choose another month or open the full transaction list.' : 'Add the first transaction and Qashy will turn it into useful context.'}</AppText>
              {state.transactions.length ? (
                <ActionButton title="See all transactions" variant="secondary" onPress={() => router.push('/transactions')} />
              ) : (
                <ActionButton title="Add transaction" icon="plus" onPress={() => router.push({ pathname: '/transaction', params: { returnTo: '/overview' } })} />
              )}
            </MotionView>
          )}
        </Card>
        </ScreenContainer>
      </ScrollView>
      <FloatingActionButton
        label="Add transaction"
        visibility={fabVisibility}
        onPress={() => router.push({ pathname: '/transaction', params: { returnTo: '/overview' } })}
        style={{ position: 'absolute', right: width < 768 ? 20 : 32, bottom: process.env.EXPO_OS === 'web' && width < 768 ? 92 : 26 }}
      />
    </View>
  );
}
