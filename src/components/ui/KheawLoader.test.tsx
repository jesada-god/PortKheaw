// @vitest-environment jsdom

/**
 * The loader's rendered contract: what it announces, what it shows, and what it
 * deliberately does not show.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KHEAW_LOADING_MESSAGE, KHEAW_LOADING_STATUS_LABEL, KheawLoader } from './KheawLoader';

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
});

function render(element: React.ReactElement) {
  act(() => root.render(element));
}

const status = () => container.querySelector<HTMLElement>('[role="status"]');
const mascot = () => container.querySelector<HTMLImageElement>('img');
const bubble = () => container.querySelector<HTMLElement>('.kheaw-loader__bubble');

describe('KheawLoader', () => {
  it('is a polite live region named for assistive technology', () => {
    render(<KheawLoader />);
    const region = status()!;
    expect(region).toBeTruthy();
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-label')).toBe(KHEAW_LOADING_STATUS_LABEL);
  });

  it('renders the message as real text, not baked into the artwork', () => {
    render(<KheawLoader />);
    expect(bubble()?.textContent).toBe(KHEAW_LOADING_MESSAGE);
    expect(bubble()?.textContent).toBe('กำลังโหลดอยู่นะ!');
  });

  it('accepts a different message without changing anything else', () => {
    render(<KheawLoader message="กำลังโหลดข้อมูลออปชัน" />);
    expect(bubble()?.textContent).toBe('กำลังโหลดข้อมูลออปชัน');
    expect(mascot()?.getAttribute('src')).toBe('/brand/kheaw-loading.webp');
  });

  it('treats the mascot as decorative, since the status text already speaks', () => {
    render(<KheawLoader />);
    const image = mascot()!;
    expect(image.getAttribute('alt')).toBe('');
    expect(image.getAttribute('aria-hidden')).toBe('true');
  });

  it('reserves the mascot box before the file arrives, so nothing shifts', () => {
    render(<KheawLoader />);
    const image = mascot()!;
    // Intrinsic dimensions of the committed asset: the browser derives the
    // aspect ratio from these and holds the space during load.
    expect(image.getAttribute('width')).toBe('360');
    expect(image.getAttribute('height')).toBe('352');
  });

  it('leaves the mascot lazy by default, and fetches it first when prioritised', () => {
    // The default belongs to section loaders, which sit below the fold.
    render(<KheawLoader />);
    expect(mascot()?.getAttribute('loading')).toBe('lazy');

    /*
     * On a route fallback the mascot IS the LCP element, and `lazy` hid it from
     * the preload scanner: Lighthouse measured 1.07s of load delay because the
     * request could not start until after first layout, behind every app chunk.
     */
    render(<KheawLoader variant="page" deferred priority />);
    const image = mascot()!;
    // next/image drops the attribute entirely rather than writing `eager`.
    expect(image.getAttribute('loading')).toBeNull();
    expect(image.getAttribute('fetchpriority')).toBe('high');
  });

  it('offers the browser exactly one candidate, cut to the drawn size', () => {
    render(<KheawLoader variant="page" />);
    /*
     * No `srcSet`, so there is no larger variant to pick by mistake, and no
     * `_next/image` transform on the critical path. Over-download is prevented
     * upstream instead: `--kheaw-mascot-size` tops out at 180px and the one
     * committed file is 360px — that width at a 2x device pixel ratio.
     */
    expect(mascot()?.getAttribute('src')).toBe('/brand/kheaw-loading.webp');
    expect(mascot()?.getAttribute('srcset')).toBeNull();
    expect(mascot()?.getAttribute('width')).toBe('360');
  });

  it('carries nothing but the mascot and the message', () => {
    render(<KheawLoader />);
    const region = status()!;
    expect(region.querySelectorAll('img')).toHaveLength(1);
    expect(region.querySelectorAll('svg')).toHaveLength(0);
    expect(region.querySelectorAll('a, button')).toHaveLength(0);
    // Bubble, stage, mascot and the contact shadow — nothing else.
    expect(region.querySelectorAll('.kheaw-loader__shadow')).toHaveLength(1);
    expect(region.textContent).toBe(KHEAW_LOADING_MESSAGE);
  });

  it('separates the static bubble from the animated mascot', () => {
    render(<KheawLoader />);
    // The bubble is a sibling of the stage, never inside it, so the bounce
    // cannot carry the message along with it.
    expect(bubble()?.parentElement).toBe(status());
    expect(mascot()?.closest('.kheaw-loader__stage')).toBeTruthy();
    expect(bubble()?.closest('.kheaw-loader__stage')).toBeNull();
  });

  describe.each(['page', 'section'] as const)('%s variant', (variant) => {
    it('renders the same markup under a variant-specific class', () => {
      render(<KheawLoader variant={variant} />);
      const region = status()!;
      expect(region.classList.contains('kheaw-loader')).toBe(true);
      expect(region.classList.contains(`kheaw-loader--${variant}`)).toBe(true);
      expect(region.dataset.variant).toBe(variant);
      expect(bubble()?.textContent).toBe(KHEAW_LOADING_MESSAGE);
      expect(mascot()).toBeTruthy();
    });
  });

  it('opts into the CSS grace only when asked, and into the fade only when leaving', () => {
    render(<KheawLoader />);
    expect(status()!.classList.contains('kheaw-loader--deferred')).toBe(false);
    expect(status()!.classList.contains('kheaw-loader--leaving')).toBe(false);

    render(<KheawLoader deferred />);
    expect(status()!.classList.contains('kheaw-loader--deferred')).toBe(true);

    render(<KheawLoader leaving />);
    expect(status()!.classList.contains('kheaw-loader--leaving')).toBe(true);
  });
});
