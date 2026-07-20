import { View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { MotionPressable } from '@/components/ui/motion';
import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';
import { radius, readableTextColor } from '@/theme/tokens';

export function SettingsRow({
  title,
  subtitle,
  icon,
  color,
  value,
  tone = 'default',
  disabled = false,
  literal = false,
  onPress,
}: {
  title: string;
  subtitle?: string;
  icon: string;
  color?: string;
  value?: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /**
   * Set when the row describes a stored entity (account, category, schedule,
   * rate) rather than fixed UI copy. Title, subtitle, and value are then
   * rendered and announced verbatim. Translate any fixed fragment at the call
   * site before composing it in.
   */
  literal?: boolean;
  onPress?: () => void;
}) {
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const destructive = tone === 'danger';
  // Without this the row exposes title, subtitle, and value as three unrelated
  // leaves, so a screen reader never ties the value to what it belongs to.
  const accessibilityLabel = [title, subtitle, value]
    .filter((part): part is string => Boolean(part))
    .map((part) => (literal ? part : t(part)))
    .join(', ');
  return (
    <MotionPressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={onPress ? { disabled } : undefined}
      onPress={onPress}
      disabled={!onPress || disabled}
      pressedScale={0.985}
      style={({ pressed }) => ({ minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, opacity: disabled ? 0.5 : pressed ? 0.62 : 1 })}>
      <View style={{ width: 38, height: 38, borderRadius: radius.control, backgroundColor: color ?? (destructive ? theme.surfaceMuted : theme.accentContainer), alignItems: 'center', justifyContent: 'center' }}>
        <AppIcon name={icon} color={color ? readableTextColor(color) : destructive ? theme.negative : theme.accent} size={18} />
      </View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flex: 1, gap: 1 }}><AppText literal={literal} variant="label" style={destructive ? { color: theme.negative } : undefined}>{title}</AppText>{subtitle ? <AppText literal={literal} variant="caption" muted numberOfLines={2}>{subtitle}</AppText> : null}</View>
      {value ? (
        <AppText
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          literal={literal}
          variant="caption"
          muted
          numberOfLines={1}
          style={{ flexShrink: 1 }}>
          {value}
        </AppText>
      ) : null}
      {onPress ? <AppIcon name="chevron.right" color={theme.textMuted} size={17} /> : null}
    </MotionPressable>
  );
}
