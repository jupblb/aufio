import { Command, CommanderError } from 'commander';
import { resolve } from 'node:path';
import { EqController } from './controller.ts';
import type { WriteOptions } from './controller.ts';
import { devices } from './device.ts';
import { headroom } from './dsp.ts';
import { parsePreset, toDevice } from './preset.ts';
import { SLOTS } from './protocol.ts';
import { defaultDataDir, inputPath, listPresets, readJson } from './store.ts';

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

export async function main(argv = process.argv): Promise<void> {
  const program = new Command()
    .name('aufio')
    .description('Local KA17 EQ control. JSON output; no hardware writes without --yes.')
    .version('0.1.0')
    .option(
      '--data-dir <path>',
      'preset and backup directory',
      process.env.AUFIO_DATA_DIR ?? defaultDataDir,
    )
    .option('--device <path>', 'exact KA17 HID path from inspect')
    .exitOverride();
  program.configureOutput({ writeErr: () => {} });
  const dataDir = () => resolve(program.opts().dataDir as string);
  const load = async (name: string) => readJson(inputPath(dataDir(), name));
  const controller = () => new EqController(dataDir(), program.opts().device as string | undefined);

  program
    .command('inspect')
    .description('Enumerate KA17 control interfaces; no EQ changes')
    .action(async () => {
      print({
        devices: (await devices()).map((d) => ({
          ...d,
          usbReleaseHex: `0x${d.release.toString(16).padStart(4, '0')}`,
        })),
        slots: SLOTS,
        dataDir: dataDir(),
        eqPowerState: 'unknown; BYPASS is not EQ OFF',
      });
    });

  program
    .command('read')
    .description('Read the active slot, preamp and every band')
    .action(async () => {
      print(await controller().read());
    });

  program
    .command('save <name>')
    .description('Save active EQ locally, with a raw backup; never writes to the DAC')
    .action(async (name: string) => {
      print(await controller().save(name));
    });

  program
    .command('list')
    .description('List local presets')
    .action(async () => {
      print({ directory: dataDir(), presets: await listPresets(dataDir()) });
    });
  program
    .command('show <preset>')
    .description('Show a named preset or JSON file')
    .action(async (name: string) => {
      print(parsePreset(await load(name)));
    });
  program
    .command('validate <preset>')
    .description('Validate and preview encoded EQ and headroom; no USB access')
    .action(async (name: string) => {
      const eq = toDevice(parsePreset(await load(name)));
      const estimate = headroom(eq);
      print({
        valid: true,
        applyAllowed: estimate.estimatedPeakDb <= 0,
        deviceEq: eq,
        headroom: estimate,
      });
      if (estimate.estimatedPeakDb > 0) process.exitCode = 1;
    });

  for (const command of ['diff', 'verify']) {
    program
      .command(`${command} <preset-or-snapshot>`)
      .description('Compare a local file with live EQ; never changes slots')
      .action(async (name: string) => {
        const result = await controller().compare(name);
        print(result);
        if (command === 'verify' && !result.matches) process.exitCode = 1;
      });
  }

  program
    .command('apply <file>')
    .description('Apply a named preset or JSON file to the active USER slot')
    .option('--yes', 'confirm hardware write')
    .option('--dry-run', 'show differences without writing')
    .action(async (name: string, options: WriteOptions) => {
      print(await controller().apply(name, options));
    });

  program
    .command('restore <file>')
    .description('Restore a raw snapshot to its already-active USER slot')
    .option('--yes', 'confirm hardware write')
    .option('--dry-run', 'show differences without writing')
    .action(async (name: string, options: WriteOptions) => {
      print(await controller().restore(name, options));
    });

  program
    .command('select <slot>')
    .description('Select USER1, USER2, USER3 or BYPASS (not hardware EQ OFF)')
    .option('--yes', 'confirm changing active EQ')
    .action(async (name: string, options: WriteOptions) => {
      print(await controller().select(name, options));
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return;
    process.stderr.write(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n',
    );
    process.exitCode = 1;
  }
}
