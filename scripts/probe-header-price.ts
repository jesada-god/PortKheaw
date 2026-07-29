/**
 * Stock Price Header → canonical market snapshot probe.
 *
 * Answers, against live providers and with nothing mocked: for each symbol, what
 * does every layer the header depends on actually return right now, and what
 * would the header therefore display?
 *
 * It runs the real server pipeline — instrument resolution, the Polygon gateway
 * quote, `loadResilientQuote`, the Yahoo regular quote and the Yahoo extended
 * print — then pushes those exact payloads through
 * {@link resolveCanonicalMarketSnapshot}, the single resolver the header renders
 * from. So the reported main/secondary price is the resolver's own answer on real
 * data, not an assertion about it.
 *
 * Run: npm run probe:header-price -- [SYMBOL...]     (defaults to NVTS)
 */

import { getYahooChartProvider } from '@/src/lib/market-data/candles';
import {
  canonicalRegularTradingDateAt,
  resolveCurrentMarketSession,
} from '@/src/lib/market-data/current-session';
import { getMarketDataGateway } from '@/src/lib/market-data/gateway/service';
import { loadResilientQuote } from '@/src/lib/market-data/quote-service';
import { classifyUsEquitySession } from '@/src/lib/market-data/session';
import { resolveCanonicalMarketSnapshot } from '@/src/lib/market-data/market-snapshot';

const symbols = process.argv.slice(2).filter((value) => /^[A-Za-z][A-Za-z0-9.\-]*$/.test(value));
const SYMBOLS = symbols.length > 0 ? symbols.map((value) => value.toUpperCase()) : ['NVTS'];

function show(label: string, value: unknown): void {
  console.log(`${label}:`, JSON.stringify(value, null, 1));
}

async function main(): Promise<void> {
  const now = new Date();
  const session = resolveCurrentMarketSession({ now });
  console.log('now (UTC)          :', now.toISOString());
  console.log('now (America/NY)   :', now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  console.log('current session    :', session.session, `(${session.source})`);
  console.log('canonical reg. date:', canonicalRegularTradingDateAt(now));

  let failures = 0;
  for (const symbol of SYMBOLS) {
    console.log(`\n================ ${symbol} ================`);
    const gateway = getMarketDataGateway();
    try {
      const instrument = await gateway.resolveInstrument(symbol);
      try {
        const quote = await gateway.getQuote({ instrument });
        const iso = new Date(quote.timestamp * 1_000).toISOString();
        show('gateway.getQuote', { ...quote, _iso: iso, _priceSession: classifyUsEquitySession(iso) });
      } catch (cause) {
        console.log('gateway.getQuote FAILED:', String(cause));
      }
    } catch (cause) {
      console.log('resolveInstrument FAILED:', String(cause));
    }

    const resilient = await loadResilientQuote(symbol).catch((cause) => {
      console.log('loadResilientQuote FAILED:', String(cause));
      return null;
    });
    if (resilient) {
      show('loadResilientQuote', {
        data: resilient.data,
        freshness: resilient.freshness,
        provider: resilient.provider,
        diagnostics: resilient.diagnostics,
        _priceSession: resilient.freshness.asOf ? classifyUsEquitySession(resilient.freshness.asOf) : null,
      });
    }

    const extended = await getYahooChartProvider().getExtendedQuote(symbol).catch((cause) => {
      console.log('yahoo.getExtendedQuote FAILED:', String(cause));
      return null;
    });
    show('yahoo.getExtendedQuote', extended);

    if (!resilient) { failures += 1; continue; }
    const snapshot = resolveCanonicalMarketSnapshot({
      symbol,
      session,
      quote: {
        data: resilient.data,
        freshness: resilient.freshness,
        provider: resilient.provider ?? null,
      },
      extended,
      now,
    });
    show('CANONICAL SNAPSHOT', snapshot);
    console.log('→ phase / reason   :', snapshot.session, snapshot.closeReason ?? '-');
    console.log('→ main price       :', snapshot.mainPrice, `(${snapshot.mainPriceRole}, ${snapshot.mainPriceSource ?? 'no source'})`);
    console.log('→ regularClose     :', snapshot.regularClose, `@ ${snapshot.regularCloseTimestamp ?? 'n/a'}`);
    console.log('→ prev reg. close  :', snapshot.previousRegularClose);
    console.log('→ extended         :', snapshot.extendedPrice, snapshot.extendedSession ?? '-', snapshot.extendedPriceTimestamp ?? '-');
    console.log('→ flags            :', snapshot.flags.join(', ') || 'none');
    if (snapshot.mainPrice === null) failures += 1;
  }

  if (failures > 0) {
    console.error(`\n${failures} symbol(s) produced no main price.`);
    process.exit(1);
  }
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
