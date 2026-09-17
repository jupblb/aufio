import type { Band, Eq } from './protocol.ts';

type Coefficients = [number, number, number];
interface Biquad {
  numerator: Coefficients;
  denominator: Coefficients;
}

export interface Headroom {
  estimatedPeakDb: number;
  recommendedPreampDb: number;
  fitsPreampRange: boolean;
  warning: string;
}

// KA17 peaks are wider than an RBJ peak with the same stored Q. Multiply by
// this factor when writing an RBJ Q; divide when modelling a stored device Q.
export function peakingQFactor(gainDb: number): number {
  return 10 ** (Math.abs(gainDb) / 40);
}

function coefficients(band: Band, sampleRate: number): Biquad {
  const amplitude = 10 ** (band.gainDb / 40);
  const angle = (2 * Math.PI * band.frequencyHz) / sampleRate;
  const cosine = Math.cos(angle);
  const q = band.type === 'PK' ? band.q / peakingQFactor(band.gainDb) : band.q;
  const alpha = Math.sin(angle) / (2 * q);
  const beta = 2 * Math.sqrt(amplitude) * alpha;

  // RBJ biquad coefficients, in [b0, b1, b2] / [a0, a1, a2] order.
  // The ratio cancels a0, so no separate coefficient normalization is needed.
  // Only the peaking Q correction is measured on KA17; shelves are approximate.
  switch (band.type) {
    case 'PK':
      return {
        numerator: [1 + alpha * amplitude, -2 * cosine, 1 - alpha * amplitude],
        denominator: [1 + alpha / amplitude, -2 * cosine, 1 - alpha / amplitude],
      };
    case 'LS':
      return {
        numerator: [
          amplitude * (amplitude + 1 - (amplitude - 1) * cosine + beta),
          2 * amplitude * (amplitude - 1 - (amplitude + 1) * cosine),
          amplitude * (amplitude + 1 - (amplitude - 1) * cosine - beta),
        ],
        denominator: [
          amplitude + 1 + (amplitude - 1) * cosine + beta,
          -2 * (amplitude - 1 + (amplitude + 1) * cosine),
          amplitude + 1 + (amplitude - 1) * cosine - beta,
        ],
      };
    case 'HS':
      return {
        numerator: [
          amplitude * (amplitude + 1 + (amplitude - 1) * cosine + beta),
          -2 * amplitude * (amplitude - 1 + (amplitude + 1) * cosine),
          amplitude * (amplitude + 1 + (amplitude - 1) * cosine - beta),
        ],
        denominator: [
          amplitude + 1 - (amplitude - 1) * cosine + beta,
          2 * (amplitude - 1 - (amplitude + 1) * cosine),
          amplitude + 1 - (amplitude - 1) * cosine - beta,
        ],
      };
    default:
      throw new Error(`Cannot estimate response of ${band.type}`);
  }
}

function polynomialPower([c0, c1, c2]: Coefficients, angle: number): number {
  // Squared magnitude of c0 + c1·e^(-jω) + c2·e^(-2jω).
  const real = c0 + c1 * Math.cos(angle) + c2 * Math.cos(2 * angle);
  const imaginary = c1 * Math.sin(angle) + c2 * Math.sin(2 * angle);
  return real ** 2 + imaginary ** 2;
}

// This estimates frequency response; it does not measure the connected DAC.
export function magnitudeDb(band: Band, hz: number, sampleRate: number): number {
  const { numerator, denominator } = coefficients(band, sampleRate);
  const angle = (2 * Math.PI * hz) / sampleRate;
  return 10 * Math.log10(polynomialPower(numerator, angle) / polynomialPower(denominator, angle));
}

export function headroom(eq: Eq): Headroom {
  let peak = 0;
  for (const rate of [44100, 48000, 96000, 192000]) {
    // Include DC, Nyquist and exact filter centers as well as a log-spaced
    // scan, so narrow peaks don't rely entirely on the grid hitting a center.
    const frequencies = [0, rate / 2, ...eq.bands.map((band) => band.frequencyHz)];
    for (let i = 0; i <= 2048; i++) frequencies.push(10 * (rate / 2 / 10) ** (i / 2048));
    for (const hz of frequencies) {
      const db = eq.bands.reduce((sum, band) => sum + magnitudeDb(band, hz, rate), 0);
      if (!Number.isFinite(db)) throw new Error('Non-finite headroom estimate');
      peak = Math.max(peak, db);
    }
  }

  // Cascaded filter gains add in dB. Recommend attenuation for the combined
  // peak plus 1 dB margin, rounded towards more attenuation in 0.1 dB steps.
  const recommendedPreampDb = -Math.ceil((peak + 1) * 10) / 10;
  return {
    estimatedPeakDb: Math.round((peak + eq.preampDb) * 100) / 100,
    recommendedPreampDb,
    fitsPreampRange: recommendedPreampDb >= -12,
    warning:
      'Model estimate only; shelves are not acoustically verified on this KA17. Recommendation includes 1 dB margin. Keep listening volume low when changing EQ.',
  };
}
