import { Link, Slot, usePathname } from 'expo-router';
import { useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { MotionView } from '@/components/ui/motion';
import { useQashyTheme } from '@/theme/theme';

const NAV_ITEMS = [
  { href: '/overview' as const, label: 'Overview', icon: 'wallet', match: '/overview' },
  { href: '/transactions' as const, label: 'Transactions', icon: 'arrow.left.arrow.right', match: '/transactions' },
  { href: '/plan' as const, label: 'Plan', icon: 'target', match: '/plan' },
  { href: '/more' as const, label: 'More', icon: 'ellipsis.circle', match: '/more' },
];

function NavigationItem({
  item,
  active,
  compact,
  mobile,
}: {
  item: typeof NAV_ITEMS[number];
  active: boolean;
  compact: boolean;
  mobile: boolean;
}) {
  const theme = useQashyTheme();
  const [showTooltip, setShowTooltip] = useState(false);
  const currentPageProps = active ? { 'aria-current': 'page' as const } : {};
  const foreground = active ? theme.onAccentContainer : theme.textMuted;
  return (
    <Link href={item.href} asChild>
      {/* Link asChild drops function-form styles on web, so this must stay a
          plain style object. */}
      <Pressable
        {...currentPageProps}
        accessibilityHint={compact && !mobile ? item.label : undefined}
        accessibilityLabel={item.label}
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        aria-selected={active}
        onBlur={() => setShowTooltip(false)}
        onFocus={() => setShowTooltip(true)}
        onHoverIn={() => setShowTooltip(true)}
        onHoverOut={() => setShowTooltip(false)}
        style={{
          minHeight: 48,
          minWidth: mobile ? 64 : compact ? 52 : undefined,
          flex: mobile ? 1 : undefined,
          paddingHorizontal: mobile ? 4 : compact ? 12 : 16,
          borderRadius: 16,
          borderCurve: 'continuous',
          flexDirection: mobile ? 'column' : !compact ? 'row' : 'column',
          alignItems: 'center',
          justifyContent: mobile ? 'center' : 'flex-start',
          gap: mobile ? 3 : 10,
          backgroundColor: 'transparent',
          position: 'relative',
          zIndex: showTooltip ? 20 : undefined,
        }}>
        {active ? (
          <MotionView
            variant="fade"
            exit
            animateLayout
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              borderRadius: 16,
              borderCurve: 'continuous',
              backgroundColor: theme.accentContainer,
            }}
          />
        ) : null}
        <AppIcon name={item.icon} color={foreground} size={mobile ? 22 : 20} />
        {mobile || !compact ? (
          <AppText selectable={false} variant="label" numberOfLines={1} style={{ color: foreground, fontSize: mobile ? 11 : 15 }}>
            {item.label}
          </AppText>
        ) : null}
        {compact && !mobile && showTooltip ? (
          <MotionView
            variant="right"
            exit
            pointerEvents="none"
            role="tooltip"
            style={{
              position: 'absolute',
              left: 58,
              top: 7,
              minHeight: 36,
              justifyContent: 'center',
              paddingHorizontal: 12,
              borderRadius: 10,
              backgroundColor: theme.surfaceElevated,
              borderWidth: 1,
              borderColor: theme.border,
              boxShadow: '0 4px 14px rgba(25,27,32,0.16)',
            }}>
            <AppText selectable={false} variant="caption" numberOfLines={1}>{item.label}</AppText>
          </MotionView>
        ) : null}
      </Pressable>
    </Link>
  );
}

export default function WebTabsLayout() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const theme = useQashyTheme();
  const compact = width < 1200;
  const mobile = width < 768;

  const renderNavigation = (targetMobile: boolean) => NAV_ITEMS.map((item) => {
    const active = pathname === item.match || pathname.startsWith(`${item.match}/`) || (item.match === '/overview' && pathname === '/');
    return <NavigationItem key={item.label} item={item} active={active} compact={targetMobile ? false : compact} mobile={targetMobile} />;
  });

  return (
    <View style={{ flex: 1, flexDirection: mobile ? 'column' : 'row', backgroundColor: theme.background }}>
      <View
        accessibilityLabel="Primary"
        role="navigation"
        style={{
          display: mobile ? 'none' : 'flex',
          width: compact ? 84 : 244,
          padding: 18,
          borderRightWidth: 1,
          borderRightColor: theme.border,
          gap: 28,
        }}>
        <View style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: compact ? 'center' : 'flex-start', gap: 12 }}>
          <View style={{ width: 38, height: 38, borderRadius: 13, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center' }}>
            <AppText selectable={false} variant="headline" style={{ color: theme.onAccent }}>Q</AppText>
          </View>
          {!compact ? <AppText variant="headline">Qashy</AppText> : null}
        </View>
        <View style={{ gap: 8, zIndex: 10 }}>{renderNavigation(false)}</View>
        {!compact ? (
          <View style={{ marginTop: 'auto', gap: 4 }}>
            <AppText variant="caption" muted>LOCAL-FIRST FINANCE</AppText>
            <AppText variant="caption" muted>Your data stays on this device.</AppText>
          </View>
        ) : null}
      </View>
      <View style={{ flex: 1 }}><Slot /></View>
      <View
        accessibilityLabel="Primary"
        role="navigation"
        style={{
          display: mobile ? 'flex' : 'none',
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          minHeight: 64 + insets.bottom,
          backgroundColor: theme.surfaceElevated,
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 8,
          paddingTop: 6,
          paddingBottom: Math.max(6, insets.bottom),
          borderTopWidth: 1,
          borderTopColor: theme.border,
          boxShadow: '0 -2px 12px rgba(25,27,32,0.06)',
        }}>
        {renderNavigation(true)}
      </View>
    </View>
  );
}
