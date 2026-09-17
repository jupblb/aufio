import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type HID from 'node-hid';
import { EqController } from '../src/controller.ts';
import { Ka17 } from '../src/device.ts';
import { fromDevice } from '../src/preset.ts';
import type { Eq, State } from '../src/protocol.ts';
import { presetPath, readJson, saveJson } from '../src/store.ts';
import type { Snapshot } from '../src/store.ts';

const target: Eq = {
  preampDb: -6.3,
  bands: [{ type: 'HS', frequencyHz: 4321, gainDb: 2.4, q: 0.71 }],
};

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'aufio-controller-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const identity: HID.Device = {
    path: 'fake-ka17',
    vendorId: 0x2972,
    productId: 0x93,
    release: 0x225,
    interface: 3,
  };
  const state: State = {
    slot: 9,
    preampDb: -3.2,
    bands: [{ type: 'PK', frequencyHz: 731, gainDb: -2.1, q: 1.23 }],
  };
  const events: { event: string; path: string }[] = [];
  t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
    events.push(JSON.parse(String(chunk)));
    return true;
  });

  // Exercise real storage and locking, but never open USB. Protocol details
  // are tested separately; unexpected transport access is a test failure.
  const device = new Ka17({
    async write() {
      throw new Error('Unexpected transport write');
    },
    async read() {
      throw new Error('Unexpected transport read');
    },
    async close() {},
  });
  t.mock.method(device, 'read', async () => {
    device.reports = ['01bb0b000016010900ee'];
    return structuredClone(state);
  });
  const close = t.mock.method(device, 'close', async () => {});
  const failure = { apply: false };

  async function assertBackup(operation: 'write' | 'select') {
    assert.equal(events.length, 1, 'Recovery path must be emitted before hardware changes');
    assert.equal(events[0]!.event, `before-${operation}-backup`);
    const snapshot = (await readJson(events[0]!.path)) as Snapshot;
    assert.deepEqual(snapshot.state, state, 'The backup must already exist and contain the old EQ');
    assert.deepEqual(snapshot.rawReports, ['01bb0b000016010900ee']);
  }

  const apply = t.mock.method(device, 'apply', async (eq: Eq, before: State) => {
    await assertBackup('write');
    assert.deepEqual(before, state);
    if (failure.apply) throw new Error('disconnected');
    return { ...structuredClone(eq), slot: state.slot };
  });
  const select = t.mock.method(device, 'select', async (_slot: number) => {
    await assertBackup('select');
  });
  const connect = t.mock.fn(async (path?: string) => {
    assert.equal(path, 'fake-ka17');
    return { device, identity };
  });
  const controller = new EqController(dir, 'fake-ka17', connect);
  await saveJson(presetPath(dir, 'target'), fromDevice('target', target));
  return { dir, state, identity, events, controller, apply, select, close, connect, failure };
}

test('dry-run and matching EQ neither back up nor write to the device', async (t) => {
  const fixture = await setup(t);
  const preview = await fixture.controller.apply('target', { dryRun: true });
  assert.ok(preview.dryRun);
  assert.deepEqual(preview.deviceEq, target);
  assert.equal(preview.differences!.length, 5);
  assert.equal(preview.restoreIgnoresHeadroom, false);

  await saveJson(presetPath(fixture.dir, 'same'), fromDevice('same', fixture.state));
  assert.deepEqual(await fixture.controller.apply('same', { yes: true }), {
    changed: false,
    reason: 'Live values already match; no flash save issued',
    powerCyclePersistence: 'unverified',
  });
  assert.equal(fixture.apply.mock.callCount(), 0);
  assert.equal(fixture.close.mock.callCount(), 2);
  assert.deepEqual(fixture.events, []);
  await assert.rejects(readdir(join(fixture.dir, 'backups')), { code: 'ENOENT' });
});

test('confirmation and clipping checks run before opening a device', async (t) => {
  const fixture = await setup(t);
  await assert.rejects(fixture.controller.apply('missing', {}), /--yes/);
  await assert.rejects(fixture.controller.restore('missing', {}), /--yes/);
  await assert.rejects(fixture.controller.select('USER1', {}), /--yes/);
  await saveJson(
    presetPath(fixture.dir, 'clipping'),
    fromDevice('clipping', {
      preampDb: 0,
      bands: [{ type: 'PK', frequencyHz: 731, gainDb: 3, q: 1.23 }],
    }),
  );
  await assert.rejects(fixture.controller.apply('clipping', { yes: true }), /Estimated clipping/);
  assert.equal(fixture.connect.mock.callCount(), 0);
  assert.deepEqual(fixture.events, []);
});

