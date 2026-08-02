import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  isPushConfigured: vi.fn(),
}));

vi.mock('@/src/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));
vi.mock('@/src/lib/push/service', () => ({
  isPushConfigured: mocks.isPushConfigured,
}));

import { deviceLabelFromUserAgent } from '@/src/lib/push/device';
import { DELETE, POST } from './route';

function query(result: unknown) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>['then'];
  } = {
    upsert: vi.fn(async () => result),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
  };
  chain.then = (resolve, reject) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

function clientFor(userId: string | null) {
  const tables = {
    user_settings: query({ error: null, count: 0 }),
    push_subscriptions: query({ error: null, count: 0 }),
  };
  const client = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: userId ? { id: userId } : null },
      })),
    },
    from: vi.fn((table: keyof typeof tables) => tables[table]),
    rpc: vi.fn(async () => ({ data: 'subscription-id', error: null })),
  };
  return { client, tables };
}

const subscription = (endpoint: string) => ({
  endpoint,
  expirationTime: null,
  keys: { p256dh: 'public-key', auth: 'auth-key' },
  userId: 'attacker-supplied-id',
});

describe('/api/push/subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPushConfigured.mockReturnValue(true);
  });

  it('authenticates the session and never accepts a client user id', async () => {
    const { client, tables } = clientFor('account-1');
    mocks.createClient.mockResolvedValue(client);
    const response = await POST(new NextRequest(
      'https://portkheaw.vercel.app/api/push/subscriptions',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0)',
        },
        body: JSON.stringify(subscription('https://push.example/device-1')),
      },
    ));

    expect(response.status).toBe(200);
    expect(tables.user_settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'account-1',
        push_enabled: true,
      }),
      { onConflict: 'user_id' },
    );
    expect(client.rpc).toHaveBeenCalledWith(
      'upsert_push_subscription',
      expect.objectContaining({
        input_endpoint: 'https://push.example/device-1',
        input_device_label: 'Windows',
      }),
    );
    const rpcCall = client.rpc.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(rpcCall[1]).not.toHaveProperty(
      'input_user_id',
    );
  });

  it('upserts independent endpoints for multiple devices', async () => {
    const { client } = clientFor('account-1');
    mocks.createClient.mockResolvedValue(client);
    for (const endpoint of [
      'https://push.example/device-1',
      'https://push.example/device-2',
    ]) {
      await POST(new NextRequest(
        'https://portkheaw.vercel.app/api/push/subscriptions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(subscription(endpoint)),
        },
      ));
    }
    expect(client.rpc).toHaveBeenNthCalledWith(
      1,
      'upsert_push_subscription',
      expect.objectContaining({
        input_endpoint: 'https://push.example/device-1',
      }),
    );
    expect(client.rpc).toHaveBeenNthCalledWith(
      2,
      'upsert_push_subscription',
      expect.objectContaining({
        input_endpoint: 'https://push.example/device-2',
      }),
    );
  });

  it('deletes only the signed-in user device and disables push when none remain', async () => {
    const { client, tables } = clientFor('account-1');
    mocks.createClient.mockResolvedValue(client);
    const response = await DELETE(new NextRequest(
      'https://portkheaw.vercel.app/api/push/subscriptions',
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'https://push.example/device-1',
        }),
      },
    ));
    expect(response.status).toBe(200);
    expect(tables.push_subscriptions.delete).toHaveBeenCalledOnce();
    expect(tables.push_subscriptions.eq).toHaveBeenCalledWith(
      'user_id',
      'account-1',
    );
    expect(tables.user_settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ push_enabled: false }),
    );
  });

  it('rejects an unauthenticated write', async () => {
    const { client } = clientFor(null);
    mocks.createClient.mockResolvedValue(client);
    const response = await POST(new NextRequest(
      'https://portkheaw.vercel.app/api/push/subscriptions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription('https://push.example/device-1')),
      },
    ));
    expect(response.status).toBe(401);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('derives a bounded device label without trusting client input', () => {
    expect(deviceLabelFromUserAgent('Mozilla/5.0 (Linux; Android 15)'))
      .toBe('Android');
    expect(deviceLabelFromUserAgent(null)).toBe('อุปกรณ์นี้');
  });
});
