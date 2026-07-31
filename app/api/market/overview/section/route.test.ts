import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const services = vi.hoisted(() => ({
  loadMarketIndices: vi.fn(),
  loadIndustryDashboard: vi.fn(),
  loadWatchlistPrices: vi.fn(),
}));

vi.mock('@/src/lib/overview/service', () => services);
vi.mock('@/src/lib/supabase/server', () => ({ createClient: vi.fn(async () => null) }));
vi.mock('@/src/lib/watchlist/repository', () => ({
  WatchlistRepository: class {
    async getDefault() { return { items: [] }; }
  },
}));

import { GET } from './route';

function request(section: string) {
  return new NextRequest(`http://localhost/api/market/overview/section?section=${section}`);
}

describe('overview section retry route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    services.loadMarketIndices.mockResolvedValue([{ symbol: 'SPY' }]);
    services.loadIndustryDashboard.mockResolvedValue({
      industries: [{ slug: 'semiconductors' }],
      breadth: { validCount: 12 },
      state: 'ready',
      classificationUpdatedAt: '2026-07-31T04:40:43.000Z',
      quotesUpdatedAt: '2026-07-31T14:00:00.000Z',
      candidateCount: 285,
      completedCount: 282,
      deadlineReached: false,
    });
    services.loadWatchlistPrices.mockResolvedValue([]);
  });

  it('returns only the requested batch section', async () => {
    const response = await GET(request('industries'));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.data).toMatchObject({
      section: 'industries',
      value: [{ slug: 'semiconductors' }],
      related: {
        breadth: { validCount: 12 },
        industryData: {
          state: 'ready',
          candidateCount: 285,
          completedCount: 282,
        },
      },
    });
    expect(services.loadMarketIndices).not.toHaveBeenCalled();
    expect(services.loadIndustryDashboard).toHaveBeenCalledTimes(1);
  });

  it('isolates a provider failure behind safe copy', async () => {
    services.loadMarketIndices.mockRejectedValue(new Error('raw upstream endpoint failed'));
    const response = await GET(request('market'));
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(503);
    expect(body).toContain('ข้อมูลส่วนนี้ยังไม่พร้อม');
    expect(body).not.toContain('raw upstream');
  });

  it('rejects unknown sections without calling a provider', async () => {
    const response = await GET(request('portfolio'));
    expect(response.status).toBe(400);
    expect(services.loadMarketIndices).not.toHaveBeenCalled();
    expect(services.loadIndustryDashboard).not.toHaveBeenCalled();
  });
});
