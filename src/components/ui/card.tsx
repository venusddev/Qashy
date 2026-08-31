import { Children, Fragment, type ReactNode } from 'react';
import { StyleSheet, View, type ColorValue, type ViewProps, type ViewStyle } from 'react-native';

import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';

export type CardVariant = 'default' | 'hero' | 'list';

export interface CardProps extends ViewProps {
  /**
   * `default` — a resting panel. Border, no shadow.
   * `hero` — the one card on a screen that outranks the others. Lifted, never
   *   bordered; it is the top of the elevation ladder, not a louder box.
   * `list` — a container for rows. Flush padding, hairlines between children.
   */
  variant?: CardVariant;
  /** `list` only: pull the hairlines in from the start edge, past a row's icon. */
  dividerInset?: number;
}

/**
 * Elevation is expressed by exactly one mechanism per mode, never two.
 *
 * The old card set a surface, a 1px border, *and* a shadow simultaneously, in
 * both modes. That reads as an outline rather than as depth, and it left the app
 * with no way to say "this card matters more than that one" — Overview's hero
 * asked for `surfaceElevated`, which in light mode is the same white as every
 * other card, so the request quietly did nothing.
 *
 * So: light mode lifts with shadow and by dropping the border (white can't get
 * lighter). Dark mode lifts with `surfaceElevated` and no shadow (a glow is
 * invisible against a near-black page). Same component, same intent, two honest
 * implementations.
 */
export function Card({ variant = 'default', dividerInset = 0, style, children, ...props }: CardProps) {
  const theme = useQashyTheme();
  const dark = theme.mode === 'dark';
  const hero = variant === 'hero';

  const base: ViewStyle = {
    backgroundColor: hero ? theme.surfaceElevated : theme.surface,
    borderRadius: radius.card,
    borderCurve: 'continuous',
    borderWidth: hero && !dark ? 0 : StyleSheet.hairlineWidth,
    borderColor: theme.border,
    boxShadow: hero ? theme.shadowRaised : theme.shadowCard,
  };

  if (variant === 'list') {
    base.paddingVertical = space.xs;
    base.paddingHorizontal = space.lg;
    base.overflow = 'hidden';
  } else {
    base.padding = hero ? space.xxl : space.lg;
  }

  return (
    <View {...props} style={[base, style]}>
      {variant === 'list' ? withDividers(children, theme.border, dividerInset) : children}
    </View>
  );
}

function withDividers(children: ReactNode, color: ColorValue, inset: number) {
  const items = Children.toArray(children);
  if (items.length < 2) return children;
  return items.map((child, index) => (
    <Fragment key={index}>
      {index > 0 ? (
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: color, marginStart: inset }} />
      ) : null}
      {child}
    </Fragment>
  ));
}
