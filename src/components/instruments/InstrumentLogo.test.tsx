// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstrumentLogo, normalizeInstrumentLogoUrl } from './InstrumentLogo';
import {
  InstrumentLogoProvider,
  rememberInstrumentLogo,
  resetRememberedInstrumentLogos,
} from './InstrumentLogoProvider';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.useRealTimers();
});

describe('InstrumentLogo', () => {
  it('normalizes only credential-free HTTPS provider URLs', () => {
    expect(normalizeInstrumentLogoUrl(' https://images.example.test/logo.png#fragment '))
      .toBe('https://images.example.test/logo.png');
    expect(normalizeInstrumentLogoUrl('/market-logos/spy.svg#fragment'))
      .toBe('/market-logos/spy.svg');
    expect(normalizeInstrumentLogoUrl('//images.example.test/logo.png')).toBeNull();
    expect(normalizeInstrumentLogoUrl('http://images.example.test/logo.png')).toBeNull();
    expect(normalizeInstrumentLogoUrl('https://user:secret@images.example.test/logo.png')).toBeNull();
    expect(normalizeInstrumentLogoUrl('not-a-url')).toBeNull();
  });

  it('renders a fixed-size monogram when no provider logo exists', () => {
    act(() => {
      root.render(<InstrumentLogo symbol="NVDA" companyName="NVIDIA" logoUrl={null} size={44} />);
    });
    const fallback = container.querySelector('[role="img"]') as HTMLElement;
    expect(fallback.textContent).toBe('NVD');
    expect(fallback.style.width).toBe('44px');
    expect(fallback.style.getPropertyValue('--instrument-logo-desktop-size')).toBe('44px');
    expect(fallback.style.getPropertyValue('--instrument-logo-mobile-size')).toBe('44px');
    expect(fallback.getAttribute('aria-label')).toContain('NVIDIA');
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders a responsive plain logo without a nested frame or image padding', () => {
    act(() => {
      root.render(
        <InstrumentLogo
          symbol="RKLB"
          companyName="Rocket Lab"
          logoUrl="https://images.example.test/rklb.png"
          size={44}
          mobileSize={40}
          appearance="plain"
        />,
      );
    });
    const logo = container.firstElementChild as HTMLElement;
    const image = container.querySelector('img') as HTMLImageElement;
    expect(logo.style.width).toBe('40px');
    expect(logo.style.getPropertyValue('--instrument-logo-desktop-size')).toBe('44px');
    expect(logo.style.getPropertyValue('--instrument-logo-mobile-size')).toBe('40px');
    expect(logo.className).toContain('bg-transparent');
    expect(logo.className).not.toContain('border');
    expect(image.className).toContain('object-contain');
    expect(image.className).not.toContain('p-1');
  });

  it('does not priority-preload an external provider logo', () => {
    act(() => {
      root.render(
        <InstrumentLogo
          symbol="AAPL"
          companyName="Apple Inc."
          logoUrl="https://images.example.test/aapl.png"
          priority
        />,
      );
    });
    const image = container.querySelector('img') as HTMLImageElement;
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('fetchpriority')).not.toBe('high');
    expect(image.getAttribute('data-nimg')).toBeNull();
    expect(image.getAttribute('decoding')).toBe('async');
  });

  it('keeps priority loading for a same-origin logo asset', () => {
    act(() => {
      root.render(
        <InstrumentLogo
          symbol="SPY"
          companyName="S&P 500"
          logoUrl="/market-logos/spy.svg"
          priority
        />,
      );
    });
    const image = container.querySelector('img') as HTMLImageElement;
    expect(image.getAttribute('loading')).toBe('eager');
    expect(image.getAttribute('data-nimg')).toBe('fill');
  });

  it('falls back to a monogram after one real provider image fails', () => {
    act(() => {
      root.render(
        <InstrumentLogo
          symbol="AAPL"
          companyName="Apple Inc."
          logoUrl="https://images.example.test/aapl.png"
        />,
      );
    });
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    act(() => image!.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[role="img"]')?.textContent).toBe('AAP');
  });

  it('draws the logo the page resolved when the caller has none in scope', () => {
    act(() => {
      root.render(
        <InstrumentLogoProvider logos={{ ONDS: 'https://images.example.test/onds.png' }}>
          {/* Exactly what a holding row passes: it knows the symbol, not the URL. */}
          <InstrumentLogo symbol="ONDS" companyName="Ondas" logoUrl={null} />
        </InstrumentLogoProvider>,
      );
    });
    const image = container.querySelector('img') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://images.example.test/onds.png');
  });

  it('lets an explicit logo win over the page-level one', () => {
    act(() => {
      root.render(
        <InstrumentLogoProvider logos={{ SPY: 'https://images.example.test/spy.png' }}>
          <InstrumentLogo symbol="SPY" companyName="S&P 500" logoUrl="/market-logos/spy.svg" />
        </InstrumentLogoProvider>,
      );
    });
    // `next/image` serves the same-origin asset, so the bundled mark wins.
    expect(container.querySelector('img')?.getAttribute('src')).toContain('/market-logos/spy.svg');
  });

  it('paints a logo a mutation just resolved, without a reload', () => {
    resetRememberedInstrumentLogos();
    // Exactly what a newly added holding renders as: symbol known, logo not yet.
    act(() => {
      root.render(<InstrumentLogo symbol="AEVA" companyName="Aeva" logoUrl={null} />);
    });
    expect(container.querySelector('[role="img"]')?.textContent).toBe('AEV');

    // The add mutation comes back with the URL it resolved and persisted.
    act(() => rememberInstrumentLogo('aeva', 'https://images.example.test/aeva.png'));

    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('https://images.example.test/aeva.png');
    resetRememberedInstrumentLogos();
  });

  it('ignores an empty mutation response rather than blanking a logo', () => {
    resetRememberedInstrumentLogos();
    rememberInstrumentLogo('NVTS', 'https://images.example.test/nvts-ok.png');
    act(() => {
      root.render(<InstrumentLogo symbol="NVTS" companyName="Navitas" logoUrl={null} />);
    });
    act(() => {
      rememberInstrumentLogo('NVTS', null);
      rememberInstrumentLogo('NVTS', '');
    });

    expect(container.querySelector('img')?.getAttribute('src'))
      .toBe('https://images.example.test/nvts-ok.png');
    resetRememberedInstrumentLogos();
  });

  it('reports a broken provider logo once, then falls back silently', () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: { body?: string }) => {
      calls.push(`${url}:${init?.body ?? ''}`);
      return Promise.resolve(new Response('{}'));
    }));
    const broken = 'https://images.example.test/broken-once.png';

    act(() => {
      root.render(<InstrumentLogo symbol="NVTS" companyName="Navitas" logoUrl={broken} />);
    });
    act(() => container.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(container.querySelector('[role="img"]')?.textContent).toBe('NVT');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/api/instruments/logo-invalidate');
    expect(calls[0]).toContain('NVTS');

    // A second component showing the same URL must not report it again.
    act(() => {
      root.render(<InstrumentLogo symbol="NVTS" companyName="Navitas" logoUrl={broken} />);
    });
    expect(container.querySelector('img')).toBeNull();
    expect(calls).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('does not report a same-origin asset that fails to load', () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response('{}'));
    }));
    act(() => {
      root.render(<InstrumentLogo symbol="GLD" companyName="ทองคำ" logoUrl="/market-logos/gld.svg" />);
    });
    act(() => container.querySelector('img')!.dispatchEvent(new Event('error')));
    expect(calls).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('keeps a successfully loaded provider image after the timeout window', async () => {
    vi.useFakeTimers();
    act(() => {
      root.render(
        <InstrumentLogo
          symbol="MSFT"
          companyName="Microsoft"
          logoUrl="https://images.example.test/msft.png"
        />,
      );
    });
    const image = container.querySelector('img');
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 100 });
    await act(async () => {
      image!.dispatchEvent(new Event('load', { bubbles: true }));
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(8_001));
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.querySelector('[role="img"]')).toBeNull();
  });
});
