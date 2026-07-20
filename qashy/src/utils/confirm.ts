import { Alert } from 'react-native';

import { translateCurrent } from '@/localization/localization';
import { hapticWarning } from '@/utils/haptics';

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
}

// Alert.alert is a no-op on react-native-web, so dialogs must branch per platform.
export function confirmDestructive({ title, message, confirmLabel = 'Delete' }: ConfirmOptions) {
  const translatedTitle = translateCurrent(title);
  const translatedMessage = message ? translateCurrent(message) : undefined;
  const translatedConfirmLabel = translateCurrent(confirmLabel);
  if (process.env.EXPO_OS === 'web') {
    const text = translatedMessage ? `${translatedTitle}\n\n${translatedMessage}` : translatedTitle;
    return Promise.resolve(typeof window !== 'undefined' && window.confirm(text));
  }
  return new Promise<boolean>((resolve) => {
    Alert.alert(translatedTitle, translatedMessage, [
      { text: translateCurrent('Cancel'), style: 'cancel', onPress: () => resolve(false) },
      {
        text: translatedConfirmLabel,
        style: 'destructive',
        onPress: () => {
          hapticWarning();
          resolve(true);
        },
      },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

export function showError(title: string, message?: string) {
  const translatedTitle = translateCurrent(title);
  const translatedMessage = message ? translateCurrent(message) : undefined;
  if (process.env.EXPO_OS === 'web') {
    if (typeof window !== 'undefined') window.alert(translatedMessage ? `${translatedTitle}\n\n${translatedMessage}` : translatedTitle);
    return;
  }
  Alert.alert(translatedTitle, translatedMessage);
}

export function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}
