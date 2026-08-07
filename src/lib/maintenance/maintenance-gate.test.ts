import { describe, expect, it } from 'vitest';
import {
  decideMaintenance, isMaintenanceExemptPath, MAINTENANCE_PATH,
} from './maintenance-gate';

/**
 * The gate's whole contract, as a table.
 *
 * These are the rules that cause an incident when they are wrong: a webhook that
 * gets redirected, an operator locked out of the console that ends the outage, a
 * stale tab that keeps writing, or a notice page that redirects to itself.
 */

const off = { maintenanceEnabled: false, isAdmin: false };
const on = { maintenanceEnabled: true, isAdmin: false };
const onAdmin = { maintenanceEnabled: true, isAdmin: true };

describe('maintenance off changes nothing', () => {
  it.each([
    ['/', 'GET'],
    ['/portfolio', 'POST'],
    ['/api/option-simulations', 'POST'],
    ['/admin', 'GET'],
  ])('allows %s %s', (pathname, method) => {
    expect(decideMaintenance({ pathname, method, ...off })).toEqual({ action: 'allow' });
  });
});

describe('maintenance on gates ordinary readers', () => {
  it('redirects a page read to the notice', () => {
    expect(decideMaintenance({ pathname: '/portfolio', method: 'GET', ...on }))
      .toEqual({ action: 'redirect', location: MAINTENANCE_PATH });
  });

  it('redirects the root and the marketing surface too', () => {
    for (const pathname of ['/', '/tools', '/stock/AAPL', '/settings/subscription']) {
      expect(decideMaintenance({ pathname, method: 'GET', ...on }).action).toBe('redirect');
    }
  });

  /*
   * The bypass a page-only guard leaves behind: a tab opened before the switch
   * was thrown still holds a working form, and a server action posts to the page
   * URL rather than to `/api`. It must be refused, not redirected — a browser
   * follows a redirect and the write silently does not happen.
   */
  it('refuses a mutation posted by a tab that was already open', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(decideMaintenance({ pathname: '/portfolio', method, ...on }))
        .toEqual({ action: 'block', status: 503 });
    }
  });

  it('refuses an API read with a status rather than an HTML redirect', () => {
    expect(decideMaintenance({ pathname: '/api/market/quote/AAPL', method: 'GET', ...on }))
      .toEqual({ action: 'block', status: 503 });
  });
});

describe('an operator keeps the product', () => {
  it.each([
    ['/admin', 'GET'],
    ['/admin/system', 'GET'],
    ['/portfolio', 'GET'],
    ['/portfolio', 'POST'],
    ['/api/market/quote/AAPL', 'GET'],
  ])('allows %s %s so the console can be used to check the release', (pathname, method) => {
    expect(decideMaintenance({ pathname, method, ...onAdmin })).toEqual({ action: 'allow' });
  });
});

describe('system paths are never gated', () => {
  it('exempts the notice itself, so there is no redirect loop', () => {
    expect(isMaintenanceExemptPath(MAINTENANCE_PATH)).toBe(true);
    expect(decideMaintenance({ pathname: MAINTENANCE_PATH, method: 'GET', ...on }))
      .toEqual({ action: 'allow' });
  });

  it('exempts the Stripe webhook, in both directions', () => {
    expect(isMaintenanceExemptPath('/api/billing/webhook')).toBe(true);
    expect(decideMaintenance({ pathname: '/api/billing/webhook', method: 'POST', ...on }))
      .toEqual({ action: 'allow' });
  });

  it.each([
    '/auth/sign-in',
    '/auth/callback',
    '/auth/sign-out',
    '/api/auth/confirm',
    '/api/cron/alerts',
    '/api/alerts/evaluate',
    '/api/health',
    '/api/version',
    '/api/maintenance/state',
    '/icon.svg',
    '/manifest.webmanifest',
    '/icons/icon-192.png',
  ])('exempts %s', (pathname) => {
    expect(isMaintenanceExemptPath(pathname)).toBe(true);
    expect(decideMaintenance({ pathname, method: 'POST', ...on })).toEqual({ action: 'allow' });
  });

  it('does not exempt a path that merely starts with an exempt word', () => {
    expect(isMaintenanceExemptPath('/authors')).toBe(false);
    expect(isMaintenanceExemptPath('/api/authenticity')).toBe(false);
    expect(isMaintenanceExemptPath('/maintenance-plan')).toBe(false);
  });
});
