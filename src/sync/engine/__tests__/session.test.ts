/**
 * Two whole engines, talking.
 *
 * Nothing is stubbed here except the finance repository and the wire itself. Real Ed25519
 * identities, real signatures, real hash chains, real sealed frames, real storage — joined by
 * a loopback that models a network the only way a loopback honestly can: by delivering
 * asynchronously, and by not delivering at all when it is told to be partitioned.
 *
 * The property under test throughout is convergence, and it is asserted the strict way: after
 * a pass, every device's op log holds the *same set of ops*. Anything weaker — "the change
 * showed up" — passes on a system that duplicates, reorders, or drops history as long as the
 * one entity being watched happens to survive.
 */

import { SYNC_META, writeMeta } from '@/data/sync-store';
import { MAX_CLOCK_SKEW_MS } from '@/sync/oplog';
import { utf8Bytes } from '@/sync/crypto';
import {
  NOW,
  activityRows,
  link,
  makeVault,
  opRows,
  quarantineRowsOf,
  settle,
  type TestDevice,
} from '@/sync/engine/__tests__/helpers';

/** Every op each device holds, by id — the thing that has to be equal after a sync. */
const held = async (device: TestDevice) => (await opRows(device)).map((row) => row.opId);

/** One full pass per device, in order, letting delivery land between each. */
async function gossip(devices: readonly TestDevice[], rounds = 1) {
  for (let round = 0; round < rounds; round += 1) {
    for (const device of devices) {
      await device.session.reconcile();
      await settle();
    }
  }
}

async function expectConverged(devices: readonly TestDevice[]) {
  const logs = await Promise.all(devices.map(held));
  for (const log of logs) expect(log).toEqual(logs[0]);
  return logs[0];
}

describe('SyncSession — convergence', () => {
  it('carries each device’s changes to the other', async () => {
    const [alice, bob] = await makeVault();
    link(alice, bob);
    await alice.stage([alice.body('accounts', 'a1')]);
    await bob.stage([bob.body('categories', 'c1')]);

    await gossip([alice, bob]);

    expect(await expectConverged([alice, bob])).toHaveLength(2);
    // Each side projected only what it did not already have. A device re-applying its own
    // ops through the remote path would look identical in the op log and be badly wrong.
    expect(alice.repository.flat.map((op) => op.entityType)).toEqual(['categories']);
    expect(bob.repository.flat.map((op) => op.entityType)).toEqual(['accounts']);
  });

  it('seals before it sends, so nothing goes out that a peer could not verify', async () => {
    const [alice, bob] = await makeVault();
    link(alice, bob);
    await alice.stage([alice.body('accounts', 'a1')]);

    const outcome = await alice.session.reconcile();
    await settle();

    expect(outcome.sealed).toBe(1);
    expect(outcome.pushed).toEqual([
      { peerId: bob.deviceId, batches: 1, ops: 1, needsFullState: [], truncated: false },
    ]);
    expect(await held(bob)).toHaveLength(1);
  });

  it('converges again after a partition, without losing either side’s edits', async () => {
    const [alice, bob] = await makeVault();
    const wire = link(alice, bob);
    await gossip([alice, bob]);

    wire.partition();
    await alice.stage([alice.body('accounts', 'a1'), alice.body('accounts', 'a2')]);
    await bob.stage([bob.body('categories', 'c1')]);
    await gossip([alice, bob]);

    // Nothing crossed. Both sides believe they pushed, which is exactly what a device on a
    // dead network believes, and neither has any way to know otherwise yet.
    expect(await held(alice)).toHaveLength(2);
    expect(await held(bob)).toHaveLength(1);

    expect(wire.heal()).toBeGreaterThan(0);
    await settle();
    await gossip([alice, bob]);

    expect(await expectConverged([alice, bob])).toHaveLength(3);
  });

  it('reaches a device it has never spoken to, through one that has', async () => {
    const [alice, bob, carol] = await makeVault(3);
    // Deliberately no Alice↔Carol wire. This is the case that makes forwarding load-bearing
    // rather than an optimisation: a laptop catching up on a phone through a tablet.
    link(alice, bob);
    link(bob, carol);
    await alice.stage([alice.body('accounts', 'a1')]);
    await carol.stage([carol.body('goals', 'g1')]);

    await gossip([alice, bob, carol], 3);

    expect(await expectConverged([alice, bob, carol])).toHaveLength(2);
    expect(alice.repository.flat.map((op) => op.entityType)).toEqual(['goals']);
    expect(carol.repository.flat.map((op) => op.entityType)).toEqual(['accounts']);
  });

  it('treats re-delivery as a no-op however many times it happens', async () => {
    const [alice, bob] = await makeVault();
    link(alice, bob);
    await alice.stage([alice.body('accounts', 'a1')]);

    await gossip([alice, bob], 4);

    expect(await held(bob)).toHaveLength(1);
    // One application, not four. The op log is idempotent, so re-delivery costs a frame and
    // nothing else — which is what lets a relay hand back overlapping ranges without care.
    expect(bob.repository.applied).toHaveLength(1);
  });

  it('does not double-apply when the same channel is reused across passes', async () => {
    const [alice, bob] = await makeVault();
    const wire = link(alice, bob);
    // A live data channel is one long-lived object. Re-attaching a receive handler on every
    // foreground would apply the tenth batch of the day ten times over.
    bob.session.attach(wire.channels[1]);
    bob.session.attach(wire.channels[1]);
    await alice.stage([alice.body('accounts', 'a1')]);

    await gossip([alice, bob]);

    expect(await held(bob)).toHaveLength(1);
    expect(bob.repository.applied).toHaveLength(1);
  });

  it('splits a long backlog across frames without desynchronising the stream', async () => {
    const [alice, bob] = await makeVault();
    const wire = link(alice, bob);
    await alice.stage(
      Array.from({ length: 5 }, (_unused, index) => alice.body('accounts', `a${index}`)),
    );
    await alice.session.reconcile();

    // One op per frame, so the per-channel AEAD counters have to advance in lockstep five
    // times running. A single mismatch and every frame after it fails to open.
    const outcome = await alice.session.push(bob.asPeer(), wire.channels[0], 1);
    await settle(6);

    expect(outcome).toMatchObject({ batches: 5, ops: 5, truncated: false });
    expect(await held(bob)).toHaveLength(5);
    expect(bob.errors).toEqual([]);
  });
});

