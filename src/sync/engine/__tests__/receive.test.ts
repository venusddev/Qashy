/**
 * What a hostile peer cannot do.
 *
 * Every case here is an attempted write by somebody who should not be able to write, and
 * every one of them asserts the same two things: the batch is refused **whole**, and the
 * refusal is **visible** in the activity log. Both halves matter. A partial apply is how a
 * truncation attack succeeds quietly, and a silent rejection is how sync that stopped working
 * looks identical to sync that is working.
 *
 * The one deliberate exception is quarantine, which is not a rejection at all: those ops are
 * kept and forwarded and only the local *projection* is held back. It is tested here anyway,
 * because "stored but not shown" is the outcome most easily mistaken for a silent drop.
 */

import {
  BASE_CURRENCY,
  EPOCH,
  NOW,
  NOW_ISO,
  activityRows,
  makeVault,
  opRows,
  peerRow,
  quarantineRowsOf,
  strangerKeys,
  type TestDevice,
} from '@/sync/engine/__tests__/helpers';
import { SYNC_META, readMeta, readStates } from '@/data/sync-store';
import { toPeerRow, toRosterMember } from '@/sync/engine/roster';
import { MAX_CLOCK_SKEW_MS, emptyMeta, hashOp, sealOp } from '@/sync/oplog';
import { receiveBatch } from '@/sync/engine/receive';
import { SyncEngineError } from '@/sync/engine/types';
import { SYNC_CONTROL_ENTITY } from '@/sync/revocation';
import type { EntityType } from '@/domain/models';

/** Receives, expecting a refusal, and returns the error so a test can inspect its code. */
async function expectRejected(receiver: TestDevice, batch: Parameters<typeof receiveBatch>[1]) {
  await expect(receiveBatch(receiver.deps, batch)).rejects.toThrow(SyncEngineError);
  return receiver;
}

const rejections = async (device: TestDevice) =>
  (await activityRows(device)).filter((row) => row.kind === 'rejected');

