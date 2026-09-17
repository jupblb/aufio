// KA17 packet layout derived from devicePEQ; see THIRD_PARTY_NOTICES.md.
export const VENDOR_ID = 0x2972;
export const PRODUCT_ID = 0x0093;
export const REPORT_ID = 1;
export const COMMAND = { band: 0x15, slot: 0x16, preamp: 0x17, count: 0x18, save: 0x19 };
export const SLOTS = {
  Jazz: 0,
  Pop: 1,
  Rock: 2,
  Dance: 3,
  USER1: 4,
  'R&B': 5,
  Classic: 6,
  'Hip-hop': 7,
  USER2: 8,
  USER3: 9,
  BYPASS: 10,
};
export const USER_SLOTS = [SLOTS.USER1, SLOTS.USER2, SLOTS.USER3];
export const SELECTABLE_SLOTS = {
  USER1: SLOTS.USER1,
  USER2: SLOTS.USER2,
  USER3: SLOTS.USER3,
  BYPASS: SLOTS.BYPASS,
};
export const FILTER_TYPES = ['PK', 'LS', 'HS', 'BP', 'LP', 'HP', 'AP'] as const;
export type FilterType = (typeof FILTER_TYPES)[number];
export interface Band {
  type: FilterType;
  frequencyHz: number;
  gainDb: number;
  q: number;
}
export interface Eq {
  preampDb: number;
  bands: Band[];
}
export interface State extends Eq {
  slot: number;
}

export function slotName(id: number): string {
  return Object.entries(SLOTS).find(([, value]) => value === id)?.[0] ?? `UNKNOWN(${id})`;
}

// The descriptor defines 32 payload bytes plus the HID report-ID byte.
export function packet(write: boolean, command: number, data: number[] = []): Buffer {
  if (data.length > 24) throw new Error('HID payload too long');
  const result = Buffer.alloc(33);
  result.set([
    REPORT_ID,
    write ? 0xaa : 0xbb,
    write ? 0x0a : 0x0b,
    0,
    0,
    command,
    data.length,
    ...data,
    0,
    0xee,
  ]);
  return result;
}

export function response(report: Buffer): { command: number; data: Buffer } | undefined {
  // Native HID includes a leading report ID (unlike WebHID). Skip media keys
  // and write acknowledgements; reads have BB 0B, a length byte at offset 6,
  // then data at offset 7 followed by 00 EE. Trailing USB padding is ignored.
  if (report[0] !== REPORT_ID || report[1] !== 0xbb || report[2] !== 0x0b) return;
  if (report.length < 9 || report[3] !== 0 || report[4] !== 0)
    throw new Error('Malformed KA17 response');
  const length = report[6]!;
  if (
    length > 24 ||
    report.length < length + 9 ||
    report[7 + length] !== 0 ||
    report[8 + length] !== 0xee
  ) {
    throw new Error('Truncated or malformed KA17 response');
  }
  return { command: report[5]!, data: report.subarray(7, 7 + length) };
}

export function signedGain(value: number): number[] {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(Math.round(value * 10));
  return [...bytes];
}

export function bandBytes(index: number, band: Band): number[] {
  const bytes = Buffer.alloc(8);
  bytes[0] = index;
  bytes.writeInt16BE(Math.round(band.gainDb * 10), 1);
  bytes.writeUInt16BE(Math.round(band.frequencyHz), 3);
  bytes.writeUInt16BE(Math.round(band.q * 100), 5);
  bytes[7] = FILTER_TYPES.indexOf(band.type);
  return [...bytes];
}

export function decodeBand(bytes: Buffer): Band {
  const type = FILTER_TYPES[bytes[7]!];
  if (bytes.length !== 8 || !type) throw new Error('Invalid band response or unknown filter type');
  return {
    type,
    gainDb: bytes.readInt16BE(1) / 10,
    frequencyHz: bytes.readUInt16BE(3),
    q: bytes.readUInt16BE(5) / 100,
  };
}

export function difference(expected: Eq, actual: Eq): string[] {
  const differences: string[] = [];
  if (expected.preampDb !== actual.preampDb)
    differences.push(`preampDb: expected ${expected.preampDb}, got ${actual.preampDb}`);
  if (expected.bands.length !== actual.bands.length)
    differences.push(`band count: expected ${expected.bands.length}, got ${actual.bands.length}`);
  expected.bands.forEach((band, index) => {
    for (const key of ['type', 'frequencyHz', 'gainDb', 'q'] as const) {
      if (band[key] !== actual.bands[index]?.[key])
        differences.push(
          `bands[${index}].${key}: expected ${band[key]}, got ${actual.bands[index]?.[key]}`,
        );
    }
  });
  return differences;
}
