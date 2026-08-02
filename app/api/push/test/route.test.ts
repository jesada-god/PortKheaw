import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  isPushConfigured: vi.fn(),
  sendWebPush: vi.fn(),
  classifyPushFailure: vi.fn(),
}));

vi.mock('@/src/lib/supabase/server', () => ({
  createClient: mocks.createClient,
}));
vi.mock('@/src/lib/push/service', () => ({
  isPushConfigured: mocks.isPushConfigured,
  sendWebPush: mocks.sendWebPush,
  classifyPushFailure: mocks.classifyPushFailure,
}));

import { POST } from './route';

const row = {
  id: 'subscription-1',
  user_id: 'account-1',
  endpoint: 'https://push.example/device-1',
  expiration_time: null,
  p256dh: 'public-key',
  auth: 'auth-key',
  enabled: true,
  failure_count: 0,
};

function tableQuery(subscription = row) {
  const chain: Record<string, ReturnType<typeof vi.fn>> & {
    then?: Promise<unknown>['then'];
  } = {
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({
      data: subscription,
      error: null,
    })),
  };
  chain.then = (resolve, reject) =>
    Promise.resolve({ data: null, error: null }).then(resolve, reject);
  return chain;
}

function clientWithClaim(claim: {
  allowed: boolean;
  retry_after_seconds: number;
} | null) {
  const query = tableQuery();
  const rpc = vi.fn(async (name: string) => {
    if (name === 'claim_push_test') {
      return {
        data: claim ? [{
          subscription_id: 'subscription-1',
          ...claim,
        }] : [],
        error: null,
      };
    }
    if (name === 'create_push_test_notification') {
      return {
        data: [{
          notification_id: 'notification-1',
          delivery_id: 'delivery-1',
        }],
        error: null,
      };
    }
    return { data: [], error: null };
  });
  return {
    query,
    client: {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'account-1' } },
        })),
      },
      rpc,
      from: vi.fn(() => query),
    },
  };
}

const request = () => new NextRequest(
  'https://portkheaw.vercel.app/api/push/test',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: row.endpoint }),
  },
);

describe('POST /api/push/test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPushConfigured.mockReturnValue(true);
    mocks.sendWebPush.mockResolvedValue({ statusCode: 201 });
  });

  it('sends immediately to the claimed device and opens the Inbox', async () => {
    const { client, query } = clientWithClaim({
      allowed: true,
      retry_after_seconds: 0,
    });
    mocks.createClient.mockResolvedValue(client);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.sendWebPush).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'subscription-1' }),
      {
        title: 'PortKheaw',
        body: 'PortKheaw พร้อมแจ้งเตือนแล้ว',
        url: '/notifications',
        tag: 'portkheaw-test-subscription-1',
      },
    );
    expect(client.rpc).toHaveBeenCalledWith(
      'create_push_test_notification',
      expect.objectContaining({
        input_subscription_id: 'subscription-1',
      }),
    );
    expect(query.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'sent',
        provider_status: 'http-201',
      }),
    );
  });

  it('enforces the atomic per-device rate limit', async () => {
    const { client } = clientWithClaim({
      allowed: false,
      retry_after_seconds: 18,
    });
    mocks.createClient.mockResolvedValue(client);
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('18');
    expect(mocks.sendWebPush).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalledWith(
      'create_push_test_notification',
      expect.anything(),
    );
  });

  it('deletes an endpoint rejected as expired by the provider', async () => {
    const { client, query } = clientWithClaim({
      allowed: true,
      retry_after_seconds: 0,
    });
    mocks.createClient.mockResolvedValue(client);
    mocks.sendWebPush.mockRejectedValue({ statusCode: 410 });
    mocks.classifyPushFailure.mockReturnValue({
      code: 'subscription-gone',
      gone: true,
      transient: false,
      statusCode: 410,
    });
    const response = await POST(request());
    expect(response.status).toBe(404);
    expect(query.delete).toHaveBeenCalledOnce();
    expect(query.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        provider_status: 'http-410',
      }),
    );
  });
});
