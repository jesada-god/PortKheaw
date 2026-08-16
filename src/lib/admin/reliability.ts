import type { SchedulerStatus } from '@/src/types/database';

/**
 * The reliability report: what an operator needs to answer "is it working?"
 * without opening a log.
 *
 * This module maps state that other systems already report — the readiness
 * routine, the billing configuration check, the market gateway's own `/healthz`
 * — onto three colours and a sentence each. It performs no checks of its own, it
 * reaches nothing, and it is pure, so the mapping can be asserted without a
 * running gateway.
 *
 * What it must never carry is as important as what it does: no key, no token, no
 * connection string, no provider URL, no environment variable name. Every field
 * below is either a word from a fixed vocabulary, a count, or a timestamp.
 */

export type ReliabilityLevel = 'ok' | 'degraded' | 'down' | 'unknown';

export const RELIABILITY_LABEL: Readonly<Record<ReliabilityLevel, string>> = {
  ok: 'ปกติ',
  degraded: 'ทำงานสำรอง',
  down: 'ขัดข้อง',
  unknown: 'ยังตรวจไม่ได้',
};

export const RELIABILITY_DOT: Readonly<Record<ReliabilityLevel, string>> = {
  ok: '🟢',
  degraded: '🟡',
  down: '🔴',
  unknown: '⚪',
};

export interface ReliabilityRow {
  id: string;
  label: string;
  level: ReliabilityLevel;
  /** One plain sentence. Never an error message and never a stack. */
  detail: string;
  /** Name/value pairs for the expandable section. Operational signal only. */
  technical: Array<{ label: string; value: string }>;
}

export interface ReliabilityReport {
  rows: ReliabilityRow[];
  /** The worst level present, which is what the page leads with. */
  overall: ReliabilityLevel;
}

export type CheckState = 'ok' | 'degraded' | 'unavailable';

/** Whatever the gateway's `/healthz` answered, or `null` when it did not. */
export interface GatewayHealth {
  status: 'ready' | 'degraded';
  upstreamState: string;
  feed: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReliabilityInput {
  database: CheckState;
  scheduler: SchedulerStatus;
  billing: CheckState;
  /** Whether the REST market provider is configured, and which one it is. */
  marketRest: { configured: boolean; provider: string };
  /** Configured but unreachable is `{ configured: true, health: null }`. */
  marketGateway: { configured: boolean; health: GatewayHealth | null };
  deployment: { commitSha: string; buildTime: string | null };
}

const ORDER: readonly ReliabilityLevel[] = ['ok', 'unknown', 'degraded', 'down'];

function worst(levels: readonly ReliabilityLevel[]): ReliabilityLevel {
  return levels.reduce<ReliabilityLevel>(
    (found, level) => ORDER.indexOf(level) > ORDER.indexOf(found) ? level : found,
    'ok',
  );
}

function fromCheckState(state: CheckState): ReliabilityLevel {
  return state === 'ok' ? 'ok' : state === 'degraded' ? 'degraded' : 'down';
}

function uptimeText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return hours > 0 ? `${hours} ชั่วโมง ${minutes} นาที` : `${minutes} นาที`;
}

