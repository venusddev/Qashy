import { useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import type { AccentSource, ThemeMode } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';

const ACCENTS = ['#5966E9', '#007AFF', '#00A58E', '#36A852', '#E7892C', '#E0516B', '#A95BCD', '#6D7885'];

export function AppearanceScreen() {
  const repository = useFinanceRepository();
  const { settings } = useFinanceState();
  const theme = useQashyTheme();
  const [mode, setMode] = useState<ThemeMode>(settings.themeMode);
  const [source, setSource] = useState<AccentSource>(settings.accentSource);
  const [hex, setHex] = useState(settings.accentHex);
  const validHex = /^#[0-9A-Fa-f]{6}$/.test(hex);
  const save = async () => {
    if (!validHex) return Alert.alert('Invalid color', 'Use a six-digit hex color such as #5966E9.');
    await repository.updateSettings({ themeMode: mode, accentSource: source, accentHex: hex.toUpperCase() });
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, paddingBottom: 40, gap: 16, width: '100%', maxWidth: 720, alignSelf: 'center' }}>
      <Card style={{ gap: 16 }}>
        <AppText variant="headline">Appearance</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{(['system', 'light', 'dark'] as ThemeMode[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={mode === item} onPress={() => setMode(item)} />)}</View>
      </Card>
      <Card style={{ gap: 16 }}>
        <AppText variant="headline">Accent source</AppText>
        <ChoiceChip label={process.env.EXPO_OS === 'android' ? 'Material You wallpaper' : 'System accent'} selected={source === 'system'} onPress={() => setSource('system')} icon="paintbrush" />
        <AppText muted>{process.env.EXPO_OS === 'android' ? 'Android 12 and later derive this from your wallpaper. Older versions use Qashy’s default palette.' : 'Uses native semantic surfaces and the platform accent.'}</AppText>
        <AppText variant="label">Curated accents</AppText>
        <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
          {ACCENTS.map((color) => <Pressable key={color} accessibilityRole="button" accessibilityLabel={`Use ${color} accent`} onPress={() => { setSource('preset'); setHex(color); }} style={{ width: 44, height: 44, borderRadius: 99, backgroundColor: color, borderWidth: source !== 'system' && hex.toUpperCase() === color ? 3 : 0, borderColor: theme.text }} />)}
        </View>
        <FormField label="Custom accent" value={hex} onChangeText={(value) => { setSource('custom'); setHex(value); }} autoCapitalize="characters" maxLength={7} hint="Only the accent changes; semantic surfaces retain accessible contrast." />
      </Card>
      <Card style={{ backgroundColor: validHex ? hex : theme.accent, gap: 6 }}>
        <AppText variant="caption" style={{ color: '#FFFFFFB8' }}>PREVIEW</AppText>
        <AppText variant="headline" style={{ color: '#FFFFFF' }}>Glass, color, and clarity</AppText>
        <AppText style={{ color: '#FFFFFFD9' }}>Qashy adapts the same hierarchy across iOS, Android, and desktop.</AppText>
      </Card>
      <ActionButton title="Save appearance" icon="checkmark" onPress={save} />
    </ScrollView>
  );
}