describe('receiveBatch — trust', () => {
  it('rejects a roster member that has neither a pairing control nor an authored op', async () => {
    const [alice, bob, stranger] = await makeVault(3);
    await bob.storage.transact((tx) => tx.table('syncPeers').delete([stranger.deviceId]));

    await expectRejected(
      bob,
      alice.batch([], { roster: [toRosterMember(stranger.asPeer())] }),
    );
    expect(await peerRow(bob, stranger.deviceId)).toBeUndefined();
  });

  it('accepts a signed batch from a rostered peer', async () => {
    const [alice, bob] = await makeVault();
    const ops = alice.author([alice.body('accounts', 'account-1')]);

    const outcome = await receiveBatch(bob.deps, alice.batch(ops));

    expect(outcome).toMatchObject({ peerId: alice.deviceId, stored: 1, applied: 1 });
    expect(bob.repository.flat).toHaveLength(1);
    expect(await opRows(bob)).toHaveLength(1);
    expect(await rejections(bob)).toHaveLength(0);
  });

  it('refuses a batch from a device that was never paired', async () => {
    const [alice, bob, stranger] = await makeVault(3);
    // Bob forgets the stranger entirely — the roster is the whole definition of trust.
    await bob.storage.transact((tx) => tx.table('syncPeers').delete([stranger.deviceId]));

    const ops = stranger.author([stranger.body('accounts', 'account-1')]);
    await expectRejected(bob, stranger.batch(ops));

    expect(await opRows(bob)).toHaveLength(0);
    expect(bob.repository.applied).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([{ code: 'unknownPeer', peerId: stranger.deviceId }]);
    // Bob's own roster is untouched: refusing a stranger is not a reason to forget Alice.
    expect(await peerRow(bob, alice.deviceId)).toBeDefined();
  });

  it('refuses a batch from a revoked device', async () => {
    const [alice, bob] = await makeVault();
    await bob.storage.transact((tx) =>
      tx.table('syncPeers').put([
        toPeerRow(alice.asPeer({ revokedAt: NOW_ISO, revokedSeq: 0 })),
      ]),
    );

    const ops = alice.author([alice.body('accounts', 'account-1')]);
    await expectRejected(bob, alice.batch(ops));

    expect(await opRows(bob)).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([{ code: 'revokedPeer' }]);
  });

  it('keeps accepting a revoked device’s earlier ops when another peer forwards them', async () => {
    const [alice, bob, carol] = await makeVault(3);
    const carolOps = carol.author([carol.body('accounts', 'account-1')]);
    // Carol is thrown away, but what she wrote while she was a member is still history.
    await bob.storage.transact((tx) =>
      tx.table('syncPeers').put([
        toPeerRow(carol.asPeer({ revokedAt: NOW_ISO, revokedSeq: 1 })),
      ]),
    );

    const outcome = await receiveBatch(bob.deps, alice.batch(carolOps));

    expect(outcome.stored).toBe(1);
    expect(await rejections(bob)).toHaveLength(0);
  });

  it('refuses an op authored after the device’s revocation cutoff, even when a live peer forwards it', async () => {
    const [alice, bob, carol] = await makeVault(3);
    await bob.storage.transact((tx) =>
      tx.table('syncPeers').put([
        toPeerRow(carol.asPeer({ revokedAt: NOW_ISO, revokedSeq: 0 })),
      ]),
    );

    const postRevocation = carol.author([carol.body('accounts', 'account-1')]);
    await expectRejected(bob, alice.batch(postRevocation));

    expect(await opRows(bob)).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([
      { code: 'revokedPeer', peerId: carol.deviceId },
    ]);
  });

  it('refuses a revoked device that forges an active peer as the batch sender', async () => {
    const [alice, bob, carol] = await makeVault(3);
    await bob.storage.transact((tx) =>
      tx.table('syncPeers').put([
        toPeerRow(carol.asPeer({ revokedAt: NOW_ISO, revokedSeq: 0 })),
      ]),
    );

    const carolOps = carol.author([carol.body('accounts', 'account-1')]);
    // Carol knows the shared content key and can create an envelope whose AAD says "Alice".
    // The batch signature still identifies Carol, so Bob must reject the impersonation.
    const forgedSender = carol.batch(carolOps, { sender: alice.deviceId });
    await expectRejected(bob, forgedSender);

    expect(await opRows(bob)).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([
      { code: 'badSignature', peerId: alice.deviceId },
    ]);
  });

  it('learns a third device from an authenticated roster before verifying its forwarded op', async () => {
    const [alice, bob, carol] = await makeVault(3);
    await bob.storage.transact((tx) => tx.table('syncPeers').delete([carol.deviceId]));

    const carolOps = carol.author([carol.body('accounts', 'account-1')]);
    const batch = alice.batch(carolOps, { roster: [toRosterMember(carol.asPeer())] });
    const outcome = await receiveBatch(bob.deps, batch);

    expect(outcome.stored).toBe(1);
    expect(await peerRow(bob, carol.deviceId)).toMatchObject({
      peerId: carol.deviceId,
      revokedAt: null,
    });
    expect(await rejections(bob)).toHaveLength(0);
  });

  it('ignores a roster snapshot that tries to remove a device', async () => {
    const [alice, bob, carol] = await makeVault(3);

    await receiveBatch(
      bob.deps,
      alice.batch([], {
        roster: [toRosterMember(carol.asPeer({ revokedAt: NOW_ISO, revokedSeq: 0 }))],
      }),
    );
    expect(await peerRow(bob, carol.deviceId)).toMatchObject({
      revokedAt: null,
    });
  });

  it('applies a signed immediate-removal control instead of trusting the roster', async () => {
    const [alice, bob, carol] = await makeVault(3);
    const control = {
      ...alice.body('accounts', 'control'),
      entityType: SYNC_CONTROL_ENTITY as EntityType,
      entityId: 'revocation',
      kind: 'set' as const,
      payload: { control: 'revoke', targetId: carol.deviceId, cutoff: 0, at: NOW_ISO },
    };
    await receiveBatch(bob.deps, alice.batch(alice.author([control])));
    expect(await peerRow(bob, carol.deviceId)).toMatchObject({
      revokedAt: NOW_ISO,
      revokedSeq: 0,
    });
  });

  it('raises a removal cutoff to the target chain already held by the receiver', async () => {
    const [alice, bob, carol] = await makeVault(3);
    const carolOps = carol.author([
      carol.body('accounts', 'account-1'),
      carol.body('accounts', 'account-2'),
    ]);
    await receiveBatch(bob.deps, alice.batch(carolOps));

    const control = {
      ...alice.body('accounts', 'control'),
      entityType: SYNC_CONTROL_ENTITY as EntityType,
      entityId: 'revocation',
      kind: 'set' as const,
      payload: { control: 'revoke', targetId: carol.deviceId, cutoff: 0, at: NOW_ISO },
    };
    await receiveBatch(bob.deps, alice.batch(alice.author([control])));

    expect(await peerRow(bob, carol.deviceId)).toMatchObject({
      revokedAt: NOW_ISO,
      revokedSeq: 2,
    });
  });

  it('does not let a roster cutoff reject a device’s history', async () => {
    const [alice, bob, carol] = await makeVault(3);
    const acceptedBeforeNotice = carol.author([carol.body('accounts', 'account-1')]);
    await receiveBatch(bob.deps, alice.batch(acceptedBeforeNotice));

    await receiveBatch(
      bob.deps,
      alice.batch([], {
        roster: [toRosterMember(carol.asPeer({ revokedAt: NOW_ISO, revokedSeq: 0 }))],
      }),
    );
    expect(await peerRow(bob, carol.deviceId)).toMatchObject({
      revokedAt: null,
    });

    const authoredAfterNotice = carol.author([carol.body('accounts', 'account-2')]);
    await receiveBatch(bob.deps, alice.batch(authoredAfterNotice));
    expect(await opRows(bob)).toHaveLength(2);
  });

  it('refuses a forwarded op attributed to a device the vault has never heard of', async () => {
    const [alice, bob, ghost] = await makeVault(3);
    await bob.storage.transact((tx) => tx.table('syncPeers').delete([ghost.deviceId]));

    const ops = ghost.author([ghost.body('accounts', 'account-1')]);
    await expectRejected(bob, alice.batch(ops));

    expect(await opRows(bob)).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([{ code: 'unknownAuthor', peerId: alice.deviceId }]);
  });
});

