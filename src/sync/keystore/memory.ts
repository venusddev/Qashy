/**
 * An in-process keystore.
 *
 * Two jobs. It is the test double every sync suite pairs devices with — which is why it
 * reports `supportsPassphrase: true` even though a passphrase over a variable in RAM
 * protects nothing: the gate's state machine lives in `BaseKeystore`, and this is where it
 * gets exercised. It is also what `platform.ts` falls back to if a platform ever resolves
 * neither the native nor the web file, so sync degrades to "works until you close the app"
 * instead of crashing at import time.
 *
 * It is never wired into a real build.
 */

import { BaseKeystore } from '@/sync/keystore/base';
import type { SyncKeystore } from '@/sync/keystore/types';

/**
 * The bytes on "disk". Held outside the keystore instance so two instances can share one,
 * which is how a test simulates an app restart: build a second `MemoryKeystore` over the
 * same cell and it starts cold, with no cached record and no open gate.
 */
export interface MemoryKeystoreCell {
  bytes: Uint8Array | null;
}

export class MemoryKeystore extends BaseKeystore {
  readonly kind: SyncKeystore['kind'] = 'memory';
  /** Widened from the literal so a suite can subclass this to stand in for a platform that has no gate. */
  readonly supportsPassphrase: boolean = true;

  constructor(
    private readonly cell: MemoryKeystoreCell = { bytes: null },
    /** False exercises the path where sync must refuse to start rather than fall back. */
    private readonly isAvailable = true,
  ) {
    super();
  }

  protected override async available() {
    return this.isAvailable;
  }

  protected async readContainer() {
    // A copy, so a caller that mutates what it reads cannot rewrite the store behind us —
    // the real backends hand back fresh buffers and the double must not be more forgiving.
    return this.cell.bytes ? new Uint8Array(this.cell.bytes) : null;
  }

  protected async writeContainer(bytes: Uint8Array) {
    this.cell.bytes = new Uint8Array(bytes);
  }

  protected async eraseContainer() {
    this.cell.bytes?.fill(0);
    this.cell.bytes = null;
  }
}
