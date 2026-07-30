/** Pre-read caps for user-selected files that would otherwise be buffered whole in memory. */
export const MAX_VAULT_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_SYNC_IMPORT_BYTES = 64 * 1024 * 1024;
export const MAX_CSV_IMPORT_BYTES = 16 * 1024 * 1024;

const mib = (bytes: number) => Math.floor(bytes / (1024 * 1024));

export function assertFileSize(
  size: number | null | undefined,
  maxBytes: number,
  kind: string,
): asserts size is number {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${kind} size could not be checked safely. Choose another file.`);
  }
  if (size > maxBytes) {
    throw new Error(`${kind} is larger than the ${mib(maxBytes)} MiB safety limit.`);
  }
}
