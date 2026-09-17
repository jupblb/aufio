import { Command, CommanderError } from 'commander';
import { resolve } from 'node:path';
import { devices, openDevice } from './device.ts';
import type { Ka17 } from './device.ts';
import type HID from 'node-hid';
import { fromDevice, headroom, object, parsePreset, toDevice } from './preset.ts';
import { difference, slotName, SLOTS, USER_SLOTS } from './protocol.ts';
import { backup, defaultDataDir, inputPath, listPresets, parseSnapshot, presetPath, readJson, saveJson, withLock } from './store.ts';
import type { Snapshot } from './store.ts';

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

export async function main(argv = process.argv): Promise<void> {
  const program = new Command().name('aufio').description('Local KA17 EQ control. JSON output; no hardware writes without --yes.')
    .version('0.1.0').option('--data-dir <path>', 'preset and backup directory', process.env.AUFIO_DATA_DIR ?? defaultDataDir)
    .option('--device <path>', 'exact KA17 HID path from inspect').exitOverride();
  program.configureOutput({ writeErr: () => {} });
  const dataDir = () => resolve(program.opts().dataDir as string);
  const load = async (name: string) => readJson(inputPath(dataDir(), name));

  async function session<T>(fn: (device: Ka17, identity: HID.Device) => Promise<T>): Promise<T> {
    return withLock(async () => {
      const { device, identity } = await openDevice(program.opts().device as string | undefined);
      try { return await fn(device, identity); }
      finally { await device.close(); }
    });
  }

  async function capture(device: Ka17, identity: HID.Device): Promise<Snapshot> {
    const state = await device.read();
    return { schemaVersion: 1, kind: 'ka17-snapshot', capturedAt: new Date().toISOString(), identity, state, rawReports: [...device.reports] };
  }

  function requireWrite(yes: boolean | undefined): void {
    if (!yes) throw new Error('Hardware writes require --yes. Use diff, validate or apply --dry-run first.');
  }

  function checkFirmware(identity: HID.Device): void {
    if (identity.release < 0x0200 || identity.release >= 0x0300) throw new Error('Hardware writes require KA17 2.x firmware. No firmware updates are performed by aufio.');
  }

  program.command('inspect').description('Enumerate KA17 control interfaces; no EQ changes').action(async () => {
    print({ devices: (await devices()).map(d => ({ ...d, usbReleaseHex: `0x${d.release.toString(16).padStart(4, '0')}` })), slots: SLOTS, dataDir: dataDir(), eqPowerState: 'unknown; BYPASS is not EQ OFF' });
  });

  program.command('read').description('Read the active slot, preamp and every band').action(async () => {
    print(await session(capture));
  });

  program.command('save <name>').description('Save active EQ locally, with a raw backup; never writes to the DAC').action(async (name: string) => {
    const path = presetPath(dataDir(), name);
    print(await session(async (device, identity) => {
      const snapshot = await capture(device, identity);
      const backupPath = await backup(dataDir(), snapshot);
      await saveJson(path, fromDevice(name, snapshot.state));
      return { savedLocally: path, backup: backupPath, slot: slotName(snapshot.state.slot), deviceWritten: false };
    }));
  });

  program.command('list').description('List local presets').action(async () => { print({ directory: dataDir(), presets: await listPresets(dataDir()) }); });
  program.command('show <preset>').description('Show a named preset or JSON file').action(async (name: string) => { print(parsePreset(await load(name))); });
  program.command('validate <preset>').description('Validate and preview encoded EQ and headroom; no USB access').action(async (name: string) => {
    const eq = toDevice(parsePreset(await load(name)));
    const estimate = headroom(eq);
    print({ valid: true, applyAllowed: estimate.estimatedPeakDb <= 0, deviceEq: eq, headroom: estimate });
    if (estimate.estimatedPeakDb > 0) process.exitCode = 1;
  });

  for (const command of ['diff', 'verify']) {
    program.command(`${command} <preset-or-snapshot>`).description('Compare a local file with live EQ; never changes slots').action(async (name: string) => {
      const value = object(await load(name));
      const snapshot = value.kind === 'ka17-snapshot' ? parseSnapshot(value) : undefined;
      const expected = snapshot?.state ?? toDevice(parsePreset(value));
      const result = await session(async (device, identity) => {
        const actual = await device.read();
        const differences = difference(expected, actual);
        if (snapshot && snapshot.state.slot !== actual.slot) differences.push(`slot: expected ${snapshot.state.slot}, got ${actual.slot}`);
        if (snapshot && snapshot.identity.release !== identity.release) differences.push('Device revision differs from snapshot');
        return { matches: differences.length === 0, slot: slotName(actual.slot), differences, powerCyclePersistence: 'not established by a single read' };
      });
      print(result);
      if (command === 'verify' && !result.matches) process.exitCode = 1;
    });
  }

  for (const restore of [false, true]) {
    const command = restore ? 'restore' : 'apply';
    program.command(`${command} <file>`).description(restore ? 'Restore a raw snapshot to its already-active USER slot' : 'Apply a named preset or JSON file to the active USER slot')
      .option('--yes', 'confirm hardware write').option('--dry-run', 'show differences without writing')
      .action(async (name: string, options: { yes?: boolean; dryRun?: boolean }) => {
        if (!options.dryRun) requireWrite(options.yes);
        const value = await load(name);
        const original = restore ? parseSnapshot(value) : undefined;
        const eq = original?.state ?? toDevice(parsePreset(value));
        const estimate = restore ? undefined : headroom(eq);
        if (!options.dryRun && estimate && estimate.estimatedPeakDb > 0) {
          throw new Error(`Estimated clipping: ${estimate.estimatedPeakDb} dB. Use preampDb <= ${estimate.recommendedPreampDb}, or reduce boosts if below -12 dB.`);
        }
        print(await session(async (device, identity) => {
          checkFirmware(identity);
          const before = await capture(device, identity);
          if (!USER_SLOTS.includes(before.state.slot)) throw new Error('Select USER1, USER2 or USER3 before writing EQ');
          if (original && (original.state.slot !== before.state.slot || original.identity.release !== identity.release)) {
            throw new Error('Snapshot slot/revision must match the current device. Select the snapshot USER slot first.');
          }
          const differences = difference(eq, before.state);
          if (options.dryRun) return { dryRun: true, slot: slotName(before.state.slot), differences, deviceEq: eq, headroom: estimate, restoreIgnoresHeadroom: restore };
          if (!differences.length) return { changed: false, reason: 'Live values already match; no flash save issued', powerCyclePersistence: 'unverified' };
          const backupPath = await backup(dataDir(), before);
          // Emit the recovery path before the first write, even if interrupted.
          process.stderr.write(JSON.stringify({ event: 'before-write-backup', path: backupPath }) + '\n');
          try {
            await device.apply(eq, before.state);
          } catch (error) {
            throw new Error(`${(error as Error).message}. Device may contain partial changes. Backup: ${backupPath}. Read current state before restoring; no automatic write retry.`);
          }
          return { changed: true, backup: backupPath, slot: slotName(before.state.slot), deviceSave: 'command sent', readback: 'matched', powerCyclePersistence: 'unverified', headroom: estimate };
        }));
      });
  }

  program.command('select <slot>').description('Select USER1, USER2, USER3 or BYPASS (not hardware EQ OFF)')
    .option('--yes', 'confirm changing active EQ').action(async (name: string, options: { yes?: boolean }) => {
      requireWrite(options.yes);
      if (!['USER1', 'USER2', 'USER3', 'BYPASS'].includes(name)) throw new Error('Expected USER1, USER2, USER3 or BYPASS');
      print(await session(async (device, identity) => {
        checkFirmware(identity);
        const before = await capture(device, identity);
        const path = await backup(dataDir(), before);
        process.stderr.write(JSON.stringify({ event: 'before-select-backup', path }) + '\n');
        await device.select(SLOTS[name as keyof typeof SLOTS]);
        return { selected: name, backup: path, eqPowerState: 'unknown; BYPASS is not EQ OFF' };
      }));
    });

  try { await program.parseAsync(argv); }
  catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    process.stderr.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n');
    process.exitCode = 1;
  }
}
