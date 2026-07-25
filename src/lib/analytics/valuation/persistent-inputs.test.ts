import { describe, expect, it, vi } from 'vitest';
import {
  ValuationInputLkgService,
  type ValuationInputLkgEntry,
  type ValuationInputLkgRepository,
} from './persistent-inputs';

class MemoryRepository implements ValuationInputLkgRepository {
  readonly entries = new Map<string, ValuationInputLkgEntry>();
  listCalls = 0;

  async list(ownerKey: string): Promise<ValuationInputLkgEntry[]> {
    this.listCalls += 1;
    return [...this.entries.values()].filter((entry) => entry.ownerKey === ownerKey);
  }

  async upsert(entry: ValuationInputLkgEntry): Promise<void> {
    this.entries.set(
      `${entry.scope}:${entry.ownerKey}:${entry.metric}:${entry.period}`,
      structuredClone(entry),
    );
  }
}

const now = Date.parse('2026-07-25T00:00:00.000Z');

function scalarEntry(
  metric: 'beta' | 'risk-free-rate' | 'equity-risk-premium',
  value: number,
  overrides: Partial<ValuationInputLkgEntry> = {},
): ValuationInputLkgEntry {
  const market = metric !== 'beta';
  return {
    scope: market ? 'market' : 'company',
    ownerKey: market ? 'US' : 'NVDA',
    metric,
    period: 'latest',
    data: { value },
    source: 'structured-provider',
    origin: 'provider',
    asOf: '2026-07-24T00:00:00.000Z',
    fetchedAt: '2026-07-24T01:00:00.000Z',
    validatedAt: '2026-07-24T01:00:00.000Z',
    freshness: 'fresh',
    schemaVersion: 1,
    provenance: {
      provider: 'structured-provider',
      sourceType: 'structured-provider',
      field: metric,
      fiscalPeriod: 'latest',
      asOf: '2026-07-24T00:00:00.000Z',
      evidence: [],
      evidenceQuality: 'high',
    },
    ...overrides,
  };
}

describe('ValuationInputLkgService', () => {
  it('survives a service restart and shares one US market snapshot across symbols', async () => {
    const repository = new MemoryRepository();
    const cold = new ValuationInputLkgService(repository, () => now);
    await cold.writeMany([
      scalarEntry('beta', 1.72),
      scalarEntry('risk-free-rate', 0.043),
      scalarEntry('equity-risk-premium', 0.047),
    ]);

    const restarted = new ValuationInputLkgService(repository, () => now);
    const [nvda, aapl, msft] = await Promise.all([
      restarted.read('NVDA'),
      restarted.read('AAPL'),
      restarted.read('MSFT'),
    ]);

    expect(nvda.company.beta?.value).toBe(1.72);
    expect(nvda.market.riskFreeRate?.value).toBe(0.043);
    expect(aapl.market.riskFreeRate?.value).toBe(0.043);
    expect(msft.market.equityRiskPremium?.value).toBe(0.047);
    expect([...repository.entries.values()].filter((entry) => entry.scope === 'market'))
      .toHaveLength(2);
    expect(repository.listCalls).toBe(4);
  });

  it('rejects an invalid replacement and preserves the last-known-good value', async () => {
    const repository = new MemoryRepository();
    const service = new ValuationInputLkgService(repository, () => now);
    await service.write(scalarEntry('beta', 1.72));

    await expect(service.write(scalarEntry('beta', Number.NaN))).rejects.toThrow(
      'Invalid valuation LKG entry',
    );

    const restarted = new ValuationInputLkgService(repository, () => now);
    expect((await restarted.read('NVDA')).company.beta?.value).toBe(1.72);
  });

  it('deduplicates concurrent persistent reads for the same symbol and shared market', async () => {
    const repository = new MemoryRepository();
    const list = vi.spyOn(repository, 'list');
    const service = new ValuationInputLkgService(repository, () => now);

    await Promise.all([
      service.read('NVDA'),
      service.read('NVDA'),
      service.read('NVDA'),
    ]);

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledWith('NVDA');
    expect(list).toHaveBeenCalledWith('US');
  });
});
