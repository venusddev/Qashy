import { createDeviceIdentity } from '@/sync/crypto';
import type { Peer } from '@/sync/engine/roster';
import { formatHlc, type SyncOp } from '@/sync/oplog';
import {
  SYNC_CONTROL_ENTITY,
  RevocationError,
  deriveRevocationState,
} from '@/sync/revocation';

const AT = '2026-07-01T12:00:00.000Z';

const peer = (identity: ReturnType<typeof createDeviceIdentity>): Peer => ({
  deviceId: identity.deviceId,
  name: identity.deviceId,
  platform: 'test',
  signingKey: identity.signing.publicKey,
  agreementKey: identity.agreement.publicKey,
  epoch: 1,
  addedAt: '2026-07-01T00:00:00.000Z',
  revokedAt: null,
  revokedSeq: null,
  acked: {},
  known: {},
  lastSeenAt: null,
});

const control = (
  author: ReturnType<typeof createDeviceIdentity>,
  seq: number,
  payload: Record<string, unknown>,
): SyncOp => ({
  opId: `${author.deviceId}:${seq}`,
  deviceId: author.deviceId,
  seq,
  prevHash: '',
  opHash: String(seq),
  signature: 'signed',
  hlc: formatHlc({ wall: Date.parse(AT) + seq, counter: 0, deviceId: author.deviceId }),
  entityType: SYNC_CONTROL_ENTITY as SyncOp['entityType'],
  entityId: 'revocation',
  kind: 'set',
  payload,
  schema: 1,
});

describe('signed revocation controls', () => {
  it('requires a 50%-or-more quorum and keeps each approval attributable', () => {
    const owner = createDeviceIdentity();
    const approver = createDeviceIdentity();
    const target = createDeviceIdentity();
    const roster = new Map([[approver.deviceId, peer(approver)], [target.deviceId, peer(target)]]);
    const proposal = control(owner, 1, {
      control: 'propose', proposalId: 'remove-target', targetId: target.deviceId,
      voters: [owner.deviceId, approver.deviceId, target.deviceId].sort(), required: 2, cutoff: 7, at: AT,
    });

    expect(deriveRevocationState([proposal], roster, { mode: 'quorum', ownerDeviceId: owner.deviceId }, owner.deviceId).revocations).toEqual([]);

    const approval = control(approver, 1, { control: 'approve', proposalId: 'remove-target', targetId: target.deviceId });
    expect(deriveRevocationState([proposal, approval], roster, { mode: 'quorum', ownerDeviceId: owner.deviceId }, owner.deviceId).revocations)
      .toEqual([{ targetId: target.deviceId, cutoff: 7, at: AT }]);
  });

  it('rejects a non-owner attempting an owner-only removal', () => {
    const owner = createDeviceIdentity();
    const attacker = createDeviceIdentity();
    const target = createDeviceIdentity();
    const roster = new Map([[attacker.deviceId, peer(attacker)], [target.deviceId, peer(target)]]);
    const forged = control(attacker, 1, { control: 'revoke', targetId: target.deviceId, cutoff: 0, at: AT });

    expect(() => deriveRevocationState([forged], roster, { mode: 'owner', ownerDeviceId: owner.deviceId }, owner.deviceId))
      .toThrow(RevocationError);
  });
});
