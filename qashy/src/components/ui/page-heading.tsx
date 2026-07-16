import { View } from 'react-native';

import { AppText } from '@/components/ui/app-text';

export function PageHeading({
  title,
  subtitle,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
}) {
  if (process.env.EXPO_OS !== 'web') return null;
  const headingLevelProps = { 'aria-level': 1 } as object;
  return (
    <View style={{ gap: 4 }}>
      {eyebrow ? <AppText variant="caption" muted>{eyebrow}</AppText> : null}
      <AppText {...headingLevelProps} accessibilityRole="header" role="heading" variant="title">{title}</AppText>
      {subtitle ? <AppText muted>{subtitle}</AppText> : null}
    </View>
  );
}
