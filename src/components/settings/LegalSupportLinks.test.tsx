// @vitest-environment jsdom

/**
 * The legal and help section of Settings.
 *
 * Two things are being pinned. First, that every policy page and the support
 * centre are reachable from Settings by their real routes — a broken or missing
 * row here is a trust page nobody can find. Second, that the section is built
 * from the shared document catalogue rather than a second hand-written list,
 * which is what stops it drifting when a document is renamed or rerouted.
 *
 * jsdom has no layout engine, so the narrow-viewport assertions are about the
 * DOM and the utility classes that make wrapping possible — `min-w-0` on every
 * flex child and `break-words` on the text — rather than measured pixels. The
 * labels here are the longest in the product and are wider than 320px, so
 * without those the page scrolls sideways.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legalDocuments, legalLinkOrder } from '@/src/lib/legal/documents';
import { OPEN_SOURCE_PAGE } from '@/src/lib/legal/open-source';
import { LegalSupportLinks } from './LegalSupportLinks';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => { root.render(<LegalSupportLinks />); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

const links = () => [...container.querySelectorAll('a')];

describe('the section a reader goes looking for', () => {
  it('is titled as the brief names it', () => {
    const heading = container.querySelector('#legal-support-heading');
    expect(heading?.textContent).toBe('ข้อมูล กฎหมาย และความช่วยเหลือ');
    expect(container.querySelector('section')?.getAttribute('aria-labelledby'))
      .toBe('legal-support-heading');
  });

  it('links to all five policy pages, the attribution page and the support centre', () => {
    expect(links().map((link) => link.getAttribute('href'))).toEqual([
      '/terms',
      '/privacy',
      '/subscription-policy',
      '/refund-policy',
      '/investment-disclaimer',
      '/open-source',
      '/support',
    ]);
  });

  /*
   * The row label is the document's own title, so a reader who taps a row lands
   * on a page with the same heading. A second hand-written label list is exactly
   * the thing that drifts.
   */
  it('labels each row with the document’s own title', () => {
    const rows = links();
    legalLinkOrder.forEach((slug, index) => {
      expect(rows[index].textContent, slug).toContain(legalDocuments[slug].title);
      expect(rows[index].textContent, slug).toContain(legalDocuments[slug].subtitle);
    });
    expect(rows[5].textContent).toContain(OPEN_SOURCE_PAGE.title);
    expect(rows[5].textContent).toContain(OPEN_SOURCE_PAGE.subtitle);
    expect(rows[6].textContent).toContain('ศูนย์ช่วยเหลือและรายงานปัญหา');
  });

  it('gives every row a tap target and a visible focus ring', () => {
    for (const link of links()) {
      expect(link.className).toContain('min-h-14');
      expect(link.className).toContain('focus-visible:ring-2');
    }
  });
});

/**
 * 320×720 and 390×844 both have to hold. Neither is measurable here, so what is
 * asserted is the structure that makes them possible.
 */
describe('at 320px and 390px', () => {
  it('lets every row wrap instead of widening the page', () => {
    expect(container.querySelector('section')?.className).toContain('min-w-0');
    for (const link of links()) {
      expect(link.className).toContain('min-w-0');
      // The label column shrinks; the icon tile and the chevron do not.
      const label = link.querySelector('span.min-w-0.flex-1');
      expect(label).not.toBeNull();
      expect([...label!.children].every((child) => child.className.includes('break-words')))
        .toBe(true);
    }
  });

  it('never lets a row scroll sideways on its own', () => {
    const list = container.querySelector('ul');
    expect(list?.className).toContain('overflow-hidden');
    expect(container.querySelector('[class*="overflow-x-auto"]')).toBeNull();
    expect(container.querySelector('[class*="whitespace-nowrap"]')).toBeNull();
  });
});
