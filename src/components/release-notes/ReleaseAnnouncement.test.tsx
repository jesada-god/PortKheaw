// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseAnnouncementProps } from './ReleaseAnnouncement';

const acknowledge = vi.fn<(id: string) => Promise<boolean>>();

vi.mock('@/src/lib/release-notes/acknowledge-action', () => ({
  acknowledgeReleaseNoteAction: (id: string) => acknowledge(id),
}));

const { ReleaseAnnouncement } = await import('./ReleaseAnnouncement');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const RELEASE: ReleaseAnnouncementProps = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '1.4.0',
  title: 'PortKheaw Update',
  content: '• เพิ่มระบบแจ้งเตือน\n• ปรับปรุงกราฟ\n- แก้ไขการคำนวณ',
  importance: 'normal',
  publishedAt: '2026-08-07T03:00:00.000Z',
};

beforeEach(() => {
  acknowledge.mockReset();
  acknowledge.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: Partial<ReleaseAnnouncementProps> = {}): void {
  act(() => root.render(<ReleaseAnnouncement {...RELEASE} {...props} />));
}

describe('the "what\'s new" popup', () => {
  it('shows the release as a dialog with its bullets', () => {
    render();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('PortKheaw Update');
    expect(dialog?.textContent).toContain('เพิ่มระบบแจ้งเตือน');
    expect(document.querySelectorAll('[role="dialog"] li')).toHaveLength(3);
  });

  /*
   * The body is written by an operator and rendered in every reader's session.
   * It must arrive as characters, never as nodes — this is the assertion that
   * fails loudly if anybody ever reaches for `dangerouslySetInnerHTML` here.
   */
  it('renders a script payload as text and never as markup', () => {
    render({ content: '<script>alert(1)</script>', title: '<img src=x>' });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelector('script')).toBeNull();
    expect(dialog?.querySelector('img')).toBeNull();
    expect(dialog?.textContent).toContain('<script>alert(1)</script>');
  });

  it('marks the release seen when the reader closes it — not when it renders', async () => {
    render();
    expect(acknowledge).not.toHaveBeenCalled();

    const close = document.querySelector<HTMLButtonElement>('[aria-label="ปิดหน้าต่าง"]');
    expect(close).not.toBeNull();
    await act(async () => { close?.click(); });

    expect(acknowledge).toHaveBeenCalledWith(RELEASE.id);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('the acknowledge button does the same thing', async () => {
    render();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    const acknowledgeButton = buttons.find((button) => button.textContent?.includes('รับทราบ'));
    await act(async () => { acknowledgeButton?.click(); });
    expect(acknowledge).toHaveBeenCalledWith(RELEASE.id);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  /*
   * An `important` release is louder, and still closeable. A modal a reader
   * cannot dismiss is a lockout, and nothing announced here is worth one.
   */
  it('an important release is still dismissable', async () => {
    render({ importance: 'important' });
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('อัปเดตสำคัญ');

    const close = document.querySelector<HTMLButtonElement>('[aria-label="ปิดหน้าต่าง"]');
    expect(close?.disabled).toBe(false);
    await act(async () => { close?.click(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