describe('SyncSession — failure handling', () => {
  it('does nothing at all while sync is switched off', async () => {
    const [alice, bob] = await makeVault();
    link(alice, bob);
    await alice.storage.transact((tx) => writeMeta(tx, { [SYNC_META.enabled]: '0' }));
    await alice.stage([alice.body('accounts', 'a1')]);

    expect(await alice.session.reconcile()).toMatchObject({ sealed: 0, pushed: [], failures: 0 });
    await settle();

    // Not even sealed. Signing is cheap, but a device with sync off should leave no trace of
    // having considered it.
    expect((await opRows(alice))[0].sealed).toBe(0);
    expect(await held(bob)).toHaveLength(0);
  });

  it('counts an unreachable peer without giving up on the reachable one', async () => {
    const [alice, bob, carol] = await makeVault(3);
    link(alice, bob);
    await alice.stage([alice.body('accounts', 'a1')]);

    const outcome = await alice.session.reconcile();
    await settle();

    // A phone in a pocket is unreachable most of the time. Treating that as an error would
    // produce a banner every morning and stop the devices that *are* awake from syncing.
    expect(outcome.failures).toBe(1);
    expect(outcome.pushed.map((push) => push.peerId)).toEqual([bob.deviceId]);
    expect(await held(bob)).toHaveLength(1);
    expect(await held(carol)).toHaveLength(0);
  });

  it('surfaces a frame it cannot open, and keeps the stream usable afterwards', async () => {
    const [alice, bob] = await makeVault();
    const wire = link(alice, bob);
    await alice.stage([alice.body('accounts', 'a1')]);

    await wire.channels[0].send(utf8Bytes('not a frame'.repeat(20)), 0);
    await settle();

    // Reported, not swallowed — and not thrown at the transport either, which has no idea
    // what to do with it.
    expect(bob.errors).toHaveLength(1);
    expect(bob.errors[0].peerId).toBe(alice.deviceId);

    // A junk frame at position zero costs nothing: every frame carries the sequence it was
    // sealed under, so the genuine frame that follows opens on its own terms rather than
    // against a counter the junk had already dragged forward.
    await gossip([alice, bob]);
    expect(await held(bob)).toHaveLength(1);
    expect(bob.errors).toHaveLength(1);
  });

  it('records what it sent and what it received, including the boring successes', async () => {
    const [alice, bob] = await makeVault();
    link(alice, bob);
    await alice.stage([alice.body('accounts', 'a1')]);

    await gossip([alice, bob]);

    // A log of nothing but problems cannot answer "did my laptop ever actually connect",
    // which is the question anybody asks first.
    expect((await activityRows(alice)).map((row) => row.kind)).toContain('sent');
    expect((await activityRows(bob)).map((row) => row.kind)).toContain('received');
  });
});

describe('SyncSession — reprojection', () => {
  it('merges a deferred op once this device’s clock catches up', async () => {
    const [alice, bob] = await makeVault();
    link(alice, bob);
    // Alice's clock is running well ahead. Her op is genuine and correctly signed; Bob simply
    // cannot tell a fast clock from a forged one, so he holds the projection back.
    await alice.stage([alice.body('accounts', 'a1', MAX_CLOCK_SKEW_MS + 60_000)]);

    await gossip([alice, bob]);

    expect(await held(bob)).toHaveLength(1);
    expect(bob.repository.flat).toHaveLength(0);
    expect(await quarantineRowsOf(bob)).toMatchObject([{ reason: 'clockSkew' }]);

    // Nothing corrective arrives and nothing is re-sent. The only thing that changes is the
    // time, which is the whole point: quarantine has to heal without anybody remembering why
    // it happened.
    bob.clockMs = NOW + MAX_CLOCK_SKEW_MS + 120_000;
    const outcome = await bob.session.reconcile();
    await settle();

    expect(outcome).toMatchObject({ reprojected: 1, recovered: 1 });
    expect(bob.repository.flat).toHaveLength(1);
    expect(await quarantineRowsOf(bob)).toEqual([]);
  });

  it('re-offers an entity the repository refused, and clears it when it is accepted', async () => {
    const [alice, bob] = await makeVault();
    link(alice, bob);
    bob.repository.fail = new Error('Balances would overflow.');
    await alice.stage([alice.body('accounts', 'a1')]);

    // Only Alice pushes. Bob's own pass is the thing under test a moment later, and running
    // it here would clear the quarantine before it had been asserted.
    await alice.session.reconcile();
    await settle();

    // Stored and forwarded regardless of whether this device can project it. One device's
    // disagreement must not truncate everybody else's history.
    expect(await held(bob)).toHaveLength(1);
    expect(await quarantineRowsOf(bob)).toMatchObject([{ reason: 'overflow' }]);

    const outcome = await bob.session.reconcile();
    await settle();

    expect(outcome).toMatchObject({ reprojected: 1, recovered: 1 });
    expect(await quarantineRowsOf(bob)).toEqual([]);
    expect((await activityRows(bob)).map((row) => row.kind)).toContain('recovered');
  });
});
