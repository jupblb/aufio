import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Ka17 } from '../src/device.ts';
import type { Transport } from '../src/device.ts';
import {
  bandBytes,
  decodeBand,
  packet,
  response,
  signedGain,
  SLOTS,
  USER_SLOTS,
} from '../src/protocol.ts';
import type { State } from '../src/protocol.ts';

test('golden packets use report ID 1, big-endian signed gains, exact Q and 32-byte payloads', () => {
  assert.equal(packet(false, 0x16).toString('hex'), '01bb0b0000160000ee' + '00'.repeat(24));
  assert.deepEqual(signedGain(-5.1), [0xff, 0xcd]);
  const bytes = bandBytes(9, { type: 'HS', frequencyHz: 12345, gainDb: -2.3, q: 4.56 });
  assert.deepEqual(bytes, [9, 0xff, 0xe9, 0x30, 0x39, 0x01, 0xc8, 2]);
  assert.equal(
    packet(true, 0x15, bytes).subarray(0, 17).toString('hex'),
    '01aa0a0000150809ffe9303901c80200ee',
  );
  assert.deepEqual(decodeBand(Buffer.from('09ffe9303901c802', 'hex')), {
    type: 'HS',
    frequencyHz: 12345,
    gainDb: -2.3,
    q: 4.56,
  });
  assert.deepEqual(USER_SLOTS, [4, 8, 9]);
  assert.equal(SLOTS['Hip-hop'], 7);
});

test('strict response framing ignores media keys but rejects truncated/wrong-length packets', () => {
  assert.equal(response(Buffer.from('0201', 'hex')), undefined);
  const parsed = response(Buffer.from('01bb0b00001702ffb400ee', 'hex'));
  assert.equal(parsed?.data.readInt16BE(), -76);
  assert.throws(() => response(Buffer.from('01bb0b00001702ffb400', 'hex')), /Truncated/);
  assert.throws(() => response(Buffer.from('01bb0b000017ff00ee', 'hex')), /malformed/);
  assert.throws(() => decodeBand(Buffer.from('00000003e8006412', 'hex')), /unknown filter/);
});

class Scripted implements Transport {
  writes: Buffer[] = [];
  replies: Buffer[];
  constructor(hex: string[]) {
    this.replies = hex.map((h) => Buffer.from(h, 'hex'));
  }
  async write(data: Buffer) {
    this.writes.push(data);
    return data.length;
  }
  async read() {
    if (!this.replies.length) await delay(2);
    return this.replies.shift();
  }
  async close() {}
}

test('read requires count, preamp, all indexed bands and an unchanged slot', async () => {
  const transport = new Scripted([
    '0201', // An unrelated media-key input report.
    '01bb0b000016010800ee',
    '01bb0b000018010200ee',
    '01bb0b00001702ffb400ee',
    '01bb0b0000150801000a0bb800230200ee', // Wrong band: must not complete band 0.
    '01bb0b0000150800fff30b54012c0000ee',
    '01bb0b0000150801000a0bb800230200ee',
    '01bb0b000016010800ee',
  ]);
  const state = await new Ka17(transport, 0, 50).read();
  assert.deepEqual(state, {
    slot: 8,
    preampDb: -7.6,
    bands: [
      { type: 'PK', gainDb: -1.3, frequencyHz: 2900, q: 3 },
      { type: 'HS', gainDb: 1, frequencyHz: 3000, q: 0.35 },
    ],
  });
  assert.deepEqual(
    transport.writes.map((p) => p[5]),
    [0x16, 0x18, 0x17, 0x15, 0x15, 0x16],
  );
  assert.ok(transport.writes.every((p) => p[1] === 0xbb));
});

test('missing preamp times out rather than substituting zero or proceeding', async () => {
  const transport = new Scripted(['01bb0b000016010400ee', '01bb0b000018010a00ee']);
  await assert.rejects(new Ka17(transport, 0, 10).read(), /timeout.*0x17/);
  assert.equal(transport.writes.length, 3);
});

