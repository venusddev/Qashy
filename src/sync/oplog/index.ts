/**
 * The op log and CRDT.
 *
 * Pure and offline by construction — nothing in here opens a socket, reads a clock, or
 * touches storage. Every function that needs the time takes it as an argument, which is what
 * makes convergence something you can assert in a test rather than something you hope holds
 * in the field.
 *
 * The pipeline, in order:
 *
 *   diff      records → ops        what changed, in the vocabulary of the merge registry
 *   chain     ops → signed ops     numbered, hash-chained, and attributable to one device
 *   merge     ops → CausalMeta     the authoritative per-field state, order-independent
 *   materialize  CausalMeta → entity
 *   repair    entities → entities  the deterministic pass that makes the merge *valid*
 *
 * `merge` is where convergence is decided and `repair` is where validity is. They are
 * separate because they fail differently: a merge bug diverges two devices, a repair bug
 * produces a state the finance core refuses to save. Both are tested as such.
 */

export {
  GENESIS_HASH,
  buildOp,
  hashOp,
  opIdFor,
  pendingByDevice,
  sealOp,
  verifyChain,
  verifyOpSignature,
  type ChainHead,
} from '@/sync/oplog/chain';

export {
  RETENTION_MS,
  canServeDelta,
  chainHeads,
  highestHlc,
  planCompaction,
  safeSeq,
  type CompactionPlan,
  type PeerAcks,
} from '@/sync/oplog/compaction';

export { diffEntity, diffRecords, type DiffInput, type DiffResult } from '@/sync/oplog/diff';

export {
  HLC_LENGTH,
  MAX_CLOCK_SKEW_MS,
  MAX_COUNTER,
  MAX_WALL_MS,
  ZERO_CLOCK,
  compareHlc,
  formatHlc,
  hlcFromTimestamp,
  hlcToIso,
  isHlc,
  maxHlc,
  observe,
  parseHlc,
  tick,
  type Hlc,
  type HlcClock,
} from '@/sync/oplog/hlc';

export {
  applyOp,
  applyOps,
  changedTypes,
  finalize,
  hasCompleteKnownRegisters,
  isElementPresent,
  materialize,
  mergeMeta,
  mergeMetaMaps,
  registerValueOf,
  type Finalized,
  type RegisterValue,
} from '@/sync/oplog/merge';

export {
  ENTITY_TYPES,
  createOnlyFieldsOf,
  deviceLocalFieldsOf,
  elementSetsOf,
  isEntityType,
  keyedMapsOf,
  readPath,
  registerOf,
  registersOf,
  specFor,
  writePath,
  type EntitySpec,
  type FieldStrategy,
  type RegisterSpec,
} from '@/sync/oplog/registry';

export {
  repairMergedState,
  type RepairCode,
  type RepairInput,
  type RepairNote,
  type RepairOutput,
  type RepairedRecord,
} from '@/sync/oplog/repair';

// `OP_SCHEMA_VERSION` is deliberately not re-exported here — it lives in `@/sync/crypto`
// alongside the protocol version and the HKDF labels, because they are one wire contract
// and a second export path is a second thing to forget to bump.
export {
  OP_KINDS,
  OpLogError,
  emptyMeta,
  metaKey,
  type CausalMeta,
  type DeletionState,
  type ElementState,
  type MapEntryState,
  type OpKind,
  type RegisterState,
  type SyncOp,
  type SyncOpBody,
} from '@/sync/oplog/types';
