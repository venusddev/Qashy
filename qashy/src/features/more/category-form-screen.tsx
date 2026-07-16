import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { ColorSwatch } from '@/components/ui/color-swatch';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import type { CategoryKind } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';

const COLORS = ['#5F9F78', '#E08C5A', '#5B8DEF', '#8B76D8', '#E16B75', '#C47ED0', '#6D7885'];
const ICONS = {
  expense: [
    ['cart', 'Groceries'],
    ['fork.knife', 'Dining'],
    ['car', 'Transport'],
    ['house', 'Home'],
    ['heart', 'Health'],
    ['sparkles', 'Fun'],
  ],
  income: [
    ['banknote', 'Pay'],
    ['plus.circle', 'Other income'],
  ],
} as const;

export function CategoryFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const existing = id ? state.categories.find((item) => item.id === id) : undefined;
  const [name, setName] = useState(existing?.name ?? '');
  const [kind, setKind] = useState<CategoryKind>(existing?.kind ?? 'expense');
  const [color, setColor] = useState(existing?.color ?? COLORS[0]);
  const [icon, setIcon] = useState(existing?.icon ?? ICONS[existing?.kind ?? 'expense'][0][0]);
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
  const parentChoices = state.categories.filter((item) =>
    (!item.archived || item.id === parentId) &&
    item.kind === kind &&
    !item.parentId &&
    item.id !== existing?.id,
  );
  const selectedParentId = parentChoices.some((item) => item.id === parentId) ? parentId : '';

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await repository.saveCategory({ name: name.trim() || 'Category', kind, color, icon, parentId: selectedParentId || null, archived: false }, existing?.id);
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

  if (id && !existing) return <Redirect href="/more" />;

  return (
    <FormScreen contentContainerStyle={{ gap: 16 }}>
      <Card style={{ gap: 16 }}>
        <FormField label="Category name" value={name} onChangeText={setName} autoFocus={!existing} />
        <View accessibilityLabel="Category kind" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8 }}>{(['expense', 'income'] as CategoryKind[]).map((item) => <View key={item} style={{ flex: 1 }}><ChoiceChip label={item[0].toUpperCase() + item.slice(1)} selected={kind === item} disabled={kindLocked && kind !== item} onPress={() => { setKind(item); setParentId(''); setIcon(ICONS[item][0][0]); }} /></View>)}</View>
        {kindLocked ? <AppText variant="caption" muted>Kind is locked because transactions, budgets, goals, or schedules reference this category.</AppText> : null}
        <AppText variant="label">Icon</AppText>
        <View accessibilityLabel="Category icon" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {ICONS[kind].map(([value, label]) => <ChoiceChip key={value} label={label} icon={value} selected={icon === value} onPress={() => setIcon(value)} />)}
        </View>
        <AppText variant="label">Color</AppText>
        <View accessibilityLabel="Category color" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>{COLORS.map((item) => <ColorSwatch key={item} color={item} selected={color === item} label={`Use ${item} category color`} onPress={() => setColor(item)} />)}</View>
        <AppText variant="label">Parent category</AppText>
        <View accessibilityLabel="Parent category" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}><ChoiceChip label="None" selected={!selectedParentId} onPress={() => setParentId('')} />{parentChoices.map((item) => <ChoiceChip key={item.id} label={`${item.name}${item.archived ? ' (archived)' : ''}`} disabled={item.archived} selected={selectedParentId === item.id} onPress={() => setParentId(item.id)} />)}</View>
      </Card>
      <ActionButton title={busy ? 'Saving…' : existing ? 'Save category' : 'Create category'} icon="checkmark" onPress={save} disabled={busy} busy={busy} />
      {existing ? <ActionButton title="Archive category" variant="danger" onPress={archive} disabled={busy} /> : null}
    </FormScreen>
  );
}
