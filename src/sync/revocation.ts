/**
 * Signed membership-control events.
 *
 * Roster snapshots distribute public keys, but they are not authority to remove a device.
 * Removal decisions travel as ordinary signed, hash-chained ops so an intermediary cannot
 * invent another device's vote or lose an approval while forwarding it.
 */

import type { Peer, Roster } from '@/sync/engine/roster';
import type { SyncOp } from '@/sync/oplog';

export const SYNC_CONTROL_ENTITY = '__sync_control__';

export type RevocationMode = 'any' | 'quorum' | 'owner';

export interface RevocationPolicy {
  readonly mode: RevocationMode;
  readonly ownerDeviceId: string;
}

export interface RevocationProposal {
  readonly id: string;
  readonly targetId: string;
  readonly proposerId: string;
  readonly voters: readonly string[];
  readonly required: number;
  readonly cutoff: number;
  readonly at: string;
  readonly approvals: readonly string[];
}

export interface AppliedRevocation {
  readonly targetId: string;
  readonly cutoff: number;
  readonly at: string;
}

type Control =
  | { readonly type: 'policy'; readonly mode: RevocationMode }
  | { readonly type: 'owner'; readonly ownerDeviceId: string }
  | { readonly type: 'revoke'; readonly targetId: string; readonly cutoff: number; readonly at: string }
  | {
      readonly type: 'propose';
      readonly id: string;
      readonly targetId: string;
      readonly voters: readonly string[];
      readonly required: number;
      readonly cutoff: number;
      readonly at: string;
    }
  | { readonly type: 'approve'; readonly id: string; readonly targetId: string };

export class RevocationError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value || value.length > 128) {
    throw new RevocationError(`A membership control has an invalid ${label}.`);
  }
  return value;
};

const cutoff = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RevocationError('A membership control has an invalid revocation cutoff.');
  }
  return value;
};

const at = (value: unknown): string => {
  const result = text(value, 'time');
  if (new Date(result).toISOString() !== result) {
    throw new RevocationError('A membership control has an invalid time.');
  }
  return result;
};

const mode = (value: unknown): RevocationMode => {
  if (value === 'any' || value === 'quorum' || value === 'owner') return value;
  throw new RevocationError('A membership control has an invalid policy.');
};

export const isControlOp = (op: Pick<SyncOp, 'entityType'>) => String(op.entityType) === SYNC_CONTROL_ENTITY;

const readControl = (op: SyncOp): Control => {
  if (op.kind !== 'set' || op.entityId !== 'revocation') {
    throw new RevocationError('A membership control has an invalid operation shape.');
  }
  const payload = op.payload;
  if (!isRecord(payload)) throw new RevocationError('A membership control has no payload.');
  switch (payload.control) {
    case 'policy':
      return { type: 'policy', mode: mode(payload.mode) };
    case 'owner':
      return { type: 'owner', ownerDeviceId: text(payload.ownerDeviceId, 'owner') };
    case 'revoke':
      return { type: 'revoke', targetId: text(payload.targetId, 'target'), cutoff: cutoff(payload.cutoff), at: at(payload.at) };
    case 'propose': {
      if (!Array.isArray(payload.voters) || payload.voters.length > 32) {
        throw new RevocationError('A membership proposal has an invalid voter list.');
      }
      const voters = payload.voters.map((value) => text(value, 'voter'));
      if (new Set(voters).size !== voters.length) throw new RevocationError('A membership proposal repeats a voter.');
      const required = cutoff(payload.required);
      if (required < 1 || required !== Math.ceil(voters.length / 2)) {
        throw new RevocationError('A membership proposal has an invalid quorum.');
      }
      return {
        type: 'propose', id: text(payload.proposalId, 'proposal id'), targetId: text(payload.targetId, 'target'),
        voters, required, cutoff: cutoff(payload.cutoff), at: at(payload.at),
      };
    }
    case 'approve':
      return { type: 'approve', id: text(payload.proposalId, 'proposal id'), targetId: text(payload.targetId, 'target') };
    default:
      throw new RevocationError('A membership control has an unknown action.');
  }
};

const activeIdsAt = (roster: Roster, localDeviceId: string, when: string): string[] => {
  const live = [localDeviceId];
  for (const peer of roster.values()) {
    if (peer.addedAt <= when && (!peer.revokedAt || peer.revokedAt > when)) live.push(peer.deviceId);
  }
  return live.sort();
};

const activeNow = (roster: Roster, localDeviceId: string): Set<string> =>
  new Set([localDeviceId, ...[...roster.values()].filter((peer) => !peer.revokedAt).map((peer) => peer.deviceId)]);

