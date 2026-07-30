// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricDisclosure } from './MetricDisclosure';

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return { host, root };
}

const toggles = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="metric-disclosure-toggle"]')];
const panels = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-testid="metric-disclosure-panel"]')];

describe('MetricDisclosure', () => {
  it('starts collapsed so no explanation is on screen before it is pressed', async () => {
    const { host, root } = mount(null);
    await act(async () => root.render(<MetricDisclosure summary="ดูคำอธิบาย" label="POP">สัดส่วน valid paths ที่ P&L มากกว่า 0</MetricDisclosure>));

    expect(toggles(host)[0].getAttribute('aria-expanded')).toBe('false');
    expect(panels(host)[0].hidden).toBe(true);
    expect(toggles(host)[0].textContent).toContain('ดูคำอธิบาย');

    await act(async () => root.unmount());
  });

  it('opens on press and closes again on a second press', async () => {
    const { host, root } = mount(null);
    await act(async () => root.render(<MetricDisclosure summary="ดูคำอธิบาย" openSummary="ซ่อนคำอธิบาย">คำอธิบาย POP</MetricDisclosure>));

    await act(async () => { toggles(host)[0].click(); });
    expect(toggles(host)[0].getAttribute('aria-expanded')).toBe('true');
    expect(panels(host)[0].hidden).toBe(false);
    expect(panels(host)[0].textContent).toContain('คำอธิบาย POP');
    expect(toggles(host)[0].textContent).toContain('ซ่อนคำอธิบาย');

    await act(async () => { toggles(host)[0].click(); });
    expect(toggles(host)[0].getAttribute('aria-expanded')).toBe('false');
    expect(panels(host)[0].hidden).toBe(true);

    await act(async () => root.unmount());
  });

  it('keeps one card open without opening any sibling card', async () => {
    const { host, root } = mount(null);
    await act(async () => root.render(<>
      <MetricDisclosure summary="ดูคำอธิบาย" label="POP">คำอธิบาย POP</MetricDisclosure>
      <MetricDisclosure summary="ดูคำอธิบาย" label="VaR 95%">คำอธิบาย VaR</MetricDisclosure>
      <MetricDisclosure summary="ดูคำอธิบาย" label="P95">คำอธิบาย P95</MetricDisclosure>
    </>));

    expect(panels(host).map((panel) => panel.hidden)).toEqual([true, true, true]);

    await act(async () => { toggles(host)[1].click(); });
    expect(panels(host).map((panel) => panel.hidden)).toEqual([true, false, true]);
    expect(toggles(host).map((toggle) => toggle.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false']);

    await act(async () => { toggles(host)[2].click(); });
    expect(panels(host).map((panel) => panel.hidden)).toEqual([true, false, false]);

    await act(async () => root.unmount());
  });

  it('exposes a keyboard-operable button wired to its own panel', async () => {
    const { host, root } = mount(null);
    await act(async () => root.render(<>
      <MetricDisclosure summary="ดูคำอธิบาย">คำอธิบายที่หนึ่ง</MetricDisclosure>
      <MetricDisclosure summary="ดูคำอธิบาย">คำอธิบายที่สอง</MetricDisclosure>
    </>));

    const [first, second] = toggles(host);
    // A real <button> gets Enter/Space activation from the platform; the ids must
    // still be unique per instance or aria-controls would cross-wire the cards.
    expect(first.tagName).toBe('BUTTON');
    expect(first.getAttribute('type')).toBe('button');
    expect(first.getAttribute('aria-controls')).not.toBe(second.getAttribute('aria-controls'));
    expect(first.getAttribute('aria-controls')).toBe(panels(host)[0].id);
    expect(second.getAttribute('aria-controls')).toBe(panels(host)[1].id);
    expect(panels(host)[0].getAttribute('aria-labelledby')).toBe(first.id);
    expect(first.className).toContain('focus-visible:ring-2');

    first.focus();
    expect(document.activeElement).toBe(first);

    await act(async () => root.unmount());
  });
});
