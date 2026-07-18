import { router } from 'expo-router';
import { ScrollView, View, useWindowDimensions } from 'react-native';

import { AnimatedMoney } from '@/components/finance/animated-money';
import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { MotionView } from '@/components/ui/motion';
import { PageHeading } from '@/components/ui/page-heading';
import { ProgressBar } from '@/components/ui/progress-bar';
import { ScreenContainer } from '@/components/ui/screen-container';
import { SectionHeader } from '@/components/ui/section-header';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { radius, readableTextColor } from '@/theme/tokens';
import { todayLocal } from '@/utils/date';
import { hapticSuccess } from '@/utils/haptics';
import { formatMoney } from '@/utils/money';

const GOAL_MILESTONES = [0.25, 0.5, 0.75, 1];

export function PlanScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 860;
  const today = todayLocal();
  const budgets = repository.getBudgetStatuses(today, { includeInactiveCustom: true });
  const goals = state.goals.filter((item) => !item.archived && !item.deletedAt);

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }}>
      <ScreenContainer>
        <PageHeading title="Plan" subtitle="Set flexible limits and track progress toward meaningful goals." />
        <View style={{ flexDirection: wide ? 'row' : 'column', gap: 18, alignItems: 'flex-start' }}>
          <View style={{ flex: 1, width: '100%', gap: 14 }}>
            <SectionHeader title="Budgets" action="New budget" onAction={() => router.push('/budget')} />
            {budgets.length ? budgets.map(({ budget, snapshot, spentMinor, effectiveLimitMinor, categorySpend }, index) => {
              const ratio = effectiveLimitMinor > 0 ? spentMinor / effectiveLimitMinor : spentMinor > 0 ? 1 : 0;
              const customState = budget.period.unit === 'custom'
                ? today > snapshot.periodEnd
                  ? 'Ended · '
                  : today < snapshot.periodStart
                    ? 'Upcoming · '
                    : ''
                : '';
              return (
                <MotionView key={budget.id} delay={Math.min(index, 5) * 45} animateLayout exit>
                  <Card style={{ gap: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ width: 44, height: 44, borderRadius: radius.control, backgroundColor: budget.color, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="chart" color={readableTextColor(budget.color)} size={20} /></View>
                    <View style={{ flex: 1, gap: 2 }}><AppText variant="headline">{budget.name}</AppText><AppText variant="caption" muted>{customState}{budget.period.unit} · {snapshot.periodStart} to {snapshot.periodEnd}{budget.rollover ? ` · rollover ${formatMoney(snapshot.rolloverMinor, state.settings.baseCurrency, state.settings.locale, { sign: true })}` : ''}</AppText></View>
                    <ActionButton title="Edit" variant="secondary" onPress={() => router.push({ pathname: '/budget', params: { id: budget.id } })} />
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}>
                    <AppText variant="label"><AnimatedMoney variant="label" minor={spentMinor} currency={state.settings.baseCurrency} locale={state.settings.locale} /> spent</AppText>
                    <AppText variant="caption" muted><AnimatedMoney variant="caption" muted minor={Math.max(0, effectiveLimitMinor - spentMinor)} currency={state.settings.baseCurrency} locale={state.settings.locale} /> left</AppText>
                  </View>
                  <ProgressBar value={ratio} color={ratio > 1 ? theme.negative as string : budget.color} />
                  {categorySpend.length ? (
                    <View style={{ gap: 10, paddingTop: 4 }}>
                      {categorySpend.slice(0, 3).map((limit) => {
                        const category = state.categories.find((item) => item.id === limit.categoryId);
                        return category ? <View key={limit.categoryId} style={{ gap: 5 }}><View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><AppText variant="caption">{category.name}</AppText><AppText variant="caption" muted>{formatMoney(limit.amountMinor, state.settings.baseCurrency, state.settings.locale)} / {formatMoney(limit.limitMinor, state.settings.baseCurrency, state.settings.locale)}</AppText></View><ProgressBar value={limit.amountMinor / limit.limitMinor} color={category.color} /></View> : null;
                      })}
                    </View>
                  ) : null}
                  </Card>
                </MotionView>
              );
            }) : (
              <MotionView variant="zoom">
                <Card style={{ alignItems: 'center', gap: 12, paddingVertical: 34 }}>
                  <View style={{ width: 54, height: 54, borderRadius: radius.card, backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="chart" color={theme.onAccentContainer} size={24} /></View>
                  <AppText variant="headline">Give spending a gentle boundary</AppText>
                  <AppText muted style={{ textAlign: 'center' }}>Create a monthly, weekly, yearly, or one-off budget. Nothing is forced into envelopes.</AppText>
                  <ActionButton title="Create a budget" icon="plus" onPress={() => router.push('/budget')} />
                </Card>
              </MotionView>
            )}
          </View>

          <View style={{ flex: 1, width: '100%', gap: 14 }}>
            <SectionHeader title="Goals" action="New goal" onAction={() => router.push('/goal')} />
            {goals.length ? goals.map((goal, index) => {
              const progress = repository.getGoalProgress(goal.id);
              const displayProgress = Math.max(0, progress);
              const ratio = goal.targetMinor > 0 ? displayProgress / goal.targetMinor : 0;
              return (
                <MotionView key={goal.id} delay={70 + Math.min(index, 5) * 45} animateLayout exit>
                  <Card style={{ gap: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ width: 44, height: 44, borderRadius: radius.control, backgroundColor: goal.color, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="target" color={readableTextColor(goal.color)} size={21} /></View>
                    <View style={{ flex: 1, gap: 2 }}><AppText variant="headline">{goal.name}</AppText><AppText variant="caption" muted>{goal.kind} goal{goal.targetDate ? ` · by ${goal.targetDate}` : ''}</AppText></View>
                    <ActionButton title="Open" variant="secondary" onPress={() => router.push({ pathname: '/goal', params: { id: goal.id } })} />
                  </View>
                  <AnimatedMoney variant="money" minor={displayProgress} currency={state.settings.baseCurrency} locale={state.settings.locale} />
                  <ProgressBar
                    value={ratio}
                    color={goal.color}
                    milestones={GOAL_MILESTONES}
                    onMilestone={hapticSuccess}
                  />
                  <AppText variant="caption" muted>{Math.max(0, Math.min(100, Math.round(ratio * 100)))}% of {formatMoney(goal.targetMinor, state.settings.baseCurrency, state.settings.locale)}</AppText>
                  </Card>
                </MotionView>
              );
            }) : (
              <MotionView variant="zoom" delay={70}>
                <Card style={{ alignItems: 'center', gap: 12, paddingVertical: 34 }}>
                  <View style={{ width: 54, height: 54, borderRadius: radius.card, backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="target" color={theme.onAccentContainer} size={24} /></View>
                  <AppText variant="headline">Save toward something real</AppText>
                  <AppText muted style={{ textAlign: 'center' }}>Track a savings target or a planned purchase with manual or linked progress.</AppText>
                  <ActionButton title="Create a goal" icon="plus" onPress={() => router.push('/goal')} />
                </Card>
              </MotionView>
            )}
          </View>
        </View>
      </ScreenContainer>
    </ScrollView>
  );
}
