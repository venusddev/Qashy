/**
 * What a device holds in order to be a member of a vault, and the contract for holding it.
 *
 * Exactly three secrets exist per device: the vault root key (shared by every paired
 * device, the thing pairing transfers) and this device's two private halves (never
 * transmitted, which is what makes revocation mean something). Everything else in the
 * protocol is derived from those, so this is the complete list of what has to survive a
 * restart and what has to be destroyed when sync is turned off.
 *
 * Nothing else belongs in here. In particular, sync *configuration* — endpoint URLs, the
 * device roster, watermarks — lives in the device-local `sync_meta` table, because it is
 * queried constantly and is not secret. Mixing the two would mean every read of a relay
 * URL touches the Keychain.
 */

import type { DeviceIdentity, VaultRootKey } from '@/sync/crypto';

export interface StoredVault {
  readonly vaultKey: VaultRootKey;
  readonly identity: DeviceIdentity;
  /**
   * Increments on every vault-key rotation.
   *
   * It lives here rather than only in `sync_meta` because it is a property *of this key*:
   * a rotation that bumped one without the other would leave the device sealing batches
   * under a key its peers have retired while labelling them with the old epoch, which
   * every peer would then reject for the wrong reason. One write, one authority.
   */
  readonly epoch: number;
}

/**
 * - `empty` — this device has never been paired. The ordinary state before setup.
 * - `unlocked` — the vault is readable right now.
 * - `locked` — a vault is stored but a passphrase gate is armed and has not been opened.
 * - `unavailable` — this platform cannot store secrets safely (no Keychain, no WebCrypto,
 *   no IndexedDB). Sync must refuse to start rather than fall back to something weaker.
 */
export type KeystoreStatus = 'empty' | 'unlocked' | 'locked' | 'unavailable';

export type KeystoreErrorCode =
  /** A passphrase gate is armed. Call `unlock` first. */
  | 'locked'
  /** The operation is meaningless on this platform (a passphrase gate on iOS, say). */
  | 'unsupported'
  /** Secure storage is missing or refused. */
  | 'unavailable'
  /** Something is stored, but it is not a vault record this build understands. */
  | 'corrupt'
  /** There is no vault to operate on. */
  | 'empty';

export class KeystoreError extends Error {
  constructor(
    message: string,
    readonly code: KeystoreErrorCode,
  ) {
    super(message);
    this.name = 'KeystoreError';
  }
}

export interface SyncKeystore {
  /** Which implementation this is. Surfaced in diagnostics, never used to branch on behaviour. */
  readonly kind: 'secure-store' | 'browser' | 'memory';

  /**
   * Whether `setPassphrase` does anything here.
   *
   * False on iOS and Android, and that is not a gap: the Keychain and the Android Keystore
   * are already gated on the device unlock, so a second passphrase would add friction
   * without adding a boundary. A browser profile has no equivalent, which is the whole
   * reason the gate exists at all.
   */
  readonly supportsPassphrase: boolean;

  status(): Promise<KeystoreStatus>;

  /**
   * The stored vault, or `null` when this device has never been paired.
   *
   * Throws `KeystoreError('locked')` when a passphrase gate is armed and `unlock` has not
   * run. It does not return `null` in that case — "no vault" and "I can't see the vault"
   * lead to opposite UI, and conflating them is how a user gets offered a fresh pairing
   * that would orphan their existing one.
   */
  read(): Promise<StoredVault | null>;

  write(vault: StoredVault): Promise<void>;

  /** Erases every trace, and clears the in-memory copy. Used by "turn off sync" and reset. */
  erase(): Promise<void>;

  /**
   * Arms, changes (`next` non-null), or removes (`next` null) the passphrase gate.
   * Requires the vault to be readable, so an armed gate must be unlocked first.
   */
  setPassphrase(next: string | null): Promise<void>;

  /** Opens an armed gate for this session. Throws `SyncCryptoError('badPassphrase')` on a wrong one. */
  unlock(passphrase: string): Promise<void>;

  /** Drops the in-memory copy. A no-op when no gate is armed — there is nothing to re-lock. */
  lock(): void;
}
