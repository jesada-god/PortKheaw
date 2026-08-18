import type { OptionsChain } from '@/src/lib/market-data/options/contracts';

/**
 * The expected move, derived from a chain and nothing else.
 *
 * This is a COLLECTOR, not a feature. Nothing in the product reads it, no flag
 * turns it on, and it is deliberately not wired to the Market Signal engine.
 * P5 found that an expected-move signal cannot be tested at all — the corpus is
 * OHLCV and no provider backfills a historical chain — so the only way it ever
 * becomes answerable is to start writing down what the market was pricing,
 * today, and revisit when there is enough of it.
 *
 * `docs/market-signal/expected-move-collection.md` has the arithmetic on how
 * long "enough" is. The short version is that the first suggestive look is about
 * twelve months away and a full verdict is years, which is exactly why this is
 * four numbers a day rather than a project.
 *
 * ---------------------------------------------------------------------------
 * THE ONE MODELLING CHOICE IN HERE, MADE ON PURPOSE
 * ---------------------------------------------------------------------------
 * Which expiry. A chain carries weeklies and monthlies together, so "the front
 * expiry" is one day out on a Thursday and thirty on the Monday after. A series
 * built that way is not comparable with itself, and no amount of later
 * normalisation fixes a series whose horizon jumps around.
 *
 * So the rule is the nearest expiry at least `MINIMUM_DAYS_TO_EXPIRY` away, and
 * the actual `daysToExpiry` is stored beside it so a later analysis can filter,
 * normalise, or throw the rule out entirely and use something else. Recording
 * the input is the job; deciding what it means is not.
 */

/**
 * Seven days. Below this the expected move is dominated by a single session and
 * by pin risk around the strike, which is a different quantity from the one an
 * expected-move band is supposed to describe.
 */
export const MINIMUM_DAYS_TO_EXPIRY = 7;

export interface ExpectedMoveObservation {
  symbol: string;
  /** The trading date this describes, `YYYY-MM-DD`. */
  asOf: string;
  spot: number;
  expiration: string;
  daysToExpiry: number;
  /** ATM implied volatility as a decimal, e.g. 0.284 for 28.4%. */
  atmIv: number;
  /** Spot · IV · sqrt(days/365), in price units. */
  impliedMove: number;
  /** The same as a share of spot, which is what survives a stock split. */
  impliedMovePct: number;
  /** The strike the IV was read at, so the ATM choice is auditable afterwards. */
  atmStrike: number;
  provider: string;
}

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Pick the expiry this observation is about.
 *
 * Exported because the choice is the interesting part and a test should be able
 * to state it directly rather than through a whole chain fixture.
 */
export function chooseExpiration(
  expirations: readonly string[],
  asOf: string,
  minimumDays = MINIMUM_DAYS_TO_EXPIRY,
): string | null {
  const eligible = expirations
    .filter((expiration) => daysBetween(asOf, expiration) >= minimumDays)
    .sort();
  return eligible[0] ?? null;
}

/**
 * ATM implied volatility: the call and the put at the strike nearest spot,
 * averaged.
 *
 * Both sides, because a single side carries whatever skew that side has and the
 * average is the closer thing to "what the market thinks the move is". When only
 * one side quotes an IV the single side is used and that is recorded implicitly
 * by the strike — when neither does, the answer is `null` and the day is not
 * written. A zero would be a lie that later reads as a very calm market.
 */
export function atmImpliedVolatility(
  chain: Pick<OptionsChain, 'spot' | 'calls' | 'puts'>,
): { iv: number; strike: number } | null {
  const strikes = [...new Set([...chain.calls, ...chain.puts].map((contract) => contract.strike))];
  if (strikes.length === 0) return null;

  const nearest = strikes.reduce((best, strike) =>
    Math.abs(strike - chain.spot) < Math.abs(best - chain.spot) ? strike : best);

  const quoted = [
    chain.calls.find((contract) => contract.strike === nearest)?.impliedVolatility,
    chain.puts.find((contract) => contract.strike === nearest)?.impliedVolatility,
  ].filter((iv): iv is number => typeof iv === 'number' && Number.isFinite(iv) && iv > 0);

  if (quoted.length === 0) return null;
  return { iv: quoted.reduce((sum, iv) => sum + iv, 0) / quoted.length, strike: nearest };
}

/**
 * One day's row, or `null` when the chain cannot support one.
 *
 * Every `null` path is a refusal to write something invented: no eligible
 * expiry, no quoted IV at the money, a non-positive spot. A gap in this table is
 * a day the market did not tell us, which is a fact; a row full of zeroes would
 * be a day we told ourselves something.
 */
export function deriveExpectedMove(
  chain: Pick<OptionsChain, 'underlyingSymbol' | 'spot' | 'expiration' | 'calls' | 'puts' | 'provider'>,
  asOf: string,
): ExpectedMoveObservation | null {
  if (!Number.isFinite(chain.spot) || chain.spot <= 0) return null;

  const daysToExpiry = daysBetween(asOf, chain.expiration);
  if (daysToExpiry < MINIMUM_DAYS_TO_EXPIRY) return null;

  const atm = atmImpliedVolatility(chain);
  if (!atm) return null;

  const impliedMove = chain.spot * atm.iv * Math.sqrt(daysToExpiry / 365);

  return {
    symbol: chain.underlyingSymbol,
    asOf,
    spot: chain.spot,
    expiration: chain.expiration,
    daysToExpiry,
    atmIv: atm.iv,
    impliedMove,
    impliedMovePct: impliedMove / chain.spot,
    atmStrike: atm.strike,
    provider: chain.provider,
  };
}
