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
import { FULL_STATE_ENTRY_CAP, buildBatch, loadSendSnapshot } from '@/sync/engine/send';
import { hasUnsealed, sealPending } from '@/sync/engine/sealer';
import {
  BASE_CURRENCY,
  EPOCH,
  makeVault,
  opRows,
  type TestDevice,
} from '@/sync/engine/__tests__/helpers';

/** Builds one batch the way the session does: from a freshly loaded snapshot. */
const outbox = (
  sender: TestDevice,
  peer: TestDevice,
  acked: Record<string, number> = {},
  limit = 100,
  stateOffset = 0,
) =>
  loadSendSnapshot(sender.storage).then((snapshot) =>
    buildBatch(
      {
        storage: sender.storage,
        deviceId: sender.deviceId,
        signingKey: sender.identity.signing.secretKey,
        limit,
      },
      { ...peer.asPeer(), acked },
      snapshot,
      stateOffset,
    ),
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
    expect(behind.more).toBe(false);

    const caughtUp = await outbox(alice, bob, { [alice.deviceId]: 2 });
    expect(caughtUp.needsFullState).toEqual([]);
  });

  it('splits a full state that exceeds one chunk across consecutive batches', async () => {
    const [alice, bob] = await makeVault();
    const bodies = Array.from(
      { length: FULL_STATE_ENTRY_CAP + 100 },
      (_unused, index) => alice.body('accounts', `a${index}`),
    );
    const ops = await alice.stage(bodies);
    // Compact everything but the head, so the whole state has to go as chunks.
    await alice.storage.transact((tx) =>
      tx.table('syncOps').delete(ops.slice(0, -1).map((op) => op.opId)),
    );

    // Walk the chunks exactly the way the session does, respecting every cap it respects.
    const all: string[] = [];
    let offset = 0;
    for (let batch = 0; batch < 32; batch += 1) {
      const outgoing = await outbox(alice, bob, { [alice.deviceId]: 0 }, 100, offset);
      expect(outgoing.needsFullState).toEqual([alice.deviceId]);
      const chunk = outgoing.batch.fullState ?? [];
      expect(chunk.length).toBeLessThanOrEqual(FULL_STATE_ENTRY_CAP);
      all.push(...chunk.map((state) => (state as { entityId: string }).entityId));
      if (!outgoing.more) break;
      offset += chunk.length;
    }

    // Every entity's state arrives exactly once, in deterministic key order.
    expect(new Set(all)).toEqual(new Set(bodies.map((body) => body.entityId)));
    expect(all).toHaveLength(bodies.length);
  });
  it('splits a full state by encoded size as well as by entry count', async () => {
    const [alice, bob] = await makeVault();
    // Two staged ops give the chain a head; the first is compacted away so the peer has to
    // be answered with state. The sealer never runs here, so the head stays unsealed — which
    // is fine, `needsFullState` is decided from the chain's existence, not its seal state.
    const ops = await alice.stage([alice.body('accounts', 'fat'), alice.body('accounts', 'fat2')]);
    await alice.storage.transact((tx) =>
      tx.table('syncOps').delete([ops[0].opId]),
    );

    const [op] = ops;
    const fat = {
      hlc: op.hlc,
      entityType: 'accounts' as const,
      entityId: 'fat',
      maxHlc: op.hlc,
      created: { hlc: op.hlc, fields: { id: 'fat', createdAt: op.hlc, name: 'fat' } },
      registers: {
        name: { hlc: op.hlc, value: { name: 'x'.repeat(400_000) } },
      },
      sets: {},
      maps: {},
      unknown: [],
      deleted: null,
    };
    // The state the session would hold: plenty of states, one of them enormous.
    const states = Array.from({ length: 8 }, (_unused, index) => ({
      ...fat,
      entityId: `fat-${index}`,
    }));
    await alice.storage.transact(
      (tx) => tx.table('syncState').put(states.map((state) => ({
        key: `accounts:${state.entityId}`,
        type: 'accounts',
        meta: JSON.stringify(state),
        maxHlc: state.maxHlc,
        deletedHlc: null,
      }))),
      { silent: true },
    );

    const first = await outbox(alice, bob, { [alice.deviceId]: 0 });
    expect(first.needsFullState).toEqual([alice.deviceId]);
    expect(first.batch.fullState).toBeDefined();
    // Four enormous entries nearly fill the character budget; the rest follow in later chunks.
    expect(first.batch.fullState!.length).toBeLessThan(8);
    expect(first.more).toBe(true);

    const all = [first.batch.fullState ?? []];
    let offset = first.batch.fullState!.length;
    while (true) {
      const next = await outbox(alice, bob, { [alice.deviceId]: 0 }, 100, offset);
      all.push(next.batch.fullState ?? []);
      if (!next.more) break;
      offset += next.batch.fullState!.length;
    }
    // Every entity's state arrives exactly once across the chunks, in deterministic key order.
    const keys = all.flat().map((state) => (state as { entityId: string }).entityId);
    expect(new Set(keys)).toEqual(
      new Set(['fat-0', 'fat-1', 'fat-2', 'fat-3', 'fat-4', 'fat-5', 'fat-6', 'fat-7', 'fat', 'fat2']),
    );
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
