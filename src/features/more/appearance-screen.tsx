import { useState } from 'react';
import { ScrollView, View, useColorScheme } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { ColorSwatch } from '@/components/ui/color-swatch';
import { FormField } from '@/components/ui/form-field';
import { MotionView } from '@/components/ui/motion';
import type { AccentSource, ThemeMode } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import {
  ACCENT_PRESETS,
  accessibleAccentColor,
  darkTokens,
  lightTokens,
  mixHex,
  readableTextColor,
} from '@/theme/tokens';
import { errorMessage, showError } from '@/utils/confirm';

export function AppearanceScreen() {
  const repository = useFinanceRepository();
  const { settings } = useFinanceState();
  const theme = useQashyTheme();
  const systemScheme = useColorScheme();
  const [expectedRevision, setExpectedRevision] = useState(settings.revision);
  const [mode, setMode] = useState<ThemeMode>(settings.themeMode);
  const [source, setSource] = useState<AccentSource>(settings.accentSource);
  const [hex, setHex] = useState(settings.accentHex);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const validHex = /^#[0-9A-Fa-f]{6}$/.test(hex);
  const previewMode = mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;
  const modeTokens = previewMode === 'dark' ? darkTokens : lightTokens;
  const requestedPreview = source === 'system' ? '#5966E9' : validHex ? hex : theme.staticAccent;
  const previewHex = accessibleAccentColor(requestedPreview, modeTokens.surface, modeTokens.text);
  const previewText = readableTextColor(previewHex);
  const previewMuted = mixHex(previewText, previewHex, 0.25);
  const customError = source === 'custom' && !validHex
    ? 'Use a six-digit hex color such as #5966E9.'
    : undefined;
  const save = async () => {
    if (saving || customError) return;
    setSaving(true);
    setSaved(false);
    try {
      const updated = await repository.updateSettings({
        themeMode: mode,
        accentSource: source,
        accentHex: validHex ? hex.toUpperCase() : settings.accentHex,
      }, expectedRevision);
      setExpectedRevision(updated.revision);
      setSaved(true);
    } catch (reason) {
      showError('Couldn’t save appearance', errorMessage(reason, 'Try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, paddingBottom: 40, gap: 16, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
      <MotionView>
        <Card style={{ gap: 16 }}>
          <AppText variant="headline">Appearance</AppText>
          <View accessibilityLabel="Appearance" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{(['system', 'light', 'dark'] as ThemeMode[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={mode === item} onPress={() => { setMode(item); setSaved(false); }} />)}</View>
        </Card>
      </MotionView>
      <MotionView delay={45}>
        <Card style={{ gap: 16 }}>
          <AppText variant="headline">Accent source</AppText>
          <View accessibilityLabel="Accent source" accessibilityRole="radiogroup" style={{ gap: 12 }}>
            <ChoiceChip label={process.env.EXPO_OS === 'android' ? 'Material You wallpaper' : 'Qashy default'} selected={source === 'system'} onPress={() => { setSource('system'); setSaved(false); }} icon="paintbrush" />
            <AppText muted>{process.env.EXPO_OS === 'android' ? 'Android 12 and later derive this from your wallpaper. Older versions use Qashy’s default palette.' : 'Uses Qashy’s indigo accent on neutral surfaces.'}</AppText>
            <AppText variant="label">Curated accents</AppText>
            <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
              {ACCENT_PRESETS.map((color) => <ColorSwatch key={color} color={color} selected={source === 'preset' && hex.toUpperCase() === color} label={`Use ${color} accent`} onPress={() => { setSource('preset'); setHex(color); setSaved(false); }} />)}
            </View>
          </View>
          <FormField label="Custom accent" value={hex} onChangeText={(value) => { setSource('custom'); setHex(value); setSaved(false); }} autoCapitalize="characters" maxLength={7} error={customError} hint="Only the accent changes. Qashy gently adjusts unsafe colors to preserve contrast." />
        </Card>
      </MotionView>
      <MotionView key={`${mode}-${source}-${previewHex}`} variant="zoom" exit animateLayout>
        <Card style={{ backgroundColor: previewHex, gap: 6 }}>
          <AppText variant="caption" style={{ color: previewMuted }}>PREVIEW</AppText>
          <AppText variant="headline" style={{ color: previewText }}>Color, contrast, and clarity</AppText>
          <AppText style={{ color: previewMuted }}>Qashy adapts the same hierarchy across iOS, Android, and desktop.</AppText>
        </Card>
      </MotionView>
      <MotionView delay={90}>
        <ActionButton title={saving ? 'Saving…' : saved ? 'Saved' : 'Save appearance'} icon="checkmark" disabled={saving || Boolean(customError)} busy={saving} onPress={save} />
      </MotionView>
    </ScrollView>
  );
}
