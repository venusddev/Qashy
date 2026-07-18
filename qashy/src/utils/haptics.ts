import * as Haptics from 'expo-haptics';

// Haptics are native-only; on web every helper is a silent no-op so call
// sites never need to branch per platform.
const supportsHaptics = process.env.EXPO_OS === 'ios' || process.env.EXPO_OS === 'android';

function trigger(effect: () => Promise<void>) {
  if (!supportsHaptics) return;
  effect().catch(() => {});
}

/** Small tick for picking among options: chips, steppers, toggling a selection. */
export function hapticSelection() {
  trigger(() => Haptics.selectionAsync());
}

/** Light physical tap for direct actions: floating action button, entering selection mode. */
export function hapticImpactLight() {
  trigger(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** Positive confirmation after a save, import, or milestone completes. */
export function hapticSuccess() {
  trigger(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** Cautionary buzz when the user confirms a destructive action. */
export function hapticWarning() {
  trigger(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}
