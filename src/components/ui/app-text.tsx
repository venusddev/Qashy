import { Children } from 'react';
import { Text, type TextProps, type TextStyle } from 'react-native';

import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';

type Variant = 'display' | 'title' | 'headline' | 'body' | 'caption' | 'label' | 'eyebrow' | 'money';

// Not `as const`: TextStyle declares fontVariant as a mutable array, so a
// readonly tuple is rejected where the style is actually consumed.
const TABULAR: TextStyle['fontVariant'] = ['tabular-nums'];

/**
 * The type scale.
 *
 * The ramp topped out at `title` (30) and `money` (28), so the largest figure on
 * the app's most important screen — net worth — was an inline `fontSize: 34`
 * override written at the call site. The one number the whole product is built
 * around had no name in the system. And every all-caps kicker ("CURRENT NET
 * WORTH", "LOCAL-FIRST FINANCE") was `caption` with the casing baked into the
 * string and no tracking, which is what makes small caps look cramped.
 *
 * `display` and `eyebrow` close both gaps. The mid-scale sizes are unchanged on
 * purpose: `label` at 15/600 against `body` at 16/400 reads as two distinct
 * roles because of the weight, and shrinking it would have taken every row title
 * and button label in the app down with it. What did change is optical tracking
 * — letter-spacing tightens as size grows, which is what stops large text from
 * looking loose beside small text.
 */
const variants: Record<Variant, TextStyle> = {
  /** The single largest figure on a screen. Net worth, a goal total. */
  display: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: -0.6, fontVariant: TABULAR },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.5 },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3 },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  /** A short piece of UI text with weight: a row title, a button, a stat value. */
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600', letterSpacing: -0.1 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  /** A small all-caps kicker above a heading or a hero figure. */
  eyebrow: { fontSize: 11, lineHeight: 14, fontWeight: '700', letterSpacing: 0.9 },
  money: { fontSize: 28, lineHeight: 34, fontWeight: '700', fontVariant: TABULAR, letterSpacing: -0.5 },
};

/**
 * `literal` opts a run of text out of translation. Anything the user typed —
 * account and category names, transaction titles, notes, tag names — must set
 * it. Without it the dictionary rewrites content it happens to have a key for,
 * so an account the user deliberately named "Savings" renders as "חיסכון" in
 * Hebrew and the ledger stops matching what they entered.
 *
 * `numeric` locks the digits to a fixed advance width. Every figure that can
 * change in place — a balance that animates, a column of amounts, a countdown —
 * needs it, or the text jitters horizontally as digits swap.
 */
export function AppText({ variant = 'body', muted, numeric, style, selectable = false, literal = false, children, ...props }: TextProps & { variant?: Variant; muted?: boolean; numeric?: boolean; literal?: boolean }) {
  const theme = useQashyTheme();
  const { isRtl, t } = useLocalization();
  const localizedChildren = literal
    ? children
    : Children.map(children, (child) => typeof child === 'string' ? t(child) : child);
  return (
    <Text
      {...props}
      selectable={selectable}
      style={[
        variants[variant],
        numeric ? { fontVariant: TABULAR } : null,
        { color: muted ? theme.textMuted : theme.text, writingDirection: isRtl ? 'rtl' : 'ltr', textAlign: isRtl ? 'right' : undefined },
        style,
      ]}>
      {localizedChildren}
    </Text>
  );
}
