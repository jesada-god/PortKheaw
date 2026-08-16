// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The two kinds of emphasis, kept distinct.
 *
 * The operator overview leans on exactly one accent-surfaced card —
 * "ผู้ใช้งานทั้งหมด" — while three other bands each open with a figure that is
 * merely *larger*. Before `lead` existed, making a band's first figure bigger
 * meant giving it the accent too, and four accented cards say the same thing as
 * none. So what is asserted here is the separation itself: size without colour
 * has to be reachable, and the accent has to remain the thing that is not.
 */

import { StatCard } from './StatCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode): HTMLDivElement {
  act(() => { root.render(node); });
  return container;
}

/** The card's own element, whatever wrapper React put around it. */
function card(): HTMLElement {
  const element = container.firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error('nothing rendered');
  return element;
}

function value(): HTMLElement {
  const element = container.querySelectorAll('p')[1];
  if (!(element instanceof HTMLElement)) throw new Error('no value rendered');
  return element;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('emphasis', () => {
  it('gives a plain card the ordinary surface and the ordinary figure size', () => {
    render(<StatCard label="Pro" value="3" />);
    expect(card().className).toContain('bg-[var(--surface)]');
    expect(card().className).not.toContain('accent-soft');
    expect(value().className).toContain('text-xl');
  });

  it('makes a lead card larger without spending the accent on it', () => {
    render(<StatCard label="รายได้" value="฿0" emphasis="lead" />);
    expect(value().className).toContain('text-3xl');
    // The whole point of the variant: size, and no accent surface.
    expect(card().className).toContain('bg-[var(--surface)]');
    expect(card().className).not.toContain('accent-soft');
  });

  it('gives the one hero card both the size and the accent surface', () => {
    render(<StatCard label="ผู้ใช้งานทั้งหมด" value="18" emphasis="hero" />);
    expect(value().className).toContain('text-3xl');
    expect(card().className).toContain('bg-[var(--accent-soft)]');
  });

  it('keeps the critical tone on the figure, and never lets emphasis replace it', () => {
    render(<StatCard label="ระดับวิกฤต" value="2" tone="critical" />);
    expect(value().className).toContain('text-[var(--negative)]');
  });
});
