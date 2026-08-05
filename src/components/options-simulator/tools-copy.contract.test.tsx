// @vitest-environment jsdom

/**
 * The contract for everything a reader sees under เครื่องมือ.
 *
 * Two separate rules are held here, and they are not the same rule:
 *  - engine wording ("expectedPnL must be greater than 0", "valid paths",
 *    "pricing engine") stays exactly as it is inside the engines, the schemas and
 *    the logs, because tests and audits match on it;
 *  - none of it may reach the page. Every failure a reader can hit goes through
 *    `error-presentation`, and anything unrecognised lands on a Thai fallback
 *    rather than leaking English or a variable name.
 */

import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presentEdgeGate, presentError, presentUnavailableReason } from './error-presentation';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/tools/what-if',
}));
vi.mock('@/src/components/layout/Header', () => ({
  default: ({ title, subtitle }: { title: string; subtitle?: string }) => <header>{title}{subtitle}</header>,
}));
vi.mock('@/src/lib/market-data/fx/client', () => ({ fetchFxRate: () => Promise.resolve({ quote: null }) }));

import SimulatorWorkspace, { seedWorkspace } from './SimulatorWorkspace';
import { monteCarloSettingsSchema, optionLegSchema } from '@/src/lib/options-simulator/validation';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const workspaceSource = read('./SimulatorWorkspace.tsx');
const validationSource = read('../../lib/options-simulator/validation.ts');
const scenarioScoreSource = read('../../lib/options-simulator/scenario-score.ts');
const serverComputeSource = read('../../lib/options-simulator/server-compute.ts');
const workerSource = read('../../workers/optionsMonteCarlo.worker.ts');
const toolsPageSource = read('../../../app/tools/page.tsx');

/*
  Engineering wording the page may never print. `GBM paths`, not `GBM`: the model's
  standard name is still allowed inside the disclosure that is labelled as
  technical, exactly as a beginner glossary would keep "Delta".
*/
const BANNED = /pricing engine|GBM paths|valid paths|lower tail|time step|expectedPnL|EVR must|must be greater|must be less|Infinity|NaN|undefined|null|schema|denominator|payoff engine/i;

