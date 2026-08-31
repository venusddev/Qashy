/**
 * Change capture, without touching the finance core.
 *
 * `LocalFinanceRepository` is ~2500 lines of carefully-invariant finance logic, and making
 * every mutation site emit an op would mean editing every one of them. It does not have to:
 * `putMany` already hands this layer the complete, atomic, typed change set of every
 * mutation. Reading the previous rows for those same keys *inside the same transaction* and
 * diffing old against new derives the ops for free, and the repository never learns that
 * sync exists.
 *
 * **`putMany` captures; `transact` does not.** That split is deliberate and load-bearing.
 * `putMany` is the convenience wrapper the repository uses for a local mutation, so it is
 * exactly the right hook. `transact` is the escape hatch for a caller that already knows
 * what it is doing — the sync engine applying a peer's ops, the sealer stamping a signature,
 * compaction dropping rows. Capturing there too would re-diff a peer's merged result and
 * emit *local* ops attributing the peer's change to this device, which then replicate back
 * as though this device had made them. `LocalFinanceRepository.applyRemoteOpsNow` therefore
 * writes through `transact`, never `putMany`, and says so at the call site.
 *
 * Crypto is deliberately absent here. Ops are written unsigned (`sealed = 0`) and a
 * background sealer signs them afterwards; only sealed ops are ever transmitted. That keeps
 * the write path synchronous and pure, and — the reason it is not merely tidy — it is what
 * the Dexie transaction contract requires: awaiting anything foreign inside `work` leaves
 * Dexie's promise zone and lets IndexedDB commit underneath the write.
 */

import {
  recordOps,
  readChainState,
  writeChainState,
  writeMeta,
  SYNC_META,
} from '@/data/sync-store';
import type {
  StorageAdapter,
  StorageTx,
  StoredEntity,
  TransactOptions,
} from '@/data/storage-adapter';
import { recordKey } from '@/data/storage-adapter';
import type { EntityType, FinanceEntity } from '@/domain/models';
import { buildOp, diffRecords, metaKey, tick, type DiffInput } from '@/sync/oplog';

/** Surfaced after commit rather than thrown: the write itself is legitimate and complete. */
export type DiffWarningListener = (warnings: readonly string[]) => void;
export type ResetHandler = () => Promise<void>;

export class SyncingStorageAdapter implements StorageAdapter {
  private readonly warningListeners = new Set<DiffWarningListener>();
  private resetHandler: ResetHandler | null = null;

