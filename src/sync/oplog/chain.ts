/**
 * The hash chain: what makes a peer's history verifiable rather than merely plausible.
 *
 * Encryption alone stops a relay reading your finances. It does nothing about a relay that
 * re-orders batches, drops the middle of a week, or replays yesterday's ops on top of
 * today's — all of which are silent, and all of which corrupt a merge that trusts what it
 * is handed. So every device numbers its own ops with a strictly increasing `seq` and
 * binds each one to the previous op's hash. A gap, a rewind, or a fork is then arithmetic,
 * not a judgement call, and it is caught before a single op is applied.
 *
 * The signature covers `opHash`, which covers `prevHash`, which covers the entire chain
 * back to its first op. One valid signature on the newest op therefore attests to
 * everything before it — which is what makes verification cheap enough to run on every
 * batch instead of only when something already looks wrong.
 *
 * Hashing is **synchronous** on purpose. It runs inside a storage transaction, where
 * awaiting `crypto.subtle.digest` would leave Dexie's promise zone and let IndexedDB
 * commit underneath the write.
 */

import type { SigningPublicKey, SigningSecretKey } from '@/sync/crypto';
import { LABELS, fromHex, sha256, sign, toHex, utf8Bytes, verify } from '@/sync/crypto';
import { canonicalJson } from '@/utils/canonical-json';
import { OpLogError, type SyncOp, type SyncOpBody } from '@/sync/oplog/types';

/** The first op of a chain has no predecessor; the empty string is that, explicitly. */
export const GENESIS_HASH = '';

export const opIdFor = (deviceId: string, seq: number) => `${deviceId}:${seq}`;

/**
 * `SHA-256(label ‖ prevHash ‖ canonicalJson(body))`, hex.
 *
 * The body is canonicalised rather than stringified, so two devices that assembled the same
 * op through different code paths hash it identically. Without that, key order alone would
 * fork the chain.
 */
export function hashOp(prevHash: string, body: SyncOpBody): string {
  const canonical = canonicalJson({
    hlc: body.hlc,
    entityType: body.entityType,
    entityId: body.entityId,
    kind: body.kind,
    payload: body.payload,
    schema: body.schema,
  });
  return toHex(sha256(utf8Bytes(LABELS.op), utf8Bytes(prevHash), utf8Bytes(canonical)));
}

/** Numbers and chains a locally-produced op. Unsigned — the background sealer does that. */
export function buildOp(
  bodies: readonly SyncOpBody[],
  deviceId: string,
  fromSeq: number,
  fromHash: string,
): { readonly ops: readonly SyncOp[]; readonly seq: number; readonly headHash: string } {
  let seq = fromSeq;
  let prevHash = fromHash;
  const ops: SyncOp[] = [];
  for (const body of bodies) {
    seq += 1;
    const opHash = hashOp(prevHash, body);
    ops.push({
      ...body,
      opId: opIdFor(deviceId, seq),
      deviceId,
      seq,
      prevHash,
      opHash,
      signature: '',
    });
    prevHash = opHash;
  }
  return { ops, seq, headHash: prevHash };
}

/** The bytes a device signs, and the bytes a peer verifies. */
const signedBytes = (op: SyncOp) => utf8Bytes(`${LABELS.op}:${op.deviceId}:${op.seq}:${op.opHash}`);

/**
 * Signs an op.
 *
 * `deviceId` and `seq` are inside the signed bytes as well as inside `opHash`, so a
 * signature lifted from one device's op cannot be replayed as another's — the chain
 * position is part of what was attested, not just the contents.
 */
export function sealOp(op: SyncOp, secretKey: SigningSecretKey): SyncOp {
  return { ...op, signature: toHex(sign(signedBytes(op), secretKey)) };
}

export function verifyOpSignature(op: SyncOp, publicKey: SigningPublicKey): boolean {
  if (!op.signature) return false;
  try {
    return verify(fromHex(op.signature), signedBytes(op), publicKey);
  } catch {
    // A malformed signature is a failed verification, not a crash. Rethrowing here would
    // let a peer take the app down by sending one op with an odd-length hex string.
    return false;
  }
}

export interface ChainHead {
  readonly seq: number;
  readonly headHash: string;
}

/**
 * Verifies one device's ops form an unbroken continuation of what we already hold.
 *
 * Fails closed and fails whole: a batch with one bad op is rejected entirely rather than
 * applied up to the break. Partial application is how a truncation attack succeeds quietly.
 *
 * `ops` must be this device's ops only, ascending by `seq`.
 */
export function verifyChain(ops: readonly SyncOp[], head: ChainHead): ChainHead {
  let { seq, headHash } = head;
  for (const op of ops) {
    if (op.seq <= seq) {
      // Already held. Re-delivery is ordinary — a relay may hand back an overlapping range —
      // but the op must be *identical*, or the chain has been rewritten behind us.
      throw new OpLogError(
        `Op ${op.opId} rewinds this device's history to ${op.seq}.`,
        'chainFork',
      );
    }
    if (op.seq !== seq + 1) {
      throw new OpLogError(
        `Missing ops between ${seq} and ${op.seq} for device ${op.deviceId}.`,
        'chainBreak',
      );
    }
    if (op.prevHash !== headHash) {
      throw new OpLogError(`Op ${op.opId} does not follow the history we hold.`, 'chainBreak');
    }
    if (op.opHash !== hashOp(op.prevHash, op)) {
      throw new OpLogError(`Op ${op.opId} does not match its own hash.`, 'malformed');
    }
    seq = op.seq;
    headHash = op.opHash;
  }
  return { seq, headHash };
}

/**
 * Splits a batch into per-device chains, dropping ops already held.
 *
 * Idempotence lives here: a re-delivered batch has every op at or below the known head, so
 * it filters down to nothing and applying it is a no-op. An op *below* the head whose hash
 * disagrees with what we recorded is a different matter — that is a rewritten history, and
 * `verifyChain` refuses it.
 */
export function pendingByDevice(
  ops: readonly SyncOp[],
  known: ReadonlyMap<string, ChainHead>,
): Map<string, SyncOp[]> {
  const byDevice = new Map<string, SyncOp[]>();
  for (const op of ops) {
    const head = known.get(op.deviceId);
    if (head && op.seq <= head.seq) continue;
    const list = byDevice.get(op.deviceId);
    if (list) list.push(op);
    else byDevice.set(op.deviceId, [op]);
  }
  for (const list of byDevice.values()) list.sort((first, second) => first.seq - second.seq);
  return byDevice;
}
