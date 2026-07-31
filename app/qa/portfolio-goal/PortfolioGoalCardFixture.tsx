'use client';

import { PortfolioGoalCard } from '@/src/components/portfolio/PortfolioGoalCard';
import { buildPortfolioGoalCardModel, type PortfolioGoalScope } from '@/src/lib/portfolio/goal-card';
import { formatPortfolioMoney, signedMoney, signedPercent } from '@/src/lib/portfolio/presentation';
import type { HoldingSummary, PortfolioSummary } from '@/src/lib/portfolio/types';

const cases = [
  { key: 'strong-gain', percent: 4, amount: 40, scope: 'selected' },
  { key: 'gain', percent: 1, amount: 10, scope: 'selected' },
  { key: 'flat', percent: 0, amount: 0, scope: 'selected' },
  { key: 'loss', percent: -1, amount: -10, scope: 'selected' },
  { key: 'strong-loss', percent: -4, amount: -40, scope: 'selected' },
  { key: 'severe-loss', percent: -9, amount: -90, scope: 'aggregate' },
] as const;

function holding(todayChange: number | null): HoldingSummary {
  return {
    symbol: 'KHEAW',
    quantity: 10,
    averageCost: 90,
    costBasis: 900,
    marketPrice: 100,
    marketValue: 1000,
    realizedGain: 0,
    unrealizedGain: 100,
    allocation: 100,
    priceCached: false,
    priceStale: false,
    priceSource: 'qa-fixture',
    priceAsOf: '2026-08-01T03:15:00.000Z',
    todayChange,
    todayChangePercent: todayChange,
    lots: [],
    transactions: [],
  };
}

function summary({
  amount,
  percent,
  hasAssets = true,
}: {
  amount: number | null;
  percent: number | null;
  hasAssets?: boolean;
}): PortfolioSummary {
  return {
    holdings: hasAssets ? [holding(amount)] : [],
    cashBalance: 250,
    marketValue: hasAssets ? 1000 : 0,
    costBasis: hasAssets ? 900 : 0,
    realizedGain: 0,
    unrealizedGain: hasAssets ? 100 : 0,
    totalValue: hasAssets ? 1250 : 250,
    equityMarketValue: hasAssets ? 1000 : 0,
    optionsMarketValue: 0,
    optionRemainingCost: 0,
    netDepositedCapital: 1150,
    netTransferredCapital: 0,
    totalGain: 100,
    totalGainPercent: 8.7,
    todayChange: amount,
    todayChangePercent: percent,
    optionPositions: [],
    hasMissingPrices: false,
  };
}

function FixtureCard({
  name,
  scope,
  fixtureSummary,
}: {
  name: string;
  scope: PortfolioGoalScope;
  fixtureSummary: PortfolioSummary;
}) {
  const model = buildPortfolioGoalCardModel({
    scope,
    summary: fixtureSummary,
    goal: { targetValueUsd: 1000, targetDate: null },
    activePortfolios: 2,
    totalPortfolios: 3,
  });
  const money = (value: number | string | null) => value === null
    ? '—'
    : formatPortfolioMoney(value, 'USD', null);
  const signed = (value: number | null) => value === null ? '—' : signedMoney(value, 'USD', null);
  const percent = (value: number | null) => value === null ? '—' : signedPercent(value);
  return <article className="min-w-0" data-fixture={name}>
    <PortfolioGoalCard
      model={model}
      selectedPortfolioName="พอร์ตทดสอบ"
      showBalances
      isOnline
      money={money}
      signed={signed}
      percent={percent}
      onScopeChange={() => undefined}
      onEditGoal={() => undefined}
    />
  </article>;
}

export function PortfolioGoalCardFixture() {
  return <main className="min-h-screen overflow-x-clip bg-[#0A0E17] p-3 text-white sm:p-6">
    <div className="mx-auto max-w-7xl">
      <h1 className="text-xl font-bold">Portfolio Goal Card · browser fixture</h1>
      <p className="mt-1 text-sm text-slate-400">Local QA fixture; no Production portfolio data is replaced.</p>
      <div className="mt-5 grid min-w-0 gap-5">
        {cases.map((fixture) => <FixtureCard
          key={fixture.key}
          name={fixture.key}
          scope={fixture.scope}
          fixtureSummary={summary({ amount: fixture.amount, percent: fixture.percent })}
        />)}
        <FixtureCard
          name="empty"
          scope="selected"
          fixtureSummary={summary({ amount: 0, percent: 0, hasAssets: false })}
        />
        <FixtureCard
          name="unavailable"
          scope="selected"
          fixtureSummary={summary({ amount: null, percent: null })}
        />
      </div>
    </div>
  </main>;
}
