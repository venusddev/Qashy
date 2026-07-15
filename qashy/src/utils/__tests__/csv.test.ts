import { escapeCsv, parseCsvText } from '@/utils/csv';

describe('CSV utilities', () => {
  it('parses quoted fields and aliases common headers', () => {
    const rows = parseCsvText('date,type,description,amount,currency,account\n2026-07-01,expense,"Cafe, lunch",12.50,USD,Everyday');
    expect(rows[0]).toMatchObject({ title: 'Cafe, lunch', amount: '12.50', rowNumber: 2 });
  });

  it('escapes commas, quotes, and line breaks', () => {
    expect(escapeCsv('A, "B"')).toBe('"A, ""B"""');
  });
});
