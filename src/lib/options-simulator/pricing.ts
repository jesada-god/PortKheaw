import type { ExerciseStyle, Greeks, OptionKind } from './types';

export interface PricingInput {
  spot: number;
  strike: number;
  timeYears: number;
  volatility: number;
  rate: number;
  dividendYield: number;
  kind: OptionKind;
  style: ExerciseStyle;
}

const ZERO_GREEKS: Greeks = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };

function normalPdf(value: number): number {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

export function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export function intrinsicValue(spot: number, strike: number, kind: OptionKind): number {
  return Math.max(0, kind === 'call' ? spot - strike : strike - spot);
}

export function blackScholes(input: Omit<PricingInput, 'style'>): { value: number; greeks: Greeks } {
  const { spot, strike, timeYears, volatility, rate, dividendYield, kind } = input;
  if (![spot, strike, timeYears, volatility, rate, dividendYield].every(Number.isFinite) || spot <= 0 || strike <= 0 || volatility <= 0 || timeYears < 0) {
    throw new Error('Black-Scholes inputs must be finite with positive spot, strike and volatility');
  }
  if (timeYears === 0) return { value: intrinsicValue(spot, strike, kind), greeks: ZERO_GREEKS };
  const sqrtT = Math.sqrt(timeYears);
  const d1 = (Math.log(spot / strike) + (rate - dividendYield + 0.5 * volatility ** 2) * timeYears) / (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  const spotDiscount = Math.exp(-dividendYield * timeYears);
  const strikeDiscount = Math.exp(-rate * timeYears);
  const direction = kind === 'call' ? 1 : -1;
  const value = direction * (spot * spotDiscount * normalCdf(direction * d1) - strike * strikeDiscount * normalCdf(direction * d2));
  const delta = kind === 'call' ? spotDiscount * normalCdf(d1) : spotDiscount * (normalCdf(d1) - 1);
  const gamma = spotDiscount * normalPdf(d1) / (spot * volatility * sqrtT);
  const commonTheta = -(spot * spotDiscount * normalPdf(d1) * volatility) / (2 * sqrtT);
  const thetaAnnual = kind === 'call'
    ? commonTheta - rate * strike * strikeDiscount * normalCdf(d2) + dividendYield * spot * spotDiscount * normalCdf(d1)
    : commonTheta + rate * strike * strikeDiscount * normalCdf(-d2) - dividendYield * spot * spotDiscount * normalCdf(-d1);
  const vega = spot * spotDiscount * normalPdf(d1) * sqrtT;
  const rho = kind === 'call'
    ? strike * timeYears * strikeDiscount * normalCdf(d2)
    : -strike * timeYears * strikeDiscount * normalCdf(-d2);
  return { value, greeks: { delta, gamma, theta: thetaAnnual / 365, vega: vega / 100, rho: rho / 100 } };
}

export function binomialValue(input: PricingInput, steps = 200): number {
  const { spot, strike, timeYears, volatility, rate, dividendYield, kind, style } = input;
  if (timeYears <= 0) return intrinsicValue(spot, strike, kind);
  const count = Math.max(2, Math.floor(steps));
  const dt = timeYears / count;
  const up = Math.exp(volatility * Math.sqrt(dt));
  const down = 1 / up;
  const probability = (Math.exp((rate - dividendYield) * dt) - down) / (up - down);
  if (probability < 0 || probability > 1) throw new Error('Binomial inputs imply an invalid risk-neutral probability');
  const discount = Math.exp(-rate * dt);
  const nodeRatio = down / up;
  const values = new Array<number>(count + 1);
  let nodeSpot = spot * up ** count;
  for (let index = 0; index <= count; index += 1) {
    values[index] = intrinsicValue(nodeSpot, strike, kind);
    nodeSpot *= nodeRatio;
  }
  for (let step = count - 1; step >= 0; step -= 1) {
    nodeSpot = spot * up ** step;
    for (let index = 0; index <= step; index += 1) {
      const continuation = discount * (probability * values[index] + (1 - probability) * values[index + 1]);
      values[index] = style === 'american'
        ? Math.max(continuation, intrinsicValue(nodeSpot, strike, kind))
        : continuation;
      nodeSpot *= nodeRatio;
    }
  }
  return values[0];
}

/** Price-only path for batch calculations that do not consume Greeks. */
export function priceOptionValue(input: PricingInput): number {
  return input.style === 'european'
    ? blackScholes(input).value
    : binomialValue(input);
}

function finiteDifferenceGreeks(input: PricingInput): Greeks {
  const price = (overrides: Partial<PricingInput>) => binomialValue({ ...input, ...overrides });
  const spotStep = Math.max(input.spot * 0.001, 0.01);
  const volStep = 0.0001;
  const rateStep = 0.0001;
  const base = price({});
  const up = price({ spot: input.spot + spotStep });
  const down = price({ spot: Math.max(0.0001, input.spot - spotStep) });
  return {
    delta: (up - down) / (2 * spotStep),
    gamma: (up - 2 * base + down) / (spotStep ** 2),
    theta: input.timeYears > 1 / 365 ? price({ timeYears: input.timeYears - 1 / 365 }) - base : intrinsicValue(input.spot, input.strike, input.kind) - base,
    vega: (price({ volatility: input.volatility + volStep }) - base) / volStep / 100,
    rho: (price({ rate: input.rate + rateStep }) - base) / rateStep / 100,
  };
}

export function priceOption(input: PricingInput): { value: number; greeks: Greeks; methodology: 'black-scholes' | 'binomial' } {
  if (input.style === 'european') {
    return { ...blackScholes(input), methodology: 'black-scholes' };
  }
  return { value: binomialValue(input), greeks: finiteDifferenceGreeks(input), methodology: 'binomial' };
}
