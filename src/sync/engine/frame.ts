/**
 * The boundary between a batch and the bytes that carry it.
 *
 * Everything above this file works in ops and rosters; everything below it works in opaque
 * frames. Keeping the two apart is what lets a transport be written without a single thought
 * about cryptography — a relay uploads a `Uint8Array`, a data channel sends a `Uint8Array`,
 * and neither is ever handed anything it could accidentally leak.
 *
 * Two properties are worth stating because they are easy to assume and expensive to be wrong
 * about:
 *
 * **Sealing failures are not caught here.** A frame that will not open is either tampered
 * with, addressed to somebody else, or from a vault epoch this device has moved past, and all
 * three deserve to be visible. Wrapping them in a soft failure is how a device ends up
 * silently not syncing for a month.
 *
 * **`seq` is a per-channel counter, not a chain position.** It exists to make each frame's
 * associated data unique so a frame cannot be replayed or reordered inside a session, and
 * both sides derive it the same way: count frames from zero, per direction, per channel. A
 * new channel starts over at zero, so a frame captured from a *previous* session could in
 * principle be replayed into a new one — and that is harmless by construction, because the op
 * log is idempotent. `pendingByDevice` drops every op already held, so a replayed batch
 * applies nothing. The AEAD counter defends the session; op-log idempotence defends the rest.
 */

import {
  ENVELOPE_PURPOSES,
  MAX_FRAME_BYTES,
  open,
  seal,
  type SealingKey,
} from '@/sync/crypto';
import { decodeBatch, encodeBatch } from '@/sync/engine/batch';
import { SyncEngineError, type SyncBatch } from '@/sync/engine/types';

export interface FrameContext {
  /** The vault content key, derived from the root key. Never the root key itself. */
  readonly key: SealingKey;
  readonly deviceId: string;
  readonly epoch: number;
}

/**
 * Seals a batch for one specific peer.
 *
 * Addressed rather than broadcast even though every paired device holds the same content key,
 * because the recipient is bound into the associated data: a frame built for the laptop will
 * not open on the phone. That costs one seal per peer and buys the guarantee that a relay
 * cannot take a blob addressed to a device that has since been revoked and hand it to one
 * that has not.
 */
export const sealBatch = (
  context: FrameContext,
  batch: SyncBatch,
  recipientDeviceId: string,
  seq: number,
): Uint8Array =>
  seal(
    context.key,
    {
      purpose: 'batch',
      senderDeviceId: context.deviceId,
      recipientDeviceId,
      epoch: context.epoch,
      seq,
    },
    encodeBatch(batch),
  );

/**
 * Opens a frame from one specific peer.
 *
 * The size check comes first and is not an optimisation. `open` allocates to decrypt, and the
 * whole point of a cap is to refuse before allocating — a peer that can make this device
 * allocate eight megabytes per frame can make it allocate until it dies, without ever holding
 * a valid key.
 */
export function openBatch(
  context: FrameContext,
  frame: Uint8Array,
  senderDeviceId: string,
  seq: number,
): SyncBatch {
  if (frame.length > MAX_FRAME_BYTES) {
    throw new SyncEngineError(
      `That frame is ${frame.length} bytes; the limit is ${MAX_FRAME_BYTES}.`,
      'tooLarge',
      senderDeviceId,
    );
  }
  return decodeBatch(
    open(
      context.key,
      {
        purpose: 'batch',
        senderDeviceId,
        recipientDeviceId: context.deviceId,
        epoch: context.epoch,
        seq,
      },
      frame,
    ),
  );
}

/** Re-exported so a transport can sanity-check a blob without importing the crypto module. */
export const BATCH_PURPOSE = ENVELOPE_PURPOSES.batch;