/** Every literal the page can print: prop values plus the shared copy constants. */
function userVisibleStrings(source: string): string[] {
  const strings: string[] = [];
  const attribute = /(?:helper|title|summary|openSummary|placeholder|aria-label|invalidMessage|label)="([^"{}]+)"/g;
  const constant = /^const [A-Z_]+ = '([^']+)';$/gm;
  const mapEntry = /^\s+(?:'[^']+'|[a-zA-Z-]+): '([^']+)',$/gm;
  for (const pattern of [attribute, constant, mapEntry]) {
    for (const match of source.matchAll(pattern)) strings.push(match[1]);
  }
  return strings;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))));
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  localStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe('Tools copy', () => {
  it('prints the agreed explanation for every metric a reader acts on', () => {
    // What the number means first, then what it does to their money.
    expect(workspaceSource).toContain("const PRICE_IMPACT_HELP = 'กำไรหรือขาดทุนโดยประมาณที่เกิดจากการเปลี่ยนแปลงของราคาหุ้น'");
    expect(workspaceSource).toContain("const TIME_IMPACT_HELP = 'มูลค่าที่คาดว่าจะลดลงเมื่อเวลาผ่านไป ยิ่งถือสัญญานาน มูลค่าอาจยิ่งลดลงแม้ราคาหุ้นไม่เปลี่ยน'");
    expect(workspaceSource).toContain("const DELTA_WHAT_IF_HELP = 'หากราคาหุ้นอ้างอิงขยับขึ้น 1 ดอลลาร์ มูลค่ารวมของสถานะคุณจะเปลี่ยนประมาณเท่าไร โดยรวมจำนวนสัญญาที่ถือแล้ว'");
    expect(workspaceSource).toContain("const DELTA_MONTE_CARLO_HELP = 'แสดงว่ามูลค่ารวมของสถานะไวต่อการเปลี่ยนแปลงของราคาหุ้นมากเพียงใด ค่านี้ใช้ประกอบการดูความเสี่ยง'");
    expect(workspaceSource).toContain("const PROBABILITY_OF_PROFIT_HELP = 'โอกาสที่สถานะนี้จะจบด้วยกำไร หลังหักต้นทุนและค่าธรรมเนียมแล้ว'");
    expect(workspaceSource).toContain("const VALUE_AT_RISK_HELP = 'หากตลาดเกิดกรณีที่แย่กว่าปกติ ซึ่งพบได้ประมาณ 5% ของการจำลอง คุณอาจขาดทุนอย่างน้อยประมาณเท่าไร'");
    expect(workspaceSource).toContain("const EXPECTED_SHORTFALL_HELP = 'หากผลลัพธ์อยู่ในกลุ่ม 5% ที่แย่ที่สุด คุณอาจขาดทุนเฉลี่ยประมาณเท่าไร'");
    expect(workspaceSource).toContain("const TOUCH_TARGET_HELP = 'โอกาสที่ราคาหุ้นจะขึ้นหรือลงไปถึงเป้าหมายที่ตั้งไว้ อย่างน้อยหนึ่งครั้งก่อนวันเป้าหมาย'");
    expect(workspaceSource).toContain("const CLOSE_AT_TARGET_HELP = 'โอกาสที่ราคาหุ้นในวันเป้าหมายจะอยู่ถึงหรือผ่านระดับราคาที่ตั้งไว้'");
    // Both simulation modes explain themselves where the reader chooses one.
    expect(workspaceSource).toContain("forecast: 'คาดการณ์ราคาจากแนวโน้มในอดีต เหมาะสำหรับทดลองว่าพอร์ตอาจเป็นอย่างไรหากแนวโน้มยังดำเนินต่อ'");
    expect(workspaceSource).toContain("'risk-neutral': 'ประเมินมูลค่าตามสมมติฐานมาตรฐานของตลาด โดยไม่คาดเดาว่าหุ้นจะขึ้นหรือลง เหมาะสำหรับดูมูลค่าโดยประมาณ'");
    expect(workspaceSource).toContain('data-testid="drift-mode-help"');
  });

  it('reuses one wording per idea instead of explaining a metric twice', () => {
    // Delta and time decay each appear on both tabs; each reads from one constant.
    expect(workspaceSource.match(/helper=\{DELTA_WHAT_IF_HELP\}/g)).toHaveLength(1);
    expect(workspaceSource.match(/helper=\{DELTA_MONTE_CARLO_HELP\}/g)).toHaveLength(1);
    expect(workspaceSource.match(/helper=\{TIME_IMPACT_HELP\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workspaceSource.match(/helper=\{PRICE_IMPACT_HELP\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workspaceSource.match(/helper=\{PROBABILITY_OF_PROFIT_HELP\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workspaceSource.match(/title=\{VALUE_AT_RISK_TITLE\}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(workspaceSource.match(/title=\{EXPECTED_SHORTFALL_TITLE\}/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps engineering wording out of every label, helper and placeholder', () => {
    const offenders = [...userVisibleStrings(workspaceSource), ...userVisibleStrings(toolsPageSource)]
      .filter((text) => BANNED.test(text));
    expect(offenders).toEqual([]);
  });

  it('keeps engineering wording out of the validation messages a reader is shown', () => {
    const messages = [...validationSource.matchAll(/return '([^']+)';/g)].map((match) => match[1]);
    expect(messages.length).toBeGreaterThan(10);
    expect(messages.filter((text) => BANNED.test(text) || /Valuation Date|engine decimal|Target Date/.test(text))).toEqual([]);
    expect(validationSource).toContain('วันที่ต้องการดูผลต้องอยู่หลังวันที่ใช้คำนวณ และต้องก่อนวันหมดอายุ');
  });

  it('renders the tools shell without a single raw English or engine term', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => { root.render(<SimulatorWorkspace initialType="monte-carlo" />); });

    const visible = [...container.querySelectorAll<HTMLElement>('*')]
      .filter((element) => !element.closest('[data-testid="metric-disclosure-panel"]'))
      .flatMap((element) => [element.textContent ?? '', element.getAttribute('aria-label') ?? '', element.getAttribute('placeholder') ?? '']);
    expect(visible.filter((text) => BANNED.test(text))).toEqual([]);
    act(() => { root.unmount(); });
  });

  it('keeps every button and option label short enough for a 320px column', () => {
    // Long labels are what makes the sticky action grow and the tab row scroll away.
    const labels = [...workspaceSource.matchAll(/>([^<>{}]{2,})<\/(?:Button|option)>/g)].map((match) => match[1].trim());
    expect(labels.length).toBeGreaterThan(5);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(40);
    // The mobile calculate action is the tightest of all.
    expect(workspaceSource).toContain("const calculateLabel = tab === 'Monte Carlo Simulation' ? 'เริ่มจำลอง' : 'คำนวณผลลัพธ์';");
    // Values still wrap rather than widen their card.
    expect(workspaceSource).toContain('min-w-0 rounded-xl');
    expect(workspaceSource).toContain('break-words font-mono font-bold');
  });

  it('keeps the page title short enough that the header never ellipses it', () => {
    // The shared header truncates rather than overflowing, so a long title is lost
    // copy at 320px; "Options Portfolio Simulator" was being cut off there.
    const title = workspaceSource.match(/<Header title="([^"]+)"/)?.[1] ?? '';
    expect(title).toBe('จำลองออปชัน');
    expect(title.length).toBeLessThanOrEqual(12);
  });
});

describe('Tools copy leaves the numbers alone', () => {
  it('keeps the persisted workspace shape and its metric keys byte-identical', () => {
    // Rewording a label must never rename a field the API or a saved simulation uses.
    const seeded = seedWorkspace('monte-carlo');
    expect(Object.keys(seeded).sort()).toEqual([
      'cashPosition', 'companyName', 'currency', 'dataSource', 'dataStatus', 'dataTimestamp',
      'description', 'entryDate', 'exchange', 'legs', 'methodologyVersion', 'monteCarlo', 'name',
      'resultSnapshot', 'scenarios', 'simulationType', 'stockQuantity', 'strategyType', 'symbol',
      'underlyingPrice', 'valuationDate',
    ]);
    expect(seeded.methodologyVersion).toBe('options-simulator-v1');
    expect(seeded.monteCarlo).toEqual({ paths: 10_000, seed: 42, horizonDays: 30, steps: 30, drift: 0, volatility: 0.2, rate: 0, dividendYield: 0 });
    expect(Object.keys(seeded.legs[0]).sort()).toEqual([
      'entryPremium', 'expiration', 'fees', 'id', 'impliedVolatility', 'kind', 'multiplier', 'quantity', 'side', 'strike', 'style',
    ]);
    // An untouched seed is incomplete: premium=0 must not persist as real risk data.
    const otherwiseComplete = { ...seeded.legs[0], expiration: '2026-09-01', strike: 100, impliedVolatility: 0.5 };
    expect(optionLegSchema.safeParse(otherwiseComplete).success).toBe(false);
    expect(optionLegSchema.safeParse({ ...otherwiseComplete, entryPremium: 5 }).success).toBe(true);
    expect(monteCarloSettingsSchema.safeParse(seeded.monteCarlo).success).toBe(true);
  });

  it('leaves the engines and their thresholds untouched', () => {
    // These are the strings and constants the presentation layer reads; it never edits them.
    expect(scenarioScoreSource).toContain("if (!(metrics.evr > 0)) reasons.push('EVR must be greater than 0');");
    expect(scenarioScoreSource).toContain('if (confidenceScore < 60)');
    expect(serverComputeSource).toContain('priceImpact: afterPrice.theoreticalValue - current.theoreticalValue');
    expect(serverComputeSource).toContain('timeImpact: afterTime.theoreticalValue - afterPrice.theoreticalValue');
    expect(serverComputeSource).toContain('ivImpact: valuation.theoreticalValue - afterTime.theoreticalValue');
    expect(workspaceSource).not.toContain('valuePortfolio(');
    expect(workspaceSource).toContain('deltaEstimate: sensitivity.delta');
    expect(workspaceSource).toContain('body: JSON.stringify({ input: prepared.data })');
    expect(workspaceSource).not.toContain('body: JSON.stringify({ workspace: scoped');
    expect(serverComputeSource).toContain('generateMonteCarloPathSet(workspace, settings, { targetPrice })');
    expect(workspaceSource).toContain("methodologyVersion: 'options-simulator-v1'");
  });

  it('keeps the legacy worker on the shared calculation DTO and exposes failures', () => {
    expect(workspaceSource).not.toContain('new Worker(');
    expect(workerSource).toContain('MessageEvent<{ input: MonteCarloCalculationInput }>');
    expect(workerSource).toContain("error: { code: 'worker-failed'");
    expect(workerSource).not.toContain('comparisonWorkspace: SimulationWorkspace');
  });
});

describe('Tools error presentation', () => {
  it('turns the positive-edge gate into the agreed Thai heading and sentence', () => {
    const gate = presentEdgeGate(['expectedPnL must be greater than 0', 'EVR must be greater than 0']);
    expect(gate.title).toBe('ยังไม่ผ่านเกณฑ์ความได้เปรียบ');
    expect(gate.message).toBe('ระบบยังไม่พบความได้เปรียบของกลยุทธ์นี้ กำไรที่คาดหวังและอัตราผลตอบแทนที่คาดหวังต้องมากกว่า 0');
    // The internal wording survives untouched, for logs and audits.
    expect(gate.detail).toBe('expectedPnL must be greater than 0; EVR must be greater than 0');
  });

  it('maps every failure the engines can raise to Thai', () => {
    const cases: Array<[string, string]> = [
      ['commonValidPaths must be at least 1,000', 'ผลจำลองยังน้อยเกินไป'],
      ['confidence must be at least 60', 'ความน่าเชื่อถือของข้อมูลยังต่ำ'],
      ['maxLoss must be finite and greater than 0', 'ยังคำนวณขอบเขตขาดทุนไม่ได้'],
      ['No common valid path intersection is available.', 'ยังเปรียบเทียบผลไม่ได้'],
      ['ProfitFactor is unavailable.', 'ยังเทียบกำไรกับขาดทุนไม่ได้'],
      ['A valid target date and target price are required', 'ยังกรอกเป้าหมายไม่ครบ'],
      ['A finite positive starting spot is required', 'ยังไม่มีราคาหุ้นตั้งต้น'],
      ['Scenario score audit failed: unknown error', 'ผลจำลองยังตรวจสอบไม่ผ่าน'],
      ['Options chain response ไม่ผ่าน schema validation', 'นำเข้าสัญญาไม่สำเร็จ'],
      ['Simulation failed', 'จำลองไม่สำเร็จ'],
      ['ข้อมูลสำหรับคำนวณราคาไม่ครบหรือไม่ใช่ตัวเลข', 'ข้อมูลคำนวณไม่ครบ'],
      ['สมมติฐาน IV ดอกเบี้ย หรือเงินปันผลชุดนี้ไม่สามารถใช้คำนวณราคาได้', 'สมมติฐานราคาใช้คำนวณไม่ได้'],
      ['ข้อมูลที่ส่งมามีขนาดใหญ่เกินกำหนด', 'ข้อมูลมีขนาดใหญ่เกินกำหนด'],
      ['ข้อมูลสำหรับจำลองมีค่าที่ไม่ใช่ตัวเลข', 'ข้อมูลจำลองไม่ถูกต้อง'],
      ['จำนวนรอบ ค่าเริ่มสุ่ม หรือสมมติฐานของชุดจำลองไม่ตรงกัน', 'ตั้งค่าชุดจำลองไม่ตรงกัน'],
      ['ระบบจำลองความเป็นไปได้ไม่สำเร็จ', 'จำลองความเป็นไปได้ไม่สำเร็จ'],
    ];
    for (const [detail, title] of cases) {
      const presented = presentError(detail);
      expect(presented.title).toBe(title);
      expect(presented.detail).toBe(detail);
      expect(presented.message).not.toMatch(BANNED);
      expect(presented.message).not.toMatch(/[A-Za-z]{4,}/);
    }
  });

  it('falls back to a safe Thai sentence for anything it has never seen', () => {
    for (const unknown of ['TypeError: Cannot read properties of undefined', '', null, undefined, 500, new Error('ECONNRESET')]) {
      const presented = presentError(unknown as never);
      expect(presented.title).toBe('ทำรายการนี้ไม่สำเร็จ');
      expect(presented.message).toBe('ระบบทำรายการนี้ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หากยังไม่ได้ ให้ตรวจสอบข้อมูลที่กรอกแล้วลองใหม่');
      expect(presented.message).not.toMatch(/[A-Za-z]{4,}/);
    }
    expect(presentUnavailableReason('something nobody mapped')).not.toMatch(/[A-Za-z]{4,}/);
    expect(presentUnavailableReason('', 'ผลที่บันทึกไว้ยังไม่มีคะแนน')).toBe('ผลที่บันทึกไว้ยังไม่มีคะแนน');
  });

  it('routes every raw engine string in the page through the mapping', () => {
    // The engine still says it; the page never prints it.
    expect(scenarioScoreSource).toContain("reasons.push('expectedPnL must be greater than 0')");
    expect(scenarioScoreSource).toContain("reason: 'A finite positive starting spot is required'");
    expect(workspaceSource).toContain('presentEdgeGate(strategy.positiveEdgeReasons)');
    expect(workspaceSource).toContain('presentUnavailableReason(strategy.reason)');
    expect(workspaceSource).toContain('setOperationError(presentError(cause).message)');
    expect(workspaceSource).toContain('calculationPayloadMessage(payload');
    expect(workspaceSource).not.toContain('{strategy.positiveEdgeReasons.join');
    expect(workspaceSource).not.toContain('{strategy.reason}</p>');
  });
});
