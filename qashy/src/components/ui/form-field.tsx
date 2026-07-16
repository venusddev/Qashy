import { TextInput, View, type TextInputProps } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { MotionView } from '@/components/ui/motion';
import { useQashyTheme } from '@/theme/theme';

export function FormField({
  label,
  hint,
  error,
  required = false,
  style,
  accessibilityHint,
  ...props
}: TextInputProps & { label: string; hint?: string; error?: string; required?: boolean }) {
  const theme = useQashyTheme();
  const description = error ?? hint;
  const baseAccessibilityLabel = props.accessibilityLabel ?? label;
  const fieldAccessibilityLabel = required
    ? `${baseAccessibilityLabel}, required`
    : baseAccessibilityLabel;
  return (
    <View style={{ gap: 7 }}>
      <AppText variant="label">{label}{required ? ' *' : ''}</AppText>
      <TextInput
        {...props}
        accessibilityLabel={fieldAccessibilityLabel}
        accessibilityHint={error ?? accessibilityHint}
        aria-required={required || undefined}
        placeholderTextColor={theme.textMuted}
        style={[
          {
            minHeight: 50,
            paddingHorizontal: 15,
            paddingVertical: 12,
            borderRadius: 16,
            borderCurve: 'continuous',
            borderWidth: 1,
            borderColor: error ? theme.negative : theme.border,
            backgroundColor: theme.surface,
            color: theme.text,
            fontSize: 16,
          },
          style,
        ]}
      />
      {description ? (
        <MotionView key={description} variant="up" exit animateLayout>
          <AppText
            accessibilityRole={error ? 'alert' : undefined}
            accessibilityLiveRegion={error ? 'polite' : undefined}
            selectable
            variant="caption"
            muted={!error}
            style={error ? { color: theme.negative } : undefined}>
            {description}
          </AppText>
        </MotionView>
      ) : null}
    </View>
  );
}
