import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReliabilityReport, gatewayHealthUrl, type ReliabilityInput } from './reliability';

const pageSource = readFileSync(join(process.cwd(), 'app/admin/reliability/page.tsx'), 'utf8');

function input(overrides: Partial<ReliabilityInput> = {}): ReliabilityInput {
  return {
    database: 'ok',
    scheduler: 'ok',
    billing: 'ok',
    marketRest: { configured: true, provider: 'polygon' },
    marketGateway: {
      configured: true,
      health: {
        status: 'ready', upstreamState: 'ready', feed: 'delayed_sip',
        uptimeSeconds: 7_200, timestamp: '2026-08-16T00:00:00.000Z',
      },
    },
    deployment: { commitSha: 'a'.repeat(40), buildTime: '2026-08-16T00:00:00.000Z' },
    ...overrides,
  };
}

const level = (report: ReturnType<typeof buildReliabilityReport>, id: string) =>
  report.rows.find((row) => row.id === id)?.level;

describe('reliability status mapping', () => {
  it('reports a healthy platform as green on every line', () => {
    const report = buildReliabilityReport(input());
    expect(report.overall).toBe('ok');
    expect(report.rows.every((row) => row.level === 'ok')).toBe(true);
  });

  it('calls a reachable gateway with a cold upstream a fallback, not an outage', () => {
    const report = buildReliabilityReport(input({
      marketGateway: {
        configured: true,
        health: {
          status: 'degraded', upstreamState: 'connecting', feed: 'delayed_sip',
          uptimeSeconds: 30, timestamp: '2026-08-16T00:00:00.000Z',
        },
      },
    }));
    expect(level(report, 'market-websocket')).toBe('degraded');
    // REST is the floor, and it is unaffected — readers are still served.
    expect(level(report, 'market-rest')).toBe('ok');
    expect(report.overall).toBe('degraded');
  });

  it('calls an unreachable gateway an outage of the socket alone', () => {
    const report = buildReliabilityReport(input({ marketGateway: { configured: true, health: null } }));
    expect(level(report, 'market-websocket')).toBe('down');
    expect(report.rows.find((row) => row.id === 'market-websocket')?.detail).toContain('REST');
  });

  it('separates a schema behind its deployment from a database that is gone', () => {
    expect(level(buildReliabilityReport(input({ database: 'degraded' })), 'database')).toBe('degraded');
    expect(level(buildReliabilityReport(input({ database: 'unavailable' })), 'database')).toBe('down');
  });

  it('maps every scheduler state onto its own severity', () => {
    expect(level(buildReliabilityReport(input({ scheduler: 'ok' })), 'scheduler')).toBe('ok');
    expect(level(buildReliabilityReport(input({ scheduler: 'lagging' })), 'scheduler')).toBe('degraded');
    expect(level(buildReliabilityReport(input({ scheduler: 'stale' })), 'scheduler')).toBe('down');
    expect(level(buildReliabilityReport(input({ scheduler: 'unknown' })), 'scheduler')).toBe('unknown');
  });

  it('leads with the worst line rather than an average', () => {
    expect(buildReliabilityReport(input({ database: 'unavailable', scheduler: 'lagging' })).overall).toBe('down');
    expect(buildReliabilityReport(input({ billing: 'degraded' })).overall).toBe('degraded');
  });
});

describe('what the reliability console may not expose', () => {
  it('never renders a key, a token or a connection string', () => {
    const report = buildReliabilityReport(input());
    const rendered = JSON.stringify(report);
    for (const banned of ['API_KEY', 'SERVICE_ROLE', 'apikey', 'secret', 'Bearer', 'postgres://']) {
      expect(rendered).not.toContain(banned);
    }
    // The billing line says whether money can move, never which value is absent.
    expect(rendered).not.toMatch(/STRIPE|PRICE_ID|WEBHOOK/i);
  });

  it('derives the gateway health address from the public socket URL, and only that', () => {
    expect(gatewayHealthUrl('wss://gateway.example.com/ws')).toBe('https://gateway.example.com/healthz');
    expect(gatewayHealthUrl('ws://localhost:8081/ws?token=x')).toBe('http://localhost:8081/healthz');
    expect(gatewayHealthUrl('https://gateway.example.com')).toBeNull();
    expect(gatewayHealthUrl('')).toBeNull();
    expect(gatewayHealthUrl(null)).toBeNull();
  });

  it('gates the page on the operator guard before it reads anything', () => {
    const body = pageSource.slice(pageSource.indexOf('export default async function'));
    // The guard is the component's FIRST await, so a non-operator's request
    // produces no markup at all rather than markup that is discarded after.
    expect(body.slice(body.indexOf('await ')).startsWith('await requireAdminPage();')).toBe(true);
    // It reads state; it never offers a way to change any of it.
    expect(pageSource).not.toContain('use server');
    expect(pageSource).not.toContain('<form');
  });

  it('reads no secret-bearing environment variable', () => {
    const referenced = [...pageSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((match) => match[1]);
    expect(referenced.sort()).toEqual([
      'NEXT_PUBLIC_MARKET_WS_URL', 'NEXT_PUBLIC_MARKET_WS_URL',
      'PORTKHEAW_BUILD_TIME', 'PORTKHEAW_COMMIT_SHA', 'VERCEL_GIT_COMMIT_SHA',
    ]);
  });
});
