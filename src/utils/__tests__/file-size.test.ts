import {
  MAX_CSV_IMPORT_BYTES,
  assertFileSize,
} from '@/utils/file-size';

describe('selected file size limits', () => {
  it('accepts a file at the cap', () => {
    expect(() =>
      assertFileSize(MAX_CSV_IMPORT_BYTES, MAX_CSV_IMPORT_BYTES, 'CSV file'),
    ).not.toThrow();
  });

  it('rejects before a whole oversized file can be read', () => {
    expect(() =>
      assertFileSize(MAX_CSV_IMPORT_BYTES + 1, MAX_CSV_IMPORT_BYTES, 'CSV file'),
    ).toThrow(/16 MiB safety limit/);
  });

  it('fails closed when the picker cannot provide a trustworthy size', () => {
    expect(() => assertFileSize(undefined, MAX_CSV_IMPORT_BYTES, 'CSV file')).toThrow(
      /could not be checked safely/,
    );
    expect(() => assertFileSize(Number.NaN, MAX_CSV_IMPORT_BYTES, 'CSV file')).toThrow(
      /could not be checked safely/,
    );
  });
});
