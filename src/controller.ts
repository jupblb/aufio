import type HID from 'node-hid';
import { openDevice } from './device.ts';
import type { Ka17 } from './device.ts';
import { headroom } from './dsp.ts';
import { fromDevice, parseObject, parsePreset, toDevice } from './preset.ts';
import { difference, slotName, SELECTABLE_SLOTS, USER_SLOTS } from './protocol.ts';
import type { Eq } from './protocol.ts';
import {
  backup,
  inputPath,
  parseSnapshot,
  presetPath,
  readJson,
  saveJson,
  withLock,
} from './store.ts';
import type { Snapshot } from './store.ts';

export interface WriteOptions {
  yes?: boolean;
  dryRun?: boolean;
}

// Owns the safe device workflows. The CLI only parses arguments and displays
// results; the transport only implements KA17 commands.
export class EqController {
  private readonly dataDir: string;
  private readonly devicePath?: string;
  private readonly connect: typeof openDevice;

  constructor(dataDir: string, devicePath?: string, connect = openDevice) {
    this.dataDir = dataDir;
    this.devicePath = devicePath;
    this.connect = connect;
  }

  read(): Promise<Snapshot> {
    return this.withDevice(capture);
  }

  async save(name: string) {
    const path = presetPath(this.dataDir, name);
    return this.withDevice(async (device, identity) => {
      const snapshot = await capture(device, identity);
      const backupPath = await backup(this.dataDir, snapshot);
      await saveJson(path, fromDevice(name, snapshot.state));
      return {
        savedLocally: path,
        backup: backupPath,
        slot: slotName(snapshot.state.slot),
        deviceWritten: false,
      };
    });
  }

  async compare(name: string) {
    const value = parseObject(await this.load(name));
    const snapshot = value.kind === 'ka17-snapshot' ? parseSnapshot(value) : undefined;
    const expected = snapshot?.state ?? toDevice(parsePreset(value));

    return this.withDevice(async (device, identity) => {
      const actual = await device.read();
      const differences = difference(expected, actual);
      if (snapshot && snapshot.state.slot !== actual.slot) {
        differences.push(`slot: expected ${snapshot.state.slot}, got ${actual.slot}`);
      }
      if (snapshot && snapshot.identity.release !== identity.release) {
        differences.push('Device revision differs from snapshot');
      }
      return {
        matches: differences.length === 0,
        slot: slotName(actual.slot),
        differences,
        powerCyclePersistence: 'not established by a single read',
      };
    });
  }

  async apply(name: string, options: WriteOptions) {
    if (!options.dryRun) requireConfirmation(options.yes);
    const eq = toDevice(parsePreset(await this.load(name)));
    return this.writeEq(eq, options);
  }

  async restore(name: string, options: WriteOptions) {
    if (!options.dryRun) requireConfirmation(options.yes);
    const snapshot = parseSnapshot(await this.load(name));
    return this.writeEq(snapshot.state, options, snapshot);
  }

  async select(name: string, options: WriteOptions) {
    requireConfirmation(options.yes);
    if (!Object.hasOwn(SELECTABLE_SLOTS, name)) {
      throw new Error('Expected USER1, USER2, USER3 or BYPASS');
    }
    const slot = SELECTABLE_SLOTS[name as keyof typeof SELECTABLE_SLOTS];

    return this.withDevice(async (device, identity) => {
      checkFirmware(identity);
      const before = await capture(device, identity);
      const path = await this.backupBeforeChange(before, 'select');
      await device.select(slot);
      return { selected: name, backup: path, eqPowerState: 'unknown; BYPASS is not EQ OFF' };
    });
  }

  private async writeEq(eq: Eq, options: WriteOptions, original?: Snapshot) {
    // Restoring preserves raw values exactly, even if the old EQ could clip.
    // Applying a new preset must pass the headroom check before USB is opened.
    const estimate = original ? undefined : headroom(eq);
    if (!options.dryRun && estimate && estimate.estimatedPeakDb > 0) {
      throw new Error(
        `Estimated clipping: ${estimate.estimatedPeakDb} dB. Use preampDb <= ${estimate.recommendedPreampDb}, or reduce boosts if below -12 dB.`,
      );
    }

    return this.withDevice(async (device, identity) => {
      checkFirmware(identity);
      const before = await capture(device, identity);
      if (!USER_SLOTS.includes(before.state.slot)) {
        throw new Error('Select USER1, USER2 or USER3 before writing EQ');
      }
      if (
        original &&
        (original.state.slot !== before.state.slot ||
          original.identity.release !== identity.release)
      ) {
        throw new Error(
          'Snapshot slot/revision must match the current device. Select the snapshot USER slot first.',
        );
      }

      const differences = difference(eq, before.state);
      if (options.dryRun) {
        return {
          dryRun: true,
          slot: slotName(before.state.slot),
          differences,
          deviceEq: eq,
          headroom: estimate,
          restoreIgnoresHeadroom: original !== undefined,
        };
      }
      if (!differences.length) {
        return {
          changed: false,
          reason: 'Live values already match; no flash save issued',
          powerCyclePersistence: 'unverified',
        };
      }

      const backupPath = await this.backupBeforeChange(before, 'write');
      try {
        await device.apply(eq, before.state);
      } catch (error) {
        throw new Error(
          `${(error as Error).message}. Device may contain partial changes. Backup: ${backupPath}. Read current state before restoring; no automatic write retry.`,
        );
      }
      return {
        changed: true,
        backup: backupPath,
        slot: slotName(before.state.slot),
        deviceSave: 'command sent',
        readback: 'matched',
        powerCyclePersistence: 'unverified',
        headroom: estimate,
      };
    });
  }

  private load(name: string): Promise<unknown> {
    return readJson(inputPath(this.dataDir, name));
  }

  private async backupBeforeChange(
    snapshot: Snapshot,
    operation: 'write' | 'select',
  ): Promise<string> {
    const path = await backup(this.dataDir, snapshot);
    // The file must be durable, and its recovery path visible, before changing
    // hardware: interruption can prevent the command's final result appearing.
    process.stderr.write(JSON.stringify({ event: `before-${operation}-backup`, path }) + '\n');
    return path;
  }

  private async withDevice<T>(
    operation: (device: Ka17, identity: HID.Device) => Promise<T>,
  ): Promise<T> {
    return withLock(async () => {
      const { device, identity } = await this.connect(this.devicePath);
      try {
        return await operation(device, identity);
      } finally {
        await device.close();
      }
    });
  }
}

async function capture(device: Ka17, identity: HID.Device): Promise<Snapshot> {
  const state = await device.read();
  return {
    schemaVersion: 1,
    kind: 'ka17-snapshot',
    capturedAt: new Date().toISOString(),
    identity,
    state,
    rawReports: [...device.reports],
  };
}

function requireConfirmation(yes: boolean | undefined): void {
  if (!yes) {
    throw new Error('Hardware writes require --yes. Use diff, validate or apply --dry-run first.');
  }
}

function checkFirmware(identity: HID.Device): void {
  if (identity.release < 0x0200 || identity.release >= 0x0300) {
    throw new Error(
      'Hardware writes require KA17 2.x firmware. No firmware updates are performed by aufio.',
    );
  }
}
