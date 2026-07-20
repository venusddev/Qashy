import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { SectionList, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TransactionRow } from '@/components/finance/transaction-row';
import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { FloatingActionButton } from '@/components/ui/floating-action-button';
import { IconButton } from '@/components/ui/icon-button';
import { MotionView } from '@/components/ui/motion';
import { PageHeading } from '@/components/ui/page-heading';
import { screenContentMetrics } from '@/components/ui/screen-container';
import { TextButton } from '@/components/ui/text-button';
import { useScrollHide } from '@/components/ui/use-scroll-hide';
import { useLocalization } from '@/localization/localization';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
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
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const { visibility: fabVisibility, onScroll } = useScrollHide();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  // Optimistic overlays for batch mutations: context updates from the
  // repository don't always reach an already-mounted screen on web, so the
  // list applies the change locally, then drops the overlay as soon as a
  // fresh transactions snapshot arrives (keeping it from masking later edits).
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, string | null>>({});
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [seenTransactions, setSeenTransactions] = useState(state.transactions);
  if (seenTransactions !== state.transactions) {
    setSeenTransactions(state.transactions);
    if (Object.keys(categoryOverrides).length) setCategoryOverrides({});
    if (hiddenIds.length) setHiddenIds([]);
  }
  const selectedKinds = [...new Set(state.transactions
    .filter((item) => selectedIds.includes(item.id) && item.kind !== 'transfer')
    .map((item) => item.kind))];
  const compatibleCategoryKind = selectedKinds.length === 1 ? selectedKinds[0] : null;
  const transactions = useMemo(() => {
    void state.transactions;
    return repository.queryTransactions({
      search,
      kinds: kind !== 'all' && kind !== 'upcoming' ? [kind] : undefined,
      statuses: kind === 'upcoming' ? ['upcoming'] : kind === 'all' ? ['posted', 'upcoming'] : ['posted'],
    })
      .filter((item) => !hiddenIds.includes(item.id))
      .map((item) => Object.hasOwn(categoryOverrides, item.id) ? { ...item, categoryId: categoryOverrides[item.id] } : item);
  }, [repository, state.transactions, categoryOverrides, hiddenIds, search, kind]);
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

  const changeCategory = async (categoryId: string | null) => {
    const ids = [...selectedIds];
    try {
      await repository.updateTransactionsCategory(ids, categoryId);
      hapticSuccess();
      setCategoryOverrides((current) => ({
        ...current,
        ...Object.fromEntries(ids.map((id) => [id, categoryId])),
      }));
      setSelectedIds([]);
      setSelectionMode(false);
    } catch (reason) {
      showError('Couldn’t change category', errorMessage(reason, 'Try a compatible category.'));
    }
  };

  const deleteSelected = async () => {
    const ids = [...selectedIds];
    if (!(await confirmDestructive({ title: ids.length === 1 ? 'Delete 1 transaction?' : `Delete ${ids.length} transactions?`, message: 'They will be removed from your ledger.' }))) return;
    try {
      await repository.deleteEntities('transactions', ids);
      hapticSuccess();
      setHiddenIds((current) => [...new Set([...current, ...ids])]);
      setSelectedIds([]);
      setSelectionMode(false);
    } catch (reason) {
      showError('Couldn’t delete transactions', errorMessage(reason, 'Try again.'));
    }
  };

  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: theme.background }}>
      <MotionView variant="fade" style={{ flex: 1 }}>
      <SectionList
      contentInsetAdjustmentBehavior="automatic"
      onScroll={onScroll}
      scrollEventThrottle={16}
      style={{ flex: 1, backgroundColor: theme.background }}
      contentContainerStyle={[screenContentMetrics(width, insets), { gap: 8 }]}
      sections={sections}
      extraData={`${selectedIds.join(',')}|${JSON.stringify(categoryOverrides)}|${hiddenIds.join(',')}|${repository.getSnapshot().transactions.map((item) => `${item.id}:${item.revision}`).join(',')}`}
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
          <View accessibilityLabel="Transaction type filter" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
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
                  <AppText variant="caption" muted>Change category</AppText>
                  {selectedKinds.length > 1 ? <AppText variant="caption" muted>Select only income or only expense transactions to assign a category.</AppText> : null}
                  <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                    <ChoiceChip mode="button" label="Uncategorized" selected={false} onPress={() => changeCategory(null)} />
                    {state.categories.filter((item) => item.kind === compatibleCategoryKind && !item.archived).map((category) => (
                      <ChoiceChip mode="button" key={category.id} literal label={category.name} selected={false} onPress={() => changeCategory(category.id)} />
                    ))}
                  </View>
                  <ActionButton title="Delete selected" variant="danger" onPress={deleteSelected} />
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
      renderItem={({ item, index, section }) => (
        <MotionView delay={Math.min(index, 5) * 24} animateLayout exit>
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
        <MotionView variant="zoom" style={{ alignItems: 'center', gap: 12, paddingVertical: 72 }}>
          <View style={{ width: 58, height: 58, borderRadius: radius.card, backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="magnifyingglass" color={theme.accent} size={24} /></View>
          <AppText variant="headline">{search || kind !== 'all' ? 'Nothing matches' : 'No transactions yet'}</AppText>
          <AppText muted style={{ textAlign: 'center' }}>{search || kind !== 'all' ? 'Try another search or filter.' : 'Add your first income, expense, or transfer.'}</AppText>
        </MotionView>
      }
      ListFooterComponent={<View style={{ height: 72 }} />}
      />
      </MotionView>
      <FloatingActionButton
        label="Add transaction"
        visibility={fabVisibility}
        onPress={() => router.push({ pathname: '/transaction', params: { returnTo: '/transactions' } })}
        style={{ position: 'absolute', right: 24, bottom: process.env.EXPO_OS === 'web' && width < 768 ? 92 : 24 }}
      />
    </View>
  );
}
