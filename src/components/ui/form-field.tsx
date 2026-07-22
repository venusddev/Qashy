import { TextInput, View, type TextInputProps } from 'react-native';

import { AppText } from '@/components/ui/app-text';
import { MotionView } from '@/components/ui/motion';
import { useLocalization } from '@/localization/localization';
import { useQashyTheme } from '@/theme/theme';

export function FormField({
  label,
  hint,
  error,
  required = false,
  literalLabel = false,
  style,
  accessibilityHint,
  ...props
}: TextInputProps & {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /**
   * Set when the label is built from stored data — for example a per-category
   * cap field titled with the category the user named. Scoped to the label:
   * hints and validation errors are always developer copy and stay translated.
   */
  literalLabel?: boolean;
}) {
  const theme = useQashyTheme();
  const { isRtl, t } = useLocalization();
  const description = error ?? hint;
  const translatedLabel = literalLabel ? label : t(label);
  const translatedDescription = description ? t(description) : undefined;
  const baseAccessibilityLabel = props.accessibilityLabel ? t(props.accessibilityLabel) : translatedLabel;
  const fieldAccessibilityLabel = required
    ? `${baseAccessibilityLabel}, ${t('required')}`
    : baseAccessibilityLabel;
  // The visible description (hint, or the error that replaces it) and the
  // caller's own hint are both meaningful, so announce both rather than
  // letting the description silently discard the caller's.
  const translatedCallerHint = accessibilityHint ? t(accessibilityHint) : undefined;
  const composedAccessibilityHint = [translatedDescription, translatedCallerHint]
    .filter((part): part is string => Boolean(part))
    .join('. ') || undefined;
  const isInvalid = Boolean(error);
  // React Native's AccessibilityState typing predates the `invalid` flag and
  // never modelled `aria-invalid`, but VoiceOver/TalkBack and the DOM both read
  // them at runtime. This assertion is the documented boundary for that gap.
  const validityProps = {
    accessibilityState: { ...props.accessibilityState, invalid: isInvalid },
    ...(process.env.EXPO_OS === 'web' ? { 'aria-invalid': isInvalid } : null),
  } as TextInputProps;
  return (
    <View style={{ gap: 7 }}>
      <AppText literal={literalLabel} variant="label">{label}{required ? ' *' : ''}</AppText>
      <TextInput
        {...props}
        placeholder={props.placeholder ? t(props.placeholder) : undefined}
        accessibilityLabel={fieldAccessibilityLabel}
        accessibilityHint={composedAccessibilityHint}
        {...validityProps}
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
            writingDirection: isRtl ? 'rtl' : 'ltr',
            textAlign: isRtl ? 'right' : 'left',
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
            // Already resolved above; AppText must not translate it again.
            literal
            variant="caption"
            muted={!error}
            style={error ? { color: theme.negative } : undefined}>
            {translatedDescription}
          </AppText>
        </MotionView>
      ) : null}
    </View>
  );
}
