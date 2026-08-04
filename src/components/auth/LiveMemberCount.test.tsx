/* @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock('@/src/lib/supabase/client', () => ({ createClient: mocks.createClient }));

import { LiveMemberCount } from './LiveMemberCount';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let updateHandler: ((payload: { new: Record<string, unknown> }) => void) | undefined;
let statusHandler: ((status: string) => void) | undefined;
let refetchCount = 42;
let fromCalls = 0;
const channel = {
  on: vi.fn((_type, _filter, callback) => {
    updateHandler = callback;
    return channel;
  }),
  subscribe: vi.fn((callback) => {
    statusHandler = callback;
    return channel;
  }),
};
const client = {
  channel: vi.fn(() => channel),
  removeChannel: vi.fn(async () => 'ok'),
  from: vi.fn(() => {
    fromCalls += 1;
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { member_count: refetchCount }, error: null }),
        }),
      }),
    };
  }),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  updateHandler = undefined;
  statusHandler = undefined;
  refetchCount = 42;
  fromCalls = 0;
  mocks.createClient.mockReturnValue(client);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({ matches: true })),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('live Login member count', () => {
  it('includes the initial database count in server-rendered HTML', () => {
    const html = renderToStaticMarkup(<LiveMemberCount initialCount={1284} />);
    expect(html).toContain('มีสมาชิก PortKheaw แล้ว');
    expect(html).toContain('1,284');
    expect(html).toContain('tabular-nums');
  });

  it('applies aggregate UPDATE events without reading profiles', async () => {
    await act(async () => root.render(<LiveMemberCount initialCount={10} />));
    expect(client.channel).toHaveBeenCalledWith('app-public-member-count');
    expect(channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      expect.objectContaining({ event: 'UPDATE', table: 'app_public_stats' }),
      expect.any(Function),
    );

    await act(async () => updateHandler?.({ new: { member_count: 11 } }));
    expect(container.textContent).toContain('11');
    expect(client.from).not.toHaveBeenCalledWith('profiles');
  });

  it('refetches exactly once after each reconnect, not on first subscribe', async () => {
    await act(async () => root.render(<LiveMemberCount initialCount={10} />));
    await act(async () => statusHandler?.('SUBSCRIBED'));
    expect(fromCalls).toBe(0);

    await act(async () => {
      statusHandler?.('CHANNEL_ERROR');
      statusHandler?.('SUBSCRIBED');
      await Promise.resolve();
    });
    expect(fromCalls).toBe(1);
    expect(container.textContent).toContain('42');

    await act(async () => {
      statusHandler?.('SUBSCRIBED');
      await Promise.resolve();
    });
    expect(fromCalls).toBe(1);
  });

  it('changes immediately when reduced motion is requested', async () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    await act(async () => root.render(<LiveMemberCount initialCount={7} />));
    await act(async () => updateHandler?.({ new: { member_count: 9 } }));
    expect(container.textContent).toContain('9');
    expect(requestFrame).not.toHaveBeenCalled();
    requestFrame.mockRestore();
  });
});
