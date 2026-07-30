/**
 * The device roster: the complete answer to "whose ops does this vault accept?"
 *
 * Everything about replication reduces to this list. A signature is meaningless without a
 * key to check it against, and revocation is meaningless unless the check is consulted on
 * every batch rather than once at pairing. So the roster is read fresh inside the transaction
 * that applies a batch, never cached in a field — the same reasoning that made the causal
 * state authoritative in `sync_state` rather than in memory.
 *
 * **A revoked peer's row is never deleted.** Deleting it would make that device unknown
 * rather than untrusted, and the two behave differently in the one case that matters: ops it
 * authored *before* revocation are still valid history that other peers hold and will keep
 * forwarding. An unknown author rejects the whole batch; a revoked one is simply not allowed
 * to author anything new. Losing that distinction would make revoking a device also destroy
 * every record it ever created.
 *
 * Keys cross this boundary as base64url strings because SQLite and IndexedDB disagree about
 * how a `Uint8Array` round-trips, and a string is the one representation both store and
 * compare identically. `restorePeerKeys` re-brands and length-checks them on the way back,
 * so a truncated row fails here rather than inside a curve implementation.
 */

import type { StorageTx } from '@/data/storage-adapter';
import type { SyncPeerRow } from '@/data/sync-tables';
import {
  fromBase64Url,
  restorePeerKeys,
  toBase64Url,
  type AgreementPublicKey,
  type SigningPublicKey,
} from '@/sync/crypto';
import type { PeerAcks } from '@/sync/oplog';
import { SyncEngineError } from '@/sync/engine/types';

/** A roster entry, with its keys usable rather than encoded. */
export interface Peer {
  readonly deviceId: string;
  /** Chosen by the user at pairing. Display only — nothing keys off it. */
  readonly name: string;
  readonly platform: string;
  readonly signingKey: SigningPublicKey;
  readonly agreementKey: AgreementPublicKey;
  /** The vault epoch this device was paired under. */
  readonly epoch: number;
  readonly addedAt: string;
  readonly revokedAt: string | null;
  /** `{ [deviceId]: seq }` this peer has confirmed receiving — the compaction watermark. */
  readonly acked: Readonly<Record<string, number>>;
  /** `{ [deviceId]: seq }` we hold of each chain, as of the last exchange with this peer. */
  readonly known: Readonly<Record<string, number>>;
  readonly lastSeenAt: string | null;
}

/**
 * Parses a `{ [deviceId]: seq }` column.
 *
 * Tolerant on the way in, because this is *our own* stored JSON rather than a peer's: a row
 * written by a build that recorded a field differently should degrade to "we know nothing
 * about that chain", which costs one redundant exchange, instead of making the roster
 * unreadable and sync unstartable.
 */
const parseSeqMap = (value: string): Record<string, number> => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [deviceId, seq] of Object.entries(parsed as Record<string, unknown>)) {
      if (deviceId && typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) {
        out[deviceId] = seq;
      }
    }
    return out;
  } catch {
    return {};
  }
};

export const fromPeerRow = (row: SyncPeerRow): Peer => {
  const keys = restorePeerKeys(fromBase64Url(row.signingKey), fromBase64Url(row.agreementKey));
  return {
    deviceId: row.peerId,
    name: row.name,
    platform: row.platform,
    signingKey: keys.signingKey,
    agreementKey: keys.agreementKey,
    epoch: row.epoch,
    addedAt: row.addedAt,
    revokedAt: row.revokedAt,
    acked: parseSeqMap(row.acked),
    known: parseSeqMap(row.known),
    lastSeenAt: row.lastSeenAt,
  };
};

export const toPeerRow = (peer: Peer): SyncPeerRow => ({
  peerId: peer.deviceId,
  name: peer.name,
  platform: peer.platform,
  signingKey: toBase64Url(peer.signingKey),
  agreementKey: toBase64Url(peer.agreementKey),
  epoch: peer.epoch,
  addedAt: peer.addedAt,
  revokedAt: peer.revokedAt,
  acked: JSON.stringify(peer.acked),
  known: JSON.stringify(peer.known),
  lastSeenAt: peer.lastSeenAt,
});

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