export function buildReliabilityReport(input: ReliabilityInput): ReliabilityReport {
  const rows: ReliabilityRow[] = [];

  /*
   * The app itself. It answered, because this report was rendered — which is a
   * weaker claim than it sounds and is stated as exactly that, rather than as a
   * green light somebody might read as "everything is fine".
   */
  rows.push({
    id: 'app',
    label: 'แอปพลิเคชัน',
    level: 'ok',
    detail: 'เซิร์ฟเวอร์ตอบคำขอนี้ได้ตามปกติ',
    technical: [
      { label: 'Deployment revision', value: input.deployment.commitSha },
      { label: 'Build time', value: input.deployment.buildTime ?? '—' },
    ],
  });

  const databaseLevel = fromCheckState(input.database);
  rows.push({
    id: 'database',
    label: 'ฐานข้อมูล',
    level: databaseLevel,
    detail: databaseLevel === 'ok'
      ? 'ฐานข้อมูลตอบกลับตามปกติ'
      : databaseLevel === 'degraded'
        ? 'ฐานข้อมูลตอบกลับ แต่ schema ยังตามหลัง deployment อยู่'
        : 'ติดต่อฐานข้อมูลไม่ได้',
    technical: [{ label: 'platform_readiness', value: input.database }],
  });

  const schedulerLevel: ReliabilityLevel = input.scheduler === 'ok' ? 'ok'
    : input.scheduler === 'lagging' ? 'degraded'
      : input.scheduler === 'stale' ? 'down' : 'unknown';
  rows.push({
    id: 'scheduler',
    label: 'งานเบื้องหลัง',
    level: schedulerLevel,
    detail: schedulerLevel === 'ok'
      ? 'รอบประมวลผลเบื้องหลังทำงานล่าสุดตามกำหนด'
      : schedulerLevel === 'degraded'
        ? 'รอบประมวลผลเบื้องหลังช้ากว่ากำหนด'
        : schedulerLevel === 'down'
          ? 'รอบประมวลผลเบื้องหลังไม่ได้ทำงานมานานผิดปกติ'
          : 'ยังอ่านสถานะรอบประมวลผลไม่ได้',
    technical: [{ label: 'scheduler_status', value: input.scheduler }],
  });

  /*
   * REST is not a lesser path — it is the market pipeline's floor, and the app
   * serves every reader from it when the socket is unavailable. It is reported
   * on its own line so "the socket is down" and "there is no market data" stay
   * visibly different incidents.
   */
  const restLevel: ReliabilityLevel = input.marketRest.configured ? 'ok' : 'down';
  rows.push({
    id: 'market-rest',
    label: 'ข้อมูลตลาด (REST)',
    level: restLevel,
    detail: restLevel === 'ok'
      ? 'ตั้งค่าผู้ให้บริการราคาแบบ REST ไว้แล้ว และเป็นเส้นทางสำรองเมื่อ WebSocket ใช้ไม่ได้'
      : 'ยังไม่ได้ตั้งค่าผู้ให้บริการราคาแบบ REST',
    technical: [{ label: 'Provider', value: input.marketRest.provider }],
  });

  const gatewayLevel: ReliabilityLevel = !input.marketGateway.configured
    ? 'unknown'
    : input.marketGateway.health === null
      ? 'down'
      : input.marketGateway.health.status === 'ready' ? 'ok' : 'degraded';
  rows.push({
    id: 'market-websocket',
    label: 'ข้อมูลตลาดเรียลไทม์ (WebSocket)',
    level: gatewayLevel,
    detail: gatewayLevel === 'ok'
      ? 'Gateway เชื่อมต่อกับผู้ให้บริการต้นทางและส่งข้อมูลอยู่'
      : gatewayLevel === 'degraded'
        ? 'Gateway ทำงานอยู่ แต่ต้นทางยังไม่พร้อมส่งข้อมูล ระบบใช้ REST แทนระหว่างนี้'
        : gatewayLevel === 'down'
          ? 'ติดต่อ Gateway ไม่ได้ ระบบใช้ REST แทนทั้งหมด'
          : 'ยังไม่ได้ตั้งค่า Gateway สำหรับข้อมูลเรียลไทม์',
    technical: input.marketGateway.health
      ? [
        { label: 'Upstream state', value: input.marketGateway.health.upstreamState },
        { label: 'Feed', value: input.marketGateway.health.feed },
        { label: 'Uptime', value: uptimeText(input.marketGateway.health.uptimeSeconds) },
        { label: 'Reported at', value: input.marketGateway.health.timestamp },
      ]
      : [{ label: 'Health report', value: input.marketGateway.configured ? 'ไม่ตอบกลับ' : 'ไม่ได้ตั้งค่า' }],
  });

  const billingLevel = fromCheckState(input.billing);
  rows.push({
    id: 'billing',
    label: 'การชำระเงิน',
    level: billingLevel,
    detail: billingLevel === 'ok'
      ? 'การตั้งค่าการชำระเงินครบถ้วนพอที่จะรับชำระได้'
      : billingLevel === 'degraded'
        ? 'ตั้งค่าการชำระเงินไว้แล้ว แต่ยังไม่มีแพ็กเกจที่ขายได้'
        : 'ยังตั้งค่าการชำระเงินไม่ครบ',
    // Deliberately no variable names. Which value is missing belongs in the
    // server log, not on a page — see the health endpoint's own reasoning.
    technical: [{ label: 'Billing configuration', value: input.billing }],
  });

  return { rows, overall: worst(rows.map((row) => row.level)) };
}

/**
 * The gateway's HTTP health address, derived from the WebSocket URL the browser
 * is already given.
 *
 * That URL is public — it ships in the client bundle — so reading it here adds
 * no exposure, and deriving rather than configuring means the console can never
 * end up reporting on a different gateway than the one readers connect to.
 * Returns `null` for anything that is not a well-formed ws/wss address.
 */
export function gatewayHealthUrl(websocketUrl: string | null | undefined): string | null {
  const raw = websocketUrl?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/healthz';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
