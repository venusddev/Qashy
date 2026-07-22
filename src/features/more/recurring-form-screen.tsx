import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Switch, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FormField } from '@/components/ui/form-field';
import { FormScreen } from '@/components/ui/form-screen';
import type { CategoryKind, RecurrenceUnit } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { useLocalization } from '@/localization/localization';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { todayLocal } from '@/utils/date';
import {
  validateDateInput,
  validateMoneyInput,
  validatePositiveInteger,
} from '@/utils/form-validation';
import { hapticSuccess } from '@/utils/haptics';
import { minorToLocalizedDecimalString, parseMoney } from '@/utils/money';

export function RecurringFormScreen() {
  const params = useLocalSearchParams<{ id?: string; kind?: CategoryKind; title?: string; amount?: string; accountId?: string; categoryId?: string }>();
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const existing = params.id ? state.recurringRules.find((item) => item.id === params.id) : undefined;
  const [expectedRevision] = useState(existing?.revision);
  const initialAccount = state.accounts.find((item) => item.id === (existing?.template.accountId ?? params.accountId))
    ?? state.accounts.find((item) => !item.archived);
  const [kind, setKind] = useState<CategoryKind>(existing?.template.kind ?? params.kind ?? 'expense');
  const [title, setTitle] = useState(existing?.template.title ?? params.title ?? '');
  const [note, setNote] = useState(existing?.template.note ?? '');
  const [tagIds, setTagIds] = useState(existing?.template.tagIds ?? []);
  const [amount, setAmount] = useState(existing ? minorToLocalizedDecimalString(existing.template.amountMinor, existing.template.currency, state.settings.locale) : params.amount ?? '');
  const [accountId, setAccountId] = useState(initialAccount?.id ?? '');
  const [categoryId, setCategoryId] = useState(existing?.template.categoryId ?? params.categoryId ?? '');
  const [unit, setUnit] = useState<RecurrenceUnit>(existing?.unit ?? 'month');
  const [interval, setInterval] = useState(String(existing?.interval ?? 1));
  const [startDate, setStartDate] = useState(existing?.startDate ?? todayLocal());
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  const [autoPost, setAutoPost] = useState(existing?.autoPost ?? false);
  const [active, setActive] = useState(existing?.active ?? true);
  const [busy, setBusy] = useState(false);
  const account = state.accounts.find((item) => item.id === accountId) ?? initialAccount;
  const accountChoices = state.accounts.filter((item) => !item.archived || item.id === accountId);
  const categories = state.categories.filter((item) =>
    item.kind === kind && (!item.archived || item.id === categoryId),
  );
  const referencesArchivedEntity = Boolean(
    account?.archived || categories.find((item) => item.id === categoryId)?.archived,
  );
  const amountError = account
    ? validateMoneyInput(amount, account.currency, state.settings.locale, { label: 'Amount', positive: true })
    : 'Choose an account before entering an amount.';
  const intervalError = validatePositiveInteger(interval, 'Repeat interval');
  const startDateError = validateDateInput(startDate, { label: 'Start date' });
  const endDateFormatError = validateDateInput(endDate, { label: 'End date', optional: true });
  const endDateError = !endDateFormatError && endDate && startDate && endDate < startDate
    ? 'End date must not precede the start date.'
    : endDateFormatError;
  const canSave = Boolean(account) && !amountError && !intervalError && !startDateError && !endDateError;
  const toggleTag = (tagId: string) => {
    setTagIds((current) => current.includes(tagId)
      ? current.filter((item) => item !== tagId)
      : [...current, tagId]);
  };

  const save = async () => {
    if (!account || busy || !canSave) return;
    setBusy(true);
    try {
      const normalizedInterval = Math.max(1, Math.floor(Number(interval) || 1));
      const normalizedEndDate = endDate || null;
      await repository.saveRecurringRule({
        template: {
          kind,
          title: title.trim() || t('Recurring transaction'),
          note: note.trim(),
          accountId: account.id,
          categoryId: categoryId || null,
          tagIds,
          amountMinor: parseMoney(amount, account.currency, state.settings.locale),
          currency: account.currency,
        },
        unit,
        interval: normalizedInterval,
        startDate,
        endDate: normalizedEndDate,
        nextDueDate: existing?.nextDueDate ?? startDate,
        autoPost,
        active,
      }, existing?.id, expectedRevision);
      hapticSuccess();
      router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t save schedule', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!existing || busy) return;
    if (!(await confirmDestructive({ title: 'Delete this schedule?', message: 'Already generated transactions stay in your ledger.' }))) return;
    setBusy(true);
    try {
      await repository.deleteEntities('recurringRules', [existing.id]);
      router.dismissTo('/more');
    } catch (reason) {
      showError('Couldn’t delete schedule', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (params.id && !existing) return <Redirect href="/more" />;

  return (
    <FormScreen contentContainerStyle={{ gap: 16, paddingBottom: 40 }}>
      <Card style={{ gap: 16 }}>
        <View accessibilityLabel={t('Recurring transaction kind')} accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8 }}>{(['expense', 'income'] as CategoryKind[]).map((item) => <View key={item} style={{ flex: 1 }}><ChoiceChip label={item[0].toUpperCase() + item.slice(1)} selected={kind === item} onPress={() => {
          if (item === kind) return;
          setKind(item);
          setCategoryId('');
        }} /></View>)}</View>
        <FormField label="Title" value={title} onChangeText={setTitle} placeholder="Rent, salary, subscription…" />
        <FormField label={`Amount (${account?.currency ?? state.settings.baseCurrency})`} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" error={amountError} required />
        <AppText variant="label">Account</AppText>
        <View accessibilityLabel={t('Recurring account')} accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{accountChoices.map((item) => <ChoiceChip key={item.id} literal label={`${item.name}${item.archived ? ` (${t('Archived')})` : ''}`} disabled={item.archived} selected={accountId === item.id} onPress={() => setAccountId(item.id)} />)}</View>
        <AppText variant="label">Category</AppText>
        <View accessibilityLabel={t('Recurring category')} accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          <ChoiceChip label="Uncategorized" selected={!categoryId} onPress={() => setCategoryId('')} />
          {categories.map((item) => <ChoiceChip key={item.id} literal label={`${item.name}${item.archived ? ` (${t('Archived')})` : ''}`} disabled={item.archived} selected={categoryId === item.id} onPress={() => setCategoryId(item.id)} />)}
        </View>
        <FormField label="Note" value={note} onChangeText={setNote} placeholder="Optional context" multiline style={{ minHeight: 92, textAlignVertical: 'top' }} />
        {state.tags.length ? (
          <>
            <AppText variant="label">Tags</AppText>
            <View accessibilityLabel={t('Recurring tags')} role="group" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {state.tags.map((tag) => <ChoiceChip mode="checkbox" key={tag.id} literal label={tag.name} selected={tagIds.includes(tag.id)} onPress={() => toggleTag(tag.id)} />)}
            </View>
          </>
        ) : null}
        {referencesArchivedEntity ? <AppText variant="caption" muted>This schedule stays paused until its archived account and category are restored.</AppText> : null}
      </Card>

      <Card style={{ gap: 16 }}>
        <AppText variant="label">Repeats</AppText>
        <View accessibilityLabel={t('Recurrence period')} accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>{(['day', 'week', 'month', 'year'] as RecurrenceUnit[]).map((item) => <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={unit === item} onPress={() => setUnit(item)} />)}</View>
        <FormField label="Every" value={interval} onChangeText={setInterval} keyboardType="number-pad" error={intervalError} hint={`Every ${interval || '1'} ${unit}${Number(interval) === 1 ? '' : 's'}.`} required />
        <FormField label="Starts" value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" error={startDateError} required />
        <FormField label="Ends (optional)" value={endDate} onChangeText={setEndDate} placeholder="YYYY-MM-DD" error={endDateError} />
        <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
          <View style={{ flex: 1, gap: 2 }}><AppText variant="label">Post automatically</AppText><AppText variant="caption" muted>Off by default. Upcoming items wait for your review.</AppText></View>
          <Switch accessibilityLabel={t('Post automatically')} value={autoPost} onValueChange={setAutoPost} trackColor={{ true: theme.accent }} />
        </View>
        <View style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
          <View style={{ flex: 1, gap: 2 }}><AppText variant="label">Schedule active</AppText><AppText variant="caption" muted>Pause without deleting this schedule.</AppText></View>
          <Switch accessibilityLabel={t('Schedule active')} value={active} onValueChange={setActive} disabled={referencesArchivedEntity} trackColor={{ true: theme.accent }} />
        </View>
      </Card>

      <ActionButton title={busy ? 'Saving…' : existing ? 'Save schedule' : 'Create schedule'} icon="checkmark" onPress={save} disabled={busy || !canSave} busy={busy} />
      {existing ? <ActionButton title="Delete schedule" variant="danger" onPress={remove} disabled={busy} /> : null}
    </FormScreen>
  );
}