// A simulated DSP implements the wire protocol independently of our encoder.
// It can drop a band write or corrupt a saved value to exercise verification.
class Dsp implements Transport {
  state: State = {
    slot: 4,
    preampDb: -3.2,
    bands: [{ type: 'PK', frequencyHz: 731, gainDb: -2.1, q: 1.23 }],
  };
  writes: Buffer[] = [];
  replies: Buffer[] = [];
  ignoreBand = false;
  corruptSave = false;
  disconnect = false;
  async write(p: Buffer) {
    this.writes.push(p);
    if (this.disconnect) throw new Error('disconnected');
    const command = p[5]!;
    if (p[1] === 0xaa) {
      if (command === 0x17) this.state.preampDb = p.readInt16BE(7) / 10;
      if (command === 0x18) this.state.bands.length = p[7]!;
      if (command === 0x15 && !this.ignoreBand)
        this.state.bands[p[7]!] = {
          type: (['PK', 'LS', 'HS'] as const)[p[14]!]!,
          frequencyHz: p.readUInt16BE(10),
          gainDb: p.readInt16BE(8) / 10,
          q: p.readUInt16BE(12) / 100,
        };
      if (command === 0x16) this.state.slot = p[7]!;
      if (command === 0x19 && this.corruptSave) this.state.preampDb = -1.1;
    } else {
      let data: Buffer;
      if (command === 0x16) data = Buffer.from([this.state.slot]);
      else if (command === 0x18) data = Buffer.from([this.state.bands.length]);
      else if (command === 0x17) {
        data = Buffer.alloc(2);
        data.writeInt16BE(Math.round(this.state.preampDb * 10));
      } else {
        const b = this.state.bands[p[7]!]!;
        data = Buffer.alloc(8);
        data[0] = p[7]!;
        data.writeInt16BE(Math.round(b.gainDb * 10), 1);
        data.writeUInt16BE(b.frequencyHz, 3);
        data.writeUInt16BE(Math.round(b.q * 100), 5);
        data[7] = ['PK', 'LS', 'HS'].indexOf(b.type);
      }
      this.replies.push(Buffer.from([1, 0xbb, 0x0b, 0, 0, command, data.length, ...data, 0, 0xee]));
    }
    return p.length;
  }
  async read() {
    return this.replies.shift();
  }
  async close() {}
}

const target = {
  preampDb: -6.3,
  bands: [{ type: 'HS' as const, frequencyHz: 4321, gainDb: 2.4, q: 0.71 }],
};

test('apply attenuates first, verifies before save, saves the correct slot, verifies after save', async () => {
  const dsp = new Dsp();
  dsp.state.slot = 9;
  const device = new Ka17(dsp, 0, 50);
  const result = await device.apply(target, structuredClone(dsp.state));
  assert.deepEqual(result, { slot: 9, ...target });
  const changes = dsp.writes.filter((p) => p[1] === 0xaa);
  assert.deepEqual(
    changes.map((p) => p[5]),
    [0x17, 0x18, 0x15, 0x17, 0x19],
  );
  assert.equal(changes[0]!.readInt16BE(7), -120);
  assert.equal(changes.at(-1)![7], 9);
  const saveIndex = dsp.writes.findIndex((p) => p[1] === 0xaa && p[5] === 0x19);
  assert.equal(dsp.writes[saveIndex - 1]![5], 0x16);
  assert.equal(dsp.writes[saveIndex + 1]![5], 0x16);
});

test('a dropped band write prevents saving; post-save corruption is also an error', async () => {
  const dsp = new Dsp();
  dsp.ignoreBand = true;
  await assert.rejects(
    new Ka17(dsp, 0, 50).apply(target, structuredClone(dsp.state)),
    /readback mismatch/,
  );
  assert.equal(
    dsp.writes.some((p) => p[1] === 0xaa && p[5] === 0x19),
    false,
  );
  assert.equal(dsp.state.preampDb, -12, 'Do not raise preamp after a failed band write');
  const corrupt = new Dsp();
  corrupt.corruptSave = true;
  await assert.rejects(
    new Ka17(corrupt, 0, 50).apply(target, structuredClone(corrupt.state)),
    /preampDb/,
  );
});

test('factory slots, stale backups, disconnects and short writes never proceed to save', async () => {
  const dsp = new Dsp();
  const device = new Ka17(dsp, 0, 50);
  await assert.rejects(device.apply(target, { ...dsp.state, slot: 7 }), /USER slot/);
  assert.equal(dsp.writes.length, 0);
  await assert.rejects(
    device.apply(target, { ...dsp.state, preampDb: -9 }),
    /changed since backup/,
  );
  assert.ok(dsp.writes.every((p) => p[1] === 0xbb));
  await assert.rejects(device.select(7), /Only USER/);
  dsp.disconnect = true;
  await assert.rejects(device.apply(target, structuredClone(dsp.state)), /disconnected/);
  const short = new Scripted([]);
  short.write = async () => 1;
  await assert.rejects(new Ka17(short, 0, 10).read(), /Short HID write/);
});
