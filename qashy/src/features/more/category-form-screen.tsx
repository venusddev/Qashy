import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import type { CategoryKind } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';

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
  const [busy, setBusy] = useState(false);
  // Mirrors the repository rule that a referenced category cannot change kind,
  // matching the account form's locked-currency treatment.
  const kindLocked = !!existing && (
    state.transactions.some((item) => item.categoryId === existing.id) ||
    state.recurringRules.some((item) => item.template.categoryId === existing.id) ||
    state.budgets.some((item) => item.filters.categoryIds.includes(existing.id)) ||
    state.goals.some((item) => item.linkedCategoryId === existing.id)
  );

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await repository.saveCategory({ name: name.trim() || 'Category', kind, color, icon: existing?.icon ?? (kind === 'income' ? 'arrow.down' : 'arrow.up'), parentId: parentId || null, archived: false }, existing?.id);
      router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t save category', errorMessage(reason, 'Check the form and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!existing || busy) return;
    if (!(await confirmDestructive({ title: `Archive ${existing.name}?`, message: 'The category is hidden from lists and pickers. You can restore it from the Archived section in More.', confirmLabel: 'Archive' }))) return;
    setBusy(true);
    try {
      await repository.saveCategory({ ...existing, archived: true }, existing.id);
      router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t archive category', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormScreen contentContainerStyle={{ gap: 16 }}>
      <Card style={{ gap: 16 }}>
        <FormField label="Category name" value={name} onChangeText={setName} autoFocus={!existing} />
        <View style={{ flexDirection: 'row', gap: 8 }}>{(['expense', 'income'] as CategoryKind[]).map((item) => <View key={item} style={{ flex: 1 }}><ChoiceChip label={item[0].toUpperCase() + item.slice(1)} selected={kind === item} disabled={kindLocked && kind !== item} onPress={() => { setKind(item); setParentId(''); }} /></View>)}</View>
        {kindLocked ? <AppText variant="caption" muted>Kind is locked because transactions, budgets, goals, or schedules reference this category.</AppText> : null}
        <AppText variant="label">Color</AppText>
        <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>{COLORS.map((item) => <Pressable key={item} accessibilityRole="button" accessibilityLabel={`Use ${item} category color`} onPress={() => setColor(item)} style={{ width: 44, height: 44, borderRadius: 99, backgroundColor: item, borderWidth: color === item ? 3 : 0, borderColor: theme.text }} />)}</View>
        <AppText variant="label">Parent category</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ChoiceChip label="None" selected={!parentId} onPress={() => setParentId('')} />{state.categories.filter((item) => item.kind === kind && !item.parentId && item.id !== existing?.id).map((item) => <ChoiceChip key={item.id} label={item.name} selected={parentId === item.id} onPress={() => setParentId(item.id)} />)}</View>
      </Card>
      <ActionButton title={busy ? 'Saving…' : existing ? 'Save category' : 'Create category'} icon="checkmark" onPress={save} disabled={busy} />
      {existing ? <ActionButton title="Archive category" variant="danger" onPress={archive} disabled={busy} /> : null}
    </FormScreen>
  );
}
