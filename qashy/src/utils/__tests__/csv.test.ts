import { escapeCsv, parseCsvText } from '@/utils/csv';

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

  it('rejects unclosed quoted fields', () => {
    expect(() => parseCsvText('date,title\n2026-07-01,"unclosed')).toThrow('Unclosed quoted CSV field');
  });

  it('rejects quotes inside unquoted fields and trailing text after a closing quote', () => {
    expect(() => parseCsvText('date,title\n2026-07-01,bad"quote')).toThrow('Malformed CSV quote');
    expect(() => parseCsvText('date,title\n2026-07-01,"closed"tail')).toThrow('Malformed CSV quote');
  });
});
