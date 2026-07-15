import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import type { CsvImportRow, ImportResult, TransactionKind } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { useQashyTheme } from '@/theme/theme';
import { parseCsvTable } from '@/utils/csv';
import { todayLocal } from '@/utils/date';

type CsvField = Exclude<keyof CsvImportRow, 'rowNumber'>;

const CSV_FIELDS: { key: CsvField; label: string; optional?: boolean; aliases: string[] }[] = [
  { key: 'date', label: 'Date', aliases: ['date', 'transaction_date', 'posted_date'] },
  { key: 'type', label: 'Type', aliases: ['type', 'kind', 'transaction_type'] },
  { key: 'title', label: 'Title', aliases: ['title', 'description', 'merchant', 'name'] },
  { key: 'amount', label: 'Amount', aliases: ['amount', 'value'] },
  { key: 'currency', label: 'Currency', aliases: ['currency', 'currency_code'] },
  { key: 'account', label: 'Account', aliases: ['account', 'account_name'] },
  { key: 'category', label: 'Category', optional: true, aliases: ['category', 'category_name'] },
  { key: 'tags', label: 'Tags', optional: true, aliases: ['tags', 'labels'] },
  { key: 'note', label: 'Notes', optional: true, aliases: ['note', 'notes', 'memo'] },
  { key: 'exchangeRate', label: 'Exchange rate', optional: true, aliases: ['exchange_rate', 'exchangerate'] },
  { key: 'destinationAccount', label: 'Destination account', optional: true, aliases: ['destination_account', 'to_account'] },
  { key: 'destinationAmount', label: 'Destination amount', optional: true, aliases: ['destination_amount', 'to_amount'] },
];

function inferMapping(headers: string[]) {
  return Object.fromEntries(CSV_FIELDS.map((field) => [
    field.key,
    field.aliases.find((alias) => headers.includes(alias)) ?? '',
  ])) as Record<CsvField, string>;
}

