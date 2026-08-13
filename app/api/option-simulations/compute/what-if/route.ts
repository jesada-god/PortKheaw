import { NextResponse } from 'next/server';
import { computeWhatIf } from '@/src/lib/options-simulator/server-compute';
import { whatIfCalculationRequestSchema, whatIfCalculationValidationMessages } from '@/src/lib/options-simulator/validation';
import {
  ComputeCache, computeCacheKey, ConcurrencyGate, SIMULATION_CONCURRENCY,
} from '@/src/lib/security/compute-guard';
import { guardApiRequest } from '@/src/lib/security/request-guard';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { resolveRequestAccountAccess } from '@/src/lib/subscription/account-access';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

const MAX_BODY_BYTES = 500_000;

/** Shared per instance; see the note in the Monte Carlo route. */
const gate = new ConcurrencyGate(SIMULATION_CONCURRENCY);
const cache = new ComputeCache<unknown>();

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function calculationFailure(cause: unknown): { code: string; message: string } {
  const detail = cause instanceof Error ? cause.message : '';
  if (/Black-Scholes inputs must be finite/i.test(detail)) {
    return { code: 'invalid-pricing-input', message: 'ข้อมูลสำหรับคำนวณราคาไม่ครบหรือไม่ใช่ตัวเลข กรุณาตรวจสอบราคาหุ้น ราคาใช้สิทธิ ค่า IV และวันที่' };
  }
  if (/invalid risk-neutral probability/i.test(detail)) {
    return { code: 'invalid-pricing-assumptions', message: 'สมมติฐาน IV ดอกเบี้ย หรือเงินปันผลชุดนี้ไม่สามารถใช้คำนวณราคาได้ กรุณาตรวจสอบค่าที่กรอก' };
  }
  return { code: 'calculation-failed', message: 'ระบบคำนวณราคาไม่สำเร็จ กรุณาตรวจสอบข้อมูลที่กรอกแล้วลองใหม่' };
}

export async function POST(request: Request) {
  const entitlement = await guardRouteEntitlement('simulator.what_if');
  if (entitlement.denied) return entitlement.denied;
  const { tier } = entitlement.entitlement;

  const access = await resolveRequestAccountAccess();
  const limited = await guardApiRequest(request, {
    abuseClass: 'expensive',
    scope: 'simulator.compute',
    userId: access.userId,
    operation: 'what-if',
  });
  if (limited.refusal) return limited.refusal;

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: { code: 'payload-too-large', message: 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินกำหนด กรุณาลดจำนวนสัญญาแล้วลองใหม่' } }, { status: 413 }), tier);
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* schema response below */ }
  const parsed = whatIfCalculationRequestSchema.safeParse(body);
  if (!parsed.success) {
    const input = recordValue(body) ? body.input : null;
    const issues = whatIfCalculationValidationMessages(input);
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: {
      code: 'invalid-calculation-input',
      message: 'ข้อมูลสำหรับคำนวณไม่ถูกต้อง กรุณาตรวจสอบช่องที่ระบุ',
      issues,
    } }, { status: 400 }), tier);
  }

  const key = computeCacheKey(raw);
  const cached = cache.get(key);
  if (cached) return withEntitledCacheHeaders(NextResponse.json({ data: cached, error: null }), tier);

  try {
    const run = await gate.run(() => computeWhatIf(parsed.data.input));
    if (!run.ok) {
      return withEntitledCacheHeaders(NextResponse.json(
        { data: null, error: {
          code: 'calculation-busy',
          message: 'ระบบกำลังประมวลผลคำขออื่นอยู่ กรุณาลองใหม่อีกครั้งในอีกสักครู่',
          retryable: true,
          retryAfterSeconds: 2,
        } },
        { status: 429, headers: { 'Retry-After': '2' } },
      ), tier);
    }
    cache.set(key, run.value);
    return withEntitledCacheHeaders(NextResponse.json({ data: run.value, error: null }), tier);
  } catch (cause) {
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: calculationFailure(cause) }, { status: 422 }), tier);
  }
}
