import { router } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, View } from 'react-native';

import { AnimatedMoney } from '@/components/finance/animated-money';
import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MotionView } from '@/components/ui/motion';
import { PageHeading } from '@/components/ui/page-heading';
import { ProgressBar } from '@/components/ui/progress-bar';
import { ScreenContainer } from '@/components/ui/screen-container';
import { SectionHeader } from '@/components/ui/section-header';
import { useLocalization } from '@/localization/localization';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useScreenMetrics } from '@/theme/layout';
import { useQashyTheme } from '@/theme/theme';
import { radius, space, toneColors } from '@/theme/tokens';
import { todayLocal } from '@/utils/date';
import { hapticSuccess } from '@/utils/haptics';
import { formatMoney } from '@/utils/money';

const GOAL_MILESTONES = [0.25, 0.5, 0.75, 1];

export function PlanScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const { contentWidth } = useScreenMetrics();
  const wide = contentWidth >= 860;
  const today = todayLocal();
    // The repository reads these state slices internally, so they must stay in
    // the deps even though the callback does not reference them directly.
    const budgets = useMemo(
      () => repository.getBudgetStatuses(today, { includeInactiveCustom: true }),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- repository reads these slices internally
      [repository, today, state.budgets, state.budgetPeriods, state.transactions, state.categories],
    );
    const goals = useMemo(
      () => state.goals.filter((item) => !item.archived && !item.deletedAt),
      [state.goals],
    );
    const goalProgress = useMemo(() => {
      const progress = new Map<string, number>();
      for (const goal of goals) progress.set(goal.id, repository.getGoalProgress(goal.id));
      return progress;
      // eslint-disable-next-line react-hooks/exhaustive-deps -- repository reads these slices internally
    }, [repository, goals, state.contributions, state.transactions, state.categories]);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }}>
      <ScreenContainer>
        <PageHeading title="Plan" subtitle="Set flexible limits and track progress toward meaningful goals." />
        <View style={{ flexDirection: wide ? 'row' : 'column', gap: space.xl, alignItems: 'flex-start' }}>
          <View style={{ flex: 1, width: '100%', gap: space.md }}>
            <SectionHeader title="Budgets" />
            {budgets.length ? budgets.map(({ budget, snapshot, spentMinor, effectiveLimitMinor, categorySpend }) => {
              const ratio = effectiveLimitMinor > 0 ? spentMinor / effectiveLimitMinor : spentMinor > 0 ? 1 : 0;
              const customState = budget.period.unit === 'custom'
                ? today > snapshot.periodEnd
                  ? `${t('Ended')} · `
                  : today < snapshot.periodStart
                    ? `${t('Upcoming')} · `
                    : ''
                : '';
              // Dates and the rollover amount are data, so the caption is
              // assembled with its translatable words already resolved and
              // then rendered verbatim.
              const periodSummary = `${customState}${t(budget.period.unit)} · ${snapshot.periodStart} ${t('to')} ${snapshot.periodEnd}${budget.rollover ? ` · ${t('rollover')} ${formatMoney(snapshot.rolloverMinor, state.settings.baseCurrency, state.settings.locale, { sign: true })}` : ''}`;
              const tile = toneColors(budget.color, theme.staticSurface, theme.staticText, theme.mode === 'dark');
              return (
                <MotionView key={budget.id} variant="fade" animateLayout exit>
                  <Card style={{ gap: space.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                    <View style={{ width: 44, height: 44, borderRadius: radius.tile, borderCurve: 'continuous', backgroundColor: tile.container, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="chart" color={tile.onContainer} size={20} /></View>
                    <View style={{ flex: 1, gap: space.xxs }}><AppText literal variant="headline">{budget.name}</AppText><AppText literal variant="caption" muted>{periodSummary}</AppText></View>
                    <ActionButton title="Edit" variant="secondary" onPress={() => router.push({ pathname: '/budget', params: { id: budget.id } })} />
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md, alignItems: 'baseline' }}>
                    <AppText variant="label"><AnimatedMoney variant="label" numeric minor={spentMinor} currency={state.settings.baseCurrency} locale={state.settings.locale} /> spent</AppText>
                    <AppText variant="caption" muted><AnimatedMoney variant="caption" numeric muted minor={Math.max(0, effectiveLimitMinor - spentMinor)} currency={state.settings.baseCurrency} locale={state.settings.locale} /> left</AppText>
                  </View>
                  <ProgressBar label={`${budget.name}: ${t('Budget progress')}`} value={ratio} color={ratio > 1 ? theme.negative as string : budget.color} />
                  {categorySpend.length ? (
                    <View style={{ gap: space.sm, paddingTop: space.xs }}>
                      {categorySpend.map((limit) => {
                        const category = state.categories.find((item) => item.id === limit.categoryId);
                        return category ? <View key={limit.categoryId} style={{ gap: space.xs }}><View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.sm }}><AppText literal variant="caption">{category.name}</AppText><AppText literal variant="caption" muted numeric>{`${formatMoney(limit.amountMinor, state.settings.baseCurrency, state.settings.locale)} / ${formatMoney(limit.limitMinor, state.settings.baseCurrency, state.settings.locale)}`}</AppText></View><ProgressBar label={`${category.name}: ${t('Category budget progress')}`} value={limit.amountMinor / limit.limitMinor} color={category.color} /></View> : null;
                      })}
                    </View>
                  ) : null}
                  </Card>
                </MotionView>
              );
            }) : (
              <Card>
                <EmptyState
                  compact
                  icon="chart"
                  title="Give spending a gentle boundary"
                  body="Create a monthly, weekly, yearly, or one-off budget. Nothing is forced into envelopes.">
                  <ActionButton title="Create a budget" icon="plus" onPress={() => router.push('/budget')} />
                </EmptyState>
              </Card>
            )}
          </View>

          <View style={{ flex: 1, width: '100%', gap: space.md }}>
            <SectionHeader title="Goals" />
            {goals.length ? goals.map((goal) => {
                          const progress = goalProgress.get(goal.id) ?? 0;
              const displayProgress = Math.max(0, progress);
              const ratio = goal.targetMinor > 0 ? displayProgress / goal.targetMinor : 0;
              const tile = toneColors(goal.color, theme.staticSurface, theme.staticText, theme.mode === 'dark');
              return (
                <MotionView key={goal.id} variant="fade" animateLayout exit>
                  <Card style={{ gap: space.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                    <View style={{ width: 44, height: 44, borderRadius: radius.tile, borderCurve: 'continuous', backgroundColor: tile.container, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="target" color={tile.onContainer} size={21} /></View>
                    <View style={{ flex: 1, gap: space.xxs }}><AppText literal variant="headline">{goal.name}</AppText><AppText literal variant="caption" muted>{`${t(goal.kind === 'saving' ? 'Savings goal' : 'Planned purchase')}${goal.targetDate ? ` · ${t('by')} ${goal.targetDate}` : ''}`}</AppText></View>
                    <ActionButton title="Open" variant="secondary" onPress={() => router.push({ pathname: '/goal', params: { id: goal.id } })} />
                  </View>
                  <AnimatedMoney variant="money" minor={displayProgress} currency={state.settings.baseCurrency} locale={state.settings.locale} />
                  <ProgressBar
                    label={`${goal.name}: ${t('Goal progress')}`}
                    value={ratio}
                    color={goal.color}
                    milestones={GOAL_MILESTONES}
                    onMilestone={hapticSuccess}
                  />
                  <AppText literal variant="caption" muted numeric>{`${Math.max(0, Math.min(100, Math.round(ratio * 100)))}% ${t('of')} ${formatMoney(goal.targetMinor, state.settings.baseCurrency, state.settings.locale)}`}</AppText>
                  </Card>
                </MotionView>
              );
            }) : (
              <Card>
                <EmptyState
                  compact
                  icon="target"
                  title="Save toward something real"
                  body="Track a savings target or a planned purchase with manual or linked progress.">
                  <ActionButton title="Create a goal" icon="plus" onPress={() => router.push('/goal')} />
                </EmptyState>
              </Card>
            )}
          </View>
        </View>
      </ScreenContainer>
    </ScrollView>
  );
}
