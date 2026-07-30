/**
 * What two devices say to each other, and every way one of them can say no.
 *
 * The op log decides what a change *is* and the crypto decides what a frame *is*; this
 * layer decides what a conversation is. It is the first place in the sync stack that is
 * allowed to be impure — it reads clocks, touches storage, and talks to peers — so the
 * vocabulary here is deliberately narrow: one wire shape, one error, one closed set of
 * reasons a batch can be refused.
 *
 * The closed set matters more than it looks. "Sync isn't working" is the single least
 * useful thing an app can tell someone about their own data, and every one of these codes
 * exists because it leads to a *different* action: pair the device, update the other app,
 * fix a clock, check a relay URL, or accept that one entity is stuck until a corrective
 * edit arrives. A generic failure would collapse all of those into a shrug.
 */

import type { SyncOp } from '@/sync/oplog';

/** Breaking format version for authenticated sync batches, independent of stored envelopes. */
export const BATCH_FORMAT_VERSION = 2;

/**
 * The portable part of a peer row.
 *
 * A signed snapshot lets a device learn about peers that were paired or revoked elsewhere.
 * Local delivery state (`acked`, `known`, `lastSeenAt`) is intentionally absent.
 */
export interface RosterMember {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly signingKey: string;
  readonly agreementKey: string;
  readonly epoch: number;
  readonly addedAt: string;
  readonly revokedAt: string | null;
  /** Highest authored sequence accepted when revoked; null while active. */
  readonly revokedSeq: number | null;
}

/**
 * One device's outgoing message to another.
 *
 * `version` is independent of the outer envelope version. The envelope version also protects
 * backups and keystore records, which must remain readable when the live sync protocol gains
 * a new authentication requirement.
 *
 * `epoch` and `baseCurrency` are the two preconditions that are checked *before* any op is
 * applied. Both describe the vault rather than the batch, and both are unmergeable: a stale
 * epoch means the frame predates a key rotation, and a differing base currency means every
 * `baseAmountMinor` in the batch was computed against a different unit. Carrying them in
 * every batch rather than negotiating them once per session is what makes an asynchronous
 * relay drop safe — a blob sitting in a bucket for a week still says what it assumed.
 */
export interface SyncBatch {
  readonly version: typeof BATCH_FORMAT_VERSION;
  readonly epoch: number;
  readonly baseCurrency: string;
  /** The device that assembled this batch, which is not necessarily the author of its ops. */
  readonly sender: string;
  /**
   * Ops from any device the sender holds, not only its own.
   *
   * Forwarding is what makes three devices converge without all three ever being online at
   * the same moment: a laptop that has been closed for a week catches up on the phone's
   * history through the tablet that saw both.
   */
  readonly ops: readonly SyncOp[];
  /**
   * `{ [deviceId]: seq }` — the highest `seq` the sender holds of each chain.
   *
   * Serves as both the acknowledgement (what the sender has, so compaction knows what is
   * safe to drop) and the request (what it lacks, so the reply knows what to include). One
   * field rather than two, because two could disagree and the disagreement would present as
   * sync that runs forever without converging.
   */
  readonly heads: Readonly<Record<string, number>>;
  /** Signed membership state known to the sender, excluding the recipient. */
  readonly roster: readonly RosterMember[];
  /** Ed25519 over every preceding field, made by `sender`. */
  readonly signature: string;
}

export type UnsignedSyncBatch = Omit<SyncBatch, 'signature'>;

/**
 * Why a batch was refused.
 *
 * Grouped by what the user can do about it, because that is what the UI has to say:
 *
 * - **Nothing arrived intact** — `badFrame`, `badBatch`, `tooLarge`. Either something on
 *   the path is broken or something is tampering. Retrying is the right response.
 * - **The sender is not who it should be** — `unknownPeer`, `revokedPeer`, `unknownAuthor`,
 *   `badSignature`, `unsignedOp`. Pairing state is wrong, or an attack failed. Never retry
 *   silently; these are worth showing.
 * - **The history does not line up** — `chainBreak`, `chainFork`. A gap is usually a relay
 *   that lost a blob and heals on the next full exchange; a fork never heals by itself and
 *   means a device's log was rewritten.
 * - **The vaults disagree about something unmergeable** — `epochMismatch`,
 *   `currencyMismatch`. These block, and the UI has to explain rather than retry.
 * - **This device cannot project the result** — `invariant`. The batch is *stored and
 *   forwarded* regardless; only the local projection is held back, which is what quarantine
 *   is. See `quarantine.ts`.
 */
