import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import type { PeriodUnit } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { todayLocal } from '@/utils/date';
import { minorToDecimalString, parseMoney } from '@/utils/money';

export function BudgetFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const existing = id ? state.budgets.find((item) => item.id === id) : undefined;
  const toMoneyText = (minor: number) => minorToDecimalString(minor, state.settings.baseCurrency, state.settings.locale);
  const [name, setName] = useState(existing?.name ?? 'Everyday spending');
  const [limit, setLimit] = useState(existing ? toMoneyText(existing.limitMinor) : '1000');
  const [unit, setUnit] = useState<PeriodUnit>(existing?.period.unit ?? 'month');
  const [endDate, setEndDate] = useState(existing?.period.endDate ?? todayLocal());
  const [rollover, setRollover] = useState(existing?.rollover ?? false);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(existing?.filters.categoryIds ?? []);
  const [categoryLimits, setCategoryLimits] = useState<Record<string, string>>(() => Object.fromEntries(existing?.categoryLimits.map((item) => [item.categoryId, toMoneyText(item.limitMinor)]) ?? []));
  const [saving, setSaving] = useState(false);
  const expenseCategories = state.categories.filter((item) => item.kind === 'expense' && !item.archived);

  const toggleCategory = (categoryId: string) => {
    setSelectedCategories((current) => current.includes(categoryId) ? current.filter((item) => item !== categoryId) : [...current, categoryId]);
  };

  const save = async () => {
    setSaving(true);
    try {
      await repository.saveBudget({
        name: name.trim() || 'Budget',
        icon: 'chart.pie',
        color: existing?.color ?? theme.staticAccent,
        limitMinor: parseMoney(limit, state.settings.baseCurrency, state.settings.locale),
        period: { unit, interval: 1, anchorDate: existing?.period.anchorDate ?? todayLocal(), endDate: unit === 'custom' ? endDate : null },
        rollover,
        filters: { accountIds: [], categoryIds: selectedCategories, tagIds: [] },
        categoryLimits: selectedCategories
          .filter((categoryId) => categoryLimits[categoryId]?.trim())
          .map((categoryId) => ({ categoryId, limitMinor: parseMoney(categoryLimits[categoryId], state.settings.baseCurrency, state.settings.locale) })),
        archived: false,
      }, existing?.id);
      router.replace('/plan');
    } catch (reason) {
      showError('Couldn’t save budget', errorMessage(reason, 'Try again.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!existing || saving) return;
    if (!(await confirmDestructive({ title: `Delete ${existing.name}?`, message: 'Past period snapshots are removed with it.' }))) return;
    setSaving(true);
    try {
      await repository.deleteEntities('budgets', [existing.id]);
      router.replace('/plan');
    } catch (reason) {
      showError('Couldn’t delete budget', errorMessage(reason, 'Try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormScreen contentContainerStyle={{ gap: 16, paddingBottom: 40 }}>
      <Card style={{ gap: 16 }}>
        <FormField label="Budget name" value={name} onChangeText={setName} />
        <FormField label={`Total limit (${state.settings.baseCurrency})`} value={limit} onChangeText={setLimit} keyboardType="decimal-pad" />
        <AppText variant="label">Period</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {(['day', 'week', 'month', 'year', 'custom'] as PeriodUnit[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={unit === item} onPress={() => setUnit(item)} />)}
        </View>
        {unit === 'custom' ? <FormField label="End date" value={endDate} onChangeText={setEndDate} placeholder="YYYY-MM-DD" /> : null}
        <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <View style={{ flex: 1, gap: 2 }}><AppText variant="label">Rollover</AppText><AppText variant="caption" muted>Carry both surplus and overspend forward.</AppText></View>
          <Switch value={rollover} onValueChange={setRollover} trackColor={{ true: theme.staticAccent }} />
        </View>
      </Card>

      <Card style={{ gap: 14 }}>
        <AppText variant="headline">Categories and caps</AppText>
        <AppText muted>Leave every category unselected to count all expenses.</AppText>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {expenseCategories.map((category) => <ChoiceChip key={category.id} label={category.name} selected={selectedCategories.includes(category.id)} onPress={() => toggleCategory(category.id)} />)}
        </View>
        {selectedCategories.map((categoryId) => {
          const category = expenseCategories.find((item) => item.id === categoryId);
          return category ? <FormField key={category.id} label={`${category.name} cap (optional)`} value={categoryLimits[category.id] ?? ''} onChangeText={(value) => setCategoryLimits((current) => ({ ...current, [category.id]: value }))} keyboardType="decimal-pad" placeholder="No cap" /> : null;
        })}
      </Card>

      <ActionButton title={saving ? 'Saving…' : existing ? 'Save budget' : 'Create budget'} icon="checkmark" onPress={save} disabled={saving} />
      {existing ? <ActionButton title="Delete budget" variant="danger" onPress={remove} disabled={saving} /> : null}
    </FormScreen>
  );
}
