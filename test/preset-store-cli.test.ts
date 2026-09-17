import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { headroom, magnitudeDb } from '../src/dsp.ts';
import { fromDevice, parsePreset, toDevice } from '../src/preset.ts';
import { parseSnapshot, presetPath, readJson, saveJson, withLock } from '../src/store.ts';
import { difference } from '../src/protocol.ts';

const base = fromDevice('test', {
  preampDb: -7,
  bands: [{ type: 'PK', frequencyHz: 1000, gainDb: 6, q: 1 }],
});

test('Q compensation is explicit, gain-sign symmetric, peaking-only and never silently clamped', () => {
  assert.equal(toDevice(base).bands[0]!.q, 1);
  const rbj = { ...base, qMode: 'rbj-peak' as const };
  assert.equal(toDevice(rbj).bands[0]!.q, 1.41);
  assert.equal(toDevice({ ...rbj, bands: [{ ...base.bands[0]!, gainDb: -6 }] }).bands[0]!.q, 1.41);
  assert.equal(toDevice({ ...rbj, bands: [{ ...base.bands[0]!, type: 'LS' }] }).bands[0]!.q, 1);
  assert.throws(
    () => toDevice({ ...rbj, bands: [{ ...base.bands[0]!, q: 8 }] }),
    /refusing to clamp/,
  );
  const raw = toDevice(rbj);
  assert.deepEqual(toDevice(fromDevice('roundtrip', raw)), raw);
});

test('validation rejects typos, nonfinite numbers, unsupported types and out-of-range/precision values', () => {
  assert.deepEqual(parsePreset(base), base);
  for (const patch of [
    { frequencyHz: 19 },
    { frequencyHz: 20001 },
    { q: 0.09 },
    { q: 10.01 },
    { gainDb: 12.1 },
    { gainDb: -12.1 },
    { gainDb: 1.01 },
    { frequencyHz: 21.5 },
    { q: NaN },
    { gainDb: Infinity },
    { type: 'notch' },
    { frequncyHz: 100 },
  ]) {
    assert.throws(() => parsePreset({ ...base, bands: [{ ...base.bands[0], ...patch }] }));
  }
  assert.throws(() => parsePreset({ ...base, preamp: -5 }), /Unknown preset field/);
  assert.throws(() => parsePreset({ ...base, bands: [] }), /1–10/);
  assert.throws(() => parsePreset({ ...base, bands: Array(11).fill(base.bands[0]) }), /1–10/);
  assert.throws(
    () => toDevice(parsePreset({ ...base, bands: [{ ...base.bands[0], type: 'LP' }] })),
    /PK, LS, HS only/,
  );
  const boundaries = {
    ...base,
    preampDb: -12,
    bands: [
      { type: 'PK', frequencyHz: 20, gainDb: -12, q: 0.1 },
      { type: 'HS', frequencyHz: 20000, gainDb: 12, q: 10 },
    ],
  };
  assert.deepEqual(parsePreset(boundaries), boundaries);
});

test('headroom uses the combined response, including overlapping bands and shelf resonance', () => {
  assert.ok(Math.abs(magnitudeDb(base.bands[0]!, 1000, 48000) - 6) < 1e-8);
  const overlapping = {
    preampDb: -5,
    bands: [
      { ...base.bands[0]!, gainDb: 3 },
      { ...base.bands[0]!, gainDb: 4 },
    ],
  };
  assert.equal(headroom(overlapping).estimatedPeakDb, 2);
  assert.equal(headroom({ ...overlapping, preampDb: -8 }).estimatedPeakDb, -1);
  assert.ok(headroom(overlapping).recommendedPreampDb <= -8);
  const shelf = { ...base.bands[0]!, type: 'LS' as const, gainDb: 4, q: 0.7 };
  assert.ok(Math.abs(magnitudeDb(shelf, 0, 48000) - 4) < 1e-8);
  assert.ok(Math.abs(magnitudeDb(shelf, 24000, 48000)) < 1e-8);
  assert.ok(Math.abs(magnitudeDb({ ...shelf, type: 'HS' }, 24000, 48000) - 4) < 1e-8);
  assert.ok(headroom({ preampDb: 0, bands: [{ ...shelf, q: 4 }] }).estimatedPeakDb > 4);
  assert.equal(
    headroom({ preampDb: 0, bands: [{ ...base.bands[0]!, gainDb: -8 }] }).estimatedPeakDb,
    0,
  );
});

test('diff catches type, count, preamp, frequency, gain and Q rather than just successful reads', () => {
  assert.equal(difference(base, base).length, 0);
  assert.equal(
    difference(base, {
      preampDb: -6,
      bands: [{ type: 'HS', frequencyHz: 999, gainDb: 5.9, q: 1.01 }],
    }).length,
    5,
  );
  assert.ok(difference(base, { ...base, bands: [] }).some((s) => s.startsWith('band count')));
});

test('atomic local saves refuse overwrites, clean up on errors and preserve private permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aufio-test-'));
  try {
    const path = presetPath(dir, 'original');
    await saveJson(path, base);
    await assert.rejects(saveJson(path, { corrupt: true }), { code: 'EEXIST' });
    assert.deepEqual(await readJson(path), base);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, 'presets')), ['original.json']);
    await assert.rejects(saveJson(join(dir, 'bad.json'), { invalid: 1n }));
    assert.deepEqual(await readdir(dir), ['presets']);
    assert.throws(() => presetPath(dir, '../outside'), /Preset name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cross-process lock rejects overlap and releases after a failed operation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aufio-test-'));
  const lock = join(dir, 'lock');
  try {
    await withLock(async () => {
      await assert.rejects(
        withLock(async () => {}, lock),
        /Another aufio/,
      );
    }, lock);
    await assert.rejects(
      withLock(async () => {
        throw new Error('failed');
      }, lock),
      /failed/,
    );
    assert.equal(await withLock(async () => 42, lock), 42);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('snapshot validation never treats a factory slot or foreign DAC as restorable', () => {
  const snapshot = {
    schemaVersion: 1,
    kind: 'ka17-snapshot',
    identity: { vendorId: 0x2972, productId: 0x93, release: 0x225 },
    state: { slot: 4, preampDb: base.preampDb, bands: base.bands },
  };
  assert.equal(parseSnapshot(snapshot).state.slot, 4);
  assert.throws(
    () => parseSnapshot({ ...snapshot, state: { ...snapshot.state, slot: 7 } }),
    /USER slot/,
  );
  assert.throws(
    () => parseSnapshot({ ...snapshot, identity: { ...snapshot.identity, productId: 0x88 } }),
    /KA17 snapshot/,
  );
});

test('CLI errors are JSON and writes require confirmation before touching USB or files', () => {
  for (const args of [
    ['apply', 'missing'],
    ['restore', 'missing'],
    ['select', 'USER1'],
    ['not-a-command'],
  ]) {
    const result = spawnSync(
      process.execPath,
      ['bin/aufio.mjs', '--device', 'NONEXISTENT', ...args],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    const error = JSON.parse(result.stderr).error;
    assert.match(error, args[0] === 'not-a-command' ? /unknown command/ : /--yes/);
  }
});
