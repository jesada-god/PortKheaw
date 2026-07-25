const symbols = process.argv.slice(2);

if (symbols.length === 0) {
  console.error('Usage: node scripts/probe-analyst-consensus.mjs AAPL RKLB NVDA');
  process.exitCode = 1;
} else {
  for (const rawSymbol of symbols) {
    const symbol = rawSymbol.trim().toUpperCase();

    if (process.env.FINNHUB_API_KEY) {
      try {
        const url = new URL('https://api.finnhub.io/api/v1/stock/price-target');
        url.searchParams.set('symbol', symbol);
        const response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            'X-Finnhub-Token': process.env.FINNHUB_API_KEY,
          },
          signal: AbortSignal.timeout(10_000),
        });
        const value = await response.json().catch(() => null);
        const row = value && typeof value === 'object' && !Array.isArray(value)
          ? value : {};
        const message = typeof row.error === 'string' ? row.error.toLowerCase() : '';
        const errorCategory = response.status === 401 || response.status === 403
          || message.includes('premium') || message.includes('access')
          ? 'not-entitled'
          : response.status === 429
            ? 'rate-limited'
            : !response.ok || value === null
              ? 'provider-error'
              : null;
        console.log(JSON.stringify({
          provider: 'finnhub',
          symbol,
          endpoint: 'stock/price-target',
          status: response.status,
          entitlement: errorCategory === null ? 'available' : errorCategory,
          targetMean: row.targetMean ?? null,
          targetMedian: row.targetMedian ?? null,
          targetHigh: row.targetHigh ?? null,
          targetLow: row.targetLow ?? null,
          numberAnalysts: row.numberAnalysts ?? null,
          lastUpdated: row.lastUpdated ?? null,
          responseSymbol: row.symbol ?? null,
        }));
      } catch (error) {
        console.log(JSON.stringify({
          provider: 'finnhub',
          symbol,
          endpoint: 'stock/price-target',
          status: null,
          entitlement: 'provider-error',
          error: error instanceof Error ? error.name : 'unknown',
        }));
      }
    } else {
      console.log(JSON.stringify({
        provider: 'finnhub',
        symbol,
        endpoint: 'stock/price-target',
        status: null,
        entitlement: 'unconfigured',
      }));
    }

    if (process.env.ALPHA_VANTAGE_API_KEY) {
      try {
        const url = new URL('https://www.alphavantage.co/query');
        url.searchParams.set('function', 'OVERVIEW');
        url.searchParams.set('symbol', symbol);
        url.searchParams.set('apikey', process.env.ALPHA_VANTAGE_API_KEY);
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        const value = await response.json().catch(() => null);
        const row = value && typeof value === 'object' && !Array.isArray(value)
          ? value : {};
        const message = String(row.Information ?? row.Note ?? row['Error Message'] ?? '')
          .toLowerCase();
        console.log(JSON.stringify({
          provider: 'alpha-vantage',
          symbol,
          endpoint: 'OVERVIEW',
          status: response.status,
          availability: message.includes('limit') || message.includes('frequency')
            ? 'rate-limited'
            : message.includes('invalid') || message.includes('api key')
              ? 'invalid-key'
              : !response.ok || value === null
                ? 'provider-error'
                : row.AnalystTargetPrice
                  ? 'available'
                  : 'unavailable',
          analystTargetPrice: row.AnalystTargetPrice ?? null,
          currency: row.Currency ?? null,
          latestQuarter: row.LatestQuarter ?? null,
        }));
      } catch (error) {
        console.log(JSON.stringify({
          provider: 'alpha-vantage',
          symbol,
          endpoint: 'OVERVIEW',
          status: null,
          availability: 'provider-error',
          error: error instanceof Error ? error.name : 'unknown',
        }));
      }
    } else {
      console.log(JSON.stringify({
        provider: 'alpha-vantage',
        symbol,
        endpoint: 'OVERVIEW',
        status: null,
        availability: 'unconfigured',
      }));
    }
  }
}
