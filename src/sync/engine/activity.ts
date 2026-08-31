/**
 * The visible record of what sync did.
 *
 * This exists because of one specific failure mode: a device that silently discards a peer's
 * batch is indistinguishable, from the outside, from a device that is perfectly up to date.
 * Both show the same screen. "Why has my laptop not changed in a week" is then a question
 * nobody can answer without a debugger, and the honest answer — "it rejected every batch
 * because a clock is wrong" — was known at the time and thrown away.
 *
 * So every rejection is recorded, and so are the successes, because a log containing only
 * problems cannot distinguish "nothing has gone wrong" from "nothing has happened".
 *
 * **Nothing here may carry finance data.** These lines are rendered on screen and pasted into
 * help requests. `detail` exists for a *transport or protocol* failure — a DNS error, a 502, a
 * rejected write token, a chain gap — which is exactly the information someone running their
 * own relay needs and is information the transport layer could not have learned anything
 * private from in the first place: it only ever handled sealed bytes.
 */

import type { SyncActivityInput } from '@/data/sync-store';
import { SyncCryptoError } from '@/sync/crypto';
import { OpLogError } from '@/sync/oplog';
import { SyncEngineError, type ActivityKind } from '@/sync/engine/types';

/**
 * How much of a failure description is kept.
 *
 * A relay behind a misconfigured proxy will happily return an entire HTML error page, and a
 * `fetch` rejection in some browsers stringifies to a paragraph. Neither is more useful at
 * full length than truncated, and both would otherwise be persisted in full, two hundred
 * rows deep.
 */
export const MAX_DETAIL_LENGTH = 200;

export interface ActivityInput {
  readonly kind: ActivityKind;
  readonly recordedAt: string;
  readonly peerId?: string;
  readonly count?: number;
  readonly code?: string;
  readonly detail?: string;
}

/**
 * Builds one log line.
 *
 * The optional fields are normalised to `''` and `0` rather than left absent, because
 * IndexedDB cannot index a null and the table is read in key order on every render of the
 * sync screen. A column that is sometimes missing is a column that is sometimes not there to
 * sort by.
 */
export const activityEntry = ({
  kind,
  recordedAt,
  peerId = '',
  count = 0,
  code = '',
  detail = '',
}: ActivityInput): SyncActivityInput => ({
  kind,
  peerId,
  count,
  code,
  detail: detail.slice(0, MAX_DETAIL_LENGTH),
  recordedAt,
});

/**
 * The machine-readable code behind a thrown error, for the UI to localize.
 *
 * Only the three error types this system defines are unwrapped. Anything else reports
 * `'unknown'` rather than its message: an arbitrary `Error` reaching here came from outside
 * the sync stack, so there is no guarantee about what it put in its message, and this string
 * is persisted and rendered.
 */
export function activityCode(error: unknown): string {
  if (error instanceof SyncEngineError) return error.code;
  if (error instanceof SyncCryptoError) return error.code;
  if (error instanceof OpLogError) return error.code;
  return 'unknown';
}

/**
 * A transport failure, in words a self-hoster can act on.
 *
 * The message *is* kept here, unlike in quarantine, and the distinction is deliberate: a
 * transport only ever handled sealed bytes, so nothing it can say about a failure came from a
 * record. "getaddrinfo ENOTFOUND relay.example" is precisely what someone debugging their own
 * worker needs, and withholding it to be safe would be withholding it for no reason.
 */
export function transportDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, MAX_DETAIL_LENGTH);
  if (typeof error === 'string' && error) return error.slice(0, MAX_DETAIL_LENGTH);
  return '';
}

/** A rejected batch, with everything the sync screen needs to explain it. */
export const rejectionEntry = (error: unknown, peerId: string, recordedAt: string) =>
  activityEntry({
    kind: 'rejected',
    recordedAt,
    peerId: error instanceof SyncEngineError && error.peerId ? error.peerId : peerId,
    code: activityCode(error),
    // A `SyncEngineError` writes its own messages and they are protocol-level by
    // construction, so they are safe to show. Anything else is reduced to its code above.
    detail: error instanceof SyncEngineError ? error.message.slice(0, MAX_DETAIL_LENGTH) : '',
  });
