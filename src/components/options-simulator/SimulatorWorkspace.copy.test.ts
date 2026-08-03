import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./SimulatorWorkspace.tsx', import.meta.url), 'utf8');
const validationSource = readFileSync(new URL('../../lib/options-simulator/validation.ts', import.meta.url), 'utf8');
const shellStylesSource = readFileSync(new URL('../../../app/globals.css', import.meta.url), 'utf8');
const serverComputeSource = readFileSync(new URL('../../lib/options-simulator/server-compute.ts', import.meta.url), 'utf8');
const tabsSource = readFileSync(new URL('../ui/Tabs.tsx', import.meta.url), 'utf8');
const disclosureSource = readFileSync(new URL('./MetricDisclosure.tsx', import.meta.url), 'utf8');

describe('Options Portfolio Simulator copy', () => {
  it('shows the requested beginner-friendly Thai copy', () => {
    expect(source).toContain('จำลองและวิเคราะห์เท่านั้น ไม่มีการส่งคำสั่งซื้อขายจริง');
    expect(source).toContain('เลือกหุ้นหรือ ETF');
    expect(source).toContain('ข้อมูลสัญญา');
    expect(source).toContain('Monte Carlo Simulation');
    expect(source).toContain('แบบจำลองของฉัน');
    expect(validationSource).toContain('Strike Price ต้องมากกว่า 0');
  });

  it('keeps enum values separate from their display labels', () => {
    expect(source).toContain("options={['call', 'put']}");
    expect(source).toContain("options={['buy', 'sell']}");
    expect(source).toContain("optionLabels={{ call: 'Call', put: 'Put' }}");
  });

  it('does not render legacy cash, stock, fee or exercise controls', () => {
    expect(source).not.toContain('title="เงินสดในพอร์ต"');
    expect(source).not.toContain('title="จำนวนหุ้น"');
    expect(source).not.toContain('title="Fees"');
    expect(source).not.toContain('title="Exercise Style"');
    expect(source).not.toContain('title="Position"');
    expect(source).toContain('title="ฝั่งซื้อ/ขาย (Buy/Sell)"');
  });

  it('numbers the five steps and explains the open tab under the tab row', () => {
    expect(source).toContain("Inputs: '1. ข้อมูลสัญญา'");
    expect(source).toContain("'What-If': '2. ทดลองสถานการณ์ (What-If Analysis)'");
    expect(source).toContain("'Monte Carlo': '3. จำลองความเป็นไปได้ (Monte Carlo Simulation)'");
    expect(source).toContain("Payoff: '4. กราฟกำไร/ขาดทุน (Payoff)'");
    expect(source).toContain("Greeks: '5. ค่าความไวของสัญญา (Greeks)'");
    expect(source).toContain('เลือกหุ้นและกรอกรายละเอียดสัญญาที่ต้องการวิเคราะห์');
    expect(source).toContain('ลองเปลี่ยนราคาหุ้น วันที่ และความผันผวน เพื่อดูว่ากำไรหรือขาดทุนจะเปลี่ยนไปเท่าไร');
    expect(source).toContain('จำลองราคาหุ้นหลายพันสถานการณ์ เพื่อดูโอกาสได้กำไรและระดับความเสี่ยง');
    expect(source).toContain('ดูกำไร/ขาดทุนของกลยุทธ์เมื่อราคาหุ้นเปลี่ยน');
    expect(source).toContain('ดูว่ามูลค่าสัญญาไวต่อราคาหุ้น เวลา และความผันผวนแค่ไหน');
    expect(source).toContain('data-testid="tab-step-description"');
    expect(source).toContain('{stepDescriptions[tabKey]}');
    // Every step heading is rendered from the one ordered map, never re-typed per section.
    expect(source).toContain("{stepHeadings['What-If']}");
    expect(source).toContain("{stepHeadings['Monte Carlo']}");
    expect(source).toContain('{stepHeadings.Inputs}');
    expect(source).toContain('{stepHeadings.Payoff}');
    expect(source).toContain('{stepHeadings.Greeks}');
    // Steps 4 and 5 need a What-If result; they must still announce their step when it is missing.
    expect(source).toContain('data-testid="step-placeholder"');
    expect(source).toContain('heading={stepHeadings.Payoff} onGoToWhatIf=');
    expect(source).toContain('heading={stepHeadings.Greeks} onGoToWhatIf=');
    expect(source).toContain('ขั้นตอนนี้ใช้ผลจากขั้นที่ 2');
  });

  it('keeps the tab row scrollable rather than wrapping or overflowing on mobile', () => {
    expect(tabsSource).toContain('overflow-x-auto');
    expect(tabsSource).toContain('whitespace-nowrap');
    expect(tabsSource).not.toContain('flex-wrap');
    // The description is a normal paragraph, so long Thai copy wraps instead of widening the page.
    expect(source).toContain('<p className="text-sm text-slate-400" data-testid="tab-step-description">');
  });

  it('puts both save actions at the end of the form with no duplicate row on top', () => {
    expect(source).toContain('data-testid="save-simulation-actions"');
    // The save block sits after the leg form and immediately before the saved list.
    const saveIndex = source.indexOf('data-testid="save-simulation-actions"');
    expect(saveIndex).toBeGreaterThan(source.indexOf('เพิ่มสัญญาอีก 1 รายการ'));
    expect(saveIndex).toBeLessThan(source.indexOf('แบบจำลองของฉัน'));
    // Exactly one of each control, and the unsaved status now travels with them.
    expect(source.match(/บันทึกเป็นสำเนา<\/LockedFeatureButton>/g)).toHaveLength(1);
    expect(source.match(/'ลองบันทึกอีกครั้ง' : 'บันทึก'/g)).toHaveLength(1);
    expect(source.match(/displayedSaveStatus\[saveStatus\]/g)).toHaveLength(1);
    expect(source.indexOf('displayedSaveStatus[saveStatus]')).toBeGreaterThan(saveIndex);
    // The top bar is now the back link only.
    expect(source).toContain('data-testid="workspace-top-bar"><Button variant="ghost" onClick={() => router.push(\'/tools\')}><ArrowLeft size={16} className="mr-2" />กลับไปหน้าเครื่องมือ</Button></div>');
  });

  it('uses Thai-first contract field labels and keeps the English term in parentheses', () => {
    expect(source).toContain('title="ราคาหุ้นปัจจุบัน"');
    expect(source).toContain('title="รูปแบบกลยุทธ์ (Strategy)"');
    expect(source).toContain('title="วันที่ใช้คำนวณ (Valuation Date)"');
    expect(source).toContain('รายละเอียดสัญญา (Option Legs)');
    expect(source).toContain('title="ประเภทสัญญา (Call/Put)"');
    expect(source).toContain('title="จำนวนสัญญา (Quantity)"');
    expect(source).toContain('title="ราคาใช้สิทธิ (Strike Price)"');
    expect(source).toContain('title="วันหมดอายุ (Expiration)"');
    expect(source).toContain('title="ความผันผวนที่ตลาดคาด (IV %)"');
    expect(source).toContain('title="ราคาสัญญาต่อหุ้น (Premium)"');
    expect(source).toContain('title="จำนวนหุ้นต่อ 1 สัญญา (Contract Multiplier)"');
    // The What-If and Monte Carlo IV controls carry the same renamed label as the leg field.
    expect(source.match(/title="ความผันผวนที่ตลาดคาด \(IV %\)"/g)).toHaveLength(3);
    expect(source).not.toContain('title="IV (%)"');
    expect(source).not.toContain('title="Premium"');
    expect(source).toContain('title="ราคาสัญญาเปลี่ยนโดยประมาณเมื่อหุ้นเปลี่ยน $1 (Delta)"');
    expect(source).toContain('title="มูลค่าที่ลดลงโดยประมาณต่อวัน (Theta/day)"');
    expect(source).toContain('จำนวนวันที่เหลือก่อนหมดอายุ (DTE)');
    // Renaming Delta/Theta must not silently change which error each field raises.
    expect(source).toContain('invalidMessage="Delta ต้องอยู่ระหว่าง -1 ถึง 1"');
    expect(source).toContain('invalidMessage="Theta ต้องเป็นตัวเลขที่ถูกต้อง"');
    expect(source).not.toContain("title === 'Delta' ?");
  });

  it('summarises contract market data in plain Thai and hides the provider identifiers', () => {
    expect(source).toContain('data-testid="contract-market-data"');
    expect(source).toContain('วันหมดอายุสัญญา');
    expect(source).toContain('ข้อมูลราคา ณ เวลา');
    expect(source).toContain('สถานะข้อมูล');
    expect(source).toContain('ราคาล่าสุด');
    expect(source).toContain('ราคาที่มีผู้เสนอซื้อ');
    expect(source).toContain('ราคาที่มีผู้เสนอขาย');
    expect(source).toContain('ราคากลาง');
    expect(source).toContain('ราคาที่ใช้เริ่มคำนวณ');
    expect(source).toContain('ราคาตลาดด้านบนใช้สำหรับอ้างอิง และไม่ได้ถูกนำมาแทนราคาที่คุณกรอก');
    expect(source).toContain("live: 'เรียลไทม์'");
    expect(source).toContain("delayed: 'ล่าช้า'");
    expect(source).toContain("stale: 'เก่า'");
    // Provenance is preserved, just moved behind a collapsed disclosure.
    expect(source).toContain('summary="รายละเอียดข้อมูลทางเทคนิค"');
    expect(source).toContain("{leg.contractSymbol ?? 'ไม่มีข้อมูล'}");
    expect(source).toContain("{leg.contractProvider ?? 'ไม่มีข้อมูล'}");
    // The provider quote time is never relabelled as a creation date.
    expect(source).not.toContain('วันที่สร้างสัญญา');
    expect(source).toContain('data-testid="workspace-created-at"');
    expect(source).toContain('{createdAt && ');
    expect(source).toContain('สร้างแบบจำลองเมื่อ');
  });

  it('separates contract editing from the What-If and Monte Carlo workspaces', () => {
    expect(source).toContain('data-testid="option-legs-form"');
    expect(source).toContain('data-testid="contract-summary"');
    expect(source).toContain('data-testid="what-if-controls"');
    expect(source).toContain('data-testid="monte-carlo-controls"');
    expect(source).toContain("key === 'What-If' ? 'What-If Analysis'");
    expect(source).toContain("key === 'Monte Carlo' ? 'Monte Carlo Simulation'");
    expect(source).toContain('แก้ไขข้อมูลสัญญา');
    expect(source).toContain("tab === 'Inputs' &&");
    expect(source).not.toContain("tab === 'What-If' && <section");
    expect(source).not.toContain("tab === 'Monte Carlo' && <section");
  });

  it('limits What-If to price, date and IV and clamps the target date', () => {
    expect(source).toContain('ราคาหุ้นที่อยากลอง (Target Stock Price)');
    expect(source).toContain('title="วันที่ต้องการดูผล (Target Date)"');
    expect(source).toContain('title="ความผันผวนที่ตลาดคาด (IV %)"');
    expect(source).toContain('min={minimumTargetDate}');
    expect(source).toContain('max={earliestExpiration}');
    expect(source).toContain('clampTargetDate(event.target.value');
    expect(source).toContain('ข้อมูลสัญญามีการเปลี่ยนแปลง กรุณาคำนวณใหม่');
  });

  it('derives Monte Carlo contract inputs and rejects stale server responses', () => {
    expect(source).toContain('เงินที่จ่ายเป็นค่าสัญญา');
    expect(source).toContain('จำนวนวันที่เหลือก่อนหมดอายุ (DTE)');
    expect(source).toContain('const targetDte =');
    expect(source).toContain('horizonDays: targetDte');
    expect(source).toContain('runId !== calculationRunId.current');
    expect(source).toContain("'เริ่มจำลอง' : 'คำนวณผลลัพธ์'");
    expect(source).toContain('BASIC_PATH_OPTIONS.map');
    expect(source).toContain('helper={DELTA_MONTE_CARLO_HELP}');
    expect(source).not.toContain('>Advanced Settings<');
    expect(source).toContain('progress.toLocaleString()} / {workspace.monteCarlo.paths.toLocaleString()');
    expect(source).toContain('calculationController.current?.abort()');
  });

  it('keeps numeric drafts as strings and commits finite values on blur', () => {
    expect(source).toContain("const [draft, setDraft] = useState");
    expect(source).toContain('parseFiniteDraft(draft)');
    expect(source).toContain('onBlur={commit}');
    expect(source).toContain("if (value === 0) event.currentTarget.select()");
  });

  it('keeps Manual Greeks separate from pricing and server settings', () => {
    expect(source).toContain('ค่าประมาณจาก Delta (ทั้งสถานะ)');
    expect(source).toContain('Delta เป็นตัวเลขไว้เทียบเท่านั้น ไม่ถูกนำไปบวกซ้ำในผลรวม');
    expect(source).toContain("source === 'manual' ? 'คุณกรอกเอง' : 'ระบบประเมินให้'");
    expect(source).toContain('body: JSON.stringify({ workspace: scoped, comparisonWorkspace: workspace, settings, targetPrice:');
    expect(source).not.toContain('settings: { ...settings, delta');
  });

  it('uses the new responsive leg cards and currency/percentage inputs', () => {
    expect(source).toContain('sm:grid-cols-2 lg:grid-cols-4');
    expect(source).toContain('lg:max-w-[50%]');
    expect(source).toContain('เพิ่มสัญญาอีก 1 รายการ');
    expect(source).toContain('function PremiumInput');
    expect(source).toContain('parsePremiumPaste');
    expect(source).toContain('function PercentInput');
    expect(source).toContain('percentVolatilityToEngine(value)');
  });

  it('renders validation warnings only for real validation errors and focuses the first field', () => {
    expect(source).toContain('validationErrors.length > 0 && <section role="alert" data-testid="validation-warning"');
    expect(source).toContain('validationErrors.map(displayValidationMessage)');
    expect(source).toContain('focusFirstValidationField(issues)');
    expect(source).toContain("document.querySelectorAll<HTMLElement>('[data-validation-path]')");
    expect(source).toContain('validationPath={`legs.${index}.entryPremium`}');
    expect(source).not.toContain('!contractReady');
    expect(source).not.toContain('disabled={running || !contractReady}');
  });

  it('uses calculation-only validation and reports development paths without values', () => {
    expect(source).toContain('calculationValidationMessages(analysisWorkspace())');
    expect(source).toContain("console.debug('[Options Simulator validation]'");
    expect(source).toContain('return { path, unit: validationPathUnit(path) };');
    expect(source).not.toContain('return { path, value');
  });

  it('shows distinct target-touch and terminal-close probabilities', () => {
    expect(source).toContain('title="โอกาสที่ราคาเคยแตะเป้าหมาย"');
    expect(source).toContain('title="โอกาสที่ราคาปลายทางถึงเป้าหมาย"');
    expect(source).toContain('title="โอกาสที่ราคาปลายทางไม่ถึงเป้าหมาย"');
    expect(source).toContain('helper={TOUCH_TARGET_HELP}');
    expect(source).toContain('helper={CLOSE_AT_TARGET_HELP}');
    expect(source).toContain('ผลลัพธ์เป็นความน่าจะเป็นจากสมมติฐาน ไม่ใช่การทำนายราคาที่แน่นอน');
  });

  it('localizes Result labels while preserving standard options terms', () => {
    expect(source).toContain('มูลค่าปัจจุบัน (Current Value)');
    expect(source).toContain('มูลค่าหลังทดลอง (Simulated Value)');
    expect(source).toContain('เพิ่ม/ลดจากปัจจุบัน (Change from Current)');
    expect(source).toContain('กำไร/ขาดทุนที่คาดจากสถานการณ์ (Projected P&L)');
    expect(source).toContain('กำไร/ขาดทุน (%)');
    expect(source).toContain('ราคาคุ้มทุนต่อหุ้น (Break-even)');
    expect(source).toContain('กำไรสูงสุด (Max Profit)');
    expect(source).toContain('ขาดทุนสูงสุด (Max Loss)');
    expect(source).toContain('ผลจากราคาหุ้น (Price Impact)');
    expect(source).toContain('ผลจากเวลาที่ผ่านไป (Time Decay)');
    expect(source).toContain('ผลจาก IV (IV Impact)');
    expect(source).toContain('โอกาสได้กำไร (POP)');
    expect(source).toContain('โอกาสที่สัญญาจะมีมูลค่าในตัว (ITM)');
    expect(source).toContain('กำไร/ขาดทุนเฉลี่ยจากการจำลอง (Expected P&L)');
    expect(source).toContain('ค่ากลางกำไร/ขาดทุน (Median P&L)');
    expect(source).toContain('ผลลัพธ์ในกลุ่มกรณีแย่ (P5)');
    expect(source).toContain('ผลลัพธ์ค่ากลาง (P50)');
    expect(source).toContain('ผลลัพธ์ในกลุ่มกรณีดี (P95)');
    expect(source).toContain("const VALUE_AT_RISK_TITLE = 'ระดับขาดทุนในกรณีแย่ประมาณ 5% (VaR 95%)'");
    expect(source).toContain("const EXPECTED_SHORTFALL_TITLE = 'ขาดทุนเฉลี่ยของกรณีแย่สุดประมาณ 5% (Expected Shortfall 95%)'");
    expect(source).not.toContain('มูลค่าคาดหวัง (Expected Value)');
    expect(source).not.toContain('Expected Value ติดลบ');
    expect(source.match(/amount=\{result\.expectedProfitLoss\}/g)).toHaveLength(2);
  });

  it('renames the scenario score in Thai and states it is not a win rate', () => {
    expect(source).toContain('คะแนนความน่าสนใจของสถานการณ์ (Scenario Quality Score)');
    expect(source).toContain("'Positive Scenario Edge': 'แบบจำลองพบความได้เปรียบเชิงสถิติ (Positive Scenario Edge)'");
    expect(source).toContain("const SCORE_CAVEAT = 'คะแนนนี้ไม่ใช่โอกาสชนะและไม่รับประกันผลลัพธ์'");
    expect(source).toContain('{SCORE_CAVEAT}');
    // Display translation only: the engine's raw classification still drives the tone.
    expect(source).toContain('${tone(strategy.classification)}');
    expect(source).toContain('{classificationLabel(strategy.classification)}');
    expect(source).toContain('${tone(summary)}');
  });

  it('groups Monte Carlo metrics and explains the beginner distinctions', () => {
    expect(source).toContain('testId="monte-carlo-group-summary"');
    expect(source).toContain('testId="monte-carlo-group-target"');
    expect(source).toContain('testId="monte-carlo-group-risk"');
    expect(source).toContain('data-testid="monte-carlo-group-charts"');
    expect(source).toContain('helper={PROBABILITY_OF_PROFIT_HELP}');
    expect(source).toContain('การมีมูลค่าในตัวยังไม่ได้แปลว่ากำไร');
    expect(source).toContain('title="ผลลัพธ์ในกลุ่มกรณีแย่ (P5)"');
    expect(source).toContain('title="ผลลัพธ์ค่ากลาง (P50)"');
    expect(source).toContain('title="ผลลัพธ์ในกลุ่มกรณีดี (P95)"');
    expect(source).not.toContain('กำไร · กำไร/ขาดทุน (%)');
  });

  it('shows the complete beginner summary from all valid paths', () => {
    expect(source).toContain('สรุปแบบมือใหม่');
    expect(source).toContain('จากการจำลอง {validPaths.toLocaleString()} รอบ จากทั้งหมด {result.paths.toLocaleString()} รอบ');
    expect(source).toContain('title="ขาดทุนสูงสุด (Max Loss)"');
    expect(source).toContain('title="โอกาสได้กำไร (POP)"');
    expect(source).toContain('title="กำไร/ขาดทุนเฉลี่ยจากการจำลอง (Expected P&L)"');
    expect(source).toContain('title="ค่ากลางกำไร/ขาดทุน (Median P&L)"');
    expect(source).toContain('title={VALUE_AT_RISK_TITLE}');
    expect(source).toContain('title={EXPECTED_SHORTFALL_TITLE}');
  });

  it('renders independent single-side/comparison scores, gates and the required disclaimer', () => {
    expect(source).toContain('data-testid="call-put-scenario-score"');
    expect(source).toContain("'เปรียบเทียบฝั่ง Call/Put (Call/Put Comparison)' : 'คะแนนความน่าสนใจของสถานการณ์ (Scenario Quality Score)'");
    expect(source).toContain('คะแนนสองฝั่งจึงไม่จำเป็นต้องรวมกันได้ 100');
    expect(source).toContain('presentEdgeGate(strategy.positiveEdgeReasons)');
    expect(source).toContain('โอกาสทิศทางราคาหุ้น (คิดแยกจากคะแนนกลยุทธ์)');
    expect(source).toContain('ความรุนแรงของกรณีแย่ที่สุด');
    expect(source).toContain('ไม่ใช่คำแนะนำซื้อขายและไม่รับประกันผลลัพธ์');
    expect(source).not.toContain('callPercent');
    expect(source).not.toContain('putPercent');
  });

  it('uses deterministic accessible histograms with audited markers and dated sample paths', () => {
    expect(source).toContain('<BarChart');
    expect(source).toContain('<Bar dataKey="count"');
    expect(source).toContain('การกระจายราคาหุ้นในวันเป้าหมาย (USD)');
    expect(source).toContain('ราคาหุ้นในวันเป้าหมาย (USD)');
    expect(source).toContain("value: 'จำนวนรอบจำลอง'");
    expect(source).toContain("label: 'ราคาปัจจุบัน'");
    expect(source).toContain('label: `ราคาใช้สิทธิ ${index + 1}`');
    expect(source).toContain("? 'จุดคุ้มทุน' : `จุดคุ้มทุน ${index + 1}`");
    expect(source).toContain("label: 'ราคาเป้าหมาย'");
    expect(source).toContain('title={reference.description}');
    expect(source).toContain('isAnimationActive={false}');
    expect(source).toContain('แสดงตัวอย่าง {shownPaths.length.toLocaleString()} เส้น จากการจำลอง {validPaths.toLocaleString()} รอบ');
    expect(source).toContain('dataKey="date"');
    expect(source).toContain("value: 'วันที่'");
    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('function MiniDistribution');
  });

  it('keeps chart audit fields transient and preserves the persisted result contract', () => {
    expect(source).toContain('function monteCarloSnapshot');
    expect(source).toContain('delete snapshot.validPaths');
    expect(source).toContain('delete snapshot.discardedPaths');
    expect(source).toContain('delete snapshot.terminalPriceHistogram');
    expect(source).toContain('delete snapshot.breakEvens');
    expect(source).toContain('delete snapshot.expirationProfitFloor');
    expect(source).toContain('monteCarlo: monteCarloSnapshot(result)');
    expect(source).toContain('const [callPutScore, setCallPutScore]');
    expect(source).not.toMatch(/resultSnapshot:[^\n]+callPutScore/);
    expect(source).not.toMatch(/resultSnapshot:[^\n]+scenarioScore/);
    expect(serverComputeSource).toContain('const { terminalPrices: _terminalPrices, pathSet: transientPathSet, ...result } = auditResult');
    expect(serverComputeSource).toContain('transientPathSet');
    expect(serverComputeSource).toContain('breakEvens: payoff.breakEvens');
    expect(serverComputeSource).toContain('expirationProfitFloor: boundedExpirationProfitFloor(workspace)');
    expect(serverComputeSource).toContain('scenarioScore,');
  });

  it('discloses every Monte Carlo assumption and fee treatment', () => {
    expect(source).toContain('data-testid="monte-carlo-assumptions"');
    expect(source).toContain('สมมติฐานที่ใช้ (รายละเอียดทางเทคนิค)');
    expect(source).toContain('Geometric Brownian Motion (GBM)');
    expect(source).toContain('จำนวนรอบจำลอง / ค่าเริ่มสุ่ม');
    expect(source).toContain('ราคาหุ้นปัจจุบัน');
    expect(source).toContain('วันเป้าหมาย / จำนวนวัน');
    expect(source).toContain('ความผันผวน / แนวโน้ม');
    expect(source).toContain('อัตราดอกเบี้ย / เงินปันผล');
    expect(source).toContain('จำนวนสัญญา');
    expect(source).toContain('จำนวนหุ้นต่อ 1 สัญญา');
    expect(source).toContain('รวมใน P&amp;L แล้ว');
    expect(source).toContain('ส่วนอัตราดอกเบี้ยแสดงไว้เพื่อการตรวจสอบเท่านั้น');
  });

  it('keeps USD results as source of truth and toggles display currency without rerunning either engine', () => {
    expect(source).toContain('fetchFxRate()');
    expect(source).toContain('data-testid="result-currency-control"');
    expect(source).toContain("disabled={item === 'THB' && !thbAvailable}");
    expect(source).toContain('onClick={() => onCurrencyChange(item)}');
    expect(source).toContain('ระบบคำนวณเป็นดอลลาร์เสมอ');
    expect(source).toContain('ตัวเลขผลลัพธ์ไม่เปลี่ยน');
    expect(source).toContain('const analysisWorkspaceValue = useMemo');
    expect(source).toContain('const sensitivity = useMemo');
    expect(source).toContain('const summaryLegs = useMemo');
    expect(source).not.toContain('const whatIfCalculation = useMemo');
    expect(source).not.toContain('valuePortfolio(');
    expect(source).toContain('const breakEvens = result.breakEvens ?? []');
    expect(source).toContain("fxQuote?.stale ? 'stale'");
    expect(source).toContain('1 USD = {Number(fxQuote.rate).toFixed(2)} THB');
    expect(source).toContain('อัตรา ณ {formatTimestamp(fxQuote.asOf)}');
    expect(source).toContain('function CallPutScenarioScoreCard({ score }');
    expect(source).not.toContain('function CallPutScenarioScoreCard({ score, currency }');
  });

  it('renders accessible signed P&L cards and a mobile-safe result summary', () => {
    expect(source).toContain('data-testid="result-summary"');
    expect(source).toContain('role="status" aria-label=');
    expect(source).toContain('profitLossToneClass(state)');
    expect(source).toContain('formatSignedPercent(percentage)');
    expect(source).toContain('grid grid-cols-1 gap-3 sm:grid-cols-2');
    expect(source).toContain('min-w-0 rounded-xl');
    expect(source).toContain('formatSignedPercent(percentage)');
  });

  it('groups What-If results and gives every value a beginner explanation', () => {
    expect(source).toContain('testId="result-group-key-summary"');
    expect(source).toContain('testId="result-group-position-value"');
    expect(source).toContain('testId="result-group-maximum-risk"');
    expect(source).toContain('testId="result-group-estimate-details"');
    expect(source).toContain('สรุปผลสำคัญ');
    expect(source).toContain('มูลค่าสถานะ');
    expect(source).toContain('ความเสี่ยงสูงสุด');
    expect(source).toContain('ที่มาของกำไร/ขาดทุน');
    expect(source).toContain('ดูคำอธิบาย');
    expect(source).toContain('buildProfitLossSummary(');
  });

  it('collapses every metric explanation until the reader presses it', () => {
    // The defect: a hover-only ⓘ paired with an always-printed <Helper> line, so
    // the explanation was already on screen. Both metric cards now disclose.
    expect(source).not.toContain('<Helper>{helper}</Helper>');
    expect(source).not.toContain('cursor-help');
    expect(source).not.toContain('<details');
    expect(source).not.toContain('<summary');
    expect(source.match(/<MetricDisclosure summary="ดูคำอธิบาย" openSummary="ซ่อนคำอธิบาย"/g)?.length).toBeGreaterThanOrEqual(4);
    // One disclosure per card instance: no shared boolean anywhere in the page.
    expect(disclosureSource).toContain('const [open, setOpen] = useState(false)');
    expect(disclosureSource).toContain('const controlId = useId()');
    expect(disclosureSource).toContain('aria-expanded={open}');
    expect(disclosureSource).toContain('aria-controls={panelId}');
    expect(disclosureSource).toContain('hidden={!open}');
    expect(disclosureSource).toContain('type="button"');
    expect(disclosureSource).toContain('focus-visible:ring-2');
    expect(disclosureSource).toContain('setOpen((current) => !current)');
    // The one helper that must stay visible: a field subtitle needed to fill the field in.
    expect(source).toContain('{helper && <Helper id={htmlFor ? `${htmlFor}-helper` : undefined}>{helper}</Helper>}');
  });

  it('keeps every technical block collapsed by default', () => {
    expect(source).toContain('summary="รายละเอียดข้อมูลทางเทคนิค"');
    expect(source).toContain('summary="รายละเอียดทางเทคนิคของคะแนนนี้"');
    expect(source).toContain('summary="สมมติฐานที่ใช้ (รายละเอียดทางเทคนิค)"');
    expect(source).toContain('summary="ส่วนประกอบของคะแนนและสมมติฐาน (รายละเอียดทางเทคนิค)"');
    expect(source).toContain('summary="ระบบดูอย่างไร"');
    // No disclosure is allowed to render open on first paint.
    expect(source).not.toContain('defaultOpen');
    expect(disclosureSource).not.toContain('useState(true)');
  });

  it('hides formulas in a calculation disclosure and reports reconciliation', () => {
    expect(source).toContain('ระบบดูอย่างไร');
    expect(source).toContain('data-testid="reconciliation-status"');
    expect(source).toContain('auditResultReconciliation({');
    expect(serverComputeSource).toContain('priceImpact: afterPrice.theoreticalValue - current.theoreticalValue');
    expect(serverComputeSource).toContain('timeImpact: afterTime.theoreticalValue - afterPrice.theoreticalValue');
    expect(serverComputeSource).toContain('ivImpact: valuation.theoreticalValue - afterTime.theoreticalValue');
    expect(source).not.toContain('valuePortfolio(');
    expect(source).toContain('ผลอื่น ๆ (Other Impact)');
    expect(source).toContain('รวมกันแล้วต้องเท่ากับมูลค่าที่เปลี่ยนไปทั้งหมด');
    expect(source).toContain('Delta เป็นตัวเลขไว้เทียบเท่านั้น');
  });

  it('shows Delta as a position sensitivity with an explicit unit and never adds it to impacts', () => {
    expect(source).toContain('ค่าประมาณจาก Delta (ทั้งสถานะ)');
    expect(source).toContain('Delta ของทั้งสถานะ');
    expect(source).toContain('label="Delta ต่อหุ้น"');
    expect(source).toContain('ต่อราคาหุ้นเปลี่ยน $1');
    expect(source).toContain('deltaEstimate: sensitivity.delta');
    expect(source).not.toContain('sensitivity.delta.toFixed(4)');
    expect(source).not.toContain('resolved.delta.toFixed(4)');
    expect(source).not.toContain('deltaApproximation');
    expect(source).not.toContain('ผลกระทบจาก Theta (ประมาณ)');
  });

  it('shows accessible save states, disables both actions, and supports retry feedback', () => {
    expect(source).toContain("useState<SaveFeedbackStatus | 'Offline draft'>('Unsaved')");
    expect(source).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(source).toContain("saveStatus === 'Saving'");
    expect(source).toContain("saveStatus === 'Saved'");
    expect(source).toContain("saveStatus === 'Failed'");
    expect(source).toContain('disabled={isSaving}');
    expect(source).toContain('ลองบันทึกอีกครั้ง');
    expect(source).toContain('motion-reduce:animate-none');
    expect(source).toContain("addToast({ title: 'บันทึกไม่สำเร็จ'");
    expect(source).toContain("saveStatus !== 'Unsaved'");
  });

  it('keeps Calculate visible at 320px and moves the desktop action to the form end', () => {
    expect(source).toContain('data-testid="mobile-calculate-action"');
    expect(source).toContain('md:hidden');
    expect(source).toContain('min-h-11 w-full');
    expect(source).toContain('data-testid="desktop-calculate-action"');
    expect(source).toContain('hidden justify-end md:flex');
    expect(source).not.toContain('md:left-auto md:right-6');
  });

  it('positions the sticky mobile action above the dock and reserves content space', () => {
    // Both offsets read the shell's own clearance token rather than restating
    // the navigation's height, so the bar cannot drift out from under the dock.
    expect(shellStylesSource).toContain('--dock-clearance:');
    expect(shellStylesSource).toContain('z-index: 50;');
    expect(source).toContain('bottom-[var(--dock-clearance)]');
    expect(source).toContain('z-40');
    expect(source).toContain('pb-[calc(var(--dock-clearance)+5rem)]');
    expect(source).toContain('mobile-calculate-disabled-reason');
    expect(source).toContain('aria-describedby={calculateDisabledReason');
  });
});
