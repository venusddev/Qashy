import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import type { CategoryKind } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';

const COLORS = ['#5F9F78', '#E08C5A', '#5B8DEF', '#8B76D8', '#E16B75', '#C47ED0', '#6D7885'];

export function CategoryFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.categories.find((item) => item.id === id) : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<CategoryKind>(existing?.kind ?? 'expense');
  const [color, setColor] = useState(existing?.color ?? COLORS[0]);
  const [parentId, setParentId] = useState(existing?.parentId ?? '');

  const save = async () => {
    await repository.saveCategory({ name: name.trim() || 'Category', kind, color, icon: existing?.icon ?? (kind === 'income' ? 'arrow.down' : 'arrow.up'), parentId: parentId || null, archived: false }, existing?.id);
    router.replace('/more');
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, gap: 16, width: '100%', maxWidth: 680, alignSelf: 'center' }}>
      <Card style={{ gap: 16 }}>
        <FormField label="Category name" value={name} onChangeText={setName} autoFocus={!existing} />
        <View style={{ flexDirection: 'row', gap: 8 }}>{(['expense', 'income'] as CategoryKind[]).map((item) => <View key={item} style={{ flex: 1 }}><ChoiceChip label={item[0].toUpperCase() + item.slice(1)} selected={kind === item} onPress={() => { setKind(item); setParentId(''); }} /></View>)}</View>
        <AppText variant="label">Color</AppText>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>{COLORS.map((item) => <Pressable key={item} accessibilityRole="button" accessibilityLabel={`Use ${item} category color`} onPress={() => setColor(item)} style={{ width: 44, height: 44, borderRadius: 99, backgroundColor: item, borderWidth: color === item ? 3 : 0, borderColor: theme.text }} />)}</View>
        <AppText variant="label">Parent category</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ChoiceChip label="None" selected={!parentId} onPress={() => setParentId('')} />{state.categories.filter((item) => item.kind === kind && !item.parentId && item.id !== existing?.id).map((item) => <ChoiceChip key={item.id} label={item.name} selected={parentId === item.id} onPress={() => setParentId(item.id)} />)}</View>
      </Card>
      <ActionButton title={existing ? 'Save category' : 'Create category'} icon="checkmark" onPress={save} />
      {existing ? <ActionButton title="Archive category" variant="danger" onPress={async () => { await repository.saveCategory({ ...existing, archived: true }, existing.id); router.replace('/more'); }} /> : null}
    </ScrollView>
  );
}
