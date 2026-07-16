import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View, useWindowDimensions, type ColorValue } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { ColorSwatch } from '@/components/ui/color-swatch';
import { FormField } from '@/components/ui/form-field';
import { MotionView } from '@/components/ui/motion';
import { QASHY_ACCENT } from '@/domain/defaults';
import type { AccountType, AccentSource, ThemeMode } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { ACCENT_PRESETS, radius } from '@/theme/tokens';
import { errorMessage, showError } from '@/utils/confirm';
import { validateCurrencyCode, validateMoneyInput } from '@/utils/form-validation';
import { parseMoney } from '@/utils/money';

function isValidLocale(value: string) {
  try {
    new Intl.Locale(value);
    new Intl.NumberFormat(value).format(1);
    return true;
  } catch {
    return false;
  }
}

function StepIndicator({ active, activeColor, inactiveColor }: { active: boolean; activeColor: ColorValue; inactiveColor: ColorValue }) {
  const width = useSharedValue(active ? 26 : 8);

  useEffect(() => {
    width.set(withTiming(active ? 26 : 8, {
      duration: 220,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    }));
  }, [active, width]);

  const animatedStyle = useAnimatedStyle(() => ({ width: width.value }));
  return (
    <Animated.View
      style={[
        {
          width: 8,
          height: 8,
        },
        animatedStyle,
      ]}>
      <View style={{ flex: 1, borderRadius: 99, backgroundColor: active ? activeColor : inactiveColor }} />
    </Animated.View>
  );
}

