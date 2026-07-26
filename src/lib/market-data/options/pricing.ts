/**
 * Deterministic option pricing used ONLY to fill IV/Greeks the provider did not
 * supply. Nothing here invents market data:
 *
 *  - every input is a real observed value (option mark, strike, spot, expiry);
 *  - the discount factor and forward price are SOLVED from the chain itself via
 *    put–call parity, so no interest rate, dividend yield or carry assumption is
 *    hardcoded anywhere;
 *  - when any required input is missing, or the solver does not converge inside
 *    its tolerance, the result is `null` and the UI renders "—".
 *
 * Values produced here are tagged `nexora-derived` by the caller and must never
 * be presented as provider figures.
 *
 * Model: Black–76 on the market-implied forward, which is the standard
 * arbitrage-free parameterisation for listed equity options and avoids needing a
 * separate dividend assumption. Spot Greeks are obtained by the chain rule
 * dF/dS = F/S, valid because the forward is proportional to spot.
 */

/** Trading inputs for one contract, all provider-observed. */
export interface OptionPricingInput {
  type: 'call' | 'put';
  strike: number;
  /** Observed option price (mark/mid). Must be a real, positive quote. */
  optionPrice: number;
  /** Accepted underlying price. */
  spot: number;
  /** Year fraction to expiry, ACT/365. */
  timeToExpiryYears: number;
  /** Market-implied discount factor for the expiry, from {@link solveForwardCurve}. */
  discountFactor: number;
  /** Market-implied forward price for the expiry, from {@link solveForwardCurve}. */
  forward: number;
}

export interface OptionGreeks {
  delta: number;
  gamma: number;
  /** Per calendar day, matching how providers quote theta. */
  theta: number;
  /** Per 1 volatility point (1%), matching how providers quote vega. */
  vega: number;
}

export interface ForwardCurve {
  discountFactor: number;
  forward: number;
}

/** One strike where BOTH a call and a put have a real observed price. */
export interface ParityObservation {
  strike: number;
  callPrice: number;
  putPrice: number;
}

const SQRT_2PI = Math.sqrt(2 * Math.PI);

function isPositive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

/**
 * Abramowitz–Stegun 7.1.26 error function, giving ~1e-7 absolute accuracy — far
 * inside the precision any option quote carries, and fully deterministic across
 * platforms (unlike relying on a host `Math.erf`, which does not exist).
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absolute = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absolute);
  const poly = t * (0.254829592
    + t * (-0.284496736
      + t * (1.421413741
        + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-absolute * absolute));
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Solve the discount factor and forward for one expiry from put–call parity.
 *
 * Parity states `C - K` is affine in the strike: `C − P = DF·F − DF·K`. Fitting
 * that line across every strike that has a real two-sided call AND put price
 * yields the slope `−DF` and intercept `DF·F`, so both the discount factor and
 * the forward fall out of observed prices alone. At least two distinct strikes
 * are required; a degenerate or economically impossible fit returns null rather
 * than a guessed rate.
 */
export function solveForwardCurve(
  observations: readonly ParityObservation[],
  timeToExpiryYears: number,
): ForwardCurve | null {
  if (!Number.isFinite(timeToExpiryYears) || timeToExpiryYears <= 0) return null;
  const usable = observations.filter((row) =>
    isPositive(row.strike) && isPositive(row.callPrice) && isPositive(row.putPrice));
  const strikes = new Set(usable.map((row) => row.strike));
  if (usable.length < 2 || strikes.size < 2) return null;

  const count = usable.length;
  let sumK = 0;
  let sumY = 0;
  let sumKK = 0;
  let sumKY = 0;
  for (const row of usable) {
    const y = row.callPrice - row.putPrice;
    sumK += row.strike;
    sumY += y;
    sumKK += row.strike * row.strike;
    sumKY += row.strike * y;
  }
  const denominator = count * sumKK - sumK * sumK;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return null;
  const slope = (count * sumKY - sumK * sumY) / denominator;
  const intercept = (sumY - slope * sumK) / count;

  const discountFactor = -slope;
  // A discount factor outside (0, 1] would imply a negative price of time or a
  // nonsensical negative rate far beyond anything a listed chain can express.
  if (!Number.isFinite(discountFactor) || discountFactor <= 0 || discountFactor > 1.0000001) return null;
  const forward = intercept / discountFactor;
  if (!isPositive(forward)) return null;
  return { discountFactor: Math.min(discountFactor, 1), forward };
}

