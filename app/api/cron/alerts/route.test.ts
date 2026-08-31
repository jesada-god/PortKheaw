import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  runBackgroundAlerts: vi.fn(),
  deliverPendingPushes: vi.fn(),
  runOvAlertSweep: vi.fn(),
  createOvAlertServiceStore: vi.fn(),
  ovAlertSweepQuotes: vi.fn(),
  phase2AlertsEnabled: vi.fn(),
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
vi.mock('@/src/config/features', () => ({
  phase2AlertsEnabled: mocks.phase2AlertsEnabled,
}));
vi.mock('@/src/lib/market-overview/alerts/run', () => ({
  runOvAlertSweep: mocks.runOvAlertSweep,
}));
vi.mock('@/src/lib/market-overview/alerts/service-store', () => ({
  createOvAlertServiceStore: mocks.createOvAlertServiceStore,
}));
vi.mock('@/src/lib/market-overview/alerts/sweep-quotes', () => ({
  ovAlertSweepQuotes: mocks.ovAlertSweepQuotes,
}));

import { GET } from './route';

const request = () => new NextRequest(
  'https://portkheaw.vercel.app/api/cron/alerts',
  { headers: { authorization: 'Bearer cron-secret' } },
);

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
    mocks.phase2AlertsEnabled.mockReturnValue(true);
    mocks.createOvAlertServiceStore.mockReturnValue({ service: true });
    mocks.ovAlertSweepQuotes.mockReturnValue(async () => new Map());
    mocks.runOvAlertSweep.mockResolvedValue({
      owners: 2, evaluated: 3, recorded: 1, failed: 0, hits: [], errors: [],
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

  it('rejects callers without the scheduler secret', async () => {
    const response = await GET(new NextRequest(
      'https://portkheaw.vercel.app/api/cron/alerts',
    ));
    expect(response.status).toBe(401);
    expect(mocks.runBackgroundAlerts).not.toHaveBeenCalled();
  });
});

/**
 * THE SWEEP RIDES THIS TICK AND MAY NOT COST IT ANYTHING.
 *
 * The endpoint's first job is the notification pass: Inbox items somebody is
 * watching a market for. The Overview sweep writes rows on a card. Every case
 * below is about keeping the second from being able to hurt the first.
 */
describe('the Overview alert sweep on this endpoint', () => {
  /*
    Its own setup, because a `beforeEach` inside a sibling `describe` does not
    run for this one — without it every mock here would carry the previous
    case's state, which is exactly what it did the first time this was written.
  */
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminClient.mockReturnValue({ admin: true });
    mocks.runBackgroundAlerts.mockResolvedValue({ duplicateRun: false, triggered: 1 });
    mocks.deliverPendingPushes.mockResolvedValue({ sent: 1, failed: 0 });
    mocks.phase2AlertsEnabled.mockReturnValue(true);
    mocks.createOvAlertServiceStore.mockReturnValue({ service: true });
    mocks.ovAlertSweepQuotes.mockReturnValue(async () => new Map());
    mocks.runOvAlertSweep.mockResolvedValue({
      owners: 2, evaluated: 3, recorded: 1, failed: 0, hits: [], errors: [],
    });
  });

  it('runs after the notification pass, with a service-role store', async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(mocks.runOvAlertSweep).toHaveBeenCalledOnce();
    expect(mocks.createOvAlertServiceStore).toHaveBeenCalledWith({ admin: true });
    expect(mocks.runBackgroundAlerts.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runOvAlertSweep.mock.invocationCallOrder[0],
    );
    expect(body.data.overviewAlerts).toMatchObject({ ran: true, owners: 2, recorded: 1 });
  });

  it('does not sweep a window that has already run', async () => {
    /*
      `runBackgroundAlerts` already owns the duplicate guard, keyed on a
      fifteen-minute window. The sweep honours its answer rather than inventing
      a second guard — two mechanisms for "has this window run" is how they come
      to disagree.
    */
    mocks.runBackgroundAlerts.mockResolvedValue({ duplicateRun: true, triggered: 0 });
    const response = await GET(request());
    const body = await response.json();

    expect(mocks.runOvAlertSweep).not.toHaveBeenCalled();
    expect(body.data.overviewAlerts).toEqual({ ran: false, reason: 'duplicate-window' });
  });

  it('does not run at all while PHASE2_ALERTS is off', async () => {
    mocks.phase2AlertsEnabled.mockReturnValue(false);
    const response = await GET(request());
    const body = await response.json();

    expect(mocks.runOvAlertSweep).not.toHaveBeenCalled();
    expect(mocks.createOvAlertServiceStore).not.toHaveBeenCalled();
    expect(body.data.overviewAlerts).toEqual({ ran: false, reason: 'disabled' });
    // And the pass it rides is untouched.
    expect(mocks.runBackgroundAlerts).toHaveBeenCalledOnce();
    expect(mocks.deliverPendingPushes).toHaveBeenCalledOnce();
  });

  it('a failed sweep leaves the notification pass reported as successful', async () => {
    /*
      The case this whole wrapper exists for. The tables the sweep writes to are
      unapplied migrations, so "the sweep threw" is the expected state in every
      deployment today — and it must cost nothing.
    */
    mocks.runOvAlertSweep.mockRejectedValue(new Error('relation does not exist'));
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.triggered).toBe(1);
    expect(body.data.push).toEqual({ sent: 1, failed: 0 });
    expect(body.data.overviewAlerts).toEqual({ ran: false, reason: 'failed' });
  });

  it('a failed sweep does not stop the outbox being delivered', async () => {
    mocks.runOvAlertSweep.mockRejectedValue(new Error('down'));
    await GET(request());
    expect(mocks.deliverPendingPushes).toHaveBeenCalledOnce();
  });

  it('reports owner failures as a count without failing the run', async () => {
    mocks.runOvAlertSweep.mockResolvedValue({
      owners: 3, evaluated: 5, recorded: 1, failed: 2, hits: [],
      errors: [{ userId: 'user-2', message: 'broken' }],
    });
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.overviewAlerts).toMatchObject({ ran: true, failed: 2, errors: 1 });
  });
});
