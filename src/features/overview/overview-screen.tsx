import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AnimatedMoney } from '@/components/finance/animated-money';
import { CategoryDonut, SpendLineChart } from '@/components/finance/charts';
import { TransactionRow } from '@/components/finance/transaction-row';
import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FloatingActionButton } from '@/components/ui/floating-action-button';
import { IconButton } from '@/components/ui/icon-button';
import { MotionView } from '@/components/ui/motion';
import { PageHeading } from '@/components/ui/page-heading';
import { ProgressBar } from '@/components/ui/progress-bar';
import { floatingActionMetrics, ScreenContainer } from '@/components/ui/screen-container';
import { SectionHeader } from '@/components/ui/section-header';
import { TextButton } from '@/components/ui/text-button';
import { useScrollHide } from '@/components/ui/use-scroll-hide';
import { useLocalization } from '@/localization/localization';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useScreenMetrics } from '@/theme/layout';
import { useQashyTheme } from '@/theme/theme';
import { radius, space, toneColors } from '@/theme/tokens';
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
  const metrics = useScreenMetrics();
  const insets = useSafeAreaInsets();
  const { contentWidth } = metrics;
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
  const wide = contentWidth >= 900;
  const currency = state.settings.baseCurrency;
  const locale = state.settings.locale;
  const budgetProgress = summary.budgetLimitMinor > 0 ? summary.budgetSpentMinor / summary.budgetLimitMinor : summary.budgetSpentMinor > 0 ? 1 : 0;

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" onScroll={onScroll} scrollEventThrottle={16} style={{ flex: 1, backgroundColor: theme.background }}>
        <ScreenContainer>
        {/* Native no longer draws its own copy of this heading: the section
            stack shows a real navigation header titled "Overview". Web keeps
            PageHeading, which is where the document's h1 lives. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, flexWrap: 'wrap' }}>
          <View style={{ flexShrink: 1, minWidth: 200 }}>
            <PageHeading title="Overview" subtitle="A quieter view of your finances." eyebrow="YOUR MONEY AT A GLANCE" />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: theme.surface, borderRadius: radius.pill, padding: space.xs, borderWidth: 1, borderColor: theme.border }}>
            <IconButton label="Previous month" icon="chevron.left" iconSize={16} onPress={() => changeMonth(-1)} />
            <MotionView key={month} variant={monthDirection} duration={180} style={{ minWidth: 116 }}>
              <AppText literal variant="label" style={{ textAlign: 'center' }}>{monthLabel(month, locale)}</AppText>
            </MotionView>
            <IconButton label="Next month" icon="chevron.right" iconSize={16} onPress={() => changeMonth(1)} />
          </View>
        </View>

        <Card variant="hero">
          <MotionView key={month} variant={monthDirection} exit animateLayout style={{ gap: space.xxl }}>
            <View style={{ gap: space.xs }}>
              <AppText variant="eyebrow" style={{ color: theme.accent }}>CURRENT NET WORTH</AppText>
              <AnimatedMoney minor={summary.netWorthMinor} currency={currency} locale={locale} variant="display" />
              {summary.missingExchangeRates.length ? (
                <AppText literal variant="caption" style={{ color: theme.warning }}>
                  {`Excludes ${summary.missingExchangeRates.map((rate) => rate.fromCurrency).join(', ')} until an effective exchange rate is added.`}
                </AppText>
              ) : null}
            </View>
            {/* Spent is deliberately not red. In the ledger an expense amount is
                neutral text — red is reserved for "something is wrong", like a
                budget gone over. Tinting every expense red here contradicted
                that two screens apart and made an ordinary month look alarming.
                Income keeps its green because money arriving really is the
                exception worth marking. */}
            <View style={{ flexDirection: 'row', gap: space.md, flexWrap: 'wrap' }}>
              {([
                ['Income', summary.incomeMinor, theme.positive],
                ['Spent', summary.expenseMinor, theme.text],
                ['Net flow', summary.netFlowMinor, summary.netFlowMinor >= 0 ? theme.positive : theme.negative],
              ] as const).map(([label, amount, color]) => (
                <View key={label} style={{ minWidth: 130, flex: 1, gap: space.xs }}>
                  <AppText variant="caption" muted>{label}</AppText>
                  <AnimatedMoney
                    minor={amount}
                    currency={currency}
                    locale={locale}
                    compact={contentWidth < 520}
                    variant="headline"
                    numeric
                    style={{ color }}
                  />
                </View>
              ))}
            </View>
          </MotionView>
        </Card>

        <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.xl, alignItems: 'stretch' }}>
          <Card style={{ flex: 1, gap: space.lg }}>
            <SectionHeader title="Spending rhythm" />
            <MotionView key={`spend-${month}`} variant={monthDirection} exit>
              <SpendLineChart points={summary.dailySpend} currency={currency} locale={locale} />
            </MotionView>
          </Card>
          <Card style={{ flex: 1, gap: space.lg }}>
            <SectionHeader title="By category" />
            <MotionView key={`categories-${month}`} variant={monthDirection} exit>
              <CategoryDonut items={summary.categorySpend} currency={currency} locale={locale} />
            </MotionView>
          </Card>
        </View>

        <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.xl, alignItems: 'stretch' }}>
          <Card style={{ flex: 1, gap: space.md }}>
            <SectionHeader title="Budget pulse" action="Open plan" onAction={() => router.push('/plan')} />
            {summary.budgetLimitMinor > 0 || summary.budgetSpentMinor > 0 ? (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md, alignItems: 'baseline' }}>
                  <AnimatedMoney minor={summary.budgetSpentMinor} currency={currency} locale={locale} variant="headline" numeric />
                  <AppText literal muted variant="caption">{`${t('of')} ${formatMoney(summary.budgetLimitMinor, currency, locale)}`}</AppText>
                </View>
                <ProgressBar label={t('Budget progress')} value={budgetProgress} color={budgetProgress > 1 ? theme.negative as string : undefined} />
                <AppText variant="caption" muted>{budgetProgress > 1 ? 'Over budget — review the categories driving it.' : `${Math.max(0, Math.round((1 - budgetProgress) * 100))}% remains in this period.`}</AppText>
              </>
            ) : (
              <View style={{ gap: space.md, alignItems: 'flex-start' }}><AppText muted>Create a flexible monthly or custom budget to see your pace here.</AppText><ActionButton title="Create budget" variant="secondary" onPress={() => router.push('/budget')} /></View>
            )}
          </Card>
          <Card style={{ flex: 1, gap: space.md }}>
            <SectionHeader title="Accounts" action="Manage" onAction={() => router.push('/more')} />
            {summary.accountBalances.map(({ account, balanceMinor }) => {
              const tile = toneColors(account.color, theme.staticSurface, theme.staticText, theme.mode === 'dark');
              return (
                <MotionView key={account.id} variant="fade" animateLayout exit>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                    <View style={{ width: 38, height: 38, borderRadius: radius.tile, borderCurve: 'continuous', backgroundColor: tile.container, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="wallet" color={tile.onContainer} size={17} /></View>
                    <View style={{ flex: 1, gap: space.xxs }}><AppText literal variant="label">{account.name}</AppText><AppText literal variant="caption" muted>{`${account.currency} · ${t(account.type)}`}</AppText></View>
                    <AnimatedMoney minor={balanceMinor} currency={account.currency} locale={locale} variant="label" numeric />
                  </View>
                </MotionView>
              );
            })}
          </Card>
        </View>

        {summary.upcomingTransactions.length ? (
          <Card style={{ gap: space.sm }}>
            <SectionHeader title="Coming up" />
            {summary.upcomingTransactions.map((transaction) => (
              <MotionView key={transaction.id} variant="fade" animateLayout exit style={{ gap: space.xxs }}>
                <TransactionRow transaction={transaction} compact returnTo="/overview" />
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm }}>
                  <TextButton title="Skip" tone="muted" disabled={pendingUpcomingId !== null} onPress={() => resolveUpcoming(transaction.id, 'skip')} />
                  <TextButton title="Mark paid" disabled={pendingUpcomingId !== null} onPress={() => resolveUpcoming(transaction.id, 'confirm')} />
                </View>
              </MotionView>
            ))}
          </Card>
        ) : null}

        <Card style={{ gap: space.xs }}>
          <SectionHeader title="Recent activity" action="See all" onAction={() => router.push('/transactions')} />
          {summary.recentTransactions.length ? summary.recentTransactions.map((transaction) => (
            <MotionView key={transaction.id} variant="fade" animateLayout exit>
              <TransactionRow transaction={transaction} returnTo="/overview" />
            </MotionView>
          )) : (
            <EmptyState
              compact
              icon="arrow.left.arrow.right"
              title={state.transactions.length ? `No activity in ${monthLabel(month, locale)}` : 'Your ledger is ready'}
              body={state.transactions.length ? 'Choose another month or open the full transaction list.' : 'Add the first transaction and Qashy will turn it into useful context.'}>
              {state.transactions.length ? (
                <ActionButton title="See all transactions" variant="secondary" onPress={() => router.push('/transactions')} />
              ) : (
                <ActionButton title="Add transaction" icon="plus" onPress={() => router.push({ pathname: '/transaction', params: { returnTo: '/overview' } })} />
              )}
            </EmptyState>
          )}
        </Card>
        </ScreenContainer>
      </ScrollView>
      <FloatingActionButton
        label="Add transaction"
        visibility={fabVisibility}
        onPress={() => router.push({ pathname: '/transaction', params: { returnTo: '/overview' } })}
        style={floatingActionMetrics(metrics, insets)}
      />
    </View>
  );
}
