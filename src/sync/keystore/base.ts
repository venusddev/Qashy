/**
 * The keystore state machine, shared by every platform.
 *
 * Each platform differs only in *where* an opaque byte string lives — the Keychain, the
 * Android Keystore, IndexedDB behind a non-extractable `CryptoKey`, or a field in a test
 * double. Everything above that — the record framing, the optional passphrase gate, the
 * locked/unlocked lifecycle, and the serialization that keeps a rotation from interleaving
 * with a read — is identical, so it is written once here and tested once, through the
 * memory implementation.
 *
 * The container is framed as `guard ‖ payload`. The guard byte says whether the payload is
 * a bare vault record or one sealed under a passphrase. It sits outside the sealed bytes
 * on purpose: `status()` has to be able to answer "is this locked?" without possessing the
 * passphrase, and a gate whose presence is itself a secret would just leave the UI unable
 * to prompt.
 */

import { createPassphraseBackup, openPassphraseBackup, zeroize } from '@/sync/crypto';

import { KeystoreError, type KeystoreStatus, type StoredVault, type SyncKeystore } from '@/sync/keystore/types';
import { decodeVaultRecord, encodeVaultRecord } from '@/sync/keystore/vault-record';

const GUARD_NONE = 0;
const GUARD_PASSPHRASE = 1;

export abstract class BaseKeystore implements SyncKeystore {
  abstract readonly kind: SyncKeystore['kind'];
  abstract readonly supportsPassphrase: boolean;

  /**
   * The plaintext record, held only while unlocked.
   *
   * The *record bytes* are cached rather than a decoded `StoredVault` so that this class
   * owns the only long-lived copy of the key material and can overwrite it on `lock()`.
   * Each `read()` decodes a fresh, independent value; handing out the same object and then
   * zeroizing it later would turn a caller's live key into zeros, which fails as
   * "authentication failed" somewhere unrelated rather than as "the vault was locked".
   */
  private record: Uint8Array | null = null;

  /**
   * Held for the session once a gate is opened, because re-sealing on the next write needs
   * it. This is not a weakening: a session that can read the vault key already holds
   * something strictly more valuable than the passphrase that protects it.
   */
  private passphrase: string | null = null;

  /** Serializes every operation, so a rotation cannot interleave with a read. */
  private chain: Promise<unknown> = Promise.resolve();

  protected abstract readContainer(): Promise<Uint8Array | null>;
  protected abstract writeContainer(bytes: Uint8Array): Promise<void>;
  protected abstract eraseContainer(): Promise<void>;

  /** Overridden where secure storage can genuinely be missing. */
  protected async available(): Promise<boolean> {
    return true;
  }

  async status(): Promise<KeystoreStatus> {
    return this.serial(async () => {
      if (!(await this.available())) return 'unavailable';
      if (this.record) return 'unlocked';
      const container = await this.readContainer();
      if (!container || container.length === 0) return 'empty';
      return container[0] === GUARD_PASSPHRASE ? 'locked' : 'unlocked';
    });
  }

  async read(): Promise<StoredVault | null> {
    return this.serial(async () => {
      const record = await this.loadRecord();
      return record ? decodeVaultRecord(record) : null;
    });
  }

  async write(vault: StoredVault): Promise<void> {
    return this.serial(async () => {
      await this.requireAvailable();
      // A gate that is armed but not open must not be silently dropped by an overwrite —
      // that would leave the vault stored in the clear on a browser the user asked to
      // protect. Reading the existing guard is the only way to know, so do it every time.
      const existing = await this.readContainer();
      if (existing?.[0] === GUARD_PASSPHRASE && this.passphrase === null) {
        throw new KeystoreError('Unlock this device before changing its vault.', 'locked');
      }
      await this.persist(encodeVaultRecord(vault));
    });
  }

  async erase(): Promise<void> {
    return this.serial(async () => {
      await this.eraseContainer();
      this.forget();
    });
  }

  async setPassphrase(next: string | null): Promise<void> {
    return this.serial(async () => {
      if (!this.supportsPassphrase) {
        throw new KeystoreError(
          'This device protects the vault with the system keychain, which cannot be replaced by a passphrase.',
          'unsupported',
        );
      }
      const record = await this.loadRecord();
      if (!record) {
        throw new KeystoreError('There is no vault on this device to protect.', 'empty');
      }
      const previous = this.passphrase;
      this.passphrase = next;
      try {
        await this.persist(record);
      } catch (reason) {
        // A rejected passphrase (too short) or a failed write must not leave this instance
        // believing a gate is armed that was never written — the next `write` would then
        // seal under a passphrase the user never confirmed.
        this.passphrase = previous;
        throw reason;
      }
    });
  }

  async unlock(passphrase: string): Promise<void> {
    return this.serial(async () => {
      await this.requireAvailable();
      const container = await this.readContainer();
      if (!container || container.length === 0) {
        throw new KeystoreError('There is no vault on this device.', 'empty');
      }
      if (container[0] !== GUARD_PASSPHRASE) {
        // Already open. Idempotent rather than an error: a caller that unlocks
        // unconditionally at startup is doing the right thing.
        this.record = container.slice(1);
        return;
      }
      // Deliberately not wrapped in a try/catch. `openPassphraseBackup` throws a
      // `SyncCryptoError` whose message is already the right thing to show a user, and
      // catching it here to re-throw something else would be the "swallowed crypto error"
      // this codebase forbids.
      const record = openPassphraseBackup(passphrase, container.slice(1));
      // Validate before caching, so a record that survives the AEAD but is not a vault
      // fails now rather than on the next read.
      decodeVaultRecord(record);
      this.record = record;
      this.passphrase = passphrase;
    });
  }

  lock(): void {
    this.forget();
  }

  // -------------------------------------------------------------------------

  private async loadRecord(): Promise<Uint8Array | null> {
    if (this.record) return this.record;
    await this.requireAvailable();
    const container = await this.readContainer();
    if (!container || container.length === 0) return null;
    if (container[0] === GUARD_PASSPHRASE) {
      throw new KeystoreError(
        'This vault is protected by a passphrase on this device. Enter it to continue.',
        'locked',
      );
    }
    this.record = container.slice(1);
    return this.record;
  }

  private async persist(record: Uint8Array): Promise<void> {
    const passphrase = this.passphrase;
    const payload = passphrase === null ? record : createPassphraseBackup(passphrase, record);
    const container = new Uint8Array(1 + payload.length);
    container[0] = passphrase === null ? GUARD_NONE : GUARD_PASSPHRASE;
    container.set(payload, 1);
    await this.writeContainer(container);
    // Only adopt the new record once the write succeeded: a failed write that had already
    // updated the cache would leave this session using a vault no other session can see.
    if (this.record !== record) {
      zeroize(this.record ?? undefined);
      this.record = record;
    }
  }

  private forget(): void {
    zeroize(this.record ?? undefined);
    this.record = null;
    this.passphrase = null;
  }

  private async requireAvailable(): Promise<void> {
    if (!(await this.available())) {
      throw new KeystoreError('This device has no secure storage available for sync keys.', 'unavailable');
    }
  }

  /**
   * Runs `work` after everything already queued, whether that finished or threw. Failures
   * are not propagated down the chain — one rejected write must not poison every later
   * read, which is what an unguarded `chain.then(work)` would do.
   */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work, work);
    this.chain = result.catch(() => undefined);
    return result;
  }
}
