import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  runBackgroundAlerts: vi.fn(),
  deliverPendingPushes: vi.fn(),
}));

vi.mock('@/src/config/env/server', () => ({
  serverEnv: { CRON_SECRET: 'cron-secret' },
}));
vi.mock('@/src/lib/supabase/admin', () => ({
  createAdminClient: mocks.createAdminClient,
}));
vi.mock('@/src/lib/alerts/background', () => ({
  runBackgroundAlerts: mocks.runBackgroundAlerts,
}));
vi.mock('@/src/lib/push/service', () => ({
  deliverPendingPushes: mocks.deliverPendingPushes,
}));

import { GET } from './route';

const request = () => new NextRequest(
  'https://portkheaw.vercel.app/api/cron/alerts',
  { headers: { authorization: 'Bearer cron-secret' } },
);

/*
  There was a second `describe` here, for a second sweep that rode this tick:
  `overview_alert_rules` in, `overview_alert_hits` out, behind `PHASE2_ALERTS`,
  wrapped so it could not fail a run that had already written Inbox items.

  `202609200001` merged that system into `price_alerts`, so those cases are gone
  rather than rewritten — there is nothing left for them to fence off. The
  properties they protected are now structural: one pass, whose failure IS the
  run's failure, and whose success is what the outbox delivers.
*/
describe('GET /api/cron/alerts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminClient.mockReturnValue({ admin: true });
    mocks.runBackgroundAlerts.mockResolvedValue({
      duplicateRun: false,
      triggered: 1,
    });
    mocks.deliverPendingPushes.mockResolvedValue({
      sent: 1,
      failed: 0,
    });
  });

  it('delivers the outbox after creating Inbox notifications', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.runBackgroundAlerts).toHaveBeenCalledOnce();
    expect(mocks.deliverPendingPushes).toHaveBeenCalledOnce();
    expect(mocks.runBackgroundAlerts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deliverPendingPushes.mock.invocationCallOrder[0],
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        triggered: 1,
        push: { sent: 1, failed: 0 },
        pushUnavailable: false,
      },
    });
  });

  it('keeps a successful Inbox run successful when push delivery fails', async () => {
    mocks.deliverPendingPushes.mockRejectedValue(
      new Error('provider unavailable'),
    );
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        triggered: 1,
        push: null,
        pushUnavailable: true,
      },
    });
  });

  it('reports nothing about a second alert system, because there is not one', async () => {
    const response = await GET(request());
    const body = await response.json();
    expect(body.data).not.toHaveProperty('overviewAlerts');
  });

  it('fails the run when the notification pass itself fails', async () => {
    mocks.runBackgroundAlerts.mockRejectedValue(new Error('down'));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(mocks.deliverPendingPushes).not.toHaveBeenCalled();
  });

  it('rejects callers without the scheduler secret', async () => {
    const response = await GET(new NextRequest(
      'https://portkheaw.vercel.app/api/cron/alerts',
    ));
    expect(response.status).toBe(401);
    expect(mocks.runBackgroundAlerts).not.toHaveBeenCalled();
  });
});