const ordered = (ops: readonly SyncOp[]) => [...ops].sort((a, b) =>
  a.hlc.localeCompare(b.hlc) || a.deviceId.localeCompare(b.deviceId) || a.seq - b.seq,
);

export interface RevocationState extends RevocationPolicy {
  readonly proposals: readonly RevocationProposal[];
  readonly revocations: readonly AppliedRevocation[];
}

/** Validates and folds all signed controls held by this device. */
export function deriveRevocationState(
  ops: readonly SyncOp[],
  roster: Roster,
  initial: RevocationPolicy,
  localDeviceId: string,
): RevocationState {
  let policy: RevocationPolicy = initial;
  const proposals = new Map<string, RevocationProposal>();
  const revocations = new Map<string, AppliedRevocation>();
  const removed = new Set<string>();
  const waitingApprovals = new Map<string, { readonly author: string; readonly targetId: string }[]>();

  const applyApproval = (id: string, targetId: string, author: string) => {
    const proposal = proposals.get(id);
    if (!proposal) {
      const waiting = waitingApprovals.get(id) ?? [];
      waiting.push({ author, targetId });
      waitingApprovals.set(id, waiting);
      return;
    }
    if (proposal.targetId !== targetId || author === proposal.targetId || !proposal.voters.includes(author)) {
      throw new RevocationError('A membership approval does not match a valid proposal.');
    }
    if (!proposal.approvals.includes(author)) {
      const next = { ...proposal, approvals: [...proposal.approvals, author].sort() };
      proposals.set(id, next);
      if (next.approvals.length >= next.required) {
        revocations.set(next.targetId, { targetId: next.targetId, cutoff: next.cutoff, at: next.at });
        removed.add(next.targetId);
      }
    }
  };

  for (const op of ordered(ops.filter(isControlOp))) {
    const control = readControl(op);
    const live = activeNow(roster, localDeviceId);
    for (const id of removed) live.delete(id);
    if (!live.has(op.deviceId)) throw new RevocationError('A removed device tried to change vault membership.');
    if (control.type === 'policy') {
      if (op.deviceId !== policy.ownerDeviceId) throw new RevocationError('Only the vault owner can change removal policy.');
      policy = { ...policy, mode: control.mode };
      continue;
    }
    if (control.type === 'owner') {
      if (op.deviceId !== policy.ownerDeviceId || !live.has(control.ownerDeviceId)) {
        throw new RevocationError('Only the current owner can transfer ownership to an active device.');
      }
      policy = { ...policy, ownerDeviceId: control.ownerDeviceId };
      continue;
    }
    if (control.type === 'revoke') {
      if (op.deviceId === control.targetId || (policy.mode === 'owner' && op.deviceId !== policy.ownerDeviceId)) {
        throw new RevocationError('This device is not allowed to remove that device.');
      }
      if (policy.mode === 'quorum') throw new RevocationError('This vault requires a quorum proposal.');
      revocations.set(control.targetId, { targetId: control.targetId, cutoff: control.cutoff, at: control.at });
      removed.add(control.targetId);
      continue;
    }
    if (policy.mode !== 'quorum') throw new RevocationError('This vault does not accept quorum controls.');
    if (control.type === 'propose') {
      const expected = activeIdsAt(roster, localDeviceId, control.at);
      if (op.deviceId === control.targetId || !live.has(control.targetId) || expected.join('|') !== [...control.voters].sort().join('|')) {
        throw new RevocationError('A membership proposal does not describe the active vault.');
      }
      if (proposals.has(control.id)) throw new RevocationError('A membership proposal id was reused.');
      proposals.set(control.id, { ...control, proposerId: op.deviceId, approvals: [op.deviceId] });
      for (const approval of waitingApprovals.get(control.id) ?? []) {
        applyApproval(control.id, approval.targetId, approval.author);
      }
      waitingApprovals.delete(control.id);
      continue;
    }
    applyApproval(control.id, control.targetId, op.deviceId);
  }

  for (const proposal of proposals.values()) {
    if (proposal.approvals.length >= proposal.required) {
      revocations.set(proposal.targetId, { targetId: proposal.targetId, cutoff: proposal.cutoff, at: proposal.at });
      removed.add(proposal.targetId);
    }
  }
  return { ...policy, proposals: [...proposals.values()], revocations: [...revocations.values()] };
}

export const memberIds = (roster: Roster, localDeviceId: string) => activeIdsAt(roster, localDeviceId, '9999-12-31T23:59:59.999Z');

export const peerFor = (roster: Roster, id: string): Peer | undefined => roster.get(id);
