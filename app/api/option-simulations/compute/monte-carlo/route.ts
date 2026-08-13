import { NextResponse } from 'next/server';
import { computeMonteCarlo } from '@/src/lib/options-simulator/server-compute';
import { monteCarloCalculationRequestSchema, monteCarloCalculationValidationMessages } from '@/src/lib/options-simulator/validation';
import {
  ComputeCache, computeCacheKey, ConcurrencyGate, monteCarloWorkUnits,
  MONTE_CARLO_WORK_LIMIT, SIMULATION_CONCURRENCY,
} from '@/src/lib/security/compute-guard';
import { guardApiRequest } from '@/src/lib/security/request-guard';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

export const maxDuration = 60;

const MAX_BODY_BYTES = 500_000;

/**
 * Shared by every request this instance serves. Module scope is what makes them
 * work — a gate constructed per request admits everybody, and a cache
 * constructed per request never hits.
 */
const gate = new ConcurrencyGate(SIMULATION_CONCURRENCY);
const cache = new ComputeCache<unknown>();

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function calculationFailure(cause: unknown): { code: string; message: string } {
  const detail = cause instanceof Error ? cause.message : '';
  if (/non-finite|finite underlying|positive finite|inputs must be finite/i.test(detail)) {
    return { code: 'invalid-monte-carlo-input', message: 'ข้อมูลสำหรับจำลองมีค่าที่ไม่ใช่ตัวเลข กรุณาตรวจสอบราคา IV จำนวนรอบ และสมมติฐาน' };
  }
  if (/seed|path count|path set/i.test(detail)) {
    return { code: 'invalid-monte-carlo-settings', message: 'จำนวนรอบ ค่าเริ่มสุ่ม หรือสมมติฐานของชุดจำลองไม่ตรงกัน กรุณาตรวจสอบแล้วลองใหม่' };
  }
  if (/Target date exceeds|expiration/i.test(detail)) {
    return { code: 'invalid-target-date', message: 'วันที่ดูผลต้องไม่เกินวันหมดอายุของทุกสัญญา' };
  }
  return { code: 'monte-carlo-failed', message: 'ระบบจำลองความเป็นไปได้ไม่สำเร็จ กรุณาตรวจสอบข้อมูลที่กรอกแล้วลองใหม่' };
}

/**
 * The most expensive endpoint in the product, and the order of its gates is the
 * protection:
 *
 *   1. **Entitlement**, before anything is read. A Basic account cannot reach
 *      the compute by any path, which is the difference between a paywall and a
 *      decoration.
 *   2. **Rate**, against the caller's own identity, before the body is parsed.
 *   3. **Size** — the byte cap, then the *work* cap, which is the one that
 *      matters. Bytes bound what was sent; work units bound what was asked for,
 *      and those are not the same number: a 400-byte body can request fifty
 *      million path-steps.
 *   4. **Dedupe**, so a retry storm of identical requests costs one run.
 *   5. **Concurrency**, so a parallel burst sheds instead of queueing behind a
 *      blocked event loop.
 *
 * Every one of them runs before `computeMonteCarlo`. Nothing below the gates
 * touches a provider or the database, so a refused request costs a schema parse.
 */
export async function POST(request: Request) {
  const gateResult = await guardRouteEntitlement('simulator.monte_carlo');
  if (gateResult.denied) return gateResult.denied;
  const { tier } = gateResult.entitlement;

  const access = await resolveRequestAccountAccess();
  const limited = await guardApiRequest(request, {
    abuseClass: 'expensive',
    scope: 'simulator.compute',
    userId: access.userId,
    operation: 'monte-carlo',
  });
  if (limited.refusal) return limited.refusal;

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: { code: 'payload-too-large', message: 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินกำหนด กรุณาลดจำนวนสัญญาแล้วลองใหม่' } }, { status: 413 }), tier);
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* schema response below */ }
  const parsed = monteCarloCalculationRequestSchema.safeParse(body);
  if (!parsed.success) {
    const input = recordValue(body) ? body.input : null;
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: {
      code: 'invalid-calculation-input',
      message: 'ข้อมูลสำหรับจำลองไม่ถูกต้อง กรุณาตรวจสอบช่องที่ระบุ',
      issues: monteCarloCalculationValidationMessages(input),
    } }, { status: 400 }), tier);
  }

  /*
   * Both portfolios are simulated over the same path matrix — the whole point of
   * the endpoint is the comparison — so the cost is the paths × steps grid
   * repriced against every leg on *both* sides. Counting one side would
   * understate the largest request by half.
   */
  const { portfolio, comparisonPortfolio, settings } = parsed.data.input;
  const work = monteCarloWorkUnits({
    paths: settings.paths,
    steps: settings.steps,
    legs: portfolio.legs.length + comparisonPortfolio.legs.length,
  });
  if (work > MONTE_CARLO_WORK_LIMIT) {
    // Named fields, not a bare refusal: a caller who legitimately asked for too
    // much needs to know which three numbers to bring down.
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: {
      code: 'simulation-too-large',
      message: 'ชุดจำลองนี้ใหญ่เกินกำหนด กรุณาลดจำนวนรอบ จำนวนช่วงเวลา หรือจำนวนสัญญาแล้วลองใหม่',
      retryable: false,
    } }, { status: 422 }), tier);
  }

  const key = computeCacheKey(raw);
  const cached = cache.get(key);
  if (cached) {
    return withEntitledCacheHeaders(NextResponse.json({ data: cached, error: null }), tier);
  }

  try {
    const run = await gate.run(() => computeMonteCarlo(parsed.data.input));
    if (!run.ok) {
      return withEntitledCacheHeaders(NextResponse.json(
        { data: null, error: {
          code: 'simulation-busy',
          message: 'ระบบกำลังประมวลผลคำขออื่นอยู่ กรุณาลองใหม่อีกครั้งในอีกสักครู่',
          retryable: true,
          retryAfterSeconds: 2,
        } },
        { status: 429, headers: { 'Retry-After': '2' } },
      ), tier);
    }
    // Only a successful run is cached. Caching a failure would turn one bad
    // input into thirty seconds of the same 422 for anybody who posts it.
    cache.set(key, run.value);
    return withEntitledCacheHeaders(NextResponse.json({ data: run.value, error: null }), tier);
  } catch (cause) {
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: calculationFailure(cause) }, { status: 422 }), tier);
  }
}
