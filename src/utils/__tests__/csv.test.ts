import { escapeCsv, parseCsvTable, parseCsvText } from '@/utils/csv';

describe('CSV utilities', () => {
  it('parses quoted fields and aliases common headers', () => {
    const rows = parseCsvText('date,type,description,amount,currency,account\n2026-07-01,expense,"Cafe, lunch",12.50,USD,Everyday');
    expect(rows[0]).toMatchObject({ title: 'Cafe, lunch', amount: '12.50', rowNumber: 2 });
  });

  it('escapes commas, quotes, and line breaks', () => {
    expect(escapeCsv('A, "B"')).toBe('"A, ""B"""');
  });

  it('neutralizes spreadsheet formulas but leaves plain numbers alone', () => {
    expect(escapeCsv('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(escapeCsv('+HYPERLINK("x")')).toBe('"\'+HYPERLINK(""x"")"');
    expect(escapeCsv('@cmd')).toBe("'@cmd");
    expect(escapeCsv('-12.50')).toBe('-12.50');
    expect(escapeCsv('-1200')).toBe('-1200');
  });

  it('reverses the spreadsheet formula guard during import', () => {
    const rows = parseCsvText("title,account,note\n'=Coffee,'+Cash,'@memo");
    expect(rows[0]).toMatchObject({ title: '=Coffee', account: '+Cash', note: '@memo' });
  });

  it('reports physical line numbers when blank lines are skipped', () => {
    const rows = parseCsvText(
      'date,type,title,amount,currency,account\n\n2026-07-01,expense,First,1.00,USD,Everyday\n\n2026-07-02,expense,Second,2.00,USD,Everyday\n',
    );
    expect(rows[0].rowNumber).toBe(3);
    expect(rows[1].rowNumber).toBe(5);
  });

  it('preserves significant whitespace inside quoted fields only', () => {
    const rows = parseCsvText('date,title\n2026-07-01,"  padded  "\n2026-07-02,  loose  ');
    expect(rows[0].title).toBe('  padded  ');
    expect(rows[1].title).toBe('loose');
  });

  it('rejects only the offending row for unclosed quoted fields', () => {
    const table = parseCsvTable('date,title\n2026-07-01,"unclosed');
    expect(table.rows).toHaveLength(0);
    expect(table.rowErrors).toMatchObject([{ lineNumber: 2, message: expect.stringContaining('Unclosed quoted CSV field') }]);
  });

  it('rejects only the offending row for quotes inside unquoted fields and trailing text', () => {
    const bad = parseCsvTable('date,title\n2026-07-01,bad"quote');
    expect(bad.rows).toHaveLength(0);
    expect(bad.rowErrors).toMatchObject([{ lineNumber: 2, message: expect.stringContaining('Malformed CSV quote') }]);

    const tail = parseCsvTable('date,title\n2026-07-01,"closed"tail');
    expect(tail.rows).toHaveLength(0);
    expect(tail.rowErrors).toMatchObject([{ lineNumber: 2, message: expect.stringContaining('Malformed CSV quote') }]);
  });

  it('keeps valid rows when one row has a stray quote', () => {
    const table = parseCsvTable('date,title\n2026-07-01,Good\n2026-07-02,bad"quote\n2026-07-03,Also good');
    expect(table.rows.map((row) => row.title)).toEqual(['Good', 'Also good']);
    expect(table.rowErrors).toMatchObject([{ lineNumber: 3 }]);
  });

  it('detects semicolon and tab delimited files', () => {
    expect(parseCsvTable('date;title\n2026-07-01;Coffee').rows[0]).toMatchObject({ date: '2026-07-01', title: 'Coffee' });
    expect(parseCsvTable('date\ttitle\n2026-07-01\tCoffee').rows[0]).toMatchObject({ date: '2026-07-01', title: 'Coffee' });
  });

  it('survives an export/import round trip for a literal leading apostrophe', () => {
    const table = parseCsvTable(`title\n${escapeCsv("'=SUM(A1:A9)")}`);
    expect(table.rows[0].title).toBe("'=SUM(A1:A9)");
  });
});