export function OnboardingScreen() {
  const repository = useFinanceRepository();
  const { settings } = useFinanceState();
  const theme = useQashyTheme();
  const { width } = useWindowDimensions();
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [locale, setLocale] = useState(settings.locale);
  const [currency, setCurrency] = useState(settings.baseCurrency);
  const [accountName, setAccountName] = useState('Everyday');
  const [accountType, setAccountType] = useState<AccountType>('checking');
  const [openingBalance, setOpeningBalance] = useState('0');
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [accentSource, setAccentSource] = useState<AccentSource>('system');
  const [accentHex, setAccentHex] = useState(QASHY_ACCENT);
  const [saving, setSaving] = useState(false);
  const localeValid = isValidLocale(locale);
  const currencyError = validateCurrencyCode(currency, localeValid ? locale : 'en-US');
  const currencyValid = !currencyError;
  const openingError = localeValid && currencyValid
    ? validateMoneyInput(openingBalance, currency, locale, { label: 'Opening balance' })
    : undefined;
  // Step 1 gates Continue so a bad locale or currency surfaces immediately
  // instead of failing the whole flow at the final step.
  const stepValid = (step !== 1 || (localeValid && currencyValid))
    && (step !== 2 || !openingError);
  const moveToStep = (nextStep: number) => {
    setDirection(nextStep > step ? 'forward' : 'back');
    setStep(nextStep);
  };

  const finish = async () => {
    if (saving || !localeValid || !currencyValid || openingError) return;
    setSaving(true);
    try {
      await repository.completeOnboarding({
        locale,
        baseCurrency: currency.toUpperCase(),
        accountName,
        accountType,
        openingBalanceMinor: parseMoney(openingBalance, currency, locale),
        themeMode,
        accentSource,
        accentHex,
      });
      if (process.env.EXPO_OS === 'web' && typeof navigator !== 'undefined' && navigator.storage?.persist) {
        navigator.storage.persist().catch(() => false);
      }
      router.replace('/overview');
    } catch (reason) {
      showError('Couldn’t finish setup', errorMessage(reason, 'Check the form and try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: theme.background }}
      contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <View style={{ width: '100%', maxWidth: 720, gap: 22 }}>
        <View style={{ alignItems: 'center', gap: 12 }}>
          <MotionView variant="zoom">
            <View style={{ width: 64, height: 64, borderRadius: radius.card, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px rgba(25,27,32,0.18)' }}>
              <AppText selectable={false} variant="title" style={{ color: theme.onAccent }}>Q</AppText>
            </View>
          </MotionView>
          <MotionView
            key={`heading-${step}-${direction}`}
            variant={direction === 'forward' ? 'right' : 'left'}
            exit
            animateLayout
            style={{ alignItems: 'center', gap: 4 }}>
            <AppText variant="title">{step === 0 ? 'Money, made calmer.' : ['Your home currency', 'Create your first account', 'Make it yours'][step - 1]}</AppText>
            <AppText muted style={{ textAlign: 'center', maxWidth: 520 }}>
              {step === 0
                ? 'Qashy is a private, local-first place for everyday spending, flexible budgets, and goals.'
                : ['Dates and amounts will follow these preferences.', 'Balances are derived from this opening amount and your transactions.', 'Follow the system or choose an accent that feels like you.'][step - 1]}
            </AppText>
          </MotionView>
        </View>

        <View style={{ flexDirection: 'row', gap: 7, justifyContent: 'center' }}>
          {[0, 1, 2, 3].map((item) => (
            <StepIndicator
              key={item}
              active={item === step}
              activeColor={theme.accent}
              inactiveColor={theme.border}
            />
          ))}
        </View>

        <Card style={{ gap: 18, padding: width < 560 ? 18 : 28 }}>
          <MotionView
            key={`step-${step}-${direction}`}
            variant={direction === 'forward' ? 'right' : 'left'}
            exit
            animateLayout>
            {step === 0 ? (
              <View style={{ gap: 16 }}>
                {[
                  ['Private by default', 'No account and no finance data leaves this device.'],
                  ['Flexible, not fussy', 'Track the categories and time periods that fit your life.'],
                  ['Ready everywhere', 'A native-feeling phone app and a responsive desktop PWA.'],
                ].map(([title, description], index) => (
                  <MotionView key={title} delay={index * 45} variant="right" style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
                    <View style={{ width: 34, height: 34, borderRadius: radius.control, backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}>
                      <AppIcon name="checkmark" color={theme.accent} size={18} />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}><AppText variant="label">{title}</AppText><AppText muted>{description}</AppText></View>
                  </MotionView>
                ))}
              </View>
            ) : null}

            {step === 1 ? (
              <View style={{ gap: 16 }}>
                <FormField label="Locale" value={locale} onChangeText={setLocale} placeholder="en-US" autoCapitalize="none" hint={locale.trim() && !localeValid ? 'Use a valid locale such as en-US.' : undefined} />
                <FormField label="Base currency" value={currency} onChangeText={setCurrency} placeholder="USD" autoCapitalize="characters" maxLength={3} hint={currency.trim() && currencyError ? currencyError : 'Budgets, goals, and reports use this currency.'} />
                <View accessibilityLabel="Base currency" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {['USD', 'EUR', 'GBP', 'ILS', 'JPY'].map((item) => <ChoiceChip key={item} label={item} selected={currency === item} onPress={() => setCurrency(item)} />)}
                </View>
              </View>
            ) : null}

            {step === 2 ? (
              <View style={{ gap: 16 }}>
                <FormField label="Account name" value={accountName} onChangeText={setAccountName} placeholder="Everyday" />
                <AppText variant="label">Account type</AppText>
                <View accessibilityLabel="Account type" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {(['checking', 'cash', 'savings', 'credit', 'wallet'] as AccountType[]).map((item) => (
                    <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={accountType === item} onPress={() => setAccountType(item)} />
                  ))}
                </View>
                <FormField label={`Opening balance (${currency})`} value={openingBalance} onChangeText={setOpeningBalance} keyboardType="decimal-pad" placeholder="0" error={openingError} required />
              </View>
            ) : null}

            {step === 3 ? (
              <View style={{ gap: 18 }}>
                <AppText variant="label">Appearance</AppText>
                <View accessibilityLabel="Appearance" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {(['system', 'light', 'dark'] as ThemeMode[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={themeMode === item} onPress={() => setThemeMode(item)} />)}
                </View>
                <AppText variant="label">Accent</AppText>
                <View accessibilityLabel="Accent color" accessibilityRole="radiogroup" style={{ gap: 12 }}>
                  <ChoiceChip label="System accent" selected={accentSource === 'system'} onPress={() => setAccentSource('system')} icon="paintbrush" />
                  <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
                    {ACCENT_PRESETS.map((color) => (
                      <ColorSwatch
                        key={color}
                        color={color}
                        selected={accentSource === 'preset' && accentHex === color}
                        label={`Use ${color} accent`}
                        onPress={() => { setAccentSource('preset'); setAccentHex(color); }}
                      />
                    ))}
                  </View>
                </View>
              </View>
            ) : null}
          </MotionView>

          <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end', paddingTop: 4 }}>
            {step > 0 ? (
              <MotionView variant="zoom" exit>
                <ActionButton title="Back" variant="secondary" onPress={() => moveToStep(step - 1)} />
              </MotionView>
            ) : null}
            <ActionButton
              title={step === 3 ? (saving ? 'Setting up…' : 'Start using Qashy') : 'Continue'}
              icon={step === 3 ? 'checkmark' : 'chevron.right'}
              disabled={saving || !stepValid}
              busy={saving}
              onPress={() => step === 3 ? finish() : moveToStep(step + 1)}
            />
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}
