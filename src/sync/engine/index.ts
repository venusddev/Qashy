/**
 * The sync engine.
 *
 * Where the pure halves meet the impure one. `src/sync/crypto/` decides what a frame is and
 * `src/sync/oplog/` decides what a change is — both offline, both deterministic, both fully
 * testable without a network. This directory is the first that reads a clock, opens a
 * transaction, or talks to another device, and it is deliberately the last thing written,
 * because by the time it exists the two hard problems underneath it are already proven.
 *
 * The shape, outward from the wire:
 *
 *   transport   bytes ↔ a peer            pluggable; knows nothing about keys or ops
 *   frame       bytes ↔ SyncBatch         the sealed envelope, addressed and epoch-bound
 *   batch       bytes ↔ SyncBatch         structural validation, deliberately semantics-blind
 *   roster      who this vault trusts     consulted per batch, never cached in a field
 *   receive     SyncBatch → the ledger    verify, store, project — whole or not at all
 *   send        the ledger → SyncBatch    sealed ops only, always a contiguous prefix
 *   session     when any of it runs       one entry point, hung on the app's foreground seam
 *
 * Two rules hold everywhere below this line and are worth stating once rather than repeating
 * in every file. **Fail closed and fail whole** — a signature failure, a roster miss, or a
 * chain break rejects the entire batch, because partial application is exactly how a
 * truncation attack succeeds quietly. And **a stored op is never withheld from a peer** —
 * even one this device cannot itself project, because one device's disagreement must not
 * truncate everybody else's history.
 */

export { MAX_DETAIL_LENGTH, activityCode, activityEntry, rejectionEntry, transportDetail, type ActivityInput } from '@/sync/engine/activity';

export { MAX_BATCH_OPS, decodeBatch, encodeBatch } from '@/sync/engine/batch';

export { BATCH_PURPOSE, openBatch, sealBatch, type FrameContext } from '@/sync/engine/frame';

export {
  QUARANTINE_REASON_BY_CODE,
  describeFailure,
  healQuarantine,
  quarantineCount,
  quarantineRows,
  recordQuarantine,
  type QuarantineChange,
} from '@/sync/engine/quarantine';

export {
  headsRecord,
  projectableOps,
  receiveBatch,
  type ReceiveDeps,
  type ReceiveOutcome,
} from '@/sync/engine/receive';

export {
  activePeers,
  fromPeerRow,
  isRevoked,
  mergeHeads,
  peerAcks,
  readRoster,
  requireAuthor,
  requireSender,
  toPeerRow,
  writePeers,
  type Peer,
  type Roster,
} from '@/sync/engine/roster';

export { SEAL_BATCH_SIZE, hasUnsealed, sealPending, type SealerInput } from '@/sync/engine/sealer';

export { SEND_BATCH_OPS, buildBatch, type OutgoingBatch, type SendDeps } from '@/sync/engine/send';

export {
  MAX_BATCHES_PER_PASS,
  SyncSession,
  type PushOutcome,
  type ReconcileOutcome,
  type SyncSessionDeps,
} from '@/sync/engine/session';

export {
  LoopbackChannel,
  LoopbackTransport,
  type PeerDescriptor,
  type SyncChannel,
  type SyncTransport,
  type TransportKind,
} from '@/sync/engine/transport';

export {
  ACTIVITY_KINDS,
  SyncEngineError,
  type ActivityKind,
  type RejectionCode,
  type SyncBatch,
} from '@/sync/engine/types';