/** Undiscounted Black–76 price of a call/put on the forward. */
export function black76Price(input: Omit<OptionPricingInput, 'optionPrice' | 'spot'> & { volatility: number }): number | null {
  const { type, strike, timeToExpiryYears, discountFactor, forward, volatility } = input;
  if (!isPositive(strike) || !isPositive(forward) || !isPositive(discountFactor)) return null;
  if (!Number.isFinite(timeToExpiryYears) || timeToExpiryYears <= 0) return null;
  if (!Number.isFinite(volatility) || volatility <= 0) return null;
  const stdDev = volatility * Math.sqrt(timeToExpiryYears);
  if (!Number.isFinite(stdDev) || stdDev <= 0) return null;
  const d1 = (Math.log(forward / strike) + 0.5 * stdDev * stdDev) / stdDev;
  const d2 = d1 - stdDev;
  const price = type === 'call'
    ? discountFactor * (forward * normalCdf(d1) - strike * normalCdf(d2))
    : discountFactor * (strike * normalCdf(-d2) - forward * normalCdf(-d1));
  return Number.isFinite(price) ? price : null;
}

const MIN_VOLATILITY = 1e-4;
const MAX_VOLATILITY = 5;
const PRICE_TOLERANCE = 1e-8;
const MAX_BISECTION_STEPS = 100;

/**
 * Implied volatility by bisection on a monotonically increasing price/vol curve.
 *
 * Bisection is chosen over Newton deliberately: it cannot diverge on the
 * near-zero-vega wings where listed quotes are noisiest, and it is bit-for-bit
 * reproducible. Returns null when the observed price sits outside the model's
 * no-arbitrage band `[intrinsic, DF·F]` (a stale or crossed quote), or when the
 * solution would land on the clamped boundary, where the number would be an
 * artefact of the bracket rather than a measurement.
 */
export function solveImpliedVolatility(input: OptionPricingInput): number | null {
  const { type, strike, optionPrice, timeToExpiryYears, discountFactor, forward } = input;
  if (!isPositive(strike) || !isPositive(optionPrice) || !isPositive(forward) || !isPositive(discountFactor)) return null;
  if (!Number.isFinite(timeToExpiryYears) || timeToExpiryYears <= 0) return null;

  const intrinsic = type === 'call'
    ? Math.max(0, discountFactor * (forward - strike))
    : Math.max(0, discountFactor * (strike - forward));
  const upperBound = type === 'call' ? discountFactor * forward : discountFactor * strike;
  if (optionPrice <= intrinsic || optionPrice >= upperBound) return null;

  let low = MIN_VOLATILITY;
  let high = MAX_VOLATILITY;
  const priceAt = (volatility: number) => black76Price({ type, strike, timeToExpiryYears, discountFactor, forward, volatility });
  const lowPrice = priceAt(low);
  const highPrice = priceAt(high);
  if (lowPrice === null || highPrice === null) return null;
  // Outside the solvable bracket the answer would be the clamp, not a solution.
  if (optionPrice <= lowPrice || optionPrice >= highPrice) return null;

  for (let step = 0; step < MAX_BISECTION_STEPS; step += 1) {
    const mid = 0.5 * (low + high);
    const price = priceAt(mid);
    if (price === null) return null;
    const difference = price - optionPrice;
    if (Math.abs(difference) < PRICE_TOLERANCE) return mid;
    if (difference > 0) high = mid; else low = mid;
  }
  const solution = 0.5 * (low + high);
  return Number.isFinite(solution) && solution > MIN_VOLATILITY && solution < MAX_VOLATILITY ? solution : null;
}

