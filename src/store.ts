import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type HID from 'node-hid';
import { parseObject, parseEq } from './preset.ts';
import { PRODUCT_ID, USER_SLOTS, VENDOR_ID } from './protocol.ts';
import type { State } from './protocol.ts';

export const defaultDataDir = join(homedir(), 'Library', 'Application Support', 'aufio');
export const lockPath = join(tmpdir(), 'aufio-ka17.lock');
export interface Snapshot {
  schemaVersion: 1;
  kind: 'ka17-snapshot';
  capturedAt: string;
  identity: HID.Device;
  state: State;
  rawReports: string[];
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Publish a fully flushed file atomically, without ever replacing an existing
// preset or backup. Hard-link publication also prevents concurrent overwrites.
export async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(value, null, 2) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await link(temporary, path);
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temporary);
  }
}

export async function withLock<T>(operation: () => Promise<T>, path = lockPath): Promise<T> {
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Another aufio operation holds ${path}. If a previous process crashed, inspect its PID in this file and remove the stale lock only after confirming it has exited.`,
      );
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await operation();
  } finally {
    await file.close();
    await unlink(path);
  }
}

export function presetPath(dataDir: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
    throw new Error('Preset name must be 1–64 lowercase letters, digits, hyphens or underscores');
  return join(dataDir, 'presets', `${name}.json`);
}

export function inputPath(dataDir: string, nameOrPath: string): string {
  return nameOrPath.endsWith('.json') || nameOrPath.includes('/')
    ? resolve(nameOrPath)
    : presetPath(dataDir, nameOrPath);
}

export async function listPresets(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(join(dataDir, 'presets'))).filter((p) => p.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function backup(dataDir: string, snapshot: Snapshot): Promise<string> {
  const path = join(
    dataDir,
    'backups',
    `${snapshot.capturedAt.replaceAll(':', '-')}-${randomUUID()}.json`,
  );
  await saveJson(path, snapshot);
  return path;
}

export function parseSnapshot(value: unknown): Snapshot {
  const snapshot = parseObject(value);
  const identity = parseObject(snapshot.identity);
  const state = parseObject(snapshot.state);
  if (
    snapshot.kind !== 'ka17-snapshot' ||
    snapshot.schemaVersion !== 1 ||
    identity.vendorId !== VENDOR_ID ||
    identity.productId !== PRODUCT_ID
  )
    throw new Error('Not a version-1 KA17 snapshot');
  if (
    typeof identity.release !== 'number' ||
    typeof state.slot !== 'number' ||
    !USER_SLOTS.includes(state.slot)
  )
    throw new Error('Snapshot must contain a USER slot and device revision');
  parseEq(state);
  return snapshot as unknown as Snapshot;
}
