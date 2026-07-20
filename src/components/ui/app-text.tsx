import { Children } from 'react';
import { Text, type TextProps } from 'react-native';

import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';

type Variant = 'title' | 'headline' | 'body' | 'caption' | 'label' | 'money';

const variants = {
  title: { fontSize: 30, lineHeight: 36, fontWeight: '700' as const, letterSpacing: -0.2 },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '700' as const, letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600' as const },
  money: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const, fontVariant: ['tabular-nums'] as const, letterSpacing: -0.2 },
};

/**
 * `literal` opts a run of text out of translation. Anything the user typed —
 * account and category names, transaction titles, notes, tag names — must set
 * it. Without it the dictionary rewrites content it happens to have a key for,
 * so an account the user deliberately named "Savings" renders as "חיסכון" in
 * Hebrew and the ledger stops matching what they entered.
 */
export function AppText({ variant = 'body', muted, style, selectable = false, literal = false, children, ...props }: TextProps & { variant?: Variant; muted?: boolean; literal?: boolean }) {
  const theme = useQashyTheme();
  const { isRtl, t } = useLocalization();
  const localizedChildren = literal
    ? children
    : Children.map(children, (child) => typeof child === 'string' ? t(child) : child);
  return (
    <Text
      {...props}
      selectable={selectable}
      style={[variants[variant], { color: muted ? theme.textMuted : theme.text, writingDirection: isRtl ? 'rtl' : 'ltr', textAlign: isRtl ? 'right' : undefined }, style]}>
      {localizedChildren}
    </Text>
  );
}
