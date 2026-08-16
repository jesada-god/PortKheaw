import Header from '@/src/components/layout/Header';
import { requireAdminPage } from '@/src/lib/admin/admin-guard';
import {
  buildReliabilityReport,
  gatewayHealthUrl,
  RELIABILITY_DOT,
  RELIABILITY_LABEL,
  type CheckState,
  type GatewayHealth,
  type ReliabilityRow,
} from '@/src/lib/admin/reliability';
import { billingConfigResult } from '@/src/lib/billing/billing-server';
import { createClient } from '@/src/lib/supabase/server';
import { serverEnv } from '@/src/config/env/server';
import { marketDataGatewayConfigured } from '@/src/lib/market-data/gateway/service';
import type { SchedulerStatus } from '@/src/types/database';

/**
 * The reliability console: one page that answers "is it working?".
 *
 * Deliberately not a log viewer. Every line is a status somebody else already
 * publishes — the readiness routine, the billing configuration check, the market
 * gateway's own `/healthz` — reduced to a colour and a sentence, with the
 * operational detail one disclosure down. It changes nothing, configures
 * nothing, and reaches nothing it did not already reach.
 *
 * No secret can appear on it by construction: the page reads booleans and words,
 * never a key, and the only URL it touches is derived from the public WebSocket
 * address that already ships in the browser bundle.
 */
export const dynamic = 'force-dynamic';

const HEALTH_TIMEOUT_MS = 2_500;

/** The same readiness routine the public health endpoint calls. */
async function readinessCheck(): Promise<{ database: CheckState; scheduler: SchedulerStatus }> {
  try {
    const client = await createClient();
    if (!client) return { database: 'unavailable', scheduler: 'unknown' };
    const { data, error } = await client.rpc('platform_readiness');
    if (error) {
      const code = (error as { code?: unknown }).code;
      const schemaBehind = typeof code === 'string' && (code.startsWith('PGRST') || code === '42883');
      return { database: schemaBehind ? 'degraded' : 'unavailable', scheduler: 'unknown' };
    }
    const row = data?.[0];
    if (!row?.database_ready) return { database: 'unavailable', scheduler: 'unknown' };
    return { database: 'ok', scheduler: row.scheduler_status };
  } catch {
    return { database: 'unavailable', scheduler: 'unknown' };
  }
}

function billingCheck(): CheckState {
  try {
    const result = billingConfigResult();
    if (!result.enabled) return 'unavailable';
    return result.availablePlanKeys.length > 0 ? 'ok' : 'degraded';
  } catch {
    return 'unavailable';
  }
}

/**
 * The gateway's own liveness report, read over HTTP with a short deadline.
 *
 * A gateway that does not answer produces `null`, which the report renders as
 * "REST only" — the truth about what readers are getting — rather than as an
 * error the operator has to interpret. Nothing about the realtime architecture
 * is touched here; this is a read.
 */
async function gatewayCheck(): Promise<GatewayHealth | null> {
  const url = gatewayHealthUrl(process.env.NEXT_PUBLIC_MARKET_WS_URL);
  if (!url) return null;
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json() as Partial<{
      status: string; upstreamState: string; feed: string; uptime: number; timestamp: string;
    }>;
    if (body.status !== 'ready' && body.status !== 'degraded') return null;
    return {
      status: body.status,
      upstreamState: typeof body.upstreamState === 'string' ? body.upstreamState : 'unknown',
      feed: typeof body.feed === 'string' ? body.feed : 'unknown',
      uptimeSeconds: typeof body.uptime === 'number' ? body.uptime : -1,
      timestamp: typeof body.timestamp === 'string' ? body.timestamp : '—',
    };
  } catch {
    return null;
  }
}

function deploymentRevision(): { commitSha: string; buildTime: string | null } {
  const raw = process.env.PORTKHEAW_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? '';
  const commitSha = /^[0-9a-f]{40}$/i.test(raw) ? raw.toLowerCase() : 'unknown';
  const build = process.env.PORTKHEAW_BUILD_TIME;
  return {
    commitSha,
    buildTime: build && Number.isFinite(Date.parse(build)) ? new Date(build).toISOString() : null,
  };
}

export default async function AdminReliabilityPage() {
  // The gate, before anything is read. A non-operator produces no markup at all.
  await requireAdminPage();

  const [readiness, gateway] = await Promise.all([readinessCheck(), gatewayCheck()]);
  const report = buildReliabilityReport({
    database: readiness.database,
    scheduler: readiness.scheduler,
    billing: billingCheck(),
    marketRest: {
      configured: marketDataGatewayConfigured(),
      provider: serverEnv.MARKET_DATA_PROVIDER ?? 'polygon',
    },
    marketGateway: {
      configured: gatewayHealthUrl(process.env.NEXT_PUBLIC_MARKET_WS_URL) !== null,
      health: gateway,
    },
    deployment: deploymentRevision(),
  });

  return (
    <div className="min-w-0">
      <Header title="ความพร้อมของระบบ" subtitle="สถานะของแอป ข้อมูลตลาด งานเบื้องหลัง และการชำระเงิน" />
      <main className="mx-auto w-full max-w-3xl space-y-4 p-3 sm:p-4 md:p-6">
        <section
          className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
          data-testid="reliability-overall"
          data-level={report.overall}
        >
          <p className="text-xs text-[var(--text-muted)]">ภาพรวม</p>
          <p className="mt-1 text-lg font-black text-[var(--text)]">
            <span aria-hidden="true">{RELIABILITY_DOT[report.overall]}</span>{' '}
            {RELIABILITY_LABEL[report.overall]}
          </p>
          <p className="mt-2 text-xs leading-6 text-[var(--text-muted)]">
            หน้านี้อ่านสถานะจากระบบที่รายงานตัวเองอยู่แล้ว ไม่มีการเปลี่ยนค่า ไม่มีการเชื่อมต่อใหม่
            และไม่แสดงคีย์หรือค่าตั้งค่าใด ๆ
          </p>
        </section>

        <ul className="grid min-w-0 gap-3" data-testid="reliability-rows">
          {report.rows.map((row) => <StatusRow key={row.id} row={row} />)}
        </ul>
      </main>
    </div>
  );
}

function StatusRow({ row }: { row: ReliabilityRow }) {
  return (
    <li className="min-w-0">
      <details
        className="min-w-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]"
        data-testid={`reliability-row-${row.id}`}
        data-level={row.level}
      >
        <summary className="grid min-h-16 cursor-pointer list-none gap-1 p-4 sm:flex sm:items-center sm:justify-between sm:gap-3">
          <span className="min-w-0">
            <strong className="block text-sm font-bold text-[var(--text)]">
              <span aria-hidden="true">{RELIABILITY_DOT[row.level]}</span> {row.label}
            </strong>
            <span className="mt-0.5 block break-words text-xs leading-5 text-[var(--text-muted)]">{row.detail}</span>
          </span>
          <span className="shrink-0 text-xs font-semibold text-[var(--text-secondary)]">
            {RELIABILITY_LABEL[row.level]}
          </span>
        </summary>
        <dl className="grid min-w-0 gap-2 border-t border-[var(--border)] p-4 text-xs">
          {row.technical.map((item) => (
            <div key={item.label} className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
              <dt className="text-[var(--text-muted)]">{item.label}</dt>
              <dd className="min-w-0 break-all font-mono text-[var(--text-secondary)]">{item.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </li>
  );
}
