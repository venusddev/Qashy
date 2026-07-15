import { View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

import { AppText } from '@/components/ui/app-text';
import type { DashboardSummary } from '@/domain/models';
import { useQashyTheme } from '@/theme/theme';
import { formatMoney } from '@/utils/money';

export function SpendLineChart({ points, currency, locale }: { points: DashboardSummary['dailySpend']; currency: string; locale: string }) {
  const theme = useQashyTheme();
  const { width } = useWindowDimensions();
  const chartWidth = Math.min(Math.max(width - 72, 260), 520);
  const height = 150;
  const max = Math.max(...points.map((item) => item.amountMinor), 1);
  const data = points.length ? points : [{ date: '', amountMinor: 0 }, { date: '', amountMinor: 0 }];
  const path = data
    .map((point, index) => {
      const x = 8 + (index / Math.max(data.length - 1, 1)) * (chartWidth - 16);
      const y = height - 24 - (point.amountMinor / max) * (height - 48);
      return `${index ? 'L' : 'M'} ${x} ${y}`;
    })
    .join(' ');
  return (
    <View accessibilityLabel={`Daily spending chart. Highest day ${formatMoney(max, currency, locale)}`}>
      <Svg width="100%" height={height} viewBox={`0 0 ${chartWidth} ${height}`}>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <Line key={ratio} x1="8" x2={chartWidth - 8} y1={height * ratio} y2={height * ratio} stroke={theme.border as string} strokeWidth="1" />
        ))}
        <Path d={path} fill="none" stroke={theme.staticAccent} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        {data.map((point, index) => {
          const x = 8 + (index / Math.max(data.length - 1, 1)) * (chartWidth - 16);
          const y = height - 24 - (point.amountMinor / max) * (height - 48);
          return <Circle key={`${point.date}-${index}`} cx={x} cy={y} r="4" fill={theme.staticAccent} />;
        })}
      </Svg>
    </View>
  );
}

export function CategoryDonut({ items, currency, locale }: { items: DashboardSummary['categorySpend']; currency: string; locale: string }) {
  const theme = useQashyTheme();
  const total = items.reduce((sum, item) => sum + item.amountMinor, 0);
  const radius = 46;
  const circumference = 2 * Math.PI * radius;
  const segments = items.slice(0, 6).map((item, index, source) => ({
    item,
    length: total ? (item.amountMinor / total) * circumference : 0,
    offset: source
      .slice(0, index)
      .reduce((sum, previous) => sum + (total ? (previous.amountMinor / total) * circumference : 0), 0),
  }));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
      <View style={{ width: 126, height: 126 }}>
        <Svg width="126" height="126" viewBox="0 0 126 126">
          <Circle cx="63" cy="63" r={radius} fill="none" stroke={theme.surfaceMuted as string} strokeWidth="16" />
          {segments.map(({ item, length, offset }) => (
              <Circle
                key={item.category.id}
                cx="63"
                cy="63"
                r={radius}
                fill="none"
                stroke={item.category.color}
                strokeWidth="16"
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
                strokeLinecap="round"
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
        {items.slice(0, 4).map((item) => (
          <View key={item.category.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 9, height: 9, borderRadius: 99, backgroundColor: item.category.color }} />
            <AppText variant="caption" style={{ flex: 1 }}>{item.category.name}</AppText>
            <AppText variant="caption" muted>{total ? Math.round((item.amountMinor / total) * 100) : 0}%</AppText>
          </View>
        ))}
        {!items.length ? <AppText muted>No spending yet</AppText> : null}
      </View>
    </View>
  );
}
