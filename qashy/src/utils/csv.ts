const HEADER_ALIASES: Record<string, string> = {
  date: 'date',
  type: 'type',
  kind: 'type',
  status: 'status',
  title: 'title',
  description: 'title',
  amount: 'amount',
  currency: 'currency',
  account: 'account',
  category: 'category',
  tags: 'tags',
  note: 'note',
  notes: 'note',
  exchange_rate: 'exchangeRate',
  exchangerate: 'exchangeRate',
  destination_account: 'destinationAccount',
  destinationaccount: 'destinationAccount',
  destinationamount: 'destinationAmount',
  destination_amount: 'destinationAmount',
};

export function parseCsvText(input: string) {
  const table = parseCsvTable(input);
  return table.rows.map((source) => {
    const record: Record<string, string | number> = { rowNumber: source.rowNumber };
    table.headers.forEach((header) => {
      record[HEADER_ALIASES[header] ?? header] = source[header];
    });
    return record;
  });
}

export function parseCsvTable(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"' && quoted && input[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);

  if (!rows.length) return { headers: [], rows: [] as Record<string, string | number>[] };
  const headers = rows[0].map((header) => header.trim().toLowerCase().replace(/[\s-]+/g, '_'));

  const records = rows.slice(1).map((cells, index) => {
    const record: Record<string, string | number> = { rowNumber: index + 2 };
    headers.forEach((header, column) => {
      record[header] = cells[column]?.trim() ?? '';
    });
    return record;
  });
  return { headers, rows: records };
}

export function escapeCsv(value: unknown) {
  const text = String(value ?? '');
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
