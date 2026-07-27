// @vitest-environment jsdom

/**
 * Guards the two decisions behind the news thumbnail.
 *
 * 1. `unoptimized` is what lets `next/image` render a publisher CDN that is not in
 *    `images.remotePatterns` — routing news images through the optimizer would
 *    require `hostname: '**'`, an open image proxy. Next only enforces the
 *    remote-pattern allowlist when `process.env.NODE_ENV !== 'test'`, so this file
 *    renders under `production` to exercise the validation the app really runs.
 * 2. Everything that is not a renderable publisher image — none supplied, Data
 *    Saver, plain HTTP, or a request that fails — collapses to one placeholder in
 *    a frame of identical size.
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

const placeholder = () => container.querySelector('[data-testid="news-thumbnail-placeholder"]');

beforeEach(() => {
  (process.env as Record<string, string>).NODE_ENV = 'production';
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  (process.env as Record<string, string>).NODE_ENV = ORIGINAL_NODE_ENV ?? 'test';
});

describe('NewsThumbnail', () => {
  it('renders any publisher CDN without an images.remotePatterns allowlist', () => {
    render(<NewsThumbnail imageUrl="https://cdn.never-allowlisted.example/story.jpg" saveData={false} />);

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://cdn.never-allowlisted.example/story.jpg');
    // No optimizer in the path: the publisher's own URL, not /_next/image.
    expect(image?.getAttribute('src')).not.toContain('/_next/image');
    expect(image?.getAttribute('srcset')).toBeNull();
    expect(placeholder()).toBeNull();
  });

  it('lazy-loads by default and only loads eagerly when asked', () => {
    render(<NewsThumbnail imageUrl="https://cdn.publisher.example/a.jpg" saveData={false} />);
    expect(container.querySelector('img')?.getAttribute('loading')).toBe('lazy');
    act(() => { root.unmount(); });

    root = createRoot(container);
    act(() => { root.render(<NewsThumbnail imageUrl="https://cdn.publisher.example/a.jpg" saveData={false} priority />); });
    expect(container.querySelector('img')?.getAttribute('loading')).not.toBe('lazy');
  });

  it('keeps one fixed frame whether an image renders or not, so the feed never reflows', () => {
    render(<NewsThumbnail imageUrl="https://cdn.publisher.example/a.jpg" saveData={false} />);
    const withImage = container.firstElementChild?.className;
    act(() => { root.unmount(); });

    root = createRoot(container);
    act(() => { root.render(<NewsThumbnail imageUrl={null} saveData={false} />); });
    expect(container.firstElementChild?.className).toBe(withImage);
    expect(withImage).toContain('aspect-[4/3]');
    expect(container.querySelector('img')).toBeNull();
  });

  it.each([
    { name: 'no image supplied', imageUrl: null, saveData: false },
    { name: 'Data Saver', imageUrl: 'https://cdn.publisher.example/a.jpg', saveData: true },
    { name: 'plain HTTP (mixed content)', imageUrl: 'http://cdn.publisher.example/a.jpg', saveData: false },
    { name: 'an unparseable link', imageUrl: 'not a url', saveData: false },
  ])('falls back to the system placeholder for $name', ({ imageUrl, saveData }) => {
    render(<NewsThumbnail imageUrl={imageUrl} saveData={saveData} />);
    expect(container.querySelector('img')).toBeNull();
    expect(placeholder()).not.toBeNull();
  });

  it('falls back to the placeholder when a publisher blocks or drops the request', () => {
    // Observed live: biztoc.com answers hotlinked thumbnails with a Cloudflare 403.
    render(<NewsThumbnail imageUrl="https://biztoc.com/cdn/thumb.webp" saveData={false} />);
    const image = container.querySelector('img');
    expect(image).not.toBeNull();

    act(() => { image!.dispatchEvent(new Event('error')); });

    expect(container.querySelector('img')).toBeNull();
    expect(placeholder()).not.toBeNull();
  });
});
