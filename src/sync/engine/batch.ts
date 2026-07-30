/**
 * The batch codec, and the structural gate every received batch passes through first.
 *
 * Decoding is where a hostile peer gets its cheapest shot, so this module is written as a
 * validator that happens to return a value rather than a parser that happens to check a few
 * things. Nothing is coerced, nothing is defaulted, and no field is trusted because a
 * neighbouring field looked plausible. A batch either satisfies every rule below or it does
 * not exist.
 *
 * The order of the checks is part of the defence: size before allocation, shape before
 * content, structure before cryptography. By the time `verifyChain` and the signature checks
 * run — which are the expensive parts — the batch is already known to be well-formed, so a
 * malformed blob costs a JSON parse rather than several thousand Ed25519 verifications.
 *
 * **What is deliberately *not* validated here: `entityType` and `kind`.** Both are checked
 * against closed unions everywhere else in the app, and doing it here would be a bug. An op
 * from a newer build naming a type this one has never heard of has to be stored, hashed, and
 * forwarded byte-for-byte, because it is part of a hash chain that other peers depend on —
 * dropping it truncates history for everyone downstream, permanently. The merge decides what
 * it can interpret; this decides only what is structurally a batch.
 */

import { bytesToUtf8, utf8Bytes } from '@/sync/crypto';
import { isHlc, opIdFor, parseHlc, type SyncOp } from '@/sync/oplog';
import { SyncEngineError, type SyncBatch } from '@/sync/engine/types';
import { canonicalJson } from '@/utils/canonical-json';

/**
 * The most ops one batch may carry.
 *
 * Sized against the genesis migration, which is by far the largest legitimate batch anyone
 * sends: it converts an entire existing vault into `create` ops in one go. Ten thousand is
 * comfortably beyond a personal finance history and still small enough that verifying every
 * signature in the batch is a fraction of a second rather than a frozen screen.
 *
 * A sender with more than this splits; there is nothing special about the boundary because
 * chains resume exactly where they left off.
 */
export const MAX_BATCH_OPS = 10_000;

const fail = (message: string): never => {
  throw new SyncEngineError(message, 'badBatch');
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value) fail(`${what} is missing.`);
  return value as string;
};

/** Allows `''`, which is what a chain's first op carries as its `prevHash`. */
const optionalText = (value: unknown, what: string): string => {
  if (typeof value !== 'string') fail(`${what} is not a string.`);
  return value as string;
};

const count = (value: unknown, what: string, minimum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail(`${what} is not a valid number.`);
  }
  return value as number;
};

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

const decodeOp = (value: unknown, index: number): SyncOp => {
  if (!isRecord(value)) return fail(`Op ${index} is not an object.`);

  const deviceId = text(value.deviceId, `Op ${index}'s device`);
  const seq = count(value.seq, `Op ${index}'s sequence number`, 1);

  // `opId` is derivable from the two fields above, so a disagreement means the batch was
  // assembled by something that does not know the rule — or edited by something that hoped
  // one of the three would not be checked.
  if (value.opId !== opIdFor(deviceId, seq)) {
    fail(`Op ${index} has an id that does not match its chain position.`);
  }

  const hlc = text(value.hlc, `Op ${index}'s clock reading`);
  if (!isHlc(hlc)) fail(`Op ${index} has a malformed clock reading.`);
  // The author's device id is embedded in its own clock reading, which makes the two
  // independently forgeable only together. Checking them against each other closes the gap
  // where an op is attributed to one device and ordered as though it came from another.
  if (parseHlc(hlc).deviceId !== deviceId) {
    fail(`Op ${index}'s clock reading belongs to a different device.`);
  }

  if (!isRecord(value.payload)) fail(`Op ${index} has no payload.`);

  return {
    opId: value.opId as string,
    deviceId,
    seq,
    prevHash: optionalText(value.prevHash, `Op ${index}'s previous hash`),
    opHash: text(value.opHash, `Op ${index}'s hash`),
    hlc,
    // Cast without checking, on purpose — see the note at the top of this file.
    entityType: text(value.entityType, `Op ${index}'s entity type`) as SyncOp['entityType'],
    entityId: text(value.entityId, `Op ${index}'s entity id`),
    kind: text(value.kind, `Op ${index}'s kind`) as SyncOp['kind'],
    payload: value.payload as Record<string, unknown>,
    schema: count(value.schema, `Op ${index}'s schema version`, 1),
    // An unsealed op has never been signed, so nothing about it can be verified and nothing
    // downstream would catch that. Only sealed ops are ever transmitted, which makes an
    // empty signature here a malformed batch rather than a batch that needs verifying.
    signature: text(value.signature, `Op ${index}'s signature`),
  };
};

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * Canonical JSON, not `JSON.stringify`.
 *
 * The batch itself is not hashed, so this is not strictly required for correctness — but
 * the ops inside it are, and encoding them two different ways depending on which side of a
 * function boundary you are on is exactly the sort of asymmetry that produces a chain break
 * nobody can reproduce. One encoder, everywhere.
 */
export const encodeBatch = (batch: SyncBatch): Uint8Array => utf8Bytes(canonicalJson(batch));

/**
 * Parses and validates a batch, or throws.
 *
 * There is no lenient mode and no partial result. A caller that got a `SyncEngineError` from
 * here has learned everything there is to learn: the bytes are not a batch this device can
 * act on, and the correct response is to record why and drop them.
 */
export function decodeBatch(bytes: Uint8Array): SyncBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(bytes));
  } catch {
    // Deliberately not rethrown as-is: a `SyntaxError` from deep inside JSON.parse names a
    // character offset, which tells a user nothing and tells an attacker where the parser is.
    throw new SyncEngineError('That batch is not readable.', 'badBatch');
  }
  if (!isRecord(parsed)) return fail('That batch is not an object.');

  const ops = parsed.ops;
  if (!Array.isArray(ops)) return fail('That batch has no ops.');
  if (ops.length > MAX_BATCH_OPS) {
    throw new SyncEngineError(
      `That batch carries ${ops.length} ops; the limit is ${MAX_BATCH_OPS}.`,
      'tooLarge',
    );
  }

  if (!isRecord(parsed.heads)) return fail('That batch does not say what the sender holds.');
  const heads: Record<string, number> = {};
  for (const [deviceId, seq] of Object.entries(parsed.heads)) {
    // Rebuilt entry by entry rather than passed through, so nothing a peer chose the name of
    // survives into an object this device will later index into.
    if (!deviceId) fail('That batch names a device with no id.');
    heads[deviceId] = count(seq, `The sender's position on chain ${deviceId}`, 0);
  }

  return {
    epoch: count(parsed.epoch, "That batch's vault epoch", 1),
    baseCurrency: text(parsed.baseCurrency, "That batch's base currency"),
    sender: text(parsed.sender, "That batch's sender"),
    ops: ops.map(decodeOp),
    heads,
  };
}