export function CsvScreen() {
  const repository = useFinanceRepository();
  const state = useFinanceState();
  const theme = useQashyTheme();
  const [sourceRows, setSourceRows] = useState<Record<string, string | number>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<CsvField, string>>(() => inferMapping([]));
  const [defaultAccountId, setDefaultAccountId] = useState(state.accounts.find((item) => !item.archived)?.id ?? '');
  const [defaultCategoryId, setDefaultCategoryId] = useState('');
  const [rows, setRows] = useState<CsvImportRow[]>([]);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'text/plain'], copyToCacheDirectory: true, base64: false });
    if (result.canceled) return;
    const asset = result.assets[0];
    const text = asset.file ? await asset.file.text() : await new ExpoFile(asset.uri).text();
    const table = parseCsvTable(text);
    setSourceRows(table.rows);
    setHeaders(table.headers);
    setMapping(inferMapping(table.headers));
    setRows([]);
    setPreview(null);
  };

  const previewImport = async () => {
    const defaultAccount = state.accounts.find((item) => item.id === defaultAccountId)?.name ?? '';
    const defaultCategory = state.categories.find((item) => item.id === defaultCategoryId)?.name ?? '';
    const value = (record: Record<string, string | number>, field: CsvField) =>
      mapping[field] ? String(record[mapping[field]] ?? '') : '';
    const parsed = sourceRows.map((record) => ({
      rowNumber: Number(record.rowNumber),
      date: value(record, 'date'),
      type: (value(record, 'type') || 'expense').toLowerCase() as TransactionKind,
      title: value(record, 'title'),
      amount: value(record, 'amount'),
      currency: (value(record, 'currency') || state.settings.baseCurrency).toUpperCase(),
      account: value(record, 'account') || defaultAccount,
      category: value(record, 'category') || defaultCategory,
      tags: value(record, 'tags'),
      note: value(record, 'note'),
      exchangeRate: value(record, 'exchangeRate') || '1',
      destinationAccount: value(record, 'destinationAccount'),
      destinationAmount: value(record, 'destinationAmount'),
    }));
    setRows(parsed);
    setPreview(await repository.importCsv(parsed, false));
  };

  const cycleMapping = (field: typeof CSV_FIELDS[number]) => {
    const candidates = field.optional ? ['', ...headers] : headers;
    if (!candidates.length) return;
    const current = candidates.indexOf(mapping[field.key]);
    setMapping((value) => ({ ...value, [field.key]: candidates[(current + 1) % candidates.length] }));
    setPreview(null);
  };

  const commit = async () => {
    setBusy(true);
    try {
      const result = await repository.importCsv(rows, true);
      setPreview(result);
      Alert.alert('Import complete', `${result.committedIds.length} transactions imported.`);
    } finally {
      setBusy(false);
    }
  };

  const exportData = async () => {
    const csv = repository.exportCsv();
    const filename = `qashy-transactions-${todayLocal()}.csv`;
    if (process.env.EXPO_OS === 'web') {
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    }
    const file = new ExpoFile(Paths.cache, filename);
    if (file.exists) file.delete();
    file.create();
    file.write(csv);
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', dialogTitle: 'Export Qashy transactions' });
  };

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ flex: 1, backgroundColor: theme.background }} contentContainerStyle={{ padding: 18, paddingBottom: 40, gap: 16, width: '100%', maxWidth: 760, alignSelf: 'center' }}>
      <Card style={{ gap: 14 }}>
        <AppText variant="headline">Export transactions</AppText>
        <AppText muted>Creates a UTF-8 CSV with dates, amounts, currencies, source and destination accounts, categories, tags, notes, exchange-rate snapshots, and transfer linkage.</AppText>
        <ActionButton title="Export CSV" icon="tray" onPress={exportData} />
      </Card>
      <Card style={{ gap: 14 }}>
        <AppText variant="headline">Import transactions</AppText>
        <AppText muted>Headers are matched automatically. Required columns are date, type, title, amount, currency, and account. Nothing is committed until after preview.</AppText>
        <ActionButton title="Choose CSV" variant="secondary" onPress={pick} />
        {sourceRows.length ? (
          <View style={{ gap: 12, paddingTop: 6 }}>
            <AppText variant="headline">Column mapping</AppText>
            <AppText variant="caption" muted>Tap a row to cycle through the source columns. Optional fields can be set to Not mapped.</AppText>
            {CSV_FIELDS.map((field) => (
              <Pressable
                key={field.key}
                accessibilityRole="button"
                accessibilityLabel={`Map ${field.label}`}
                onPress={() => cycleMapping(field)}
                style={({ pressed }) => ({ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: 1, borderBottomColor: theme.border, opacity: pressed ? 0.65 : 1 })}>
                <AppText variant="label">{field.label}{field.optional ? '' : ' *'}</AppText>
                <AppText variant="caption" style={{ color: mapping[field.key] ? theme.accent : theme.textMuted }}>{mapping[field.key] || 'Not mapped'} ›</AppText>
              </Pressable>
            ))}
            <AppText variant="label">Default account</AppText>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {state.accounts.filter((item) => !item.archived).map((account) => (
                <Pressable key={account.id} accessibilityRole="radio" accessibilityState={{ selected: defaultAccountId === account.id }} onPress={() => { setDefaultAccountId(account.id); setPreview(null); }} style={{ padding: 10, borderRadius: 14, backgroundColor: defaultAccountId === account.id ? theme.accentContainer : theme.surfaceMuted }}>
                  <AppText variant="label" style={{ color: defaultAccountId === account.id ? theme.accent : theme.text }}>{account.name}</AppText>
                </Pressable>
              ))}
            </View>
            <AppText variant="label">Default category</AppText>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <Pressable onPress={() => { setDefaultCategoryId(''); setPreview(null); }} style={{ padding: 10, borderRadius: 14, backgroundColor: !defaultCategoryId ? theme.accentContainer : theme.surfaceMuted }}><AppText variant="label">None</AppText></Pressable>
              {state.categories.filter((item) => !item.archived).map((category) => (
                <Pressable key={category.id} onPress={() => { setDefaultCategoryId(category.id); setPreview(null); }} style={{ padding: 10, borderRadius: 14, backgroundColor: defaultCategoryId === category.id ? theme.accentContainer : theme.surfaceMuted }}><AppText variant="label">{category.name}</AppText></Pressable>
              ))}
            </View>
            <ActionButton title="Preview import" icon="checkmark" onPress={previewImport} />
          </View>
        ) : null}
        {preview ? (
          <View style={{ gap: 10, paddingTop: 6 }}>
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 120, padding: 14, borderRadius: 16, backgroundColor: theme.accentContainer }}><AppText variant="headline" style={{ color: theme.accent }}>{preview.validRows.length}</AppText><AppText variant="caption" muted>Ready</AppText></View>
              <View style={{ flex: 1, minWidth: 120, padding: 14, borderRadius: 16, backgroundColor: theme.surfaceMuted }}><AppText variant="headline">{preview.duplicateRows.length}</AppText><AppText variant="caption" muted>Duplicates</AppText></View>
              <View style={{ flex: 1, minWidth: 120, padding: 14, borderRadius: 16, backgroundColor: theme.surfaceMuted }}><AppText variant="headline" style={{ color: preview.rejectedRows.length ? theme.negative : theme.text }}>{preview.rejectedRows.length}</AppText><AppText variant="caption" muted>Rejected</AppText></View>
            </View>
            {preview.rejectedRows.slice(0, 4).map((row) => <AppText key={row.rowNumber} variant="caption" style={{ color: theme.negative }}>Row {row.rowNumber}: {row.reason}</AppText>)}
            {preview.validRows.length && !preview.committedIds.length ? <ActionButton title={busy ? 'Importing…' : `Import ${preview.validRows.length} transactions`} icon="checkmark" onPress={commit} disabled={busy} /> : null}
          </View>
        ) : null}
      </Card>
      <Card><AppText variant="caption" muted>CSV is transaction portability, not a complete backup. Budgets, goals, schedules, and appearance settings are not included.</AppText></Card>
    </ScrollView>
  );
}
