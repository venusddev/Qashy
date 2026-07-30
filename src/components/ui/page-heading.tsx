import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';
import { space } from '@/theme/tokens';

/**
 * The document heading for a section, on web only.
 *
 * Native deliberately renders nothing: the section stack shows a real navigation
 * header with the same title, and drawing a second one in the content would
 * stack two titles on top of each other. This is not a stub — it is the web half
 * of a heading that the platform supplies natively.
 */
export function PageHeading({
  title,
  subtitle,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
}) {
  const theme = useQashyTheme();
  if (process.env.EXPO_OS !== 'web') return null;
  const headingLevelProps = { 'aria-level': 1 } as object;
  return (
    <View style={{ gap: space.xxs }}>
      {eyebrow ? (
        <AppText variant="eyebrow" style={{ color: theme.textMuted, paddingBottom: space.xxs }}>{eyebrow}</AppText>
      ) : null}
      <AppText {...headingLevelProps} accessibilityRole="header" role="heading" variant="title">{title}</AppText>
      {subtitle ? <AppText muted>{subtitle}</AppText> : null}
    </View>
  );
}
