// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandLockup } from './BrandLockup';
import { appConfig } from '@/src/config/app';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<'a'> & { href: string }) =>
    <a href={href} {...rest}>{children}</a>,
}));

vi.mock('next/image', () => ({
  // `priority` and `sizes` are next/image's own props and mean nothing to a raw
  // <img>; forwarding them only earns a React warning about a boolean attribute.
  default: ({ src, alt, className }: { src: string; alt: string; className?: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} />,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<BrandLockup />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('BrandLockup', () => {
  it('is one link back to overview, named PortKheaw exactly once', () => {
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/');
    expect(links[0].getAttribute('aria-label')).toBe(appConfig.name);
    expect(appConfig.name).toBe('PortKheaw');

    /*
     * The label wins over the contents, and every part of the contents is
     * hidden anyway — so a screen reader announces "PortKheaw" once rather than
     * once for the link and again for the two halves of the word.
     */
    for (const child of Array.from(links[0].children)) {
      expect(child.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('draws the word in two halves that read as one word', () => {
    const word = container.querySelector('.brand-lockup__word');
    expect(word?.textContent).toBe('PortKheaw');
    expect(container.querySelector('.brand-lockup__port')?.textContent).toBe('Port');
    expect(container.querySelector('.brand-lockup__kheaw')?.textContent).toBe('Kheaw');
  });

  it('uses the committed mascot artwork, decoratively, with the arrow after the word', () => {
    const mascot = container.querySelector('img');
    expect(mascot?.getAttribute('src')).toBe('/brand/kheaw-mark.png');
    expect(mascot?.getAttribute('alt')).toBe('');

    const arrow = container.querySelector('.brand-lockup__arrow');
    expect(arrow?.getAttribute('aria-hidden')).toBe('true');
    expect(arrow?.previousElementSibling?.textContent).toBe('Kheaw');
  });
});

describe('BrandLockup styling contract', () => {
  const styles = readFileSync(resolve('app/globals.css'), 'utf8');

  it('colours the halves from tokens, with a readable fallback under the gradient', () => {
    expect(styles).toContain('.brand-lockup__port { color: var(--text); }');
    expect(styles).toContain('.brand-lockup__kheaw { color: var(--brand-green); }');
    // The gradient only replaces the flat colour where clipping text works, so
    // "Kheaw" can never render as transparent-on-transparent.
    expect(styles).toContain('@supports ((background-clip: text) or (-webkit-background-clip: text))');
  });

  it('defines the brand green in both appearances and never as the market-gain colour', () => {
    for (const appearance of ['dark', 'light'] as const) {
      const theme = readFileSync(resolve(`src/themes/portkheaw/${appearance}.css`), 'utf8');
      expect(theme).toMatch(/--brand-green: #[0-9A-Fa-f]{6};/);
      expect(theme).toMatch(/--brand-green-deep: #[0-9A-Fa-f]{6};/);
      const [, green] = theme.match(/--brand-green: (#[0-9A-Fa-f]{6});/)!;
      const [, positive] = theme.match(/--positive: (#[0-9A-Fa-f]{6});/)!;
      expect(green).not.toBe(positive);
    }
  });

  it('holds one mascot state on its own black plate', () => {
    const source = readFileSync(resolve('src/components/brand/BrandLockup.tsx'), 'utf8');
    expect(source).toContain('bg-[var(--brand-mark-bg)]');
    // The artwork is used as committed: never recoloured, never redrawn.
    expect(source).not.toContain('filter:');
    expect(source).not.toContain('hue-rotate');
  });
});

describe('the header that carries it', () => {
  const header = readFileSync(resolve('src/components/layout/Header.tsx'), 'utf8');

  it('shows the lockup and keeps every control it had', () => {
    expect(header).toContain('<BrandLockup');
    for (const control of ['aria-label="ค้นหา"', 'aria-label="โปรไฟล์"', '/api/notifications/unread-count', "router.push('/notifications')"]) {
      expect(header).toContain(control);
    }
  });

  it('keeps the brand out of the way of a back-navigable page title', () => {
    // Alert-style pages replace the lockup with a back control, so the two can
    // never compete for the same 320px row.
    expect(header).toContain('{!backFallbackHref && (');
  });
});