export type RejectionCode =
  /** The envelope refused to open: tampered bytes, the wrong key, or the wrong purpose. */
  | 'badFrame'
  /** The frame opened but its contents are not a well-formed batch. */
  | 'badBatch'
  /**
   * A pairing exchange did not say what a pairing exchange says.
   *
   * Kept apart from `badBatch` because the two happen at moments with nothing in common. A
   * malformed batch arrives during ordinary sync between devices that already trust each
   * other, and retrying is reasonable. This one happens with a QR code on screen and a person
   * waiting, and the only sane response is to abandon the attempt and start over — so it needs
   * to be distinguishable without parsing a message.
   */
  | 'badPairing'
  /** Over the frame or op-count cap. Rejected before allocating for it. */
  | 'tooLarge'
  /** The sending device is not in this vault's roster. */
  | 'unknownPeer'
  /** The sending device was paired once and has since been revoked. */
  | 'revokedPeer'
  /** A forwarded op is attributed to a device this vault has never heard of. */
  | 'unknownAuthor'
  /** An op's signature does not verify against its author's key. */
  | 'badSignature'
  /** An op arrived unsealed. Only sealed ops are ever transmitted, so this is malformed. */
  | 'unsignedOp'
  /** Missing ops between what we hold and what arrived. */
  | 'chainBreak'
  /** The sender's history disagrees with the history we already accepted from it. */
  | 'chainFork'
  /** The batch was sealed under a vault epoch this device has moved past. */
  | 'epochMismatch'
  /** The two vaults were onboarded with different base currencies. Unmergeable by design. */
  | 'currencyMismatch'
  /** The merged result would violate a money invariant. Quarantined, not discarded. */
  | 'invariant';

/**
 * Thrown by the engine, and never swallowed by a generic `catch`.
 *
 * Carries the peer it concerns because by the time this surfaces the caller is usually
 * several frames away from knowing which device it was talking to, and "a device rejected a
 * batch" without saying which one is not an answer anybody can act on.
 */
export class SyncEngineError extends Error {
  constructor(
    message: string,
    readonly code: RejectionCode,
    readonly peerId = '',
  ) {
    super(message);
    this.name = 'SyncEngineError';
  }
}

/**
 * What the activity log records.
 *
 * Deliberately includes the boring successes as well as the failures. A log of nothing but
 * problems cannot answer "did my laptop ever actually connect", which is the question
 * someone asks first — and an empty log then reads as "everything is fine" when it may mean
 * "nothing has happened in a month".
 */
export type ActivityKind =
  /** Ops handed to a peer. `count` is how many. */
  | 'sent'
  /** Ops accepted from a peer and projected. */
  | 'received'
  /** A batch refused whole. `code` says why. */
  | 'rejected'
  /** Entities held back because this device cannot project them. */
  | 'quarantined'
  /** Previously quarantined entities that a later op made projectable. */
  | 'recovered'
  /** A device joined the vault. */
  | 'paired'
  /** A device was removed from the vault. */
  | 'revoked'
  /** A relay reachability change or a failed push. `detail` carries the transport error. */
  | 'relay'
  /** A user-confirmed duplicate merge. */
  | 'merged'
  /** Ops dropped by retention. */
  | 'compacted';

export const ACTIVITY_KINDS: readonly ActivityKind[] = [
  'sent',
  'received',
  'rejected',
  'quarantined',
  'recovered',
  'paired',
  'revoked',
  'relay',
  'merged',
  'compacted',
];
