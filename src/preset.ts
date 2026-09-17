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

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

function number(value: unknown, label: string, min: number, max: number, scale?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a finite number in [${min}, ${max}]`);
  }
  if (scale && Math.abs(value * scale - Math.round(value * scale)) > 1e-7) throw new Error(`${label} must use steps of ${1 / scale}`);
  return value;
}

export function parseEq(value: unknown, qMode = 'device'): Eq {
  const eq = object(value);
  const preampDb = number(eq.preampDb, 'preampDb', -12, 12, 10);
  if (!Array.isArray(eq.bands) || eq.bands.length < 1 || eq.bands.length > 10) throw new Error('Expected 1–10 bands');
  const bands = eq.bands.map((value, index): Band => {
    const band = object(value);
    if (Object.keys(band).some(k => !['type', 'frequencyHz', 'gainDb', 'q'].includes(k))) throw new Error(`Unknown field in band ${index}`);
    if (!FILTER_TYPES.includes(band.type as Band['type'])) throw new Error(`Unknown filter type in band ${index}`);
    return {
      type: band.type as Band['type'],
      frequencyHz: number(band.frequencyHz, `band ${index} frequencyHz`, 20, 20000, 1),
      gainDb: number(band.gainDb, `band ${index} gainDb`, -12, 12, 10),
      q: number(band.q, `band ${index} q`, 0.1, 10, qMode === 'device' ? 100 : undefined),
    };
  });
  return { preampDb, bands };
}

export function parsePreset(value: unknown): Preset {
  const p = object(value);
  const allowed = ['schemaVersion', 'kind', 'name', 'headphone', 'notes', 'qMode', 'preampDb', 'bands'];
  if (Object.keys(p).some(k => !allowed.includes(k))) throw new Error('Unknown preset field');
  if (p.schemaVersion !== 1 || p.kind !== 'ka17-preset') throw new Error('Expected a version-1 ka17-preset');
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('Preset name is required');
  if (p.qMode !== 'device' && p.qMode !== 'rbj-peak') throw new Error('qMode must be device or rbj-peak');
  if (typeof p.headphone !== 'string' || typeof p.notes !== 'string') throw new Error('headphone and notes must be strings');
  return { schemaVersion: 1, kind: 'ka17-preset', name: p.name, headphone: p.headphone, notes: p.notes, qMode: p.qMode, ...parseEq(p, p.qMode) };
}

export function toDevice(preset: Preset): Eq {
  return {
    preampDb: preset.preampDb,
    bands: preset.bands.map(band => {
      // No silent fallback to PK for filters that this tuning implementation
      // does not yet model. Snapshots can still preserve/restore all 7 types.
      if (!['PK', 'LS', 'HS'].includes(band.type)) throw new Error(`Tuning supports PK, LS, HS only; ${band.type} can only be restored from a device snapshot`);
      const q = preset.qMode === 'rbj-peak' && band.type === 'PK' ? band.q * 10 ** (Math.abs(band.gainDb) / 40) : band.q;
      if (q < 0.1 || q > 10) throw new Error(`Compensated Q ${q} is outside [0.1, 10]; refusing to clamp`);
      return { ...band, q: Math.round(q * 100) / 100 };
    }),
  };
}

export function fromDevice(name: string, eq: Eq): Preset {
  return { schemaVersion: 1, kind: 'ka17-preset', name, headphone: 'HiFiMan Arya Unveiled', notes: 'Captured from KA17; Q values are raw device values.', qMode: 'device', preampDb: eq.preampDb, bands: eq.bands };
}

// RBJ response estimate, not a measurement or a guarantee of unclipped audio.
// Only peaking Q has KA17-specific compensation evidence; shelf response is
// approximate. Check multiple common sample rates and retain 1 dB margin.
export function magnitudeDb(band: Band, hz: number, sampleRate: number): number {
  const a = 10 ** (band.gainDb / 40);
  const w = 2 * Math.PI * band.frequencyHz / sampleRate;
  const c = Math.cos(w);
  const q = band.type === 'PK' ? band.q / 10 ** (Math.abs(band.gainDb) / 40) : band.q;
  const alpha = Math.sin(w) / (2 * q);
  const beta = 2 * Math.sqrt(a) * alpha;
  let b: number[], d: number[];
  if (band.type === 'PK') {
    b = [1 + alpha * a, -2 * c, 1 - alpha * a];
    d = [1 + alpha / a, -2 * c, 1 - alpha / a];
  } else if (band.type === 'LS') {
    b = [a * ((a + 1) - (a - 1) * c + beta), 2 * a * ((a - 1) - (a + 1) * c), a * ((a + 1) - (a - 1) * c - beta)];
    d = [(a + 1) + (a - 1) * c + beta, -2 * ((a - 1) + (a + 1) * c), (a + 1) + (a - 1) * c - beta];
  } else if (band.type === 'HS') {
    b = [a * ((a + 1) + (a - 1) * c + beta), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - beta)];
    d = [(a + 1) - (a - 1) * c + beta, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - beta];
  } else throw new Error(`Cannot estimate response of ${band.type}`);
  const x = 2 * Math.PI * hz / sampleRate;
  const power = (v: number[]) => (v[0]! + v[1]! * Math.cos(x) + v[2]! * Math.cos(2 * x)) ** 2 + (v[1]! * Math.sin(x) + v[2]! * Math.sin(2 * x)) ** 2;
  return 10 * Math.log10(power(b) / power(d));
}

export function headroom(eq: Eq): { estimatedPeakDb: number; recommendedPreampDb: number; fitsPreampRange: boolean; warning: string } {
  let peak = 0;
  for (const rate of [44100, 48000, 96000, 192000]) {
    const frequencies = [0, rate / 2, ...eq.bands.map(b => b.frequencyHz)];
    for (let i = 0; i <= 2048; i++) frequencies.push(10 * ((rate / 2) / 10) ** (i / 2048));
    for (const hz of frequencies) {
      const db = eq.bands.reduce((sum, band) => sum + magnitudeDb(band, hz, rate), 0);
      if (!Number.isFinite(db)) throw new Error('Non-finite headroom estimate');
      peak = Math.max(peak, db);
    }
  }
  const recommendedPreampDb = -Math.ceil((peak + 1) * 10) / 10;
  return {
    estimatedPeakDb: Math.round((peak + eq.preampDb) * 100) / 100,
    recommendedPreampDb,
    fitsPreampRange: recommendedPreampDb >= -12,
    warning: 'Model estimate only; shelves are not acoustically verified on this KA17. Recommendation includes 1 dB margin. Keep listening volume low when changing EQ.',
  };
}
