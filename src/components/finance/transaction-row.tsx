import { router } from 'expo-router';
import { View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { MotionPressable, MotionView } from '@/components/ui/motion';
import type { TransactionRecord } from '@/domain/models';
import { useLocalization } from '@/localization/localization';
import { useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { radius, readableTextColor } from '@/theme/tokens';
import { formatMoney } from '@/utils/money';

export function TransactionRow({
  transaction,
  compact = false,
  returnTo = '/transactions',
  selectionMode = false,
  selected = false,
  onPress,
  onLongPress,
}: {
  transaction: TransactionRecord;
  compact?: boolean;
  returnTo?: '/overview' | '/transactions';
  selectionMode?: boolean;
  selected?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const { settings, accounts, categories } = useFinanceState();
  const theme = useQashyTheme();
  const { t } = useLocalization();
  const account = accounts.find((item) => item.id === transaction.accountId);
  const category = categories.find((item) => item.id === transaction.categoryId);
  const destination = accounts.find((item) => item.id === transaction.destinationAccountId);
  const isIncome = transaction.kind === 'income';
  const isTransfer = transaction.kind === 'transfer';
  const color = selected
    ? theme.onAccentContainer
    : isTransfer
      ? theme.accent
      : isIncome
        ? theme.positive
        : theme.text;
  const direction = isTransfer ? 'Transfer, money moved' : isIncome ? 'Income, money in' : 'Expense, money out';
  const signedAmount = `${isIncome ? 'plus ' : isTransfer ? '' : 'minus '}${formatMoney(transaction.amountMinor, transaction.currency, settings.locale)}`;
  const accountContext = isTransfer
    ? `${account?.name ?? 'Unknown account'} to ${destination?.name ?? 'Unknown account'}`
    : account?.name ?? 'Unknown account';
  const rowLabel = `${direction}, ${transaction.title}, ${signedAmount}, ${category?.name ?? (isTransfer ? 'transfer' : 'uncategorized')}, ${accountContext}, ${transaction.localDate}`;
  // The fallbacks are the only translatable parts of the caption, so they are
  // resolved here and the whole line renders verbatim. Otherwise a category or
  // account the user named "Savings" would be rewritten by the dictionary.
  const categoryLabel = category?.name ?? t(isTransfer ? 'Transfer' : 'Uncategorized');
  const accountLabel = account?.name ?? t('Unknown account');
  const amountText = `${isIncome ? '+' : isTransfer ? '' : '-'}${formatMoney(transaction.amountMinor, transaction.currency, settings.locale)}`;

  return (
    <MotionPressable
      accessibilityActions={!selectionMode && onLongPress ? [{ name: 'longpress', label: 'Select transaction' }] : undefined}
      accessibilityHint={!selectionMode && onLongPress ? 'Long press to select this transaction for batch actions.' : undefined}
      accessibilityRole={selectionMode ? 'checkbox' : 'button'}
      accessibilityLabel={selectionMode ? `${rowLabel}, ${selected ? 'selected' : 'not selected'}` : rowLabel}
      accessibilityState={selectionMode ? { checked: selected } : undefined}
      aria-checked={selectionMode ? selected : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'longpress') onLongPress?.();
      }}
      onPress={onPress ?? (() => router.push({ pathname: '/transaction', params: { id: transaction.id, returnTo } }))}
      onLongPress={onLongPress}
      active={selected}
      pressedScale={0.985}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: compact ? 54 : 64, opacity: pressed ? 0.65 : 1 })}>
      {selectionMode ? (
        <MotionView variant="zoom" animateLayout style={{ width: 24, height: 24 }}>
          <View style={{ flex: 1, borderRadius: 7, borderWidth: 2, borderColor: selected ? theme.accent : theme.border, backgroundColor: selected ? theme.accent : theme.surface, alignItems: 'center', justifyContent: 'center' }}>
            {selected ? (
              <MotionView variant="zoom" exit>
                <AppIcon name="checkmark" color={theme.onAccent} size={16} />
              </MotionView>
            ) : null}
          </View>
        </MotionView>
      ) : null}
      <View style={{ width: compact ? 38 : 44, height: compact ? 38 : 44, borderRadius: radius.control, backgroundColor: category?.color ?? theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}>
        <AppIcon name={isTransfer ? 'arrow.left.arrow.right' : category?.icon ?? (isIncome ? 'arrow.down' : 'arrow.up')} color={category ? readableTextColor(category.color) : theme.onAccentContainer} size={18} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: 'row', gap: 7, alignItems: 'center' }}>
          <AppText literal variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>{transaction.title}</AppText>
          {transaction.status === 'upcoming' ? (
            <View style={{ borderRadius: 99, paddingHorizontal: 7, paddingVertical: 2, backgroundColor: theme.accentContainer }}>
              <AppText selectable={false} variant="caption" style={{ color: theme.onAccentContainer, fontSize: 11 }}>UPCOMING</AppText>
            </View>
          ) : null}
        </View>
        <AppText literal variant="caption" muted numberOfLines={1}>{`${categoryLabel} · ${accountLabel}`}</AppText>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 2 }}>
        <AppText literal variant="label" style={{ color, fontVariant: ['tabular-nums'] }}>
          {amountText}
        </AppText>
        {!compact ? <AppText literal variant="caption" muted>{transaction.localDate}</AppText> : null}
      </View>
    </MotionPressable>
  );
}
