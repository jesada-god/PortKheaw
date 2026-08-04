import { NextResponse } from 'next/server';
import { computeMonteCarlo } from '@/src/lib/options-simulator/server-compute';
import { monteCarloCalculationRequestSchema, monteCarloCalculationValidationMessages } from '@/src/lib/options-simulator/validation';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

export const maxDuration = 60;

const MAX_BODY_BYTES = 500_000;

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
    return { code: 'invalid-target-date', message: 'วันที่ต้องการดูผลต้องอยู่ก่อนวันหมดอายุของทุกสัญญา' };
  }
  return { code: 'monte-carlo-failed', message: 'ระบบจำลองความเป็นไปได้ไม่สำเร็จ กรุณาตรวจสอบข้อมูลที่กรอกแล้วลองใหม่' };
}

export async function POST(request: Request) {
  const gate = await guardRouteEntitlement('simulator.monte_carlo');
  if (gate.denied) return gate.denied;

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: { code: 'payload-too-large', message: 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินกำหนด กรุณาลดจำนวนสัญญาแล้วลองใหม่' } }, { status: 413 }), gate.entitlement.tier);
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
    } }, { status: 400 }), gate.entitlement.tier);
  }

  try {
    const data = computeMonteCarlo(parsed.data.input);
    return withEntitledCacheHeaders(NextResponse.json({ data, error: null }), gate.entitlement.tier);
  } catch (cause) {
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: calculationFailure(cause) }, { status: 422 }), gate.entitlement.tier);
  }
}