describe('receiveBatch — signatures', () => {
  it('refuses any mutation made after the sender signed the batch', async () => {
    const [alice, bob] = await makeVault();
    const signed = alice.batch(alice.author([alice.body('accounts', 'account-1')]));

    await expectRejected(bob, { ...signed, heads: { [alice.deviceId]: 99 } });

    expect(await opRows(bob)).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([{ code: 'badSignature' }]);
  });

  it('refuses an op signed by a key the roster does not list for that device', async () => {
    const [alice, bob] = await makeVault();
    // The impostor keeps Alice's device id — a mismatched id would be caught by the roster
    // lookup, which would prove nothing about the signature check.
    await bob.storage.transact((tx) =>
      tx.table('syncPeers').put([toPeerRow(alice.asPeer(strangerKeys()))]),
    );

    const ops = alice.author([alice.body('accounts', 'account-1')]);
    await expectRejected(bob, alice.batch(ops));

    expect(await opRows(bob)).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([{ code: 'badSignature' }]);
  });

  it('refuses an op whose payload was edited after it was signed', async () => {
    const [alice, bob] = await makeVault();
    const [op] = alice.author([alice.body('transactions', 'txn-1')]);

    // A tampered payload *and* a recomputed hash, so the only thing left disagreeing is the
    // signature. Leaving the hash stale would let `verifyChain` catch it and prove less.
    const body = { ...op, payload: { name: 'edited' } };
    const forged = { ...body, opHash: hashOp(op.prevHash, body) };

    await expectRejected(bob, alice.batch([forged]));
    expect(await rejections(bob)).toMatchObject([{ code: 'badSignature' }]);
  });

  it('refuses an unsigned op', async () => {
    const [alice, bob] = await makeVault();
    const [op] = alice.author([alice.body('accounts', 'account-1')]);

    await expectRejected(bob, alice.batch([{ ...op, signature: '' }]));
    expect(await rejections(bob)).toMatchObject([{ code: 'unsignedOp' }]);
  });
});

