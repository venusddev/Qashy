import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';

import { cameraSupported } from '@/components/sync/camera-support';
import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { FormField } from '@/components/ui/form-field';
import { TextButton } from '@/components/ui/text-button';
import { useQashyTheme } from '@/theme/theme';
import { radius, space } from '@/theme/tokens';

/**
 * Reads a pairing code, by camera or by hand.
 *
 * One component for both platforms, because `expo-camera` genuinely does barcode scanning in
 * the browser too — through `BarcodeDetector` where it exists and a polyfill where it does
 * not. Only *availability* differs, and that is isolated in `camera-support.*`.
 *
 * **The manual field is not a fallback bolted on for tests.** A desktop browser is one of the
 * two devices in the common case, and half of them have no camera; the manual code is how
 * that pairing happens. It is also what makes the flow drivable in Playwright, but that is a
 * consequence of it being real, not the reason it exists.
 *
 * What this component must never do with what it reads: log it, put it in a URL, write it to
 * storage, or hold it after handing it over. The pairing code is a secret with a 90-second
 * life, and every one of those would outlive it.
 */
export function QrScanner({
  onCode,
  hint,
}: {
  /** Called once per accepted code. The caller owns validation and any error message. */
  onCode: (code: string) => void;
  hint?: string;
}) {
  const theme = useQashyTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [showManual, setShowManual] = useState(!cameraSupported());

  /**
   * One code per mount.
   *
   * `onBarcodeScanned` fires on every frame that contains a symbol — several times a second,
   * for as long as the code is in view. Without this, a single QR triggers a dozen pairing
   * attempts against a rendezvous that is single-use, and the failures from attempts two
   * onward are what the user would see reported.
   *
   * A ref, not state: the frames arrive faster than a re-render.
   */
  const claimed = useRef(false);
  const claim = useCallback(
    (value: string) => {
      const code = value.trim();
      if (!code || claimed.current) return;
      claimed.current = true;
      onCode(code);
    },
    [onCode],
  );

  const canScan = cameraSupported() && permission?.granted === true;

  return (
    <View style={{ gap: space.md }}>
      {canScan && !showManual ? (
        <View
          style={{
            aspectRatio: 1,
            overflow: 'hidden',
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surfaceMuted,
          }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            // QR only. Every other symbology is a format this app cannot act on, and
            // narrowing the list is what stops a barcode on a nearby object from firing the
            // handler and burning the one claim above.
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => claim(data)}
          />
        </View>
      ) : null}

      {cameraSupported() && !permission?.granted && !showManual ? (
        <View
          style={{
            gap: space.md,
            padding: space.lg,
            borderRadius: radius.card,
            borderWidth: 1,
            borderColor: theme.border,
            backgroundColor: theme.surfaceMuted,
          }}>
          <AppText variant="label">Qashy needs the camera to scan the code</AppText>
          <AppText variant="caption" muted>
            The camera is used only to read the pairing code on your other device. No photo is
            taken and nothing is uploaded.
          </AppText>
          <ActionButton
            title={permission?.canAskAgain === false ? 'Open settings' : 'Allow camera'}
            icon="magnifyingglass"
            // `canAskAgain: false` means the OS will not show a prompt again, so calling
            // `requestPermission` resolves instantly as denied and looks like a dead button.
            // Sending them to the manual code is the path that actually works from here.
            onPress={() => {
              if (permission?.canAskAgain === false) setShowManual(true);
              else void requestPermission();
            }}
          />
        </View>
      ) : null}

      {showManual ? (
        <View style={{ gap: space.sm }}>
          <FormField
            label="Pairing code"
            value={manual}
            onChangeText={setManual}
            placeholder="Paste the code from your other device"
            autoCapitalize="characters"
            autoCorrect={false}
            // Never `secureTextEntry`. This is pasted from another screen and typos are
            // otherwise invisible; the protection here is the 90-second expiry and the SAS
            // comparison that follows, not hiding the characters from the person entering
            // them. Autofill is off so a password manager never records it.
            autoComplete="off"
            multiline
          />
          <ActionButton
            title="Continue"
            icon="checkmark"
            disabled={!manual.trim()}
            onPress={() => claim(manual)}
          />
        </View>
      ) : null}

      {hint ? (
        <AppText variant="caption" muted>
          {hint}
        </AppText>
      ) : null}

      {cameraSupported() ? (
        <TextButton
          title={showManual ? 'Scan a code instead' : 'Can’t scan? Enter the code'}
          tone="muted"
          onPress={() => setShowManual((shown) => !shown)}
        />
      ) : (
        <AppText variant="caption" muted>
          This device can’t use a camera here, so enter the code shown on your other device.
        </AppText>
      )}
    </View>
  );
}
