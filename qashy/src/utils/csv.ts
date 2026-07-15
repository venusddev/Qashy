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
  const rows: { cells: string[]; quotedCells: boolean[]; lineNumber: number }[] = [];
  let cells: string[] = [];
  let quotedCells: boolean[] = [];
  let field = '';
  let fieldQuoted = false;
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  const endField = () => {
    cells.push(field);
    quotedCells.push(fieldQuoted);
    field = '';
    fieldQuoted = false;
  };
  const endRow = () => {
    endField();
    if (cells.some((cell) => cell.trim())) rows.push({ cells, quotedCells, lineNumber: rowLine });
    cells = [];
    quotedCells = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"' && quoted && input[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
      fieldQuoted = true;
    } else if (character === ',' && !quoted) {
      endField();
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      endRow();
      line += 1;
      rowLine = line;
    } else {
      if (character === '\n') line += 1;
      field += character;
    }
  }
  endRow();

  if (!rows.length) return { headers: [], rows: [] as Record<string, string | number>[] };
  const headers = rows[0].cells.map((header) => header.trim().toLowerCase().replace(/[\s-]+/g, '_'));

  const records = rows.slice(1).map((source) => {
    // rowNumber is the physical line in the source file, so error messages
    // stay accurate even when blank lines are skipped.
    const record: Record<string, string | number> = { rowNumber: source.lineNumber };
    headers.forEach((header, column) => {
      const raw = source.cells[column] ?? '';
      record[header] = source.quotedCells[column] ? raw : raw.trim();
    });
    return record;
  });
  return { headers, rows: records };
}

export function escapeCsv(value: unknown) {
  let text = String(value ?? '');
  // Neutralize spreadsheet formula injection; plain numbers stay untouched.
  if (/^[=+@\t\r-]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