describe('receiveBatch — history', () => {
  it('ignores a replayed batch without duplicating anything', async () => {
    const [alice, bob] = await makeVault();
    const ops = alice.author([alice.body('accounts', 'account-1'), alice.body('tags', 'tag-1')]);

    const first = await receiveBatch(bob.deps, alice.batch(ops));
    const second = await receiveBatch(bob.deps, alice.batch(ops));

    expect(first.stored).toBe(2);
    expect(second.stored).toBe(0);
    expect(second.applied).toBe(0);
    expect(await opRows(bob)).toHaveLength(2);
    // The second pass hands the repository nothing at all rather than a no-op batch.
    expect(bob.repository.applied).toHaveLength(1);
    expect(await rejections(bob)).toHaveLength(0);
  });

  it('refuses an op that rewrites a position it already accepted', async () => {
    const [alice, bob] = await makeVault();
    const original = alice.author([alice.body('accounts', 'account-1')]);
    await receiveBatch(bob.deps, alice.batch(original));

    // Same chain position, different contents: Alice's log was rewritten behind us.
    const rewritten = { ...original[0], payload: { name: 'rewritten' } };
    const forged = { ...rewritten, opHash: hashOp(rewritten.prevHash, rewritten) };

    await expectRejected(bob, alice.batch([forged]));

    // What we already accepted is exactly what we still hold.
    expect(await opRows(bob)).toMatchObject([{ opHash: original[0].opHash }]);
    expect(await rejections(bob)).toMatchObject([{ code: 'chainFork' }]);
  });

  it('refuses a batch with a gap in the middle of a chain', async () => {
    const [alice, bob] = await makeVault();
    const ops = alice.author([
      alice.body('accounts', 'account-1'),
      alice.body('accounts', 'account-2'),
      alice.body('accounts', 'account-3'),
    ]);

    await expectRejected(bob, alice.batch([ops[0], ops[2]]));

    // Fail whole, not up to the break: op 1 verified fine and is still not stored.
    expect(await opRows(bob)).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([{ code: 'chainBreak' }]);
  });

  it('refuses a chain that does not continue the history we hold', async () => {
    const [alice, bob] = await makeVault();
    const [first, second] = alice.author([
      alice.body('accounts', 'account-1'),
      alice.body('accounts', 'account-2'),
    ]);
    await receiveBatch(bob.deps, alice.batch([first]));

    // Genuinely re-signed by Alice, on purpose. A *third party* rewriting `prevHash` is caught
    // one step earlier by the signature check, which proves nothing about the chain check —
    // so the only way to reach it is to model the case where the authoring device itself
    // rewrote its own history, which is exactly what a fork is.
    const detached = { ...second, prevHash: 'f'.repeat(64) };
    const forged = sealOp(
      { ...detached, opHash: hashOp(detached.prevHash, detached) },
      alice.identity.signing.secretKey,
    );
    await expectRejected(bob, alice.batch([forged]));

    expect(await opRows(bob)).toHaveLength(1);
    expect(await rejections(bob)).toMatchObject([{ code: 'chainBreak' }]);
  });

  it('accepts an overlapping range, keeping only what is new', async () => {
    const [alice, bob] = await makeVault();
    const ops = alice.author([
      alice.body('accounts', 'account-1'),
      alice.body('accounts', 'account-2'),
      alice.body('accounts', 'account-3'),
    ]);
    await receiveBatch(bob.deps, alice.batch(ops.slice(0, 2)));

    // A relay handing back a window that straddles what we have is ordinary, not an attack.
    const outcome = await receiveBatch(bob.deps, alice.batch(ops.slice(1)));

    expect(outcome.stored).toBe(1);
    expect(await opRows(bob)).toHaveLength(3);
    expect(await rejections(bob)).toHaveLength(0);
  });
});

