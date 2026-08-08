// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyProfile, DataFreshness } from '@/src/lib/market-data/types';

/**
 * Two reader-facing properties of the profile card:
 *
 * 1. A Thai reader never sees the English paragraph painted and then replaced —
 *    the description waits behind a placeholder until an attempt has settled,
 *    and falls back to the original English only when one actually failed.
 * 2. An ETF is a fund, not a company, and its heading says so.
 */

let resolveTranslation: (text: string) => void;
let rejectTranslation: (cause: Error) => void;

vi.mock('./company-profile-translation-client', () => ({
  companyProfileTranslationClient: {
    request: vi.fn(() => new Promise<string>((resolve, reject) => {
      resolveTranslation = resolve;
      rejectTranslation = reject;
    })),
  },
}));

import { CompanyProfileCard } from './CompanyProfileCard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENGLISH = 'Rocket Lab provides launch services to commercial customers.';
const THAI = 'Rocket Lab ให้บริการส่งดาวเทียมแก่ลูกค้าเชิงพาณิชย์';

const freshness: DataFreshness = {
  status: 'cached',
  asOf: '2026-08-07T13:00:00.000Z',
  maxAgeSeconds: 86_400,
};

function profile(description: string | null): CompanyProfile {
  return {
    symbol: 'RKLB',
    name: 'Rocket Lab USA, Inc.',
    description,
    exchange: 'NASDAQ',
    currency: 'USD',
    country: 'USA',
    sector: 'Industrials',
    industry: 'Aerospace & Defense',
    website: 'https://www.rocketlabusa.com/',
    marketCapitalization: 20_000_000_000,
    employees: 2_100,
    fiscalYearEnd: 'December',
    latestQuarter: '2026-06-30',
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(overrides: Partial<React.ComponentProps<typeof CompanyProfileCard>> = {}) {
  act(() => root.render(
    <CompanyProfileCard
      symbol="RKLB"
      profile={profile(ENGLISH)}
      freshness={freshness}
      provider="alpha-vantage"
      error={null}
      loading={false}
      retryAt={0}
      onRetry={() => {}}
      {...overrides}
    />,
  ));
}

function description(): string {
  return container.querySelector('.min-h-24')?.textContent ?? '';
}

describe('Thai description handover', () => {
  it('shows a placeholder instead of flashing the English source', () => {
    render();
    expect(description()).not.toContain('Rocket Lab provides');
    expect(container.querySelector('.min-h-24 [role="status"]')).not.toBeNull();
  });

  it('replaces the placeholder with Thai, and only Thai, once it arrives', async () => {
    render();
    await act(async () => { resolveTranslation(THAI); });
    expect(description()).toContain(THAI);
    expect(description()).not.toContain('Rocket Lab provides');
    expect(container.querySelector('.min-h-24 [role="status"]')).toBeNull();
  });

  it('falls back to the original English when the translation genuinely fails', async () => {
    render();
    await act(async () => { rejectTranslation(new Error('Translation request timed out')); });
    expect(description()).toContain('Rocket Lab provides');
    expect(description()).toContain('กำลังแสดงข้อความภาษาอังกฤษต้นฉบับ');
  });

  it('never withholds text from an English reader', () => {
    render({ language: 'en' });
    expect(description()).toContain('Rocket Lab provides');
  });
});

describe('instrument wording', () => {
  function heading(): string {
    return container.querySelector('h2')?.textContent ?? '';
  }

  it('calls an ETF a fund', () => {
    render({ assetType: 'ETF' });
    expect(heading()).toBe('ข้อมูลกองทุน');
  });

  it('hides company-only fields for a crypto asset without failing the card', () => {
    render({ assetType: 'crypto', language: 'en' });
    expect(heading()).toBe('Crypto Asset Profile');
    expect(container.textContent).toContain('Currency');
    expect(container.textContent).not.toContain('Employees');
    expect(container.textContent).not.toContain('Fiscal year end');
  });

  it('leaves a common stock, and an unknown instrument, as a company', () => {
    render({ assetType: 'Stock' });
    expect(heading()).toBe('ข้อมูลบริษัท');
    render({ assetType: null });
    expect(heading()).toBe('ข้อมูลบริษัท');
  });
});
