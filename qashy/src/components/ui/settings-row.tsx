import { Pressable, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';
import { radius, readableTextColor } from '@/theme/tokens';

export function SettingsRow({ title, subtitle, icon, color, value, onPress }: { title: string; subtitle?: string; icon: string; color?: string; value?: string; onPress?: () => void }) {
  const theme = useQashyTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({ minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: pressed ? 0.62 : 1 })}>
      <View style={{ width: 38, height: 38, borderRadius: radius.control, backgroundColor: color ?? theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}>
        <AppIcon name={icon} color={color ? readableTextColor(color) : theme.accent} size={18} />
      </View>
      <View style={{ flex: 1, gap: 1 }}><AppText variant="label">{title}</AppText>{subtitle ? <AppText variant="caption" muted numberOfLines={1}>{subtitle}</AppText> : null}</View>
      {value ? <AppText variant="caption" muted>{value}</AppText> : null}
      {onPress ? <AppIcon name="chevron.right" color={theme.textMuted} size={17} /> : null}
    </Pressable>
  );
}
