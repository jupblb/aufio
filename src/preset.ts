import { peakingQFactor } from './dsp.ts';
import { FILTER_TYPES } from './protocol.ts';
import type { Band, Eq } from './protocol.ts';

export interface Preset extends Eq {
  schemaVersion: 1;
  kind: 'ka17-preset';
  name: string;
  headphone: string;
  notes: string;
  qMode: 'device' | 'rbj-peak';
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

function numberInRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
  scale?: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a finite number in [${min}, ${max}]`);
  }
  // Values must land on integer device units (tenths of dB, hundredths of Q).
  // The tolerance permits floating-point roundoff, not extra precision.
  if (scale && Math.abs(value * scale - Math.round(value * scale)) > 1e-7)
    throw new Error(`${label} must use steps of ${1 / scale}`);
  return value;
}

export function parseEq(value: unknown, qMode = 'device'): Eq {
  const eq = parseObject(value);
  const preampDb = numberInRange(eq.preampDb, 'preampDb', -12, 12, 10);
  if (!Array.isArray(eq.bands) || eq.bands.length < 1 || eq.bands.length > 10)
    throw new Error('Expected 1–10 bands');
  const bands = eq.bands.map((value, index): Band => {
    const band = parseObject(value);
    if (Object.keys(band).some((k) => !['type', 'frequencyHz', 'gainDb', 'q'].includes(k)))
      throw new Error(`Unknown field in band ${index}`);
    if (!FILTER_TYPES.includes(band.type as Band['type']))
      throw new Error(`Unknown filter type in band ${index}`);
    return {
      type: band.type as Band['type'],
      frequencyHz: numberInRange(band.frequencyHz, `band ${index} frequencyHz`, 20, 20000, 1),
      gainDb: numberInRange(band.gainDb, `band ${index} gainDb`, -12, 12, 10),
      q: numberInRange(band.q, `band ${index} q`, 0.1, 10, qMode === 'device' ? 100 : undefined),
    };
  });
  return { preampDb, bands };
}

export function parsePreset(value: unknown): Preset {
  const preset = parseObject(value);
  const allowed = [
    'schemaVersion',
    'kind',
    'name',
    'headphone',
    'notes',
    'qMode',
    'preampDb',
    'bands',
  ];
  if (Object.keys(preset).some((key) => !allowed.includes(key)))
    throw new Error('Unknown preset field');
  if (preset.schemaVersion !== 1 || preset.kind !== 'ka17-preset')
    throw new Error('Expected a version-1 ka17-preset');
  if (typeof preset.name !== 'string' || !preset.name.trim())
    throw new Error('Preset name is required');
  if (preset.qMode !== 'device' && preset.qMode !== 'rbj-peak')
    throw new Error('qMode must be device or rbj-peak');
  if (typeof preset.headphone !== 'string' || typeof preset.notes !== 'string')
    throw new Error('headphone and notes must be strings');
  return {
    schemaVersion: 1,
    kind: 'ka17-preset',
    name: preset.name,
    headphone: preset.headphone,
    notes: preset.notes,
    qMode: preset.qMode,
    ...parseEq(preset, preset.qMode),
  };
}

export function toDevice(preset: Preset): Eq {
  return {
    preampDb: preset.preampDb,
    bands: preset.bands.map((band) => {
      // No silent fallback to PK for filters that this tuning implementation
      // does not yet model. Snapshots can still preserve/restore all 7 types.
      if (!['PK', 'LS', 'HS'].includes(band.type))
        throw new Error(
          `Tuning supports PK, LS, HS only; ${band.type} can only be restored from a device snapshot`,
        );
      const q =
        preset.qMode === 'rbj-peak' && band.type === 'PK'
          ? band.q * peakingQFactor(band.gainDb)
          : band.q;
      if (q < 0.1 || q > 10)
        throw new Error(`Compensated Q ${q} is outside [0.1, 10]; refusing to clamp`);
      return { ...band, q: Math.round(q * 100) / 100 };
    }),
  };
}

export function fromDevice(name: string, eq: Eq): Preset {
  return {
    schemaVersion: 1,
    kind: 'ka17-preset',
    name,
    headphone: 'HiFiMan Arya Unveiled',
    notes: 'Captured from KA17; Q values are raw device values.',
    qMode: 'device',
    preampDb: eq.preampDb,
    bands: eq.bands,
  };
}
