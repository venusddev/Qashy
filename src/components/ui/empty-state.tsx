import { type ReactNode } from 'react';
import { View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { MotionView } from '@/components/ui/motion';
import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';

/**
 * The one shape an empty list takes.
 *
 * Six screens had each hand-rolled this — an icon tile in a 52, 54, or 56pt
 * square, `paddingVertical` of 28, 30, or 34, a heading, a centred line of body
 * copy, sometimes a button — so the moment a user hit two empty screens in a row
 * the app looked like it had been assembled from two different products. The
 * differences were never decisions; they were whichever number the previous
 * screen happened to use.
 *
 * `compact` is for an empty region nested inside a populated card, where the
 * full-height treatment would push everything below it off the fold.
 */
export function EmptyState({
  icon,
  title,
  body,
  compact = false,
  children,
}: {
  icon: string;
  title: string;
  body?: string;
  compact?: boolean;
  /** Actions. Rendered in a row below the copy. */
  children?: ReactNode;
}) {
  const theme = useQashyTheme();
  const tile = compact ? 48 : 56;
  return (
    <MotionView
      variant="down"
      style={{
        alignItems: 'center',
        gap: space.md,
        paddingVertical: compact ? space.xxl : 40,
        paddingHorizontal: space.lg,
      }}>
      <View
        style={{
          width: tile,
          height: tile,
          borderRadius: radius.card,
          borderCurve: 'continuous',
          backgroundColor: theme.accentContainer,
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        <AppIcon name={icon} color={theme.onAccentContainer} size={compact ? 21 : 24} />
      </View>
      <AppText variant="headline" style={{ textAlign: 'center' }}>{title}</AppText>
      {body ? (
        <AppText muted style={{ textAlign: 'center', maxWidth: 360 }}>{body}</AppText>
      ) : null}
      {children ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space.sm, paddingTop: space.xs }}>
          {children}
        </View>
      ) : null}
    </MotionView>
  );
}
