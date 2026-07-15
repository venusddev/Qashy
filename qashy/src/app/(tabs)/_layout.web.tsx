import { Link, Slot, usePathname } from 'expo-router';
import { Pressable, View, useWindowDimensions } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';

const NAV_ITEMS = [
  { href: '/overview' as const, label: 'Overview', icon: 'wallet', match: '/overview' },
  { href: '/transactions' as const, label: 'Transactions', icon: 'arrow.left.arrow.right', match: '/transactions' },
  { href: '/plan' as const, label: 'Plan', icon: 'target', match: '/plan' },
  { href: '/more' as const, label: 'More', icon: 'ellipsis.circle', match: '/more' },
];

export default function WebTabsLayout() {
  const { width } = useWindowDimensions();
  const pathname = usePathname();
  const theme = useQashyTheme();
  const compact = width < 1200;
  const mobile = width < 768;

  const navigation = NAV_ITEMS.map((item) => {
    const active = pathname === item.match || pathname.startsWith(`${item.match}/`) || (item.match === '/overview' && pathname === '/');
    return (
      <Link key={item.label} href={item.href} asChild>
        <Pressable
          accessibilityRole="link"
          style={({ pressed }) => ({
            minHeight: 48,
            minWidth: mobile ? 64 : compact ? 52 : undefined,
            flex: mobile ? 1 : undefined,
            paddingHorizontal: compact ? 12 : 16,
            borderRadius: 16,
            borderCurve: 'continuous',
            flexDirection: mobile || !compact ? 'row' : 'column',
            alignItems: 'center',
            justifyContent: mobile ? 'center' : 'flex-start',
            gap: 10,
            backgroundColor: active ? theme.accentContainer : 'transparent',
            opacity: pressed ? 0.7 : 1,
          })}>
          <AppIcon name={item.icon} color={active ? theme.accent : theme.textMuted} size={20} />
          {mobile || !compact ? (
            <AppText selectable={false} variant="label" style={{ color: active ? theme.accent : theme.textMuted, fontSize: mobile ? 12 : 15 }}>
              {item.label}
            </AppText>
          ) : null}
        </Pressable>
      </Link>
    );
  });

  if (mobile) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.background }}>
        <Slot />
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            minHeight: 64,
            backgroundColor: theme.surfaceElevated,
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 8,
            paddingVertical: 6,
            borderTopWidth: 1,
            borderTopColor: theme.border,
            boxShadow: '0 -2px 12px rgba(25,27,32,0.06)',
          }}>
          {navigation}
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.background }}>
      <View style={{ width: compact ? 84 : 244, padding: 18, borderRightWidth: 1, borderRightColor: theme.border, gap: 28 }}>
        <View style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: compact ? 'center' : 'flex-start', gap: 12 }}>
          <View style={{ width: 38, height: 38, borderRadius: 13, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center' }}>
            <AppText selectable={false} variant="headline" style={{ color: theme.onAccent }}>Q</AppText>
          </View>
          {!compact ? <AppText variant="headline">Qashy</AppText> : null}
        </View>
        <View style={{ gap: 8 }}>{navigation}</View>
        {!compact ? (
          <View style={{ marginTop: 'auto', gap: 4 }}>
            <AppText variant="caption" muted>LOCAL-FIRST FINANCE</AppText>
            <AppText variant="caption" muted>Your data stays on this device.</AppText>
          </View>
        ) : null}
      </View>
      <View style={{ flex: 1 }}><Slot /></View>
    </View>
  );
}
