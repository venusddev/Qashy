import { KeyboardAvoidingView, ScrollView, type ScrollViewProps } from 'react-native';

import { MotionView } from '@/components/ui/motion';
import { useQashyTheme } from '@/theme/theme';

// Shared scroll container for form screens: taps on chips and buttons land on
// the first touch while the keyboard is open, and iOS keeps the focused field
// above the keyboard.
export function FormScreen({ children, contentContainerStyle, maxWidth = 680, ...props }: ScrollViewProps & { maxWidth?: number }) {
  const theme = useQashyTheme();
  const scroll = (
    <MotionView variant="fade" style={{ flex: 1 }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1, backgroundColor: theme.background }}
        contentContainerStyle={[
          { padding: 18, paddingBottom: 44, gap: 18, width: '100%', maxWidth, alignSelf: 'center' },
          contentContainerStyle,
        ]}
        {...props}>
        {children}
      </ScrollView>
    </MotionView>
  );
  if (process.env.EXPO_OS === 'web') return scroll;
  return (
    <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      {scroll}
    </KeyboardAvoidingView>
  );
}
