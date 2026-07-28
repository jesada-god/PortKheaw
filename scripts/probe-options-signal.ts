/**
 * Options Signal Engine live probe.
 *
 * Answers, against REAL providers and no mocks: for each symbol, does every one
 * of the seven inputs actually resolve, what data state does each carry, and
 * what signal does the pure engine return from those real numbers?
 *
 * It runs the exact production path — the server context loader (cached daily
 * candles for the symbol plus SPY/QQQ, support/resistance, realized volatility
 * and the earnings calendar), the real options chain from the entitled provider,
 * and the same pure `calculateOptionsSignal` the UI renders. Anything a provider
 * genuinely does not supply is reported as UNAVAILABLE; nothing is substituted.
 *
 * Run: npm run probe:options-signal -- [SYMBOL...]
 *   e.g. npm run probe:options-signal -- AAPL RKLB NVDA
 */

import { computeOptionsSupportResistance } from '@/src/lib/analytics/options-sr/calculations';
import type { OptionsSrResult } from '@/src/lib/analytics/options-sr/types';
import { assembleOptionsSignalInput } from '@/src/lib/analytics/options-signal/assemble';
import { calculateOptionsSignal } from '@/src/lib/analytics/options-signal/calculations';
import { loadOptionsSignalContext } from '@/src/lib/analytics/options-signal/service';
import type { OptionsSignalFactorId } from '@/src/lib/analytics/options-signal/types';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';

const SYMBOLS = process.argv.slice(2).filter((value) => /^[A-Za-z][A-Za-z0-9.\-]*$/.test(value));
const TARGETS = SYMBOLS.length ? SYMBOLS.map((value) => value.toUpperCase()) : ['AAPL', 'RKLB', 'NVDA'];

const FACTORS: OptionsSignalFactorId[] = ['macro', 'trend', 'momentum', 'sentiment', 'riskReward'];

async function loadChain(symbol: string): Promise<{ chain: OptionsChain | null; note: string }> {
  try {
    const service = getOptionsMarketDataService();
    const expirations = await service.getExpirations(symbol);
    const expiration = expirations.data.expirations[0];
    if (!expiration) return { chain: null, note: 'provider returned no non-expired expirations' };
    const chain = await service.getChain(symbol, expiration);
    return { chain: chain.data, note: `expiration ${expiration}` };
  } catch (cause) {
    return { chain: null, note: cause instanceof Error ? cause.message : 'options chain request failed' };
  }
}

async function probe(symbol: string): Promise<boolean> {
  console.log(`\n=== ${symbol} ===`);
  const context = await loadOptionsSignalContext(symbol);
  const { chain, note } = await loadChain(symbol);
  console.log(`options chain: ${chain ? `${chain.provider} · ${note} · status ${chain.status}` : `UNAVAILABLE · ${note}`}`);

  let optionsSr: OptionsSrResult | null = null;
  if (chain) {
    optionsSr = computeOptionsSupportResistance({
      symbol,
      expiration: chain.expiration,
      acceptedPrice: chain.spot,
      calls: chain.calls,
      puts: chain.puts,
      provider: chain.provider,
      asOf: chain.asOf,
      status: chain.status,
    });
  }

  const result = calculateOptionsSignal(assembleOptionsSignalInput(context, {
    chain,
    optionsSr,
    acceptedPrice: chain?.spot ?? null,
  }));

  console.log(`signal: ${result.signalType ?? 'INSUFFICIENT-DATA'} · confidence ${result.confidenceScore} · bias ${result.underlyingBias ?? '—'}`);
  if (result.status === 'insufficient-data') console.log(`reason: ${result.reason}`);
  for (const id of FACTORS) {
    const factor = result.diagnostics.factors[id];
    console.log(`  ${id.padEnd(12)} ${String(factor.points ?? '—').padStart(4)} / ${factor.maxPoints}  [${factor.state}]  ${factor.detail}`);
  }
  const iv = result.diagnostics.iv;
  console.log(`  iv           basis=${iv.basis ?? 'none'} rank=${iv.ivRank ?? '—'} atm=${iv.impliedVolatility ?? '—'} realized=${iv.realizedVolatility ?? '—'} ratio=${iv.ratio ?? '—'} level=${iv.level ?? '—'} [${iv.state}]${iv.reason ? ` · ${iv.reason}` : ''}`);
  const event = result.diagnostics.event;
  console.log(`  earnings     ${event.reportDate ?? '—'} · in ${event.daysToEarnings ?? '—'} days [${event.state}] provider=${context.event.provider ?? 'none'}${event.reason ? ` · ${event.reason}` : ''}`);
  console.log(`  setup        ${result.suggestedOptionsSetup.status === 'suggested'
    ? `${result.suggestedOptionsSetup.dteMin}-${result.suggestedOptionsSetup.dteMax} DTE · Delta ${result.suggestedOptionsSetup.deltaMin}-${result.suggestedOptionsSetup.deltaMax} · ${result.suggestedOptionsSetup.direction}`
    : `not-recommended · ${result.suggestedOptionsSetup.reason}`}`);
  console.log(`  prime blockers: ${result.diagnostics.dataSufficiency.primeBlockers.join(', ') || 'none'}`);

  // The probe fails only when the CANDLE-derived core is missing, because that
  // is a real regression; a provider that genuinely does not sell IV history or
  // options data is reported, not treated as a defect.
  const coreMissing = FACTORS.filter((id) => id !== 'sentiment' && !result.diagnostics.factors[id].available);
  if (coreMissing.length) {
    console.error(`FAIL ${symbol}: candle-derived factors unavailable: ${coreMissing.join(', ')}`);
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  const outcomes: boolean[] = [];
  for (const symbol of TARGETS) outcomes.push(await probe(symbol));
  if (outcomes.some((ok) => !ok)) process.exit(1);
  console.log('\nAll probed symbols resolved their candle-derived Options Signal inputs.');
}

void main();
