import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View, useWindowDimensions } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { QASHY_ACCENT } from '@/domain/defaults';
import type { AccountType, AccentSource, ThemeMode } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { parseMoney } from '@/utils/money';

const ACCENTS = ['#5966E9', '#007AFF', '#00A58E', '#36A852', '#E7892C', '#E0516B', '#A95BCD', '#6D7885'];

export function OnboardingScreen() {
  const repository = useFinanceRepository();
  const { settings } = useFinanceState();
  const theme = useQashyTheme();
  const { width } = useWindowDimensions();
  const [step, setStep] = useState(0);
  const [locale, setLocale] = useState(settings.locale);
  const [currency, setCurrency] = useState(settings.baseCurrency);
  const [accountName, setAccountName] = useState('Everyday');
  const [accountType, setAccountType] = useState<AccountType>('checking');
  const [openingBalance, setOpeningBalance] = useState('0');
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [accentSource, setAccentSource] = useState<AccentSource>('system');
  const [accentHex, setAccentHex] = useState(QASHY_ACCENT);
  const [saving, setSaving] = useState(false);

  const finish = async () => {
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
          <View style={{ width: 64, height: 64, borderRadius: 22, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', boxShadow: '0 18px 40px rgba(89,102,233,0.25)' }}>
            <AppText selectable={false} variant="title" style={{ color: theme.onAccent }}>Q</AppText>
          </View>
          <AppText variant="title">{step === 0 ? 'Money, made calmer.' : ['Your home currency', 'Create your first account', 'Make it yours'][step - 1]}</AppText>
          <AppText muted style={{ textAlign: 'center', maxWidth: 520 }}>
            {step === 0
              ? 'Qashy is a private, local-first place for everyday spending, flexible budgets, and goals.'
              : ['Dates and amounts will follow these preferences.', 'Balances are derived from this opening amount and your transactions.', 'Follow the system or choose an accent that feels like you.'][step - 1]}
          </AppText>
        </View>

        <View style={{ flexDirection: 'row', gap: 7, justifyContent: 'center' }}>
          {[0, 1, 2, 3].map((item) => (
            <View key={item} style={{ width: item === step ? 26 : 8, height: 8, borderRadius: 99, backgroundColor: item === step ? theme.accent : theme.border }} />
          ))}
        </View>

        <Card style={{ gap: 18, padding: width < 560 ? 18 : 28 }}>
          {step === 0 ? (
            <View style={{ gap: 16 }}>
              {[
                ['Private by default', 'No account and no finance data leaves this device.'],
                ['Flexible, not fussy', 'Track the categories and time periods that fit your life.'],
                ['Ready everywhere', 'A native-feeling phone app and a responsive desktop PWA.'],
              ].map(([title, description]) => (
                <View key={title} style={{ flexDirection: 'row', gap: 14, alignItems: 'flex-start' }}>
                  <View style={{ width: 34, height: 34, borderRadius: 12, backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}>
                    <AppText selectable={false} style={{ color: theme.accent }}>✓</AppText>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}><AppText variant="label">{title}</AppText><AppText muted>{description}</AppText></View>
                </View>
              ))}
            </View>
          ) : null}

          {step === 1 ? (
            <View style={{ gap: 16 }}>
              <FormField label="Locale" value={locale} onChangeText={setLocale} placeholder="en-US" autoCapitalize="none" />
              <FormField label="Base currency" value={currency} onChangeText={setCurrency} placeholder="USD" autoCapitalize="characters" maxLength={3} hint="Budgets, goals, and reports use this currency." />
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {['USD', 'EUR', 'GBP', 'ILS', 'JPY'].map((item) => <ChoiceChip key={item} label={item} selected={currency === item} onPress={() => setCurrency(item)} />)}
              </View>
            </View>
          ) : null}

          {step === 2 ? (
            <View style={{ gap: 16 }}>
              <FormField label="Account name" value={accountName} onChangeText={setAccountName} placeholder="Everyday" />
              <AppText variant="label">Account type</AppText>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {(['checking', 'cash', 'savings', 'credit', 'wallet'] as AccountType[]).map((item) => (
                  <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={accountType === item} onPress={() => setAccountType(item)} />
                ))}
              </View>
              <FormField label={`Opening balance (${currency})`} value={openingBalance} onChangeText={setOpeningBalance} keyboardType="decimal-pad" placeholder="0" />
            </View>
          ) : null}

          {step === 3 ? (
            <View style={{ gap: 18 }}>
              <AppText variant="label">Appearance</AppText>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                {(['system', 'light', 'dark'] as ThemeMode[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={themeMode === item} onPress={() => setThemeMode(item)} />)}
              </View>
              <AppText variant="label">Accent</AppText>
              <ChoiceChip label="System accent" selected={accentSource === 'system'} onPress={() => setAccentSource('system')} icon="paintbrush" />
              <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
                {ACCENTS.map((color) => (
                  <View key={color} style={{ borderRadius: 99, borderWidth: accentSource !== 'system' && accentHex === color ? 3 : 0, borderColor: theme.text, padding: 3 }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Use ${color} accent`}
                      onPress={() => { setAccentSource('preset'); setAccentHex(color); }}
                      style={{ width: 38, height: 38, borderRadius: 99, backgroundColor: color }}
                    />
                  </View>
                ))}
              </View>
            </View>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 12, justifyContent: 'flex-end', paddingTop: 4 }}>
            {step > 0 ? <ActionButton title="Back" variant="secondary" onPress={() => setStep((value) => value - 1)} /> : null}
            <ActionButton
              title={step === 3 ? (saving ? 'Setting up…' : 'Start using Qashy') : 'Continue'}
              icon={step === 3 ? 'checkmark' : 'chevron.right'}
              disabled={saving}
              onPress={() => step === 3 ? finish() : setStep((value) => value + 1)}
            />
          </View>
        </Card>
      </View>
    </ScrollView>
  );
}
