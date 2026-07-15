import { Text, type TextProps } from 'react-native';

import { useQashyTheme } from '@/theme/theme';

type Variant = 'title' | 'headline' | 'body' | 'caption' | 'label' | 'money';

const variants = {
  title: { fontSize: 32, lineHeight: 38, fontWeight: '700' as const, letterSpacing: -0.8 },
  headline: { fontSize: 20, lineHeight: 26, fontWeight: '700' as const, letterSpacing: -0.25 },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' as const },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const },
  label: { fontSize: 15, lineHeight: 20, fontWeight: '600' as const },
  money: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const, fontVariant: ['tabular-nums'] as const, letterSpacing: -0.6 },
};

export function AppText({ variant = 'body', muted, style, selectable = true, ...props }: TextProps & { variant?: Variant; muted?: boolean }) {
  const theme = useQashyTheme();
  return (
    <Text
      {...props}
      selectable={selectable}
      style={[variants[variant], { color: muted ? theme.textMuted : theme.text }, style]}
    />
  );
}
