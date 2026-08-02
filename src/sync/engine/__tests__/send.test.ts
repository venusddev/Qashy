/**
 * The outbound half: signing what the write path left unsigned, and deciding what to say.
 *
 * These two belong in one file because they are one rule seen from two sides. The write path
 * records ops unsigned — it has to, because signing inside a storage transaction would leave
 * Dexie's promise zone — so the sealer runs afterwards, and the batch builder must never send
 * anything it has not caught up with. The consequence is a property worth stating outright:
 * **every batch is a contiguous prefix of every chain it touches.** Skipping over an unsealed
 * op to reach a sealed sibling would hand the peer a hole, and a hole is not "the rest is
 * coming" — it arrives as a chain break and stops that peer syncing until someone intervenes.
 */

import { SYNC_META, storeOps, writeMeta } from '@/data/sync-store';
import type { SyncOp } from '@/sync/oplog';
import { buildBatch } from '@/sync/engine/send';
import { hasUnsealed, sealPending } from '@/sync/engine/sealer';
import {
  BASE_CURRENCY,
  EPOCH,
  makeVault,
  opRows,
  type TestDevice,
} from '@/sync/engine/__tests__/helpers';

const outbox = (sender: TestDevice, peer: TestDevice, acked: Record<string, number> = {}, limit = 100) =>
  buildBatch(
    {
      storage: sender.storage,
      deviceId: sender.deviceId,
      signingKey: sender.identity.signing.secretKey,
      limit,
    },
    { ...peer.asPeer(), acked },
  );

/** Puts another device's ops in this one's log, the way a received batch would. */
const hold = (device: TestDevice, ops: readonly SyncOp[]) =>
  device.storage.transact((tx) => storeOps(tx, ops, 1), { silent: true });

const sealer = (device: TestDevice, limit?: number) =>
  sealPending({
    storage: device.storage,
    deviceId: device.deviceId,
    signingKey: device.identity.signing.secretKey,
    limit,
  });

describe('sealPending', () => {
  it('signs this device’s own unsealed ops, oldest first', async () => {
    const [alice] = await makeVault();
    await alice.stage([alice.body('accounts', 'a1'), alice.body('accounts', 'a2')]);

    expect(await hasUnsealed(alice.storage, alice.deviceId)).toBe(true);
    expect(await sealer(alice)).toBe(2);

    const rows = await opRows(alice);
    expect(rows.map((row) => row.sealed)).toEqual([1, 1]);
    expect(rows.every((row) => row.signature.length > 0)).toBe(true);
    expect(await hasUnsealed(alice.storage, alice.deviceId)).toBe(false);
  });

  it('leaves a partially sealed log as a prefix rather than a log with holes', async () => {
    const [alice] = await makeVault();
    await alice.stage([
      alice.body('accounts', 'a1'),
      alice.body('accounts', 'a2'),
      alice.body('accounts', 'a3'),
    ]);

    expect(await sealer(alice, 2)).toBe(2);

    // Sealed 1 and 2, not 1 and 3. A partially sealed log has to stay sendable, and it is
    // only sendable while everything up to some point is signed and nothing after it is.
    const sealed = (await opRows(alice)).filter((row) => row.sealed === 1).map((row) => row.seq);
    expect(sealed).toEqual([1, 2]);
  });

  it('is idempotent, so two browser tabs on one device identity do not conflict', async () => {
    const [alice] = await makeVault();
    await alice.stage([alice.body('accounts', 'a1')]);

    await sealer(alice);
    const first = (await opRows(alice))[0].signature;
    // Nothing left to do, and Ed25519 is deterministic — a second tab signing the same op
    // produces the same bytes, so the race is a no-op rather than a conflict.
    expect(await sealer(alice)).toBe(0);
    expect((await opRows(alice))[0].signature).toBe(first);
  });

  it('never signs another device’s ops', async () => {
    const [alice, bob] = await makeVault();
    // A forwarded op arrives already sealed; an *unsealed* foreign op could only come from a
    // bug, and signing it here would be this device forging that device's history.
    await hold(bob, await alice.stage([alice.body('accounts', 'a1')]));

    expect(await sealer(bob)).toBe(0);
    expect(await hasUnsealed(bob.storage, bob.deviceId)).toBe(false);
  });
});

