import { Link, Slot, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { MotionView } from '@/components/ui/motion';
import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';

// Icon names mirror the SF Symbols used by the native tabs in `_layout.tsx` so
// the same section reads the same on every platform.
const NAV_ITEMS = [
  { href: '/overview' as const, label: 'Overview', icon: 'house', match: '/overview' },
  { href: '/transactions' as const, label: 'Transactions', icon: 'list.bullet.rectangle', match: '/transactions' },
  { href: '/plan' as const, label: 'Plan', icon: 'chart.pie', match: '/plan' },
  { href: '/more' as const, label: 'More', icon: 'ellipsis.circle', match: '/more' },
];

const pressSpring = {
  damping: 20,
  stiffness: 380,
  mass: 0.7,
  overshootClamping: true,
  reduceMotion: ReduceMotion.System,
} as const;

const popSpring = {
  damping: 14,
  stiffness: 320,
  mass: 0.8,
  reduceMotion: ReduceMotion.System,
} as const;

function NavIcon({ name, color, size, active }: { name: string; color: string; size: number; active: boolean }) {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const wasActive = useRef(active);

  useEffect(() => {
    if (active && !wasActive.current && !reduceMotion) {
      scale.set(1.2);
      scale.set(withSpring(1, popSpring));
    }
    wasActive.current = active;
  }, [active, reduceMotion, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View style={animatedStyle}>
      <AppIcon name={name} color={color} size={size} />
    </Animated.View>
  );
}

function NavigationItem({
  item,
  active,
  compact,
  mobile,
  narrow,
}: {
  item: typeof NAV_ITEMS[number];
  active: boolean;
  compact: boolean;
  mobile: boolean;
  /** Viewports where a quarter of the bar is too tight for "Transactions". */
  narrow: boolean;
}) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const [showTooltip, setShowTooltip] = useState(false);
  const currentPageProps = active ? { 'aria-current': 'page' as const } : {};
  const foreground = active ? theme.onAccentContainer : showTooltip ? theme.text : theme.textMuted;
  const pressScale = useSharedValue(1);
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
  }));
  return (
    <Link href={item.href} asChild>
      {/* Link asChild drops function-form styles on web, so this must stay a
          plain style object; animated feedback lives on the inner views. */}
      <Pressable
        {...currentPageProps}
        accessibilityHint={compact && !mobile ? t(item.label) : undefined}
        accessibilityLabel={t(item.label)}
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        aria-selected={active}
        onBlur={() => setShowTooltip(false)}
        onFocus={() => setShowTooltip(true)}
        onHoverIn={() => setShowTooltip(true)}
        onHoverOut={() => setShowTooltip(false)}
        onPressIn={() => pressScale.set(withSpring(0.95, pressSpring))}
        onPressOut={() => pressScale.set(withSpring(1, pressSpring))}
        style={{
          minHeight: 48,
          minWidth: mobile ? 64 : compact ? 52 : undefined,
          flex: mobile ? 1 : undefined,
          paddingHorizontal: mobile ? (narrow ? 2 : 4) : compact ? 12 : 16,
          borderRadius: 16,
          borderCurve: 'continuous',
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
        {!active && showTooltip ? (
          <MotionView
            variant="fade"
            duration={120}
            exit
            pointerEvents="none"
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              borderRadius: 16,
              borderCurve: 'continuous',
              backgroundColor: theme.surfaceMuted,
            }}
          />
        ) : null}
        <Animated.View
          style={[
            {
              flex: 1,
              alignSelf: 'stretch',
              flexDirection: mobile ? 'column' : !compact ? 'row' : 'column',
              alignItems: 'center',
              justifyContent: mobile ? 'center' : 'flex-start',
              gap: mobile ? 3 : 10,
            },
            contentStyle,
          ]}>
          <NavIcon name={item.icon} color={foreground as string} size={mobile ? 22 : 20} active={active} />
          {mobile || !compact ? (
            <AppText selectable={false} variant="label" numberOfLines={1} style={{ color: foreground, fontSize: mobile ? (narrow ? 10 : 11) : 15, letterSpacing: mobile && narrow ? -0.2 : undefined }}>
              {item.label}
            </AppText>
          ) : null}
        </Animated.View>
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
  const narrow = width < 360;

  const renderNavigation = (targetMobile: boolean) => NAV_ITEMS.map((item) => {
    const active = pathname === item.match || pathname.startsWith(`${item.match}/`) || (item.match === '/overview' && pathname === '/');
    return <NavigationItem key={item.label} item={item} active={active} compact={targetMobile ? false : compact} mobile={targetMobile} narrow={narrow} />;
  });

  return (
    <View style={{ flex: 1, flexDirection: mobile ? 'column' : 'row', backgroundColor: theme.background }}>
      <View
        accessibilityLabel="Primary"
        role="navigation"
        style={{
          display: mobile ? 'none' : 'flex',
          width: compact ? 84 : 244,
          // `viewport-fit=cover` means an installed PWA draws under the status
          // bar and the display cutouts, so the rail has to pad by real insets.
          paddingTop: 18 + insets.top,
          paddingBottom: 18 + insets.bottom,
          paddingLeft: 18 + insets.left,
          paddingRight: 18,
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
          paddingLeft: 8 + insets.left,
          paddingRight: 8 + insets.right,
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