/**
 * Spot Greeks from a known volatility, in the same units providers quote:
 * delta/gamma per $1 of underlying, theta per calendar day, vega per 1% of IV.
 *
 * The forward is proportional to spot (`F = S·DF_carry⁻¹`), so `dF/dS = F/S`
 * converts every forward-space derivative into spot space exactly.
 */
export function black76Greeks(
  input: Omit<OptionPricingInput, 'optionPrice'> & { volatility: number },
): OptionGreeks | null {
  const { type, strike, spot, timeToExpiryYears, discountFactor, forward, volatility } = input;
  if (!isPositive(strike) || !isPositive(spot) || !isPositive(forward) || !isPositive(discountFactor)) return null;
  if (!Number.isFinite(timeToExpiryYears) || timeToExpiryYears <= 0) return null;
  if (!Number.isFinite(volatility) || volatility <= 0) return null;

  const sqrtT = Math.sqrt(timeToExpiryYears);
  const stdDev = volatility * sqrtT;
  if (!Number.isFinite(stdDev) || stdDev <= 0) return null;
  const d1 = (Math.log(forward / strike) + 0.5 * stdDev * stdDev) / stdDev;
  const d2 = d1 - stdDev;
  const forwardPerSpot = forward / spot;

  const forwardDelta = type === 'call' ? normalCdf(d1) : normalCdf(d1) - 1;
  const delta = discountFactor * forwardDelta * forwardPerSpot;
  const gamma = discountFactor * normalPdf(d1) / (forward * stdDev) * forwardPerSpot * forwardPerSpot;
  // Vega is identical for calls and puts; scaled to "per 1 volatility point".
  const vega = discountFactor * forward * normalPdf(d1) * sqrtT / 100;

  // Annual theta of the discounted Black–76 price, converted to per-day.
  const carry = -discountFactor * forward * normalPdf(d1) * volatility / (2 * sqrtT);
  const rate = -Math.log(discountFactor) / timeToExpiryYears;
  const discounting = type === 'call'
    ? rate * discountFactor * (forward * normalCdf(d1) - strike * normalCdf(d2))
    : rate * discountFactor * (strike * normalCdf(-d2) - forward * normalCdf(-d1));
  const theta = (carry + discounting) / 365;

  const greeks = { delta, gamma, theta, vega };
  return Object.values(greeks).every((value) => Number.isFinite(value)) ? greeks : null;
}

/** ACT/365 year fraction between two instants; null when the expiry is not in the future. */
export function yearsToExpiry(asOfMs: number, expiryMs: number): number | null {
  if (!Number.isFinite(asOfMs) || !Number.isFinite(expiryMs)) return null;
  const years = (expiryMs - asOfMs) / (365 * 24 * 60 * 60 * 1_000);
  return years > 0 ? years : null;
}

/**
 * US listed equity options expire at 16:00 America/New_York on the expiration
 * date. `-04:00`/`-05:00` is resolved from the date itself rather than assumed,
 * so DTE stays correct across the daylight-saving boundary.
 */
export function optionExpiryInstantMs(expiration: string, timeZone = 'America/New_York'): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) return null;
  const naive = Date.parse(`${expiration}T16:00:00.000Z`);
  if (Number.isNaN(naive)) return null;
  const zoned = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(naive));
  const part = (type: string) => Number(zoned.find((item) => item.type === type)?.value);
  const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  // `asUtc - naive` is the zone's UTC offset at that instant (negative for New
  // York). Subtracting it shifts the naive instant so its New York wall clock
  // reads 16:00. A single pass is exact here because 16:00 never lands near the
  // 02:00 daylight-saving transition.
  const offsetMs = asUtc - naive;
  return naive - offsetMs;
}
