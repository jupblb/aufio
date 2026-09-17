import HID from 'node-hid';
import { setTimeout as delay } from 'node:timers/promises';
import {
  bandBytes,
  COMMAND,
  decodeBand,
  difference,
  packet,
  PRODUCT_ID,
  response,
  SELECTABLE_SLOTS,
  signedGain,
  USER_SLOTS,
  VENDOR_ID,
} from './protocol.ts';
import type { Eq, State } from './protocol.ts';

export interface Transport {
  write(data: Buffer): Promise<number>;
  read(timeout: number): Promise<Buffer | undefined>;
  close(): Promise<void>;
}

export async function devices(): Promise<HID.Device[]> {
  const found = await HID.devicesAsync(VENDOR_ID, PRODUCT_ID);
  // macOS enumerates both the control and media-key collections at one path.
  return [
    ...new Map(found.filter((d) => d.path && d.usagePage === 1).map((d) => [d.path, d])).values(),
  ];
}

export async function openDevice(path?: string): Promise<{ device: Ka17; identity: HID.Device }> {
  const found = (await devices()).filter((d) => !path || d.path === path);
  if (found.length !== 1)
    throw new Error(
      `Expected one KA17 control interface, found ${found.length}. Run inspect; use --device when more than one is attached.`,
    );
  const identity = found[0]!;
  const transport = await HID.HIDAsync.open(identity.path!, { nonExclusive: true });
  return { device: new Ka17(transport), identity };
}

export class Ka17 {
  private readonly transport: Transport;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private lastSend = 0;
  reports: string[] = [];

  constructor(transport: Transport, intervalMs = 200, timeoutMs = 2000) {
    this.transport = transport;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
  }

  private async send(write: boolean, command: number, data: number[] = []): Promise<void> {
    await delay(Math.max(0, this.intervalMs - (Date.now() - this.lastSend)));
    const bytes = packet(write, command, data);
    const written = await this.transport.write(bytes);
    this.lastSend = Date.now();
    if (written !== bytes.length) throw new Error(`Short HID write: ${written}/${bytes.length}`);
  }

  private async get(command: number, length: number, index?: number): Promise<Buffer> {
    await this.send(false, command, index === undefined ? [] : [index]);
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const report = await this.transport.read(Math.max(1, deadline - Date.now()));
      if (!report?.length) continue;
      const parsed = response(report);
      // Replies are not guaranteed to arrive in request order. Ignore other
      // commands/bands, but never substitute a default for a missing reply.
      if (
        !parsed ||
        parsed.command !== command ||
        (index !== undefined && parsed.data[0] !== index)
      )
        continue;
      if (parsed.data.length !== length)
        throw new Error(`Unexpected response length for command 0x${command.toString(16)}`);
      this.reports.push(report.toString('hex'));
      return parsed.data;
    }
    throw new Error(
      `KA17 response timeout for command 0x${command.toString(16)}. Close FiiO Control and retry the read; writes are not automatically retried.`,
    );
  }

  private async readSlot(): Promise<number> {
    return (await this.get(COMMAND.slot, 1))[0]!;
  }

  async read(): Promise<State> {
    this.reports = [];
    const slot = await this.readSlot();
    const count = (await this.get(COMMAND.count, 1))[0]!;
    if (count < 1 || count > 10) throw new Error(`Unsupported band count: ${count}`);
    const preampDb = (await this.get(COMMAND.preamp, 2)).readInt16BE() / 10;
    const bands = [];
    for (let i = 0; i < count; i++) bands.push(decodeBand(await this.get(COMMAND.band, 8, i)));
    if ((await this.readSlot()) !== slot)
      throw new Error('Preset changed during read. Close other controllers and retry.');
    return { slot, preampDb, bands };
  }

  async select(slot: number): Promise<void> {
    if (!Object.values(SELECTABLE_SLOTS).includes(slot))
      throw new Error('Only USER1, USER2, USER3 and BYPASS can be selected');
    await this.send(true, COMMAND.slot, [slot]);
    if ((await this.readSlot()) !== slot)
      throw new Error('Preset selection did not match readback');
  }

  // Caller holds the cross-process lock and has durably backed up `before`.
  async apply(eq: Eq, before: State): Promise<State> {
    if (!USER_SLOTS.includes(before.slot)) throw new Error('Select a USER slot before applying EQ');
    const current = await this.read();
    if (current.slot !== before.slot || difference(before, current).length)
      throw new Error('EQ changed since backup; refusing to overwrite it');
    // Keep the DSP attenuated while the individual filters are being changed.
    await this.send(true, COMMAND.preamp, signedGain(-12));
    await this.send(true, COMMAND.count, [eq.bands.length]);
    for (const [index, band] of eq.bands.entries())
      await this.send(true, COMMAND.band, bandBytes(index, band));
    await this.verify({ ...eq, preampDb: -12 }, before.slot);
    await this.send(true, COMMAND.preamp, signedGain(eq.preampDb));
    await this.verify(eq, before.slot);
    await this.send(true, COMMAND.save, [before.slot]);
    return this.verify(eq, before.slot);
  }

  async verify(eq: Eq, slot: number): Promise<State> {
    const actual = await this.read();
    const diff = difference(eq, actual);
    if (actual.slot !== slot) diff.push(`slot: expected ${slot}, got ${actual.slot}`);
    if (diff.length) throw new Error(`Device readback mismatch: ${diff.join('; ')}`);
    return actual;
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
