/**
 * The keystore's platform-agnostic surface.
 *
 * `createPlatformKeystore` is deliberately **not** re-exported here. It lives in
 * `@/sync/keystore/platform`, which resolves to a file that imports either
 * `expo-secure-store` or `indexedDB` — pulling that in transitively would mean every test
 * and every pure module that only wants the `StoredVault` type drags a native module with
 * it. This mirrors how `@/data/storage` is imported directly by the one place that
 * constructs an adapter.
 */

export { BaseKeystore } from '@/sync/keystore/base';
export { MemoryKeystore, type MemoryKeystoreCell } from '@/sync/keystore/memory';
export {
  KeystoreError,
  type KeystoreErrorCode,
  type KeystoreStatus,
  type StoredVault,
  type SyncKeystore,
} from '@/sync/keystore/types';
export {
  VAULT_RECORD_BYTES,
  decodeVaultRecord,
  encodeVaultRecord,
} from '@/sync/keystore/vault-record';
