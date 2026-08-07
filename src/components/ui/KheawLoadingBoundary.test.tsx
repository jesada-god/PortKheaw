// @vitest-environment jsdom

/**
 * The boundary driven the way a real request drives it: a loading flag that
 * flips, sometimes twice, sometimes into an error, sometimes while the reader
 * is already looking at data.
 *
 * The clock is faked because the rules are about time — that is the one thing
 * these tests mock. No request, no response and no timing constant is invented
 * anywhere below; they all come from `loading-visibility`.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KHEAW_LOADING_MESSAGE } from './KheawLoader';
import { KheawLoadingBoundary } from './KheawLoadingBoundary';
import {
  KHEAW_LOADER_DELAY_MS,
  KHEAW_LOADER_FADE_MS,
  KHEAW_LOADER_MIN_VISIBLE_MS,
} from '@/src/lib/ui/loading-visibility';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(element: React.ReactElement) {
  act(() => root.render(element));
}

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

/**
 * Past the grace and past the minimum-visible window, in the two steps the
 * browser actually takes. They cannot be collapsed into one advance: each phase
 * schedules its own timer from a committed render, and a single jump would run
 * the fake clock past the moment React commits the first one.
 */
function advanceToHandoffReady() {
  advance(KHEAW_LOADER_DELAY_MS);
  advance(KHEAW_LOADER_MIN_VISIBLE_MS);
}

const CONTENT = 'ผลลัพธ์จริง';

/** Everything that makes the loader visible to a person or a screen reader. */
const loaderShown = () => Boolean(
  container.querySelector('[role="status"]')
  && container.querySelector('img[src="/brand/kheaw-loading.webp"]'),
);
const loaderElement = () => container.querySelector<HTMLElement>('[role="status"]');
const message = () => container.querySelector('.kheaw-loader__bubble')?.textContent ?? null;
const contentShown = () => container.textContent?.includes(CONTENT) ?? false;

function boundary(props: { loading: boolean; ready?: boolean; variant?: 'page' | 'section' }) {
  return (
    <KheawLoadingBoundary {...props}>
      <p>{CONTENT}</p>
    </KheawLoadingBoundary>
  );
}

describe.each(['section', 'page'] as const)('KheawLoadingBoundary (%s variant)', (variant) => {
  it('never shows the mascot for a request that finishes inside the grace', () => {
    render(boundary({ loading: true, variant }));
    expect(loaderShown()).toBe(false);

    // Stepped right up to the threshold: the mascot must not appear for a
    // single frame of a fast request.
    for (let elapsed = 50; elapsed < KHEAW_LOADER_DELAY_MS; elapsed += 50) {
      advance(50);
      expect(loaderShown()).toBe(false);
    }

    render(boundary({ loading: false, variant }));
    expect(loaderShown()).toBe(false);
    expect(contentShown()).toBe(true);

    // And it cannot turn up late once the request is done.
    advance(5_000);
    expect(loaderShown()).toBe(false);
  });

  it('holds the section\'s space while it waits, without announcing anything', () => {
    render(boundary({ loading: true, variant }));
    const placeholder = container.querySelector<HTMLElement>('[data-kheaw-loader="pending"]')!;

    // The box that keeps a fast request from collapsing the layout and then
    // expanding it again a moment later.
    expect(placeholder).toBeTruthy();
    expect(placeholder.classList.contains(`kheaw-loader--${variant}`)).toBe(true);
    expect(placeholder.getAttribute('aria-hidden')).toBe('true');
    // Empty: no live region, no mascot, no message.
    expect(placeholder.children).toHaveLength(0);
    expect(loaderElement()).toBeNull();
  });

  it('shows the mascot and its message once the grace runs out', () => {
    render(boundary({ loading: true, variant }));
    advance(KHEAW_LOADER_DELAY_MS);

    expect(loaderShown()).toBe(true);
    expect(message()).toBe(KHEAW_LOADING_MESSAGE);
    expect(loaderElement()!.getAttribute('aria-live')).toBe('polite');
    expect(loaderElement()!.classList.contains(`kheaw-loader--${variant}`)).toBe(true);
  });

  it('keeps the mascot on screen for the full minimum when the request lands early', () => {
    render(boundary({ loading: true, variant }));
    advance(KHEAW_LOADER_DELAY_MS);
    expect(loaderShown()).toBe(true);

    // Request finishes 10ms after the mascot appeared.
    advance(10);
    render(boundary({ loading: false, variant }));

    advance(KHEAW_LOADER_MIN_VISIBLE_MS - 20);
    expect(loaderShown()).toBe(true);
    expect(loaderElement()!.classList.contains('kheaw-loader--leaving')).toBe(false);

    advance(10);
    expect(loaderElement()!.classList.contains('kheaw-loader--leaving')).toBe(true);
  });

  it('fades out over content that is already mounted, leaving no empty frame', () => {
    render(boundary({ loading: true, variant }));
    advanceToHandoffReady();

    render(boundary({ loading: false, variant }));

    // The instant the fade starts the real content is behind it, and the loader
    // is inert so it cannot intercept a click on content that is already there.
    const overlay = loaderElement()!;
    expect(overlay.classList.contains('kheaw-loader--leaving')).toBe(true);
    expect(overlay.classList.contains('kheaw-loader--overlay')).toBe(true);
    expect(contentShown()).toBe(true);

    advance(KHEAW_LOADER_FADE_MS - 1);
    expect(loaderShown()).toBe(true);
    expect(contentShown()).toBe(true);

    advance(1);
    expect(loaderShown()).toBe(false);
    expect(contentShown()).toBe(true);
    // Nothing of the boundary survives once it has settled.
    expect(container.querySelector('.kheaw-loader-host')).toBeNull();
  });

  it('drops the loader and shows the failure state when a request errors', () => {
    render(boundary({ loading: true, variant }));
    advanceToHandoffReady();
    expect(loaderShown()).toBe(true);

    // An error settles the boundary exactly like a success: the caller stops
    // loading and renders its own retry UI as children.
    render(
      <KheawLoadingBoundary loading={false} variant={variant}>
        <p role="alert">โหลดข้อมูลไม่สำเร็จ</p>
      </KheawLoadingBoundary>,
    );
    advance(KHEAW_LOADER_FADE_MS);

    expect(loaderShown()).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('โหลดข้อมูลไม่สำเร็จ');
    // No timer is left running, so nothing bounces on forever.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves existing data alone during a background revalidation', () => {
    // `ready` means there is a last-good result on screen; a refresh behind it
    // must never cover the page with the mascot.
    render(boundary({ loading: true, ready: true, variant }));
    advanceToHandoffReady();

    expect(loaderShown()).toBe(false);
    expect(contentShown()).toBe(true);
    expect(container.querySelector('[data-kheaw-loader="pending"]')).toBeNull();
  });
});

