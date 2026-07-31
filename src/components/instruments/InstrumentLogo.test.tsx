// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstrumentLogo, normalizeInstrumentLogoUrl } from './InstrumentLogo';

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
    expect(fallback.getAttribute('aria-label')).toContain('NVIDIA');
    expect(container.querySelector('img')).toBeNull();
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
