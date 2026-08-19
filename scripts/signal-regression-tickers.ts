/**
 * The thirty symbols every Options Signal regression is read on.
 *
 * Ten mega caps, ten mid caps and ten small caps, because the failures these
 * harnesses exist to catch are not evenly spread: a thin book, a wide spread and
 * an implied volatility that is mostly one earnings report are small-cap
 * problems, and a model tuned on AAPL alone would never meet them.
 *
 * It lives here, in one file, so two harnesses cannot quietly end up reporting
 * on two different universes and be compared anyway.
 */
export interface RegressionTicker {
  symbol: string;
  cap: 'mega' | 'mid' | 'small';
}

export const REGRESSION_TICKERS: RegressionTicker[] = [
  { symbol: 'AAPL', cap: 'mega' }, { symbol: 'MSFT', cap: 'mega' },
  { symbol: 'NVDA', cap: 'mega' }, { symbol: 'GOOGL', cap: 'mega' },
  { symbol: 'AMZN', cap: 'mega' }, { symbol: 'META', cap: 'mega' },
  { symbol: 'AVGO', cap: 'mega' }, { symbol: 'TSLA', cap: 'mega' },
  { symbol: 'JPM', cap: 'mega' }, { symbol: 'XOM', cap: 'mega' },

  { symbol: 'RKLB', cap: 'mid' }, { symbol: 'SOFI', cap: 'mid' },
  { symbol: 'PLTR', cap: 'mid' }, { symbol: 'ROKU', cap: 'mid' },
  { symbol: 'DKNG', cap: 'mid' }, { symbol: 'ENPH', cap: 'mid' },
  { symbol: 'CROX', cap: 'mid' }, { symbol: 'RIVN', cap: 'mid' },
  { symbol: 'AFRM', cap: 'mid' }, { symbol: 'U', cap: 'mid' },

  { symbol: 'IONQ', cap: 'small' }, { symbol: 'ACHR', cap: 'small' },
  { symbol: 'JOBY', cap: 'small' }, { symbol: 'BBAI', cap: 'small' },
  { symbol: 'LUNR', cap: 'small' }, { symbol: 'RGTI', cap: 'small' },
  { symbol: 'OPEN', cap: 'small' }, { symbol: 'WULF', cap: 'small' },
  { symbol: 'BTBT', cap: 'small' }, { symbol: 'SMCI', cap: 'small' },
];
