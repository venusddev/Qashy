import { Picker } from '@expo/ui';
import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { View } from 'react-native';

import { ActionButton } from '@/components/ui/action-button';
import { AppText } from '@/components/ui/app-text';
import { Card } from '@/components/ui/card';
import { ChoiceChip } from '@/components/ui/choice-chip';
import type { CsvImportRow, ImportResult, TransactionKind, TransactionStatus } from '@/domain/models';
import { useFinanceRepository, useFinanceState } from '@/providers/finance-provider';
import { FormScreen } from '@/components/ui/form-screen';
import { useQashyTheme } from '@/theme/theme';
import { radius } from '@/theme/tokens';
import { errorMessage, showError } from '@/utils/confirm';
import { parseCsvTable } from '@/utils/csv';
import { todayLocal } from '@/utils/date';

type CsvField = Exclude<keyof CsvImportRow, 'rowNumber'>;

const CSV_FIELDS: { key: CsvField; label: string; optional?: boolean; aliases: string[] }[] = [
  { key: 'date', label: 'Date', aliases: ['date', 'transaction_date', 'posted_date'] },
  { key: 'type', label: 'Type', aliases: ['type', 'kind', 'transaction_type'] },
  { key: 'status', label: 'Status', optional: true, aliases: ['status', 'transaction_status'] },
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
  const missingRequiredFields = CSV_FIELDS.filter((field) => !field.optional && !mapping[field.key]);

  const pick = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'text/plain'], copyToCacheDirectory: true, base64: false });
      if (result.canceled) return;
      const asset = result.assets[0];
      const text = asset.file ? await asset.file.text() : await new ExpoFile(asset.uri).text();
      const table = parseCsvTable(text);
      setRows([]);
      setPreview(null);
      if (!table.rows.length) {
        setSourceRows([]);
        setHeaders([]);
        setMapping(inferMapping([]));
        showError('No transactions found', 'Choose a CSV with a header row and at least one data row.');
        return;
      }
      setSourceRows(table.rows);
      setHeaders(table.headers);
      setMapping(inferMapping(table.headers));
    } catch (reason) {
      showError('Couldn’t read CSV', errorMessage(reason, 'Choose another UTF-8 CSV file.'));
    }
  };

  const previewImport = async () => {
    if (missingRequiredFields.length) return;
    const defaultAccount = state.accounts.find((item) => item.id === defaultAccountId)?.name ?? '';
    const defaultCategory = state.categories.find((item) => item.id === defaultCategoryId)?.name ?? '';
    const value = (record: Record<string, string | number>, field: CsvField) =>
      mapping[field] ? String(record[mapping[field]] ?? '') : '';
    const parsed = sourceRows.map((record) => ({
      rowNumber: Number(record.rowNumber),
      date: value(record, 'date'),
      type: (value(record, 'type') || 'expense').toLowerCase() as TransactionKind,
      status: (value(record, 'status') || 'posted').toLowerCase() as TransactionStatus,
      title: value(record, 'title'),
      amount: value(record, 'amount'),
      currency: (value(record, 'currency') || state.settings.baseCurrency).toUpperCase(),
      account: value(record, 'account') || defaultAccount,
      category: value(record, 'category') || defaultCategory,
      tags: value(record, 'tags'),
      note: value(record, 'note'),
      exchangeRate: value(record, 'exchangeRate'),
      destinationAccount: value(record, 'destinationAccount'),
      destinationAmount: value(record, 'destinationAmount'),
    }));
    setRows(parsed);
    setPreview(await repository.importCsv(parsed, false));
  };

  const commit = async () => {
    setBusy(true);
    try {
      const result = await repository.importCsv(rows, true);
      setPreview(result);
      showError('Import complete', `${result.committedIds.length} transactions imported.`);
    } catch (reason) {
      showError('Couldn’t import CSV', errorMessage(reason, 'No rows were imported.'));
    } finally {
      setBusy(false);
    }
  };

  const exportData = async () => {
    try {
      const csv = repository.exportCsv();
      const filename = `qashy-transactions-${todayLocal()}.csv`;
      if (process.env.EXPO_OS === 'web') {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        window.setTimeout(() => {
          anchor.remove();
          URL.revokeObjectURL(url);
        }, 1000);
        return;
      }
      const file = new ExpoFile(Paths.cache, filename);
      if (file.exists) file.delete();
      file.create();
      file.write(csv);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'text/csv', dialogTitle: 'Export Qashy transactions' });
    } catch (reason) {
      showError('Couldn’t export CSV', errorMessage(reason, 'Try again.'));
    }
  };

  return (
    <FormScreen maxWidth={760} contentContainerStyle={{ gap: 16, paddingBottom: 40 }}>
      <Card style={{ gap: 14 }}>
        <AppText variant="headline">Export transactions</AppText>
        <AppText muted>Creates a UTF-8 CSV with dates, statuses, amounts, currencies, source and destination accounts, categories, tags, notes, exchange-rate snapshots, and transfer linkage.</AppText>
        <ActionButton title="Export CSV" icon="tray" onPress={exportData} />
      </Card>
      <Card style={{ gap: 14 }}>
        <AppText variant="headline">Import transactions</AppText>
        <AppText muted>Headers are matched automatically. Required columns are date, type, title, amount, currency, and account. Nothing is committed until after preview.</AppText>
        <ActionButton title="Choose CSV" variant="secondary" onPress={pick} />
        {sourceRows.length ? (
          <View style={{ gap: 12, paddingTop: 6 }}>
            <AppText variant="headline">Column mapping</AppText>
            <AppText variant="caption" muted>Choose the source column for each Qashy field. Optional fields can stay Not mapped.</AppText>
            {CSV_FIELDS.map((field) => (
              <View
                key={field.key}
                accessibilityLabel={`Map ${field.label}`}
                role="group"
                style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: 1, borderBottomColor: theme.border }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <AppText variant="label">{field.label}{field.optional ? '' : ' *'}</AppText>
                  {!field.optional && !mapping[field.key] ? <AppText accessibilityRole="alert" variant="caption" style={{ color: theme.negative }}>Required</AppText> : null}
                </View>
                <View style={{ minWidth: 180, minHeight: 44, justifyContent: 'center' }}>
                  <Picker
                    selectedValue={mapping[field.key]}
                    onValueChange={(value) => {
                      setMapping((current) => ({ ...current, [field.key]: String(value) }));
                      setPreview(null);
                    }}
                    testID={`mapping-${field.key}`}>
                    <Picker.Item label="Not mapped" value="" />
                    {headers.map((header) => <Picker.Item key={header} label={header} value={header} />)}
                  </Picker>
                </View>
              </View>
            ))}
            <AppText variant="label">Default account</AppText>
            <View accessibilityLabel="Default account" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              {state.accounts.filter((item) => !item.archived).map((account) => (
                <ChoiceChip key={account.id} label={account.name} selected={defaultAccountId === account.id} onPress={() => { setDefaultAccountId(account.id); setPreview(null); }} />
              ))}
            </View>
            <AppText variant="label">Default category</AppText>
            <View accessibilityLabel="Default category" accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <ChoiceChip label="None" selected={!defaultCategoryId} onPress={() => { setDefaultCategoryId(''); setPreview(null); }} />
              {state.categories.filter((item) => !item.archived).map((category) => (
                <ChoiceChip key={category.id} label={category.name} selected={defaultCategoryId === category.id} onPress={() => { setDefaultCategoryId(category.id); setPreview(null); }} />
              ))}
            </View>
            {missingRequiredFields.length ? (
              <AppText accessibilityRole="alert" variant="caption" style={{ color: theme.negative }}>
                Map required fields: {missingRequiredFields.map((field) => field.label).join(', ')}.
              </AppText>
            ) : null}
            <ActionButton title="Preview import" icon="checkmark" onPress={previewImport} disabled={Boolean(missingRequiredFields.length)} />
          </View>
        ) : null}
        {preview ? (
          <View style={{ gap: 10, paddingTop: 6 }}>
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
              <View style={{ flex: 1, minWidth: 120, padding: 14, borderRadius: radius.card, backgroundColor: theme.accentContainer }}><AppText variant="headline" style={{ color: theme.accent }}>{preview.validRows.length}</AppText><AppText variant="caption" muted>Ready</AppText></View>
              <View style={{ flex: 1, minWidth: 120, padding: 14, borderRadius: radius.card, backgroundColor: theme.surfaceMuted }}><AppText variant="headline">{preview.duplicateRows.length}</AppText><AppText variant="caption" muted>Duplicates</AppText></View>
              <View style={{ flex: 1, minWidth: 120, padding: 14, borderRadius: radius.card, backgroundColor: theme.surfaceMuted }}><AppText variant="headline" style={{ color: preview.rejectedRows.length ? theme.negative : theme.text }}>{preview.rejectedRows.length}</AppText><AppText variant="caption" muted>Rejected</AppText></View>
            </View>
            {preview.rejectedRows.slice(0, 4).map((row) => <AppText key={row.rowNumber} variant="caption" style={{ color: theme.negative }}>Row {row.rowNumber}: {row.reason}</AppText>)}
            {preview.validRows.length && !preview.committedIds.length ? <ActionButton title={busy ? 'Importing…' : `Import ${preview.validRows.length} transactions`} icon="checkmark" onPress={commit} disabled={busy} /> : null}
          </View>
        ) : null}
      </Card>
      <Card><AppText variant="caption" muted>CSV is transaction portability, not a complete backup. Budgets, goals, schedules, and appearance settings are not included.</AppText></Card>
    </FormScreen>
  );
}