  /**
   * `deviceId` is `null` until this device joins a vault, and the parameter is deliberately
   * **not** optional so that every construction site has to say which it means. An accidental
   * default would be a decorator that silently captures nothing, which looks exactly like
   * working sync right up until the first pairing produces an empty history.
   *
   * Unarmed is the app's state on first launch and on every device that never turns sync on,
   * so it has to be a real supported mode rather than a brief window during startup.
   */
  constructor(
    private readonly inner: StorageAdapter,
    private deviceId: string | null,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Arms or disarms capture.
   *
   * Called once when a vault is opened and again when one is left. There is no need to
   * back-fill the ops missed while unarmed: `runGenesisMigration` runs in the same flow that
   * arms this, and it re-describes every row already on disk as a `create` op — so the history
   * a newly-paired device offers its peer is complete regardless of when capture started.
   */
  setDeviceId(deviceId: string | null) {
    this.deviceId = deviceId;
  }

  /**
   * Installs the device-key half of a full local reset.
   *
   * The finance repository owns the storage wipe, while the sync provider owns the keystore.
   * Keeping this seam on the already-shared adapter makes the two boundaries one operation in
   * the app without putting keystore imports into the finance layer.
   */
  setResetHandler(handler: ResetHandler | null) {
    this.resetHandler = handler;
    return () => {
      if (this.resetHandler === handler) this.resetHandler = null;
    };
  }

  initialize() {
    return this.inner.initialize();
  }

  readAll(type: EntityType) {
    return this.inner.readAll(type);
  }

  /**
   * Pass-through, by design — see the note at the top of this file.
   *
   * A caller reaching for `transact` is composing its own multi-table write and is
   * responsible for whatever ops it should produce. Wrapping it would make the sync engine's
   * own applies look like local edits.
   */
  transact<T>(work: (tx: StorageTx) => Promise<T>, options?: TransactOptions): Promise<T> {
    return this.inner.transact(work, options);
  }

  /**
   * A local mutation: the records, the ops they imply, and the advanced chain head, in one
   * transaction.
   *
   * The chain position is read from `sync_meta` *inside* the transaction rather than from an
   * in-memory counter. Two browser tabs share one `deviceId`, and two tabs each allocating
   * `seq = n + 1` from memory would produce two ops with the same `(deviceId, seq)` and
   * different `prevHash` — a forked chain that a correct peer must reject outright. IndexedDB
   * and SQLite both serialise writers over these tables, so reading it in-transaction makes
   * the collision impossible rather than merely unlikely.
   */
  async putMany(records: StoredEntity[], source?: object) {
    if (!records.length) return;

    // Unarmed: this device is in no vault, so there is nobody for an op to be addressed to
    // and no chain for it to extend. Straight through, byte-for-byte the behaviour the app
    // had before sync existed.
    const deviceId = this.deviceId;
    if (deviceId === null) return this.inner.putMany(records, source);

    // Read before the transaction opens. `Date.now()` is not awaited, but keeping every
    // input to `work` resolved up front is the habit the transaction contract is built on.
    const nowMs = this.now();

    const warnings = await this.inner.transact(async (tx) => {
      const previous = await this.readPrevious(tx, records);
      const { clock, head } = await readChainState(tx);

      // One clock reading for the whole batch: it is one user action, and the slots the ops
      // land in are disjoint, so a finer-grained reading would order nothing that this one
      // gets wrong.
      const stamped = tick(clock, deviceId, nowMs);
      const incoming: DiffInput[] = records.map(({ type, entity }) => ({ type, entity }));
      const diff = diffRecords(previous, incoming, stamped.hlc);

      if (diff.ops.length) {
        const built = buildOp(diff.ops, deviceId, head.seq, head.headHash);
        await recordOps(tx, built.ops, 0);
        await writeChainState(tx, {
          clock: stamped.clock,
          head: { seq: built.seq, headHash: built.headHash },
        });
      }

      // Unconditional, so a write whose diff produced nothing — a no-op save, or a change
      // confined to derived fields — still behaves exactly as it did before sync existed.
      // Last, so a failure here unwinds the ops with it: an op describing a record that was
      // never written is a change this device would broadcast but not itself hold.
      await tx.putMany(records);
      return diff.warnings;
    }, { source });

    // After commit: a warning is a note about a write that legitimately happened, so raising
    // it inside the transaction would roll back a change the user made and can see.
    if (warnings.length) this.warningListeners.forEach((listener) => listener(warnings));
  }

  /**
   * Local wipe.
   *
   * Emits no ops, and that is a security property rather than an omission. A "delete
   * everything" op would be a weapon: any compromised paired device could destroy every
   * peer's data with one message. Reset unpairs this device instead, which the confirm
   * dialog states plainly.
   */
  async clear(source?: object) {
    // Erase first. If the storage wipe fails, the finance data remains and the key is already
    // gone; the next status read will discard any leftover sync metadata rather than leave a
    // usable key beside a half-reset database.
    if (this.resetHandler) await this.resetHandler();
    this.deviceId = null;
    await this.inner.clear(source);
  }

  subscribe(listener: (source?: object) => void) {
    return this.inner.subscribe?.(listener) ?? (() => undefined);
  }

  /**
   * Fires when a write changed a field the registry marks immutable.
   *
   * Nothing was synced for that field — peers keep the value they agreed on at create time,
   * and the local row is the one that is wrong. It means local code did something it should
   * not, so it is worth surfacing rather than swallowing.
   */
  onDiffWarning(listener: DiffWarningListener) {
    this.warningListeners.add(listener);
    return () => this.warningListeners.delete(listener);
  }

  /** Records the vault's base currency, which every incoming batch is checked against. */
  setBaseCurrency(currency: string) {
    return this.inner.transact((tx) => writeMeta(tx, { [SYNC_META.baseCurrency]: currency }), {
      silent: true,
    });
  }

  private async readPrevious(tx: StorageTx, records: readonly StoredEntity[]) {
    const keys = records.map(({ type, entity }) => recordKey(type, entity.id));
    const rows = await tx.readKeys(keys);
    // Keyed by `metaKey`, which is the same `${type}:${id}` shape `recordKey` produces — the
    // op log and `records` deliberately share one key space so nothing has to translate.
    return new Map<string, FinanceEntity>(
      rows.map((row) => [metaKey(row.type, row.entity.id), row.entity]),
    );
  }
}
