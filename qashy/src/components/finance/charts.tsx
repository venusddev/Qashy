import { useEffect } from 'react';
import { View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { AppText } from '@/components/ui/app-text';
import { MotionView } from '@/components/ui/motion';
import type { DashboardSummary } from '@/domain/models';
import { useQashyTheme } from '@/theme/theme';
import { shortDate } from '@/utils/date';
import { formatMoney } from '@/utils/money';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export function SpendLineChart({ points, currency, locale }: { points: DashboardSummary['dailySpend']; currency: string; locale: string }) {
  const theme = useQashyTheme();
  const { width } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const chartWidth = Math.min(Math.max(width - 72, 260), 520);
  const height = 174;
  const actualMax = Math.max(...points.map((item) => item.amountMinor), 0);
  const scaleMax = Math.max(actualMax, 1);
  const hasSpending = actualMax > 0;
  const coordinates = points.map((point, index) => ({
    x: 8 + (index / Math.max(points.length - 1, 1)) * (chartWidth - 16),
    y: height - 32 - (point.amountMinor / scaleMax) * (height - 54),
  }));
  const path = coordinates.map(({ x, y }, index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
  const pathLength = Math.max(1, coordinates.slice(1).reduce((length, point, index) => {
    const previous = coordinates[index];
    return length + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0));
  const reveal = useSharedValue(reduceMotion ? 1 : 0);

  useEffect(() => {
    reveal.set(reduceMotion ? 1 : 0);
    reveal.set(withTiming(1, {
      duration: 520,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    }));
  }, [path, reduceMotion, reveal]);

  const pathProps = useAnimatedProps(() => ({
    strokeDashoffset: pathLength * (1 - reveal.value),
  }));
  const pointProps = useAnimatedProps(() => ({
    opacity: reveal.value,
  }));
  const firstDate = points.at(0)?.date;
  const lastDate = points.at(-1)?.date;
  const label = hasSpending
    ? `Daily spending from ${firstDate} to ${lastDate}. Highest day ${formatMoney(actualMax, currency, locale)}.`
    : `No spending from ${firstDate ?? 'the start of this period'} to ${lastDate ?? 'the end of this period'}.`;
  return (
    <MotionView variant="fade" accessibilityRole="image" accessibilityLabel={label} style={{ minHeight: height }}>
      {hasSpending ? (
        <Svg width="100%" height={height} viewBox={`0 0 ${chartWidth} ${height}`}>
          {[0.25, 0.5, 0.75].map((ratio) => (
            <Line key={ratio} x1="8" x2={chartWidth - 8} y1={(height - 24) * ratio} y2={(height - 24) * ratio} stroke={theme.border as string} strokeWidth="1" />
          ))}
          <AnimatedPath
            animatedProps={pathProps}
            d={path}
            fill="none"
            stroke={theme.accent}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={`${pathLength} ${pathLength}`}
          />
          {points.map((point, index) => {
            if (!point.amountMinor) return null;
            const { x, y } = coordinates[index];
            return <AnimatedCircle key={point.date} animatedProps={pointProps} cx={x} cy={y} r="4" fill={theme.accent} />;
          })}
          {firstDate ? <SvgText x="8" y={height - 4} fill={theme.textMuted as string} fontSize="11">{shortDate(firstDate, locale)}</SvgText> : null}
          {lastDate ? <SvgText x={chartWidth - 8} y={height - 4} textAnchor="end" fill={theme.textMuted as string} fontSize="11">{shortDate(lastDate, locale)}</SvgText> : null}
        </Svg>
      ) : (
        <View style={{ minHeight: height, alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <AppText variant="label">No spending in this period</AppText>
          <AppText variant="caption" muted>{firstDate && lastDate ? `${shortDate(firstDate, locale)} – ${shortDate(lastDate, locale)}` : 'Add an expense to start the rhythm.'}</AppText>
        </View>
      )}
    </MotionView>
  );
}

const DONUT_TOP_COUNT = 5;

export function CategoryDonut({ items, currency, locale }: { items: DashboardSummary['categorySpend']; currency: string; locale: string }) {
  const theme = useQashyTheme();
  const total = items.reduce((sum, item) => sum + item.amountMinor, 0);
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  // The ring and the legend share the same slices, with everything past the
  // top entries aggregated into "Other" so both always account for 100%.
  const top = items.slice(0, DONUT_TOP_COUNT);
  const otherMinor = items.slice(DONUT_TOP_COUNT).reduce((sum, item) => sum + item.amountMinor, 0);
  const slices = [
    ...top.map((item) => ({
      key: item.category?.id ?? 'uncategorized',
      name: item.category?.name ?? 'Uncategorized',
      color: item.category?.color ?? theme.textMuted as string,
      amountMinor: item.amountMinor,
    })),
    ...(otherMinor > 0 ? [{ key: 'other', name: 'Other', color: theme.textMuted as string, amountMinor: otherMinor }] : []),
  ];
  const segments = slices.map((slice, index, source) => ({
    slice,
    length: total ? (slice.amountMinor / total) * circumference : 0,
    offset: source
      .slice(0, index)
      .reduce((sum, previous) => sum + (total ? (previous.amountMinor / total) * circumference : 0), 0),
  }));
  return (
    <MotionView variant="zoom" delay={70} style={{ flexDirection: 'row', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <View style={{ width: 126, height: 126 }}>
        <Svg width="126" height="126" viewBox="0 0 126 126">
          <Circle cx="63" cy="63" r={radius} fill="none" stroke={theme.surfaceMuted as string} strokeWidth="16" />
          {segments.map(({ slice, length, offset }) => (
              <Circle
                key={slice.key}
                cx="63"
                cy="63"
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth="16"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
                rotation="-90"
                origin="63, 63"
              />
          ))}
          <SvgText x="63" y="59" textAnchor="middle" fill={theme.textMuted as string} fontSize="10">SPENT</SvgText>
          <SvgText x="63" y="77" textAnchor="middle" fill={theme.text as string} fontSize="13" fontWeight="700">
            {formatMoney(total, currency, locale, { compact: true })}
          </SvgText>
        </Svg>
      </View>
      <View style={{ flex: 1, minWidth: 160, gap: 9 }}>
        {slices.map((slice) => (
          <View key={slice.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 9, height: 9, borderRadius: 99, backgroundColor: slice.color }} />
            <AppText variant="caption" style={{ flex: 1 }}>{slice.name}</AppText>
            <AppText variant="caption" muted>{total ? Math.round((slice.amountMinor / total) * 100) : 0}%</AppText>
          </View>
        ))}
        {!items.length ? <AppText muted>No spending yet</AppText> : null}
      </View>
    </MotionView>
  );
}
