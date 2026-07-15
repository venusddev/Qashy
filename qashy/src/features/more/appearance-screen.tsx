import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import type { AccentSource, ThemeMode } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { ACCENT_PRESETS, mixHex, readableTextColor } from '@/theme/tokens';
import { errorMessage, showError } from '@/utils/confirm';

export function AppearanceScreen() {
  const repository = useFinanceRepository();
  const { settings } = useFinanceState();
  const theme = useQashyTheme();
  const [mode, setMode] = useState<ThemeMode>(settings.themeMode);
  const [source, setSource] = useState<AccentSource>(settings.accentSource);
  const [hex, setHex] = useState(settings.accentHex);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const validHex = /^#[0-9A-Fa-f]{6}$/.test(hex);
  const previewHex = validHex ? hex : theme.staticAccent;
  const previewText = readableTextColor(previewHex);
  const previewMuted = mixHex(previewText, previewHex, 0.25);
  const save = async () => {
    if (!validHex) return showError('Invalid color', 'Use a six-digit hex color such as #5966E9.');
    setSaving(true);
    setSaved(false);
    try {
      await repository.updateSettings({ themeMode: mode, accentSource: source, accentHex: hex.toUpperCase() });
      setSaved(true);
    } catch (reason) {
      showError('Couldn’t save appearance', errorMessage(reason, 'Try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, paddingBottom: 40, gap: 16, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
      <Card style={{ gap: 16 }}>
        <AppText variant="headline">Appearance</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{(['system', 'light', 'dark'] as ThemeMode[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={mode === item} onPress={() => setMode(item)} />)}</View>
      </Card>
      <Card style={{ gap: 16 }}>
        <AppText variant="headline">Accent source</AppText>
        <ChoiceChip label={process.env.EXPO_OS === 'android' ? 'Material You wallpaper' : 'Qashy default'} selected={source === 'system'} onPress={() => setSource('system')} icon="paintbrush" />
        <AppText muted>{process.env.EXPO_OS === 'android' ? 'Android 12 and later derive this from your wallpaper. Older versions use Qashy’s default palette.' : 'Uses Qashy’s indigo accent on neutral surfaces.'}</AppText>
        <AppText variant="label">Curated accents</AppText>
        <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
          {ACCENT_PRESETS.map((color) => <Pressable key={color} accessibilityRole="button" accessibilityLabel={`Use ${color} accent`} onPress={() => { setSource('preset'); setHex(color); }} style={{ width: 44, height: 44, borderRadius: 99, backgroundColor: color, borderWidth: source !== 'system' && hex.toUpperCase() === color ? 3 : 0, borderColor: theme.text }} />)}
        </View>
        <FormField label="Custom accent" value={hex} onChangeText={(value) => { setSource('custom'); setHex(value); }} autoCapitalize="characters" maxLength={7} hint="Only the accent changes; semantic surfaces retain accessible contrast." />
      </Card>
      <Card style={{ backgroundColor: previewHex, gap: 6 }}>
        <AppText variant="caption" style={{ color: previewMuted }}>PREVIEW</AppText>
        <AppText variant="headline" style={{ color: previewText }}>Color, contrast, and clarity</AppText>
        <AppText style={{ color: previewMuted }}>Qashy adapts the same hierarchy across iOS, Android, and desktop.</AppText>
      </Card>
      <ActionButton title={saving ? 'Saving…' : saved ? 'Saved' : 'Save appearance'} icon="checkmark" disabled={saving} onPress={save} />
    </ScrollView>
  );
}
