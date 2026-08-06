import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/src/lib/supabase/admin', () => ({ createAdminClient: mocks.createAdminClient }));

import {
  invalidateInstrumentLogo,
  isBrokenLogoUrl,
  persistInstrumentLogos,
  rememberBrokenLogoUrl,
  resetBrokenLogoUrls,
} from './logo-store';

interface Call { table: string; values: Record<string, unknown>; filters: Array<[string, unknown]> }

let calls: Call[] = [];
let selectResult: { data: Array<{ symbol: string }> | null; error: { message: string } | null };

function fakeClient() {
  return {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          const call: Call = { table, values, filters: [] };
          calls.push(call);
          const builder = {
            eq(column: string, value: unknown) {
              call.filters.push([column, value]);
              return builder;
            },
            select() {
              return Promise.resolve(selectResult);
            },
            then(resolve: (value: { error: null }) => unknown) {
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return builder;
        },
      };
    },
  };
}

beforeEach(() => {
  calls = [];
  selectResult = { data: [{ symbol: 'RKLB' }], error: null };
  mocks.createAdminClient.mockReset();
  mocks.createAdminClient.mockReturnValue(fakeClient());
  resetBrokenLogoUrls();
});

describe('persistInstrumentLogos', () => {
  it('stores a newly resolved logo against its symbol', async () => {
    await persistInstrumentLogos([
      { symbol: 'ONDS', logoUrl: 'https://images.example.test/ONDS.png', persisted: null },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.values.logo_url).toBe('https://images.example.test/ONDS.png');
    expect(calls[0]?.filters).toEqual([['symbol', 'ONDS']]);
  });

  it('writes nothing when the value is unchanged, empty or unusable', async () => {
    await persistInstrumentLogos([
      {
        symbol: 'ONDS',
        logoUrl: 'https://images.example.test/ONDS.png',
        persisted: 'https://images.example.test/ONDS.png',
      },
      { symbol: 'NVDA', logoUrl: '', persisted: 'https://images.example.test/NVDA.png' },
      { symbol: 'NVTS', logoUrl: 'http://insecure.example.test/NVTS.png', persisted: null },
    ]);

    expect(calls).toHaveLength(0);
  });

  it('does not fail a page when no service-role client is configured', async () => {
    mocks.createAdminClient.mockReturnValue(null);
    await expect(persistInstrumentLogos([
      { symbol: 'ONDS', logoUrl: 'https://images.example.test/ONDS.png', persisted: null },
    ])).resolves.toEqual([]);
  });
});

describe('invalidateInstrumentLogo', () => {
  it('clears the row only when the stored URL is the one that broke', async () => {
    const cleared = await invalidateInstrumentLogo('RKLB', 'https://images.example.test/RKLB.png');

    expect(cleared).toBe(true);
    expect(calls[0]?.values.logo_url).toBeNull();
    expect(calls[0]?.filters).toEqual([
      ['symbol', 'RKLB'],
      ['logo_url', 'https://images.example.test/RKLB.png'],
    ]);
  });

  it('reports nothing cleared when the stored URL has already moved on', async () => {
    selectResult = { data: [], error: null };
    await expect(invalidateInstrumentLogo('RKLB', 'https://images.example.test/old.png'))
      .resolves.toBe(false);
  });

  it('refuses a URL that could never have been stored', async () => {
    await expect(invalidateInstrumentLogo('RKLB', 'javascript:alert(1)')).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('broken URL memory', () => {
  it('remembers a reported URL, and only that URL', () => {
    rememberBrokenLogoUrl('https://images.example.test/RKLB.png');
    expect(isBrokenLogoUrl('https://images.example.test/RKLB.png')).toBe(true);
    expect(isBrokenLogoUrl('https://images.example.test/NVDA.png')).toBe(false);
    expect(isBrokenLogoUrl(null)).toBe(false);
  });
});