describe('KheawLoadingBoundary — request churn and teardown', () => {
  it('measures the grace from the first request when retries overlap', () => {
    render(boundary({ loading: true }));
    advance(150);
    // A second attempt starts while the first is still running.
    render(boundary({ loading: true }));
    advance(150);

    // 300ms after the wait began, not 300ms after the latest attempt.
    expect(loaderShown()).toBe(true);
  });

  it('keeps the mascot up when a new request starts mid-fade', () => {
    render(boundary({ loading: true }));
    advanceToHandoffReady();
    render(boundary({ loading: false }));
    expect(loaderElement()!.classList.contains('kheaw-loader--leaving')).toBe(true);

    advance(KHEAW_LOADER_FADE_MS / 2);
    render(boundary({ loading: true }));

    // Back to a solid loader rather than dissolving into stale content.
    expect(loaderShown()).toBe(true);
    expect(loaderElement()!.classList.contains('kheaw-loader--leaving')).toBe(false);
  });

  it('settles after rapid flapping instead of getting stuck', () => {
    render(boundary({ loading: true }));
    for (const loading of [false, true, false, true, false, true]) {
      advance(40);
      render(boundary({ loading }));
    }
    render(boundary({ loading: true }));
    advance(KHEAW_LOADER_DELAY_MS);
    expect(loaderShown()).toBe(true);

    render(boundary({ loading: false }));
    advance(KHEAW_LOADER_MIN_VISIBLE_MS);
    advance(KHEAW_LOADER_FADE_MS);

    expect(loaderShown()).toBe(false);
    expect(contentShown()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer on unmount without updating state afterwards', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(boundary({ loading: true }));
    // Unmount mid-grace, with a timer outstanding.
    advance(100);
    expect(vi.getTimerCount()).toBe(1);

    act(() => root.unmount());

    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(errors).not.toHaveBeenCalled();

    // Keep afterEach's unmount a no-op.
    root = createRoot(container);
  });

  it('clears its timer on unmount while the mascot is on screen', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(boundary({ loading: true }));
    advance(KHEAW_LOADER_DELAY_MS);
    render(boundary({ loading: false }));
    expect(vi.getTimerCount()).toBe(1);

    act(() => root.unmount());

    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(errors).not.toHaveBeenCalled();

    root = createRoot(container);
  });

  it('adds no wrapper at all once there is nothing to wait for', () => {
    render(boundary({ loading: false }));
    expect(contentShown()).toBe(true);
    expect(container.querySelector('.kheaw-loader-host')).toBeNull();
    expect(container.querySelector('.kheaw-loader')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    // The child is a direct child of the mount point: no extra box to shift the
    // layout of whatever section this boundary sits in.
    expect(container.firstElementChild?.tagName).toBe('P');
  });
});
