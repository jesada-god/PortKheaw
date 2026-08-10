import { describe, expect, it } from 'vitest';
import { aggregatePortfolioSummaries } from './aggregate';
import { calculatePortfolio } from './calculations';
import { buildPortfolioGoalCardModel, type PortfolioMascotState } from './goal-card';
import { portfolioTotalReturnPercent, portfolioTotalReturnPercentOf } from './total-return';
import type { OptionQuoteInput } from './options/types';
import type { MarketPriceInput, PortfolioSummary, PortfolioTransaction } from './types';
import { portfolioGoalMascotAsset } from '@/src/components/portfolio/PortfolioGoalMascot';

/*
 * The total return a reader is shown, and the mood Kheaw is shown in, are one
 * number read twice. These build real ledgers, replay them through the canonical
 * engine, and assert on both ends of that number at once — because the defect
 * this file exists for was invisible from either end alone: the money was right,
 * the percentage was 0.00%, and Kheaw sat neutral on a portfolio up a third.
 */

const TODAY = '2026-08-11';

let sequence = 0;
function row(overrides: Partial<PortfolioTransaction> & { type: PortfolioTransaction['type'] }): PortfolioTransaction {
  sequence += 1;
  const at = `2026-08-09T07:${String(sequence).padStart(2, '0')}:00.000Z`;
  return {
    id: `tx-${sequence}`,
    portfolioId: 'portfolio-1',
    symbol: null,
    quantity: null,
    price: null,
    amount: null,
    originalCurrency: 'USD',
    occurredAt: at.slice(0, 10),
    occurredAtTime: at,
    note: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/**
 * The row the transfer RPC writes at the destination for one option leg — the
 * shape the production portfolio in the bug report was built from. It carries
 * cost basis and no cash, which is exactly what made the old denominator zero.
 */
function optionTransferIn({
  contractSymbol = 'RKLB260821C00070000',
  underlyingSymbol = 'RKLB',
  contracts = '1',
  unitCostUsd,
  costBasisUsd,
}: {
  contractSymbol?: string;
  underlyingSymbol?: string;
  contracts?: string;
  unitCostUsd: string;
  costBasisUsd: string;
}): PortfolioTransaction {
  return row({
    type: 'transfer_in',
    quantity: contracts,
    price: unitCostUsd,
    normalizedPriceUsd: unitCostUsd,
    underlyingSymbol,
    contractSymbol,
    optionKind: 'call',
    optionSide: 'long',
    strikePrice: '70',
    expirationDate: '2026-08-21',
    multiplier: '100',
    transferCostBasisUsd: costBasisUsd,
    transferAcquiredAt: '2026-06-02T13:31:00.000Z',
    counterpartyPortfolioId: 'portfolio-0',
    transferGroupId: 'group-1',
  });
}

function optionBuy({
  contractSymbol = 'RKLB260821C00070000',
  underlyingSymbol = 'RKLB',
  contracts = '1',
  premium,
}: {
  contractSymbol?: string;
  underlyingSymbol?: string;
  contracts?: string;
  premium: string;
}): PortfolioTransaction {
  return row({
    type: 'buy_to_open',
    quantity: contracts,
    price: premium,
    normalizedPriceUsd: premium,
    fee: '0',
    normalizedFeeUsd: '0',
    underlyingSymbol,
    contractSymbol,
    optionKind: 'call',
    optionSide: 'long',
    strikePrice: '70',
    expirationDate: '2026-08-21',
    multiplier: '100',
  });
}

/** A mark with no previous close: the option is priced, Today P/L is not. */
function markOnly(mark: number, previousClose: number | null = null): OptionQuoteInput {
  return {
    bid: mark - 0.05,
    ask: mark + 0.05,
    mark,
    previousClose,
    underlyingPrice: 82,
    impliedVolatility: 0.6,
    delta: 0.7,
    theta: -0.05,
    source: 'alpaca-options-data',
    asOf: '2026-08-11T15:00:00.000Z',
    freshness: 'delayed',
  };
}

function equityQuote(price: number, previousClose: number | null = null): MarketPriceInput {
  return { price, previousClose, asOf: '2026-08-11T15:00:00.000Z', source: 'alpaca' };
}

function mascotFor(summary: PortfolioSummary): PortfolioMascotState {
  return buildPortfolioGoalCardModel({
    scope: 'selected',
    summary,
    goal: { targetValueUsd: 10_000, targetDate: null },
    activePortfolios: 1,
    totalPortfolios: 1,
  }).mascot;
}

/**
 * An option-only portfolio whose contracts arrived by transfer, priced so its
 * total return lands exactly on `returnPercent`. Basis is a flat $1,000, so the
 * mark is simply ten times the multiplier of the return.
 */
function transferredOptionPortfolio(returnPercent: number): PortfolioSummary {
  const mark = 10 * (1 + returnPercent / 100);
  return calculatePortfolio(
    [optionTransferIn({ unitCostUsd: '10', costBasisUsd: '1000' })],
    {},
    { RKLB260821C00070000: markOnly(mark) },
    TODAY,
  );
}

describe('the canonical total-return percentage', () => {
  it('divides the gain by the capital the gain was measured against, transfers included', () => {
    expect(portfolioTotalReturnPercent(null, 0n, 0n)).toBeNull();
    // $299.97 gained on $940.03 that arrived as a transferred position.
    expect(portfolioTotalReturnPercentOf({
      totalGain: 299.97,
      netDepositedCapital: 0,
      netTransferredCapital: 940.03,
    })).toBeCloseTo(31.91, 2);
    // The same money, split between a deposit and a transfer, is the same return.
    expect(portfolioTotalReturnPercentOf({
      totalGain: 299.97,
      netDepositedCapital: 440.03,
      netTransferredCapital: 500,
    })).toBeCloseTo(31.91, 2);
  });

  it('answers "no percentage" rather than zero when there is no capital base', () => {
    expect(portfolioTotalReturnPercentOf({
      totalGain: 299.97,
      netDepositedCapital: 0,
      netTransferredCapital: 0,
    })).toBeNull();
    expect(portfolioTotalReturnPercentOf({
      totalGain: 10,
      netDepositedCapital: -50,
      netTransferredCapital: 0,
    })).toBeNull();
    expect(portfolioTotalReturnPercentOf({
      totalGain: 0,
      netDepositedCapital: 1000,
      netTransferredCapital: 0,
    })).toBe(0);
  });
});

describe('the reported production portfolio', () => {
  /*
   * One RKLB call, moved in rather than bought, marked at 12.40 against a
   * 9.40 basis. Every figure in the bug report is this position in THB.
   */
  const summary = calculatePortfolio(
    [optionTransferIn({ unitCostUsd: '9.4', costBasisUsd: '940.03' })],
    {},
    { RKLB260821C00070000: markOnly(12.4) },
    TODAY,
  );

  it('is funded entirely by transferred capital, which is why the old denominator was zero', () => {
    expect(summary.netDepositedCapital).toBe(0);
    expect(summary.netTransferredCapital).toBeCloseTo(940.03, 2);
    expect(summary.cashBalance).toBe(0);
    expect(summary.equityMarketValue).toBe(0);
  });

  it('values the open contract into the total, and reports a real total return', () => {
    expect(summary.optionsMarketValue).toBeCloseTo(1240, 2);
    expect(summary.totalValue).toBeCloseTo(1240, 2);
    expect(summary.totalGain).toBeCloseTo(299.97, 2);
    expect(summary.totalGainPercent).not.toBe(0);
    expect(summary.totalGainPercent).toBeCloseTo(31.91, 2);
  });

  it('shows Kheaw the same number the card prints beside him', () => {
    const mascot = mascotFor(summary);
    expect(mascot.source).toBe('total');
    expect(mascot.percent).toBeCloseTo(31.91, 2);
    expect(mascot.percent).toBe(summary.totalGainPercent);
    expect(mascot.mood).toBe('strongGain');
    expect(mascot.message).toBe('วาสนาผู้ใดหนอออ!');
    expect(portfolioGoalMascotAsset(mascot)).toBe('/brand/01_gain_strong.png');
  });

  it('never lets goal progress stand in for the return', () => {
    const model = buildPortfolioGoalCardModel({
      scope: 'selected',
      summary,
      goal: { targetValueUsd: 10_000, targetDate: null },
      activePortfolios: 1,
      totalPortfolios: 1,
    });
    // 1240 / 10000 — the 12.40% from the screenshot, and not what Kheaw reads.
    expect(model.progress.progressPercent).toBeCloseTo(12.4, 2);
    expect(model.mascot.percent).toBeCloseTo(31.91, 2);
  });

  it('resolves the reported baht figures to +31.9%, not to 0.00%', () => {
    const currentValueThb = 40_904.23;
    const totalGainThb = 9_895.19;
    const costBasisThb = currentValueThb - totalGainThb;
    expect(costBasisThb).toBeCloseTo(31_009.04, 2);
    const returnPercent = totalGainThb / costBasisThb * 100;
    expect(returnPercent).not.toBe(0);
    expect(returnPercent).toBeCloseTo(31.91, 1);
  });
});

describe('total return across every kind of portfolio', () => {
  it('reads an option-only portfolio in profit as a gain', () => {
    const summary = calculatePortfolio(
      [
        row({ type: 'deposit', amount: '1000', normalizedAmountUsd: '1000' }),
        optionBuy({ premium: '10' }),
      ],
      {},
      { RKLB260821C00070000: markOnly(13) },
      TODAY,
    );
    expect(summary.totalValue).toBeCloseTo(1300, 2);
    expect(summary.totalGain).toBeCloseTo(300, 2);
    expect(summary.totalGainPercent).toBeCloseTo(30, 2);
    expect(mascotFor(summary)).toMatchObject({ mood: 'strongGain', source: 'total' });
  });

  it('reads an option-only portfolio at a loss as a loss', () => {
    const summary = calculatePortfolio(
      [
        row({ type: 'deposit', amount: '1000', normalizedAmountUsd: '1000' }),
        optionBuy({ premium: '10' }),
      ],
      {},
      { RKLB260821C00070000: markOnly(6) },
      TODAY,
    );
    expect(summary.totalGain).toBeCloseTo(-400, 2);
    expect(summary.totalGainPercent).toBeCloseTo(-40, 2);
    expect(mascotFor(summary)).toMatchObject({ mood: 'heavyLoss', source: 'total' });
  });

  it('reads a stock-only portfolio', () => {
    const summary = calculatePortfolio(
      [
        row({ type: 'deposit', amount: '1000', normalizedAmountUsd: '1000' }),
        row({ type: 'acquisition', symbol: 'RKLB', quantity: '10', price: '50', normalizedPriceUsd: '50', fee: '0' }),
      ],
      { RKLB: equityQuote(60) },
      {},
      TODAY,
    );
    expect(summary.totalValue).toBeCloseTo(1100, 2);
    expect(summary.totalGain).toBeCloseTo(100, 2);
    expect(summary.totalGainPercent).toBeCloseTo(10, 2);
    expect(mascotFor(summary)).toMatchObject({ mood: 'strongGain', source: 'total' });
  });

  it('reads a mixed portfolio from both sides of it', () => {
    const ledger = [
      row({ type: 'deposit', amount: '2000', normalizedAmountUsd: '2000' }),
      row({ type: 'acquisition', symbol: 'RKLB', quantity: '5', price: '100', normalizedPriceUsd: '100', fee: '0' }),
      optionBuy({ premium: '5' }),
    ];
    const summary = calculatePortfolio(
      ledger,
      { RKLB: equityQuote(120) },
      { RKLB260821C00070000: markOnly(8) },
      TODAY,
    );
    expect(summary.cashBalance).toBeCloseTo(1000, 2);
    expect(summary.equityMarketValue).toBeCloseTo(600, 2);
    expect(summary.optionsMarketValue).toBeCloseTo(800, 2);
    expect(summary.totalValue).toBeCloseTo(2400, 2);
    expect(summary.totalGain).toBeCloseTo(400, 2);
    expect(summary.totalGainPercent).toBeCloseTo(20, 2);

    // Drop the contract's value and the same metric moves, which is the proof
    // that options are inside it rather than beside it.
    const withoutOptionGain = calculatePortfolio(
      ledger,
      { RKLB: equityQuote(120) },
      { RKLB260821C00070000: markOnly(5) },
      TODAY,
    );
    expect(withoutOptionGain.totalGainPercent).toBeCloseTo(5, 2);
  });

  it('reports a true zero return as 0.00%, with Kheaw neutral and the figure still shown', () => {
    const summary = calculatePortfolio(
      [
        row({ type: 'deposit', amount: '1000', normalizedAmountUsd: '1000' }),
        optionBuy({ premium: '10' }),
      ],
      {},
      { RKLB260821C00070000: markOnly(10) },
      TODAY,
    );
    expect(summary.totalGain).toBe(0);
    expect(summary.totalGainPercent).toBe(0);
    const mascot = mascotFor(summary);
    expect(mascot).toMatchObject({ mood: 'neutral', source: 'total', percent: 0, message: 'รอเจ้าตื่น' });
  });

  it('separates "no capital base" from a zero return, and says nothing rather than 0.00%', () => {
    // A ledger with a purchase and no funding behind it: real value, no base.
    const summary = calculatePortfolio(
      [optionBuy({ premium: '10' })],
      {},
      { RKLB260821C00070000: markOnly(13) },
      TODAY,
    );
    expect(summary.netDepositedCapital).toBe(0);
    expect(summary.netTransferredCapital).toBe(0);
    expect(summary.totalGainPercent).toBeNull();
    expect(mascotFor(summary)).toMatchObject({
      mood: 'neutral',
      source: 'none',
      percent: null,
      message: 'รอเจ้าตื่น',
    });
  });

  it('holds up when a holding has no price at all', () => {
    const summary = calculatePortfolio(
      [
        row({ type: 'deposit', amount: '1000', normalizedAmountUsd: '1000' }),
        optionBuy({ premium: '10' }),
      ],
      {},
      {},
      TODAY,
    );
    expect(summary.hasMissingPrices).toBe(true);
    expect(summary.totalGain).toBeNull();
    expect(summary.totalGainPercent).toBeNull();
    expect(mascotFor(summary)).toMatchObject({ source: 'none', percent: null });
  });

  it('nets a transfer back out when the two portfolios are aggregated', () => {
    const source = calculatePortfolio(
      [
        row({ type: 'deposit', amount: '1000', normalizedAmountUsd: '1000' }),
        optionBuy({ premium: '10' }),
        row({
          type: 'transfer_out',
          quantity: '1',
          price: '10',
          normalizedPriceUsd: '10',
          underlyingSymbol: 'RKLB',
          contractSymbol: 'RKLB260821C00070000',
          optionKind: 'call',
          optionSide: 'long',
          strikePrice: '70',
          expirationDate: '2026-08-21',
          multiplier: '100',
          transferCostBasisUsd: '1000',
        }),
      ],
      {},
      { RKLB260821C00070000: markOnly(12) },
      TODAY,
    );
    const destination = transferredOptionPortfolio(20);
    expect(source.netDepositedCapital).toBeCloseTo(1000, 2);
    expect(source.netTransferredCapital).toBeCloseTo(-1000, 2);
    expect(source.totalValue).toBeCloseTo(0, 2);
    expect(destination.totalGainPercent).toBeCloseTo(20, 2);

    const combined = aggregatePortfolioSummaries([source, destination]);
    expect(combined.netDepositedCapital).toBeCloseTo(1000, 2);
    expect(combined.netTransferredCapital).toBeCloseTo(0, 2);
    expect(combined.totalValue).toBeCloseTo(1200, 2);
    expect(combined.totalGain).toBeCloseTo(200, 2);
    expect(combined.totalGainPercent).toBeCloseTo(20, 2);
    expect(mascotFor(combined)).toMatchObject({ mood: 'strongGain', source: 'total' });
  });

  it('gives a hard reload the same answer, because nothing is stored between them', () => {
    const ledger = [
      row({ type: 'deposit', amount: '1000', normalizedAmountUsd: '1000' }),
      row({ type: 'acquisition', symbol: 'RKLB', quantity: '5', price: '100', normalizedPriceUsd: '100', fee: '0' }),
      optionBuy({ premium: '5' }),
    ];
    const quotes = { RKLB260821C00070000: markOnly(8) };
    const first = calculatePortfolio(ledger, { RKLB: equityQuote(120) }, quotes, TODAY);
    const second = calculatePortfolio(ledger, { RKLB: equityQuote(120) }, quotes, TODAY);
    // A reload also re-reads the rows, and the database orders them itself.
    const reordered = calculatePortfolio([...ledger].reverse(), { RKLB: equityQuote(120) }, quotes, TODAY);

    expect(second.totalGainPercent).toBe(first.totalGainPercent);
    expect(reordered.totalGainPercent).toBe(first.totalGainPercent);
    expect(mascotFor(second)).toEqual(mascotFor(first));
    expect(mascotFor(reordered)).toEqual(mascotFor(first));
  });
});

describe('every Kheaw state stays reachable from an option-only portfolio', () => {
  it.each([
    [100, 'strongGain', 'gainOver100', 'โอ๊ย! รวยไม่ไหวแล้ววว', '/brand/07_event_gain_over_100.png'],
    [99.99, 'strongGain', 'gainOver50', 'มื้อนี้ชาบูต้องเข้าแล้วมะ!', '/brand/09_event_gain_over_50.png'],
    [50, 'strongGain', 'gainOver50', 'มื้อนี้ชาบูต้องเข้าแล้วมะ!', '/brand/09_event_gain_over_50.png'],
    [49.99, 'strongGain', null, 'วาสนาผู้ใดหนอออ!', '/brand/01_gain_strong.png'],
    [3, 'strongGain', null, 'วาสนาผู้ใดหนอออ!', '/brand/01_gain_strong.png'],
    [2.999, 'gain', null, 'ยกโลว์โชว์เหนือ', '/brand/02_gain_soft_wink.png'],
    [0.5, 'gain', null, 'ยกโลว์โชว์เหนือ', '/brand/02_gain_soft_wink.png'],
    [0.499, 'neutral', null, 'รอเจ้าตื่น', '/brand/03_neutral.png'],
    [0, 'neutral', null, 'รอเจ้าตื่น', '/brand/03_neutral.png'],
    [-0.499, 'neutral', null, 'รอเจ้าตื่น', '/brand/03_neutral.png'],
    [-0.5, 'smallLoss', null, 'แค่ Pullback (มั้ง?)', '/brand/04_loss_soft.png'],
    [-2.999, 'smallLoss', null, 'แค่ Pullback (มั้ง?)', '/brand/04_loss_soft.png'],
    [-3, 'loss', null, 'จะวูบของแทร่', '/brand/05_loss_big.png'],
    [-6.999, 'loss', null, 'จะวูบของแทร่', '/brand/05_loss_big.png'],
    [-7, 'heavyLoss', null, 'สู้ชีวิตแต่โดนกราฟสู้กลับ!', '/brand/06_loss_heavy_cry.png'],
    [-49.99, 'heavyLoss', null, 'สู้ชีวิตแต่โดนกราฟสู้กลับ!', '/brand/06_loss_heavy_cry.png'],
    [-50, 'heavyLoss', 'lossOver50', 'วัดไหนข้าวอร่อยบอกด้วย', '/brand/08_event_loss_over_50.png'],
  ] as const)('total return %s puts Kheaw in %s', (returnPercent, mood, specialEvent, message, asset) => {
    const summary = transferredOptionPortfolio(returnPercent);
    expect(summary.totalGainPercent).toBeCloseTo(returnPercent, 6);
    const mascot = mascotFor(summary);
    expect(mascot).toMatchObject({ mood, specialEvent, message, source: 'total' });
    expect(mascot.percent).toBeCloseTo(returnPercent, 6);
    expect(portfolioGoalMascotAsset(mascot)).toBe(asset);
  });

  it('covers all six moods and all three special events between them', () => {
    const states = [100, 50, 4, 1, 0, -1, -4, -8, -50].map(
      (percent) => mascotFor(transferredOptionPortfolio(percent)),
    );
    expect(new Set(states.map((state) => state.mood))).toEqual(
      new Set(['strongGain', 'gain', 'neutral', 'smallLoss', 'loss', 'heavyLoss']),
    );
    expect(new Set(states.map((state) => state.specialEvent).filter(Boolean))).toEqual(
      new Set(['gainOver100', 'gainOver50', 'lossOver50']),
    );
    expect(new Set(states.map(portfolioGoalMascotAsset)).size).toBe(9);
  });

  it('still lets a complete Today P/L take the mood, unchanged by any of this', () => {
    const summary = calculatePortfolio(
      [optionTransferIn({ unitCostUsd: '10', costBasisUsd: '1000' })],
      {},
      { RKLB260821C00070000: markOnly(10.2, 10) },
      TODAY,
    );
    expect(summary.totalGainPercent).toBeCloseTo(2, 6);
    expect(mascotFor(summary)).toMatchObject({ mood: 'gain', source: 'today' });
  });
});
