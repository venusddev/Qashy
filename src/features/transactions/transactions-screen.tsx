import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { SectionList, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TransactionRow } from '@/components/finance/transaction-row';
import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FloatingActionButton } from '@/components/ui/floating-action-button';
import { IconButton } from '@/components/ui/icon-button';
import { MotionView, ScreenTransition } from '@/components/ui/motion';
import { PageHeading } from '@/components/ui/page-heading';
import { screenContentMetrics } from '@/components/ui/screen-container';
import { TextButton } from '@/components/ui/text-button';
import { useScrollHide } from '@/components/ui/use-scroll-hide';
import { useLocalization } from '@/localization/localization';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useScreenMetrics } from '@/theme/layout';
import { useQashyTheme } from '@/theme/theme';
import { radius } from '@/theme/tokens';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { shortDate } from '@/utils/date';
import { hapticImpactLight, hapticSelection, hapticSuccess } from '@/utils/haptics';

type KindFilter = 'all' | 'expense' | 'income' | 'transfer' | 'upcoming';

export function TransactionsScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { isRtl, t } = useLocalization();
  const metrics = useScreenMetrics();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const { visibility: fabVisibility, onScroll } = useScrollHide();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectedTransactions = state.transactions.filter((item) => selectedIds.includes(item.id));
  const hasSelectedTransfers = selectedTransactions.some((item) => item.kind === 'transfer');
  const selectedKinds = [...new Set(selectedTransactions
    .filter((item) => item.kind !== 'transfer')
    .map((item) => item.kind))];
  const compatibleCategoryKind = selectedKinds.length === 1 ? selectedKinds[0] : null;
  const transactions = repository.queryTransactions({
      search,
      kinds: kind !== 'all' && kind !== 'upcoming' ? [kind] : undefined,
      statuses: kind === 'upcoming' ? ['upcoming'] : kind === 'all' ? ['posted', 'upcoming'] : ['posted'],
    }, state.transactions);
  const sections = useMemo(() => {
    const groups = new Map<string, typeof transactions>();
    transactions.forEach((transaction) => {
      const list = groups.get(transaction.localDate) ?? [];
      list.push(transaction);
      groups.set(transaction.localDate, list);
    });
    return Array.from(groups, ([title, data]) => ({ title, data }));
  }, [transactions]);

  const toggleSelected = (id: string, options?: { silent?: boolean }) => {
    if (!options?.silent) hapticSelection();
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  // Guards a double-tap on a category chip or "Delete selected" from firing two
  // concurrent batch mutations, matching how every other mutating handler in the
  // app is gated.
  const changeCategory = async (categoryId: string | null) => {
    if (busy) return;
    const ids = [...selectedIds];
    setBusy(true);
    try {
      await repository.updateTransactionsCategory(ids, categoryId);
      hapticSuccess();
      setSelectedIds([]);
      setSelectionMode(false);
    } catch (reason) {
      showError('Couldn’t change category', errorMessage(reason, 'Try a compatible category.'));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelected = async () => {
    if (busy) return;
    const ids = [...selectedIds];
    if (!(await confirmDestructive({ title: ids.length === 1 ? 'Delete 1 transaction?' : `Delete ${ids.length} transactions?`, message: 'They will be removed from your ledger.' }))) return;
    setBusy(true);
    try {
      await repository.deleteEntities('transactions', ids);
      hapticSuccess();
      setSelectedIds([]);
      setSelectionMode(false);
    } catch (reason) {
      showError('Couldn’t delete transactions', errorMessage(reason, 'Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: theme.background }}>
      <ScreenTransition style={{ flex: 1 }}>
      <SectionList
      contentInsetAdjustmentBehavior="automatic"
      onScroll={onScroll}
      scrollEventThrottle={16}
      style={{ flex: 1, backgroundColor: theme.background }}
      contentContainerStyle={[screenContentMetrics(metrics, insets), { gap: 8 }]}
      sections={sections}
      extraData={`${selectedIds.join(',')}|${state.transactions.map((item) => `${item.id}:${item.revision}`).join(',')}`}
      keyExtractor={(item) => `${item.id}:${item.revision}`}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={
        <View style={{ gap: 14, paddingBottom: 16 }}>
          <PageHeading title="Transactions" subtitle="Search, filter, and manage your local ledger." />
          <View style={{ minHeight: 50, borderRadius: radius.control, borderCurve: 'continuous', backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 }}>
            <AppIcon name="magnifyingglass" color={theme.textMuted} size={19} />
            <TextInput
              accessibilityLabel={t('Search transactions')}
              placeholder={t('Search title or note')}
              placeholderTextColor={theme.textMuted}
              value={search}
              onChangeText={(value) => {
                setSearch(value);
                setSelectedIds([]);
              }}
              style={{ flex: 1, color: theme.text, fontSize: 16, writingDirection: isRtl ? 'rtl' : 'ltr', textAlign: isRtl ? 'right' : 'left' }}
            />
            {search ? <IconButton label="Clear search" icon="xmark" iconSize={18} enteringVariant="zoom" onPress={() => {
              setSearch('');
              setSelectedIds([]);
            }} style={{ marginRight: -10 }} /> : null}
          </View>
          <View accessibilityLabel={t('Transaction type filter')} accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {(['all', 'expense', 'income', 'transfer', 'upcoming'] as KindFilter[]).map((item) => (
              <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={kind === item} onPress={() => {
                setKind(item);
                setSelectedIds([]);
              }} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            {/* One string so the dictionary's count patterns can match; split
                children would leave "transactions" on its own with no key. */}
            <AppText literal variant="caption" muted>{t(`${transactions.length} ${transactions.length === 1 ? 'transaction' : 'transactions'}`)}</AppText>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {transactions.length ? (
                <TextButton
                  title={selectionMode ? 'Done selecting' : 'Select'}
                  tone={selectionMode ? 'muted' : 'accent'}
                  onPress={() => {
                    setSelectionMode((current) => !current);
                    setSelectedIds([]);
                  }}
                />
              ) : null}
              <TextButton title="Import or export" onPress={() => router.push('/csv')} />
            </View>
          </View>
          {selectionMode ? (
            <MotionView variant="down" exit animateLayout>
              <Card style={{ gap: 12, backgroundColor: theme.accentContainer, borderColor: theme.accent }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <MotionView key={selectedIds.length} variant="fade" animateLayout>
                  <AppText literal variant="headline">{t(`${selectedIds.length} selected`)}</AppText>
                </MotionView>
                <TextButton title={selectedIds.length ? 'Clear' : 'Done'} onPress={() => {
                  if (selectedIds.length) setSelectedIds([]);
                  else setSelectionMode(false);
                }} />
              </View>
              {selectedIds.length ? (
                <>
                  {hasSelectedTransfers ? (
                    <AppText variant="caption" muted>Transfers do not have categories. Select only income or expense transactions to change categories.</AppText>
                  ) : (
                    <>
                      <AppText variant="caption" muted>Change category</AppText>
                      {selectedKinds.length > 1 ? <AppText variant="caption" muted>Select only income or only expense transactions to assign a category.</AppText> : null}
                      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                        <ChoiceChip mode="button" label="Uncategorized" selected={false} disabled={busy} onPress={() => changeCategory(null)} />
                        {state.categories.filter((item) => item.kind === compatibleCategoryKind && !item.archived).map((category) => (
                          <ChoiceChip mode="button" key={category.id} literal label={category.name} selected={false} disabled={busy} onPress={() => changeCategory(category.id)} />
                        ))}
                      </View>
                    </>
                  )}
                  <ActionButton title="Delete selected" variant="danger" disabled={busy} onPress={deleteSelected} />
                </>
              ) : <AppText variant="caption" muted>Choose one or more transactions below.</AppText>}
              </Card>
            </MotionView>
          ) : null}
        </View>
      }
      renderSectionHeader={({ section }) => (
        <View style={{ paddingTop: 12, paddingBottom: 5, paddingHorizontal: 6 }}>
          <AppText literal variant="caption" muted>{shortDate(section.title, state.settings.locale).toUpperCase()}</AppText>
        </View>
      )}
      renderItem={({ item }) => (
        <MotionView entrance={false} animateLayout exit>
          <Card style={{ paddingVertical: 0, paddingHorizontal: 14, marginBottom: 4, backgroundColor: selectedIds.includes(item.id) ? theme.accentContainer : theme.surface }}>
            <TransactionRow
              transaction={item}
              selectionMode={selectionMode}
              selected={selectedIds.includes(item.id)}
              onLongPress={() => {
                if (!selectionMode) hapticImpactLight();
                setSelectionMode(true);
                toggleSelected(item.id, { silent: !selectionMode });
              }}
              onPress={selectionMode ? () => toggleSelected(item.id) : undefined}
            />
          </Card>
        </MotionView>
      )}
      ListEmptyComponent={
        <MotionView variant="down" style={{ alignItems: 'center', gap: 12, paddingVertical: 72 }}>
          <View style={{ width: 58, height: 58, borderRadius: radius.card, backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="magnifyingglass" color={theme.accent} size={24} /></View>
          <AppText variant="headline">{search || kind !== 'all' ? 'Nothing matches' : 'No transactions yet'}</AppText>
          <AppText muted style={{ textAlign: 'center' }}>{search || kind !== 'all' ? 'Try another search or filter.' : 'Add your first income, expense, or transfer.'}</AppText>
        </MotionView>
      }
      ListFooterComponent={<View style={{ height: 72 }} />}
      />
      </ScreenTransition>
      <FloatingActionButton
        label="Add transaction"
        visibility={fabVisibility}
        onPress={() => router.push({ pathname: '/transaction', params: { returnTo: '/transactions' } })}
        style={{ position: 'absolute', right: 24, bottom: metrics.hasBottomNavigation ? 92 : 24 }}
      />
    </View>
  );
}