test('apply publishes the recovery backup before passing the exact target to the device', async (t) => {
  const fixture = await setup(t);
  const result = await fixture.controller.apply('target', { yes: true });
  assert.equal(result.changed, true);
  assert.equal(result.backup, fixture.events[0]!.path);
  assert.equal(result.slot, 'USER3');
  assert.equal(result.readback, 'matched');
  assert.equal(result.powerCyclePersistence, 'unverified');
  assert.deepEqual(fixture.apply.mock.calls[0]!.arguments, [target, fixture.state]);
  assert.equal(fixture.apply.mock.callCount(), 1);
  assert.equal(fixture.close.mock.callCount(), 1);
});

test('restore bypasses headroom and Q conversion, but requires the same slot and revision', async (t) => {
  const fixture = await setup(t);
  const snapshot = await fixture.controller.read();
  snapshot.state.preampDb = 4.2;
  snapshot.state.bands[0]!.gainDb = 7.1;
  snapshot.state.bands[0]!.q = 0.53;
  const path = join(fixture.dir, 'snapshot.json');
  await saveJson(path, snapshot);

  fixture.state.slot = 8;
  await assert.rejects(fixture.controller.restore(path, { yes: true }), /slot\/revision/);
  fixture.state.slot = 9;
  fixture.identity.release = 0x224;
  await assert.rejects(fixture.controller.restore(path, { yes: true }), /slot\/revision/);
  assert.equal(fixture.apply.mock.callCount(), 0);
  assert.deepEqual(fixture.events, []);

  fixture.identity.release = 0x225;
  const result = await fixture.controller.restore(path, { yes: true });
  assert.equal(result.changed, true);
  assert.equal(result.headroom, undefined);
  assert.deepEqual(fixture.apply.mock.calls[0]!.arguments[0], snapshot.state);
});

test('failed writes preserve a recovery path, close and unlock, without retrying', async (t) => {
  const fixture = await setup(t);
  fixture.failure.apply = true;
  await assert.rejects(fixture.controller.apply('target', { yes: true }), (error: Error) => {
    assert.match(error.message, /disconnected.*partial changes.*no automatic write retry/);
    assert.ok(error.message.includes(fixture.events[0]!.path));
    return true;
  });
  assert.equal(fixture.apply.mock.callCount(), 1);
  assert.equal(fixture.close.mock.callCount(), 1);
  // A subsequent operation can acquire the lock after the failure.
  assert.deepEqual((await fixture.controller.read()).state, fixture.state);
  assert.equal(fixture.close.mock.callCount(), 2);
});

test('slot selection rejects factory names and backs up before selecting BYPASS', async (t) => {
  const fixture = await setup(t);
  for (const name of ['Hip-hop', '7', 'constructor']) {
    await assert.rejects(fixture.controller.select(name, { yes: true }), /Expected USER/);
  }
  assert.equal(fixture.connect.mock.callCount(), 0);
  const result = await fixture.controller.select('BYPASS', { yes: true });
  assert.equal(result.selected, 'BYPASS');
  assert.equal(result.backup, fixture.events[0]!.path);
  assert.deepEqual(fixture.select.mock.calls[0]!.arguments, [10]);
  assert.equal(fixture.close.mock.callCount(), 1);
});

test('snapshot comparison includes slot and revision even when all EQ values match', async (t) => {
  const fixture = await setup(t);
  const path = join(fixture.dir, 'snapshot.json');
  await saveJson(path, await fixture.controller.read());
  assert.equal((await fixture.controller.compare(path)).matches, true);
  fixture.state.slot = 8;
  fixture.identity.release = 0x224;
  const result = await fixture.controller.compare(path);
  assert.equal(result.matches, false);
  assert.deepEqual(result.differences, [
    'slot: expected 9, got 8',
    'Device revision differs from snapshot',
  ]);
  assert.equal(fixture.apply.mock.callCount(), 0);
  assert.deepEqual(fixture.events, []);
});
