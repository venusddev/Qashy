import { View, type ViewStyle } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';

/**
 * How a state reads at a glance.
 *
 * Named after the meaning rather than the colour, so a caller cannot write
 * `tone="red"` for something that is merely informational and later have to
 * chase every site down when the palette changes.
 */
export type StatusTone = 'neutral' | 'positive' | 'warning' | 'negative';

/**
 * A small labelled state marker.
 *
 * **Always icon plus text, never colour alone.** That is an accessibility rule from
 * AGENTS.md rather than a stylistic preference, and it is why `icon` is required and
 * why there is no variant that renders a bare coloured dot. The three places this is
 * used — relay reachability, a device's last-seen state, a quarantine count — are all
 * cases where mistaking "fine" for "broken" costs someone real time, and the tone is a
 * reinforcement of the label, not the message itself.
 *
 * Not pressable by design. A pill that is sometimes a button is a target whose size and
 * affordance change with its state; where an action belongs beside one, the caller puts a
 * real button there.
 */
export function StatusPill({
  label,
  icon,
  tone = 'neutral',
  literal = false,
  style,
}: {
  label: string;
  /** An SF Symbol name. Must also exist in `IONICON_BY_SF_NAME` or Android and web show a `?`. */
  icon: string;
  tone?: StatusTone;
  /** Set when the label is user data — a device name, a URL — so it is shown as entered. */
  literal?: boolean;
  style?: ViewStyle;
}) {
  const theme = useQashyTheme();
  const color = {
    neutral: theme.textMuted,
    positive: theme.positive,
    warning: theme.warning,
    negative: theme.negative,
  }[tone];

  return (
    <View
      // One node, one announcement. Without this the icon and the label are two adjacent
      // elements and a screen reader reads the state twice — or, worse, reads the icon's
      // name instead of the word beside it.
      accessible
      accessibilityRole="text"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: space.xs + 1,
        paddingHorizontal: space.sm + 2,
        paddingVertical: space.xs + 1,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: theme.border,
        backgroundColor: theme.surfaceMuted,
        ...style,
      }}>
      <AppIcon name={icon} color={color} size={13} />
      <AppText selectable={false} literal={literal} variant="caption" style={{ color }}>
        {label}
      </AppText>
    </View>
  );
}
