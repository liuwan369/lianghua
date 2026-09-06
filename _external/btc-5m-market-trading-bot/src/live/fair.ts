/** Standard normal CDF via Abramowitz & Stegun 7.1.26 erf approximation (|err| < 1.5e-7). */
export function normalCdf(z: number): number {
  return 0.5 * (1.0 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1.0 : 1.0;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const y =
    1.0 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax));
  return sign * y;
}

/** Fair value (win probability ≈ price) of the UP token. `secsLeft<=0` → hard 1/0 at the strike. */
export function fairUp(
  btc: number,
  strike: number,
  secsLeft: number,
  sigmaPerSqrtSec: number,
): number {
  if (secsLeft <= 0.0 || sigmaPerSqrtSec <= 0.0) {
    return btc >= strike ? 1.0 : 0.0;
  }
  const sd = sigmaPerSqrtSec * Math.sqrt(secsLeft);
  if (sd <= 0.0) {
    return btc >= strike ? 1.0 : 0.0;
  }
  return normalCdf((btc - strike) / sd);
}

/** Fair value of UP from fractional BTC move since market open. */
export function fairUpFromChange(
  changePct: number | undefined,
  secsLeft: number,
  sigmaPctPerSqrtSec: number,
): number | undefined {
  if (changePct == null) return undefined;
  if (secsLeft <= 0.0 || sigmaPctPerSqrtSec <= 0.0) return undefined;
  const sd = sigmaPctPerSqrtSec * Math.sqrt(secsLeft);
  if (sd <= 0.0) return undefined;
  return normalCdf(changePct / sd);
}