describe('buildBatch', () => {
  it('sends a header even with nothing to say, because the header is the acknowledgement', async () => {
    const [alice, bob] = await makeVault();

    const outgoing = await outbox(alice, bob);

    expect(outgoing.batch).toMatchObject({
      epoch: EPOCH,
      baseCurrency: BASE_CURRENCY,
      sender: alice.deviceId,
      ops: [],
      heads: {},
    });
    expect(outgoing.more).toBe(false);
    // A device that never reports its position is a device whose peers can never compact.
    expect(outgoing.needsFullState).toEqual([]);
  });

  it('withholds unsealed ops instead of skipping past them', async () => {
    const [alice, bob] = await makeVault();
    await alice.stage([
      alice.body('accounts', 'a1'),
      alice.body('accounts', 'a2'),
      alice.body('accounts', 'a3'),
    ]);
    await sealer(alice, 1);

    const outgoing = await outbox(alice, bob);

    expect(outgoing.batch.ops.map((op) => op.seq)).toEqual([1]);
  });

  it('forwards other devices’ ops, which is what lets three devices converge', async () => {
    const [alice, bob, carol] = await makeVault(3);
    await alice.commit([alice.body('accounts', 'a1')]);
    // Carol's op, held by Alice. Bob has never spoken to Carol and gets it anyway.
    await hold(alice, await carol.commit([carol.body('categories', 'c1')]));

    const outgoing = await outbox(alice, bob);

    expect(new Set(outgoing.batch.ops.map((op) => op.deviceId))).toEqual(
      new Set([alice.deviceId, carol.deviceId]),
    );
    expect(outgoing.batch.heads).toMatchObject({ [alice.deviceId]: 1, [carol.deviceId]: 1 });
    // Alice also introduces Carol to Bob. The recipient itself is omitted because Bob already
    // knows its own identity and does not belong in its local peer roster.
    expect(outgoing.batch.roster.map((member) => member.deviceId)).toEqual([carol.deviceId]);
  });

  it('skips what the peer already has', async () => {
    const [alice, bob] = await makeVault();
    await alice.commit([
      alice.body('accounts', 'a1'),
      alice.body('accounts', 'a2'),
      alice.body('accounts', 'a3'),
    ]);

    const outgoing = await outbox(alice, bob, { [alice.deviceId]: 2 });

    expect(outgoing.batch.ops.map((op) => op.seq)).toEqual([3]);
    // Still advertises the full head. `heads` is what we hold, not what we just sent.
    expect(outgoing.batch.heads).toMatchObject({ [alice.deviceId]: 3 });
  });

  it('reports more work rather than letting the caller infer it from a full batch', async () => {
    const [alice, bob] = await makeVault();
    await alice.commit([
      alice.body('accounts', 'a1'),
      alice.body('accounts', 'a2'),
      alice.body('accounts', 'a3'),
    ]);

    const first = await outbox(alice, bob, {}, 2);
    expect(first.batch.ops.map((op) => op.seq)).toEqual([1, 2]);
    expect(first.more).toBe(true);

    // "Exactly `limit` ops" and "exactly `limit` ops and that was all of them" are different
    // situations that look identical from the op count alone.
    const second = await outbox(alice, bob, { [alice.deviceId]: 2 }, 2);
    expect(second.batch.ops.map((op) => op.seq)).toEqual([3]);
    expect(second.more).toBe(false);
  });

  it('answers full state when retention has cut below where the peer sits', async () => {
    const [alice, bob] = await makeVault();
    const ops = await alice.commit([
      alice.body('accounts', 'a1'),
      alice.body('accounts', 'a2'),
      alice.body('accounts', 'a3'),
    ]);
    // Compaction, modelled exactly as it happens: the ops that would bridge the gap are gone.
    await alice.storage.transact((tx) =>
      tx.table('syncOps').delete([ops[0].opId, ops[1].opId]),
    );

    const behind = await outbox(alice, bob, { [alice.deviceId]: 0 });
    expect(behind.needsFullState).toEqual([alice.deviceId]);
    // A state snapshot replaces the unusable suffix; sending op 3 would still make the
    // receiver verify a chain whose compacted prefix no longer exists.
    expect(behind.batch.ops).toEqual([]);
    expect(behind.batch.fullState).toBeDefined();

    const caughtUp = await outbox(alice, bob, { [alice.deviceId]: 2 });
    expect(caughtUp.needsFullState).toEqual([]);
  });

  it('carries whatever this vault currently calls its epoch and base currency', async () => {
    const [alice, bob] = await makeVault();
    await alice.storage.transact((tx) =>
      writeMeta(tx, { [SYNC_META.epoch]: '7', [SYNC_META.baseCurrency]: 'ILS' }),
    );

    // Both are unmergeable preconditions, and both ride in every batch rather than being
    // negotiated once — a blob sitting in a relay bucket for a week still says what it assumed.
    expect((await outbox(alice, bob)).batch).toMatchObject({ epoch: 7, baseCurrency: 'ILS' });
  });
});