describe('receiveBatch — unmergeable preconditions', () => {
  it('refuses a batch sealed under a different vault epoch', async () => {
    const [alice, bob] = await makeVault();
    const ops = alice.author([alice.body('accounts', 'account-1')]);

    await expectRejected(bob, alice.batch(ops, { epoch: EPOCH + 1 }));

    expect(await opRows(bob)).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([{ code: 'epochMismatch' }]);
  });

  it('refuses two vaults onboarded with different base currencies, writing nothing either side', async () => {
    const [alice, bob] = await makeVault();
    // Alice's vault is in ILS, Bob's in USD. Every `baseAmountMinor` on either side was
    // computed against a different unit, and no rate matrix exists to re-base them.
    await alice.storage.transact((tx) =>
      tx.table('syncMeta').put([{ key: SYNC_META.baseCurrency, value: 'ILS' }]),
    );
    const aliceOps = alice.author([alice.body('accounts', 'account-1')]);
    const bobOps = bob.author([bob.body('accounts', 'account-2')]);

    await expectRejected(bob, alice.batch(aliceOps, { baseCurrency: 'ILS' }));
    await expectRejected(alice, bob.batch(bobOps, { baseCurrency: BASE_CURRENCY }));

    // Symmetric, and nothing lands on either device — pairing is blocked, not half-done.
    expect(await opRows(bob)).toHaveLength(0);
    expect(await opRows(alice)).toHaveLength(0);
    expect(await rejections(bob)).toMatchObject([{ code: 'currencyMismatch' }]);
    expect(await rejections(alice)).toMatchObject([{ code: 'currencyMismatch' }]);
  });

  it('lets a device with no base currency yet adopt the first batch it receives', async () => {
    const [alice, bob] = await makeVault();
    // A device restored from a recovery phrase has no settings yet. Refusing here would make
    // restore impossible, which is a worse failure than the one the check exists to prevent.
    await bob.storage.transact((tx) =>
      tx.table('syncMeta').put([{ key: SYNC_META.baseCurrency, value: '' }]),
    );

    const outcome = await receiveBatch(bob.deps, alice.batch(alice.author([alice.body('accounts', 'a')])));
    expect(outcome.stored).toBe(1);
  });
});

describe('receiveBatch — forward compatibility', () => {
  it('applies a state snapshot when the sender can no longer provide the delta prefix', async () => {
    const [alice, bob] = await makeVault();
    const [op] = alice.author([alice.body('accounts', 'account-1')]);
    const state = emptyMeta('accounts', 'account-1', op.hlc);

    const outcome = await receiveBatch(
      bob.deps,
      alice.batch([], { fullState: [state], heads: { [alice.deviceId]: 9 } }),
    );

    expect(outcome).toMatchObject({ stored: 0, applied: 1 });
    await expect(
      bob.storage.transact((tx) => readStates(tx, ['accounts:account-1'])),
    ).resolves.toHaveProperty('size', 1);
  });

  it('rejects a create whose payload identity disagrees with its authenticated entity key', async () => {
    const [alice, bob] = await makeVault();
    const ops = alice.author([{
      ...alice.body('accounts', 'claimed-id'),
      payload: { entity: { id: 'stored-under-a-different-id' } },
    }]);

    await expect(receiveBatch(bob.deps, alice.batch(ops))).rejects.toMatchObject({ code: 'badBatch' });
    expect(await opRows(bob)).toHaveLength(0);
  });

  it('stores and forwards an op naming an entity type this build has never heard of', async () => {
    const [alice, bob] = await makeVault();
    const body = { ...alice.body('accounts', 'account-1'), entityType: 'holdings' as never };
    const ops = alice.author([body]);

    const outcome = await receiveBatch(bob.deps, alice.batch(ops));

    // Kept, because it is part of a hash chain other peers depend on. Dropping it would
    // truncate history for everyone downstream, permanently.
    expect(outcome.stored).toBe(1);
    expect(await opRows(bob)).toHaveLength(1);
    // Still handed to the repository — deciding what it can interpret is the merge's job,
    // not the receive path's.
    expect(bob.repository.flat).toHaveLength(1);
    expect(await rejections(bob)).toHaveLength(0);
  });

  it('stores and forwards an op carrying a newer schema version', async () => {
    const [alice, bob] = await makeVault();
    const ops = alice.author([{ ...alice.body('accounts', 'account-1'), schema: 99 }]);

    expect((await receiveBatch(bob.deps, alice.batch(ops))).stored).toBe(1);
    expect(await opRows(bob)).toMatchObject([{ schema: 99 }]);
  });

  it('rejects a signed set that omits members of a known field group before storing it', async () => {
    const [alice, bob] = await makeVault();
    const partial = alice.author([{
      ...alice.body('transactions', 'txn-1'),
      kind: 'set',
      payload: { registers: { ledger: { amountMinor: 999_999 } } },
    }]);

    await expect(receiveBatch(bob.deps, alice.batch(partial))).rejects.toMatchObject({ code: 'badBatch' });
    expect(await opRows(bob)).toHaveLength(0);
  });
});

