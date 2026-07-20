import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';

export default function TabsLayout() {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const tabs = (
    <NativeTabs
      tintColor={theme.accent}
      backgroundColor={theme.surfaceElevated}
      iconColor={{ default: theme.textMuted, selected: theme.accent }}
      labelStyle={{
        default: { color: theme.textMuted },
        selected: { color: theme.accent },
      }}
      indicatorColor={theme.accentContainer}
      rippleColor={theme.accentContainer}
      minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="overview">
        <NativeTabs.Trigger.Label>{t('Overview')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="transactions">
        <NativeTabs.Trigger.Label>{t('Transactions')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'list.bullet.rectangle', selected: 'list.bullet.rectangle.fill' }} md="receipt_long" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="plan">
        <NativeTabs.Trigger.Label>{t('Plan')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'chart.pie', selected: 'chart.pie.fill' }} md="donut_large" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="more" role="more">
        <NativeTabs.Trigger.Label>{t('More')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="ellipsis.circle" md="more_horiz" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
  // The section stacks run with `headerShown: false`, so nothing else supplies
  // the top inset. Both native platforms need it or tab content renders under
  // the status bar / Dynamic Island.
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.background }}>
      {tabs}
    </SafeAreaView>
  );
}
