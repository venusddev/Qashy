import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, SectionList, TextInput, View, useWindowDimensions } from 'react-native';

import { TransactionRow } from '@/components/finance/transaction-row';
import { ActionButton } from '@/components/ui/action-button';
import { AppIcon } from '@/components/ui/app-icon';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import { screenContentMetrics } from '@/components/ui/screen-container';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { radius } from '@/theme/tokens';
import { confirmDestructive, errorMessage, showError } from '@/utils/confirm';
import { shortDate } from '@/utils/date';

type KindFilter = 'all' | 'expense' | 'income' | 'transfer' | 'upcoming';

export function TransactionsScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const { width } = useWindowDimensions();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
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

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const changeCategory = async (categoryId: string | null) => {
    const ids = [...selectedIds];
    try {
      await repository.updateTransactionsCategory(ids, categoryId);
      setCategoryOverrides((current) => ({
        ...current,
        ...Object.fromEntries(ids.map((id) => [id, categoryId])),
      }));
      setSelectedIds([]);
    } catch (reason) {
      showError('Couldn’t change category', errorMessage(reason, 'Try a compatible category.'));
    }
  };

  const deleteSelected = async () => {
    const ids = [...selectedIds];
    if (!(await confirmDestructive({ title: ids.length === 1 ? 'Delete 1 transaction?' : `Delete ${ids.length} transactions?`, message: 'They will be removed from your ledger.' }))) return;
    try {
      await repository.deleteEntities('transactions', ids);
      setHiddenIds((current) => [...new Set([...current, ...ids])]);
      setSelectedIds([]);
    } catch (reason) {
      showError('Couldn’t delete transactions', errorMessage(reason, 'Try again.'));
    }
  };

  return (
    <View collapsable={false} style={{ flex: 1, backgroundColor: theme.background }}>
      <SectionList
      contentInsetAdjustmentBehavior="automatic"
      style={{ flex: 1, backgroundColor: theme.background }}
      contentContainerStyle={[screenContentMetrics(width), { gap: 8 }]}
      sections={sections}
      extraData={`${selectedIds.join(',')}|${JSON.stringify(categoryOverrides)}|${hiddenIds.join(',')}|${repository.getSnapshot().transactions.map((item) => `${item.id}:${item.revision}`).join(',')}`}
      keyExtractor={(item) => `${item.id}:${item.revision}`}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={
        <View style={{ gap: 14, paddingBottom: 16 }}>
          <View style={{ minHeight: 50, borderRadius: radius.control, borderCurve: 'continuous', backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 }}>
            <AppIcon name="magnifyingglass" color={theme.textMuted} size={19} />
            <TextInput
              accessibilityLabel="Search transactions"
              placeholder="Search title or note"
              placeholderTextColor={theme.textMuted}
              value={search}
              onChangeText={setSearch}
              style={{ flex: 1, color: theme.text, fontSize: 16 }}
            />
            {search ? <Pressable accessibilityLabel="Clear search" onPress={() => setSearch('')}><AppIcon name="xmark" color={theme.textMuted} size={18} /></Pressable> : null}
          </View>
          <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
            {(['all', 'expense', 'income', 'transfer', 'upcoming'] as KindFilter[]).map((item) => (
              <ChoiceChip key={item} label={item[0].toUpperCase() + item.slice(1)} selected={kind === item} onPress={() => setKind(item)} />
            ))}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <AppText variant="caption" muted>{transactions.length} {transactions.length === 1 ? 'transaction' : 'transactions'}</AppText>
            <Pressable onPress={() => router.push('/csv')}><AppText variant="label" style={{ color: theme.accent }}>Import or export</AppText></Pressable>
          </View>
          {selectedIds.length ? (
            <Card style={{ gap: 12, backgroundColor: theme.accentContainer, borderColor: theme.accent }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <AppText variant="headline">{selectedIds.length} selected</AppText>
                <Pressable accessibilityRole="button" onPress={() => setSelectedIds([])}><AppText variant="label" style={{ color: theme.accent }}>Clear</AppText></Pressable>
              </View>
              <AppText variant="caption" muted>Change category</AppText>
              {selectedKinds.length > 1 ? <AppText variant="caption" muted>Select only income or only expense transactions to assign a category.</AppText> : null}
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <ChoiceChip label="Uncategorized" selected={false} onPress={() => changeCategory(null)} />
                {state.categories.filter((item) => item.kind === compatibleCategoryKind && !item.archived).map((category) => (
                  <ChoiceChip key={category.id} label={category.name} selected={false} onPress={() => changeCategory(category.id)} />
                ))}
              </View>
              <ActionButton title="Delete selected" variant="danger" onPress={deleteSelected} />
            </Card>
          ) : null}
        </View>
      }
      renderSectionHeader={({ section }) => (
        <View style={{ paddingTop: 12, paddingBottom: 5, paddingHorizontal: 6 }}>
          <AppText variant="caption" muted>{shortDate(section.title, state.settings.locale).toUpperCase()}</AppText>
        </View>
      )}
      renderItem={({ item, index, section }) => (
        <Card style={{ paddingVertical: 0, paddingHorizontal: 14, marginBottom: 4, backgroundColor: selectedIds.includes(item.id) ? theme.accentContainer : theme.surface }}>
          <TransactionRow transaction={item} selected={selectedIds.includes(item.id)} onLongPress={() => toggleSelected(item.id)} onPress={selectedIds.length ? () => toggleSelected(item.id) : undefined} />
        </Card>
      )}
      ListEmptyComponent={
        <View style={{ alignItems: 'center', gap: 12, paddingVertical: 72 }}>
          <View style={{ width: 58, height: 58, borderRadius: radius.card, backgroundColor: theme.accentContainer, alignItems: 'center', justifyContent: 'center' }}><AppIcon name="magnifyingglass" color={theme.accent} size={24} /></View>
          <AppText variant="headline">{search || kind !== 'all' ? 'Nothing matches' : 'No transactions yet'}</AppText>
          <AppText muted style={{ textAlign: 'center' }}>{search || kind !== 'all' ? 'Try another search or filter.' : 'Add your first income, expense, or transfer.'}</AppText>
        </View>
      }
      ListFooterComponent={<View style={{ height: 72 }} />}
      />
      <Pressable
        accessibilityLabel="Add transaction"
        onPress={() => router.push({ pathname: '/transaction', params: { returnTo: '/transactions' } })}
        style={({ pressed }) => ({ position: 'absolute', right: 24, bottom: process.env.EXPO_OS === 'web' && width < 768 ? 92 : 24, width: 58, height: 58, borderRadius: 999, backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 14px rgba(25,27,32,0.28)', opacity: pressed ? 0.85 : 1 })}>
        <AppIcon name="plus" color={theme.onAccent} size={25} />
      </Pressable>
    </View>
  );
}