describe('receiveBatch — quarantine', () => {
  it('holds an entity back when the merge would break a money invariant, and still keeps the ops', async () => {
    const [alice, bob] = await makeVault();
    bob.repository.fail = new Error('Amount is outside the supported range.');

    const ops = alice.author([alice.body('transactions', 'txn-1')]);
    const outcome = await receiveBatch(bob.deps, alice.batch(ops));

    // Not a rejection: the ops are on disk and on their way to other peers.
    expect(outcome.stored).toBe(1);
    expect(outcome.applied).toBe(0);
    expect(outcome.quarantined).toBe(1);
    expect(await opRows(bob)).toHaveLength(1);
    expect(await quarantineRowsOf(bob)).toMatchObject([
      { key: 'transactions:txn-1', reason: 'overflow' },
    ]);
    expect(await activityRows(bob)).toMatchObject([{ kind: 'quarantined', code: 'invariant' }]);
  });

  it('clears a quarantine once a later op makes the entity projectable', async () => {
    const [alice, bob] = await makeVault();
    bob.repository.fail = new Error('Amount is outside the supported range.');
    await receiveBatch(bob.deps, alice.batch(alice.author([alice.body('transactions', 'txn-1')])));

    const corrective = alice.author([alice.body('transactions', 'txn-1')]);
    const outcome = await receiveBatch(bob.deps, alice.batch(corrective));

    expect(outcome.recovered).toBe(1);
    expect(await quarantineRowsOf(bob)).toHaveLength(0);
    expect((await activityRows(bob)).map((row) => row.kind)).toEqual([
      'quarantined',
      'received',
      'recovered',
    ]);
  });

  it('defers an op whose clock is far ahead, without dragging the local clock forward', async () => {
    const [alice, bob] = await makeVault();
    const ahead = MAX_CLOCK_SKEW_MS + 60_000;
    const ops = alice.author([
      alice.body('accounts', 'account-1'),
      alice.body('accounts', 'account-2', ahead),
    ]);

    const outcome = await receiveBatch(bob.deps, alice.batch(ops));

    // Stored and forwarded; only the projection waits.
    expect(outcome.stored).toBe(2);
    expect(outcome.quarantined).toBe(1);
    expect(bob.repository.flat).toHaveLength(1);
    expect(await quarantineRowsOf(bob)).toMatchObject([
      { key: 'accounts:account-2', reason: 'clockSkew' },
    ]);

    // The local clock did not jump. A single mis-set phone must not push the whole vault's
    // ordering into the future, where every real edit made afterwards would lose to it.
    // (Catching up and merging the deferred op is `SyncSession.reconcile`'s job — the
    // re-offer runs off `findUnprojected`, not off the next batch. See `session.test.ts`.)
    const meta = await bob.storage.transact((tx) => readMeta(tx, [SYNC_META.hlcWall]));
    expect(Number(meta.get(SYNC_META.hlcWall))).toBe(NOW);
  });
});

describe('receiveBatch — bookkeeping', () => {
  it('records what the peer holds and what we hold, monotonically', async () => {
    const [alice, bob, carol] = await makeVault(3);
    const ops = alice.author([alice.body('accounts', 'account-1')]);

    await receiveBatch(bob.deps, alice.batch(ops, { heads: { [alice.deviceId]: 1, [carol.deviceId]: 7 } }));
    // A blob that sat in a relay bucket for a week arrives claiming less than we recorded.
    await receiveBatch(bob.deps, alice.batch([], { heads: { [carol.deviceId]: 2 } }));

    const row = await peerRow(bob, alice.deviceId);
    expect(JSON.parse(row!.acked)).toEqual({ [alice.deviceId]: 1, [carol.deviceId]: 7 });
    expect(JSON.parse(row!.known)).toEqual({ [alice.deviceId]: 1 });
    expect(row!.lastSeenAt).toBe(NOW_ISO);
  });

  it('accepts an empty batch as a bare acknowledgement', async () => {
    const [alice, bob] = await makeVault();

    const outcome = await receiveBatch(bob.deps, alice.batch([]));

    expect(outcome).toMatchObject({ stored: 0, applied: 0, quarantined: 0 });
    expect(bob.repository.applied).toHaveLength(0);
    expect(await activityRows(bob)).toHaveLength(0);
    expect((await peerRow(bob, alice.deviceId))!.lastSeenAt).toBe(NOW_ISO);
  });
});