export type Roster = ReadonlyMap<string, Peer>;

export async function readRoster(tx: StorageTx): Promise<Roster> {
  const rows = await tx.table('syncPeers').all();
  return new Map(rows.map((row) => [row.peerId, fromPeerRow(row)]));
}

export const writePeers = (tx: StorageTx, peers: readonly Peer[]) =>
  peers.length ? tx.table('syncPeers').put(peers.map(toPeerRow)) : Promise.resolve();

export const isRevoked = (peer: Peer) => peer.revokedAt !== null;

export const activePeers = (roster: Roster) => [...roster.values()].filter((peer) => !isRevoked(peer));

// ---------------------------------------------------------------------------
// Trust decisions
// ---------------------------------------------------------------------------

/**
 * The peer that sent a batch, or a rejection.
 *
 * Two distinct refusals, because the fix is different for each. An unknown sender means
 * pairing never happened or was undone; a revoked one means the user threw that device away
 * and it is still trying, which is either a device that has not noticed yet or exactly the
 * situation revocation exists for. The UI should not describe those the same way.
 */
export function requireSender(roster: Roster, deviceId: string): Peer {
  const peer = roster.get(deviceId);
  if (!peer) {
    throw new SyncEngineError(
      'A device that is not paired with this vault tried to sync.',
      'unknownPeer',
      deviceId,
    );
  }
  if (isRevoked(peer)) {
    throw new SyncEngineError(
      `${peer.name} was removed from this vault and can no longer sync.`,
      'revokedPeer',
      deviceId,
    );
  }
  return peer;
}

/**
 * The device that authored an op, or a rejection.
 *
 * Separate from `requireSender` because forwarding means the two are routinely different: a
 * laptop catches up on the phone's history through the tablet. The tablet must be trusted to
 * *send*, and the phone must be known in order to *verify* — but the phone is allowed to be
 * revoked, because ops it authored while it was still a member remain valid history.
 *
 * `revokedAt` is a wall-clock string and is deliberately *not* compared against the op's
 * clock reading. Two devices in different timezones with drifting clocks would disagree
 * about which side of that boundary an op fell on, and disagreeing about which ops are valid
 * is a permanent fork. Membership is the check; timing is not.
 */
export function requireAuthor(roster: Roster, deviceId: string, sender: string): Peer {
  const peer = roster.get(deviceId);
  if (!peer) {
    throw new SyncEngineError(
      'That batch carries changes from a device this vault has never been paired with.',
      'unknownAuthor',
      sender,
    );
  }
  return peer;
}

/**
 * The roster in the shape compaction wants.
 *
 * Compaction asks "has every live peer acked this op yet", so it needs the revoked flag and
 * the ack map and nothing else. Deriving the projection here rather than passing whole
 * `Peer` objects keeps `compaction.ts` a pure function of two plain records, which is what
 * lets its retention window be tested without inventing key material.
 */
export const peerAcks = (roster: Roster): PeerAcks[] =>
  [...roster.values()].map((peer) => ({
    deviceId: peer.deviceId,
    acked: peer.acked,
    revoked: isRevoked(peer),
  }));

/**
 * Folds what a peer just told us it holds into what we had recorded.
 *
 * Monotone per chain, never a replacement. A batch that arrives out of order — which a relay
 * bucket makes ordinary rather than exceptional — would otherwise rewind the watermark and
 * un-ack ops that were already safely dropped, and compaction would then refuse to drop
 * anything ever again while waiting for an ack it had already received.
 */
export function mergeHeads(
  current: Readonly<Record<string, number>>,
  incoming: Readonly<Record<string, number>>,
): Record<string, number> {
  const merged: Record<string, number> = { ...current };
  for (const [deviceId, seq] of Object.entries(incoming)) {
    merged[deviceId] = Math.max(merged[deviceId] ?? -1, seq);
  }
  return merged;
}
