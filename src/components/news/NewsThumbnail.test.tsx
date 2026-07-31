// @vitest-environment jsdom

/**
 * Guards the two decisions behind the news thumbnail.
 *
 * 1. A native image keeps arbitrary provider-supplied URLs out of the Next image
 *    optimizer and on CSP `img-src`; routing them through the optimizer would
 *    require `hostname: '**'`, an open image proxy.
 * 2. Everything that is not a renderable publisher image — none supplied, Data
 *    Saver, plain HTTP, or a request that fails — renders no thumbnail frame.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NewsThumbnail } from './NewsThumbnail';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
let container: HTMLDivElement;
let root: Root;

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => { root.render(element); });
}

beforeEach(() => {
  (process.env as Record<string, string>).NODE_ENV = 'production';
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  (process.env as Record<string, string>).NODE_ENV = ORIGINAL_NODE_ENV ?? 'test';
});

describe('NewsThumbnail', () => {
  it('renders any publisher CDN without an optimizer or preconnect request', () => {
    render(<NewsThumbnail imageUrl="https://cdn.never-allowlisted.example/story.jpg" saveData={false} />);

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://cdn.never-allowlisted.example/story.jpg');
    // No optimizer in the path: the publisher's own URL, not /_next/image.
    expect(image?.getAttribute('src')).not.toContain('/_next/image');
    expect(image?.getAttribute('srcset')).toBeNull();
    expect(image?.getAttribute('fetchpriority')).toBe('auto');
  });

  it('lazy-loads by default and only loads eagerly when asked', () => {
    render(<NewsThumbnail imageUrl="https://cdn.publisher.example/a.jpg" saveData={false} />);
    expect(container.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    act(() => { root.unmount(); });

    root = createRoot(container);
    act(() => { root.render(<NewsThumbnail imageUrl="https://cdn.publisher.example/a.jpg" saveData={false} priority />); });
    expect(container.querySelector('img')?.getAttribute('loading')).not.toBe('lazy');
  });

  it('renders no frame when the provider supplies image=null', () => {
    render(<NewsThumbnail imageUrl={null} saveData={false} />);

    expect(container.firstElementChild).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it.each([
    { name: 'no image supplied', imageUrl: null, saveData: false },
    { name: 'Data Saver', imageUrl: 'https://cdn.publisher.example/a.jpg', saveData: true },
    { name: 'plain HTTP (mixed content)', imageUrl: 'http://cdn.publisher.example/a.jpg', saveData: false },
    { name: 'an unparseable link', imageUrl: 'not a url', saveData: false },
  ])('renders no thumbnail for $name', ({ imageUrl, saveData }) => {
    render(<NewsThumbnail imageUrl={imageUrl} saveData={saveData} />);

    expect(container.querySelector('img')).toBeNull();
    expect(container.firstElementChild).toBeNull();
  });

  it('does not request a publisher host proven to block browser hotlinks', () => {
    // Observed live: biztoc.com triggers ERR_BLOCKED_BY_ORB for its .webp URLs.
    render(<NewsThumbnail imageUrl="https://biztoc.com/cdn/thumb.webp" saveData={false} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.firstElementChild).toBeNull();
  });
});
