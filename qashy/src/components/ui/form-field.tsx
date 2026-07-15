import { TextInput, View, type TextInputProps } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { useQashyTheme } from '@/theme/theme';

export function FormField({ label, hint, style, ...props }: TextInputProps & { label: string; hint?: string }) {
  const theme = useQashyTheme();
  return (
    <View style={{ gap: 7 }}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        {...props}
        accessibilityLabel={props.accessibilityLabel ?? label}
        placeholderTextColor={theme.textMuted}
        style={[
          {
            minHeight: 50,
            paddingHorizontal: 15,
            paddingVertical: 12,
            borderRadius: 16,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surface,
            color: theme.text,
            fontSize: 16,
          },
          style,
        ]}
      />
      {hint ? <AppText variant="caption" muted>{hint}</AppText> : null}
    </View>
  );
}
