import { useEffect, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { useAnimatedMinorAmount } from '@/components/finance/animated-money';
import { AppText } from '@/components/ui/app-text';
import { MotionView } from '@/components/ui/motion';
import type { DashboardSummary } from '@/domain/models';
import { useLocalization } from '@/localization/localization';
import { useScreenMetrics } from '@/theme/layout';
import { useQashyTheme } from '@/theme/theme';
import { radius as radii, space } from '@/theme/tokens';
import { shortDate } from '@/utils/date';
import { formatMoney } from '@/utils/money';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// One plot rectangle, quoted by the series, the gridlines, and the zero line, so
// they cannot drift apart. They previously used different formulas: gridlines
// were placed as a fraction of `height - 24` while the data was scaled into
// `height - 54` starting 32 from the bottom, which landed the "50%" rule at 44%
// of the actual plot. Chart furniture that lies about the data is worse than
// none, so the geometry now has a single source.
const PLOT_TOP = 20;
const PLOT_BOTTOM_INSET = 32;
const GRID_RATIOS = [0.25, 0.5, 0.75];
/** Past this many days a dot per point reads as noise, so only the peak is marked. */
const DENSE_SERIES_POINTS = 14;

export function SpendLineChart({ points, currency, locale }: { points: DashboardSummary['dailySpend']; currency: string; locale: string }) {
  const theme = useQashyTheme();
  const { contentWidth } = useScreenMetrics();
  const reduceMotion = useReducedMotion();
  // The SVG is laid out at 100% width, so the viewBox has to match the real
  // parent width. Guessing from the window magnified strokes and label text by
  // up to ~1.6x inside a wider column, and beside the web rail the guess was a
  // further rail-width too wide, so the first frame drew oversized then snapped.
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const estimatedWidth = Math.min(Math.max(contentWidth - 72, 260), 520);
  const chartWidth = Math.max(measuredWidth || estimatedWidth, 1);
  const onLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setMeasuredWidth((current) => (Math.abs(current - next) > 0.5 ? next : current));
  };
  const height = 174;
  const amounts = points.map((item) => item.amountMinor);
  const actualMax = amounts.length ? Math.max(...amounts) : 0;
  const actualMin = amounts.length ? Math.min(...amounts) : 0;
  // Refunds make a day negative. Keep zero inside the domain so the baseline
  // stays meaningful, and scale across the full range so nothing is drawn
  // outside the viewBox.
  const domainMax = Math.max(actualMax, 0);
  const domainMin = Math.min(actualMin, 0);
  const domainSpan = Math.max(domainMax - domainMin, 1);
  const hasSpending = amounts.some((amount) => amount !== 0);
  const plotBottom = height - PLOT_BOTTOM_INSET;
  const plotHeight = plotBottom - PLOT_TOP;
  const scaleY = (amountMinor: number) => plotBottom - ((amountMinor - domainMin) / domainSpan) * plotHeight;
  const coordinates = points.map((point, index) => ({
    x: 8 + (index / Math.max(points.length - 1, 1)) * (chartWidth - 16),
    y: scaleY(point.amountMinor),
  }));
  const path = coordinates.map(({ x, y }, index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
  // Zero is always inside the domain, so the fill closes on the real baseline
  // rather than the frame; a month with refunds shades above and below it.
  const baselineY = scaleY(0);
  const areaPath = coordinates.length
    ? `${path} L ${coordinates[coordinates.length - 1].x} ${baselineY} L ${coordinates[0].x} ${baselineY} Z`
    : '';
  const pathLength = Math.max(1, coordinates.slice(1).reduce((length, point, index) => {
    const previous = coordinates[index];
    return length + Math.hypot(point.x - previous.x, point.y - previous.y);
  }, 0));
  const denseSeries = points.length > DENSE_SERIES_POINTS;
  const peakIndex = actualMax > 0 ? amounts.indexOf(actualMax) : -1;
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
  const refundNote = actualMin < 0
    ? ` Largest refund day ${formatMoney(actualMin, currency, locale)}.`
    : '';
  const label = hasSpending
    ? `Daily spending from ${firstDate} to ${lastDate}. Highest day ${formatMoney(actualMax, currency, locale)}.${refundNote}`
    : `No spending from ${firstDate ?? 'the start of this period'} to ${lastDate ?? 'the end of this period'}.`;
  return (
    <MotionView
      variant="fade"
      accessibilityRole="image"
      accessibilityLabel={label}
      onLayout={onLayout}
      style={{ minHeight: height }}>
      {hasSpending ? (
        <Svg width="100%" height={height} viewBox={`0 0 ${chartWidth} ${height}`}>
          {GRID_RATIOS.map((ratio) => (
            <Line key={ratio} x1="8" x2={chartWidth - 8} y1={plotBottom - ratio * plotHeight} y2={plotBottom - ratio * plotHeight} stroke={theme.border as string} strokeWidth="1" />
          ))}
          {domainMin < 0 ? (
            <Line
              x1="8"
              x2={chartWidth - 8}
              y1={baselineY}
              y2={baselineY}
              stroke={theme.textMuted as string}
              strokeWidth="1"
              strokeDasharray="3 3"
            />
          ) : null}
          {/* Fades in with the points rather than wiping with the stroke: a
              partially drawn area closes on a straight edge mid-series and reads
              as a wrong shape for the fraction of a second it is visible. */}
          <AnimatedPath animatedProps={pointProps} d={areaPath} fill={theme.accent} fillOpacity={0.12} stroke="none" />
          <AnimatedPath
            animatedProps={pathProps}
            d={path}
            fill="none"
            stroke={theme.accent}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={`${pathLength} ${pathLength}`}
          />
          {points.map((point, index) => {
            if (!point.amountMinor) return null;
            if (denseSeries && index !== peakIndex) return null;
            const { x, y } = coordinates[index];
            const marked = denseSeries && index === peakIndex;
            return (
              <AnimatedCircle
                key={point.date}
                animatedProps={pointProps}
                cx={x}
                cy={y}
                r={marked ? '3.5' : '3'}
                fill={theme.accent}
                stroke={marked ? theme.staticSurface : undefined}
                strokeWidth={marked ? '2' : undefined}
              />
            );
          })}
          {firstDate ? <SvgText x="8" y={height - 4} fill={theme.textMuted as string} fontSize="11">{shortDate(firstDate, locale)}</SvgText> : null}
          {lastDate ? <SvgText x={chartWidth - 8} y={height - 4} textAnchor="end" fill={theme.textMuted as string} fontSize="11">{shortDate(lastDate, locale)}</SvgText> : null}
        </Svg>
      ) : (
        <View style={{ minHeight: height, alignItems: 'center', justifyContent: 'center', gap: space.xs + 2 }}>
          <AppText variant="label">No spending in this period</AppText>
          {firstDate && lastDate ? (
            <AppText literal variant="caption" muted>{`${shortDate(firstDate, locale)} – ${shortDate(lastDate, locale)}`}</AppText>
          ) : (
            <AppText variant="caption" muted>Add an expense to start the rhythm.</AppText>
          )}
        </View>
      )}
    </MotionView>
  );
}

const DONUT_TOP_COUNT = 5;

// An SVG transform string rather than the `rotation`/`origin` convenience props.
// react-native-svg's web shim turns `origin` into a literal `transform-origin`
// DOM attribute, which React rejects as a hyphenated property name ("Did you mean
// transformOrigin?") on every render, and passes `rotation` through as a bogus
// attribute besides. Both platforms parse this string form natively instead.
const RING_ROTATION = 'rotate(-90 63 63)';

/**
 * Ring segments are separated by a hairline of track so two categories that
 * happen to sit near each other on the colour wheel still read as two slices.
 * Trimmed off the end of each arc, never below a visible minimum, so a 1%
 * category is still drawn.
 */
const SEGMENT_GAP = 2;
const MIN_SEGMENT_LENGTH = 1.5;

export function CategoryDonut({ items, currency, locale }: { items: DashboardSummary['categorySpend']; currency: string; locale: string }) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const total = items.reduce((sum, item) => sum + item.amountMinor, 0);
  const ringRadius = 46;
  const circumference = 2 * Math.PI * ringRadius;
  // The ring and the legend share the same slices, with everything past the
  // top entries aggregated into "Other" so both always account for 100%.
  const top = items.slice(0, DONUT_TOP_COUNT);
  const otherMinor = items.slice(DONUT_TOP_COUNT).reduce((sum, item) => sum + item.amountMinor, 0);
  // Only the two synthetic slices are translatable. Resolving them here lets
  // the legend render every name verbatim, so a category the user actually
  // named "Other" or "Savings" is never swapped for the dictionary's word.
  const slices = [
    ...top.map((item) => ({
      key: item.category?.id ?? 'uncategorized',
      name: item.category?.name ?? t('Uncategorized'),
      color: item.category?.color ?? theme.textMuted as string,
      amountMinor: item.amountMinor,
    })),
    ...(otherMinor > 0 ? [{ key: 'other', name: t('Other'), color: theme.textMuted as string, amountMinor: otherMinor }] : []),
  ];
  const segments = slices.map((slice, index, source) => {
    const length = total ? (slice.amountMinor / total) * circumference : 0;
    return {
      slice,
      length: source.length > 1 ? Math.max(length - SEGMENT_GAP, MIN_SEGMENT_LENGTH) : length,
      offset: source
        .slice(0, index)
        .reduce((sum, previous) => sum + (total ? (previous.amountMinor / total) * circumference : 0), 0),
    };
  });
  const reduceMotion = useReducedMotion();
  // Sweeps a track-colored cover arc away clockwise so the segments appear to
  // draw themselves in sequence, mirroring the line chart's reveal.
  const revealed = useSharedValue(reduceMotion ? circumference + 1 : 0);
  const signature = slices.map((slice) => `${slice.key}:${slice.amountMinor}`).join('|');

  useEffect(() => {
    revealed.set(reduceMotion ? circumference + 1 : 0);
    revealed.set(withTiming(circumference + 1, {
      duration: 640,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    }));
  }, [circumference, reduceMotion, revealed, signature]);

  const coverProps = useAnimatedProps(() => ({
    // Negative offset walks the cover's gap clockwise from the top so segments
    // reveal in the same order they are stacked.
    strokeDashoffset: -revealed.value,
  }));
  const animatedTotal = useAnimatedMinorAmount(total);
  const share = (amountMinor: number) => (total ? Math.round((amountMinor / total) * 100) : 0);
  // The ring and the legend are matched by an ordinal as well as a color, so
  // the pairing survives color blindness and monochrome rendering.
  const label = slices.length
    ? `Spending by category. Total ${formatMoney(total, currency, locale)}. ${slices
      .map((slice, index) => `${index + 1}. ${slice.name}, ${share(slice.amountMinor)} percent`)
      .join('. ')}.`
    : 'Spending by category. No spending yet.';
  return (
    <MotionView
      variant="zoom"
      delay={70}
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space.xl, flexWrap: 'wrap' }}>
      <View style={{ width: 126, height: 126 }}>
        <Svg width="126" height="126" viewBox="0 0 126 126">
          <Circle cx="63" cy="63" r={ringRadius} fill="none" stroke={theme.surfaceMuted as string} strokeWidth="16" />
          {segments.map(({ slice, length, offset }) => (
              <Circle
                key={slice.key}
                cx="63"
                cy="63"
                r={ringRadius}
                fill="none"
                stroke={slice.color}
                strokeWidth="16"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                strokeLinecap="butt"
                transform={RING_ROTATION}
              />
          ))}
          <AnimatedCircle
            animatedProps={coverProps}
            cx="63"
            cy="63"
            r={ringRadius}
            fill="none"
            stroke={theme.surfaceMuted as string}
            strokeWidth="17"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeLinecap="butt"
            transform={RING_ROTATION}
          />
          <SvgText x="63" y="59" textAnchor="middle" fill={theme.textMuted as string} fontSize="10">SPENT</SvgText>
          <SvgText x="63" y="77" textAnchor="middle" fill={theme.text as string} fontSize="13" fontWeight="700">
            {formatMoney(animatedTotal, currency, locale, { compact: true })}
          </SvgText>
        </Svg>
      </View>
      <View style={{ flex: 1, minWidth: 160, gap: space.sm + 1 }}>
        {slices.map((slice, index) => (
          <View key={slice.key} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <AppText literal variant="caption" muted numeric style={{ minWidth: 14 }}>{`${index + 1}.`}</AppText>
            <View style={{ width: 9, height: 9, borderRadius: radii.pill, backgroundColor: slice.color }} />
            <AppText literal variant="caption" style={{ flex: 1 }} numberOfLines={1}>{slice.name}</AppText>
            <AppText literal variant="caption" muted numeric>{`${share(slice.amountMinor)}%`}</AppText>
          </View>
        ))}
        {!items.length ? <AppText muted>No spending yet</AppText> : null}
      </View>
    </MotionView>
  );
}
