import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const portfolio = read('src/components/portfolio/PortfolioClient.tsx');
const options = read('src/components/portfolio/OptionsSection.tsx');
const manager = read('src/components/portfolio/PortfolioManager.tsx');
const modal = read('src/components/ui/Modal.tsx');
const holdingCard = read('src/components/portfolio/tracker/HoldingCard.tsx');
const optionCard = read('src/components/portfolio/tracker/OptionPositionCard.tsx');
const chips = read('src/components/portfolio/tracker/FilterChips.tsx');

describe('portfolio responsive and accessibility contract', () => {
  /*
   * One reading language at every width.
   *
   * The holdings and the option positions used to be a table from `md` up and
   * cards below it — the same figures said twice, and the table could only fit
   * by scrolling sideways inside its own box. Both are now one card list that
   * grows denser on a wide screen, so this asserts the tables are gone rather
   * than that they are well behaved.
   */
  it('renders holdings and options as one card list, with no table and no page overflow', () => {
    expect(portfolio).toContain('overflow-x-clip');
    expect(portfolio).toContain('data-testid="holdings-list"');
    expect(portfolio).not.toContain('<table');
    expect(options).toContain('data-testid="options-position-list"');
    expect(options).not.toContain('<table');
    for (const source of [holdingCard, optionCard]) {
      expect(source).not.toMatch(/min-w-\[\d{3,}px\]/);
      expect(source).toContain('min-w-0');
    }
    // The chip rails scroll; the page never does.
    expect(chips).toContain('overflow-x-auto');
  });

  it('keeps forms inside the viewport and preserves keyboard dialog semantics', () => {
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    /*
     * The dialog is capped to the viewport and its BODY is what scrolls, so a
     * long form can never push the title bar or the confirm row off screen.
     *
     * This used to read `max-h-dvh` against a modal that was one scrolling box.
     * The modal is now a flex column — capped shell, scrolling body, sticky
     * footer — and the cap is spelled `max-h-[100dvh]`, so the old literal
     * failed while the property it stood for was not only intact but stronger.
     * Asserting the shape rather than one class name is what stops that from
     * happening again.
     */
    expect(modal).toMatch(/max-h-\[100dvh\]|max-h-dvh/);
    expect(modal).toContain('sm:max-h-[calc(100dvh-2rem)]');
    expect(modal).toMatch(/data-testid="modal-body"/);
    expect(modal).toMatch(/min-h-0[^"]*flex-1[^"]*overflow-y-auto/);
    expect(modal).toContain('useDialogA11y');
    expect(portfolio).toContain('min-h-11');
    expect(options).toContain('min-h-11');
  });

  it('keeps the option modal compact without hidden user-input fields or horizontal overflow', () => {
    expect(options).toContain('data-testid="option-transaction-form"');
    expect(options).toContain('className="max-w-2xl overflow-x-hidden"');
    expect(options).toContain('className="min-w-0 space-y-4"');
    expect(options).toContain('grid min-w-0 gap-4 sm:grid-cols-2');
    expect(options).not.toContain('<Field label="Contract symbol"');
    expect(options).not.toContain('<Field label="โบรกเกอร์"');
    expect(portfolio).not.toContain('<Field label="โบรกเกอร์');
  });

  it('orders beginner option fields and keeps multiplier editable with a default of 100', () => {
    const labels = [
      'พอร์ตปลายทาง',
      'ประเภทรายการ (Action)',
      'หุ้นแม่ (Underlying)',
      'ประเภทออปชัน (Call / Put)',
      'ราคาใช้สิทธิ (Strike)',
      'วันหมดอายุ (Expiration)',
      'จำนวนสัญญา (Contracts)',
      'Premium ต่อหุ้น (USD)',
      'ตัวคูณต่อสัญญา (Multiplier)',
      'ค่าธรรมเนียม (Fee',
      'วันและเวลารายการ (Date)',
      'หมายเหตุ (Note',
    ];
    const positions = labels.map((label) => options.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(options).toContain("multiplier: '100'");
    expect(options).toContain("onChange={(value) => onChange('multiplier', value)}");
  });

  it('exposes expanded state and complete option information on the card itself', () => {
    expect(holdingCard).toContain('aria-expanded={expanded}');
    expect(optionCard).toContain('aria-expanded={expanded}');
    for (const label of ['Bid / Ask / Mark', 'Today P&L', 'Unrealized P&L', 'Breakeven', 'DTE', 'Delta', 'Theta', 'Strike', 'Underlying']) {
      expect(optionCard).toContain(label);
    }
    // Status is never carried by colour alone.
    for (const word of ['position.side', 'position.status', 'moneyness']) {
      expect(optionCard).toContain(word);
    }
  });

  it('never invents a moneyness, a Greek or an implied volatility it was not given', () => {
    const presentation = read('src/lib/portfolio/options/presentation.ts');
    expect(presentation).toContain('if (underlyingPrice === null || !Number.isFinite(underlyingPrice)) return null;');
    expect(optionCard).toContain('{moneyness && ');
    expect(optionCard).toContain("position.impliedVolatility === null ? '—'");
    expect(optionCard).toContain('quoteNumber(position.delta, 4)');
  });

  it('keeps internal option identifiers out of every user-facing label', () => {
    expect(optionCard).toContain('optionPositionTitle(position)');
    expect(optionCard).toContain('optionPositionDescription(position)');
    expect(optionCard).toContain('UNMATCHED_OPTION_MESSAGE');
    expect(options).not.toContain('targetPosition?.contractSymbol');
    expect(options).not.toContain('targetDeleting?.contractSymbol');
    expect(optionCard).not.toContain('>{position.contractSymbol}</span>');
  });

  /*
   * One portfolio list, in one place.
   *
   * The manage panel used to repeat the whole list as a second set of cards,
   * with the same value, cash, profit and goal bar the tracker's own cards
   * already carry. The list belongs to "พอร์ตของฉัน"; the manage area keeps the
   * verbs and a name to apply them to, and nothing else.
   */
  it('lists portfolios once, and keeps the manage area to the actions', () => {
    expect(portfolio).toContain('title="พอร์ตของฉัน"');
    expect(portfolio).toContain('data-testid="portfolio-card-list"');
    // Rendered text, not the prose explaining why it is not rendered here.
    expect(manager).not.toMatch(/>\s*พอร์ตของฉัน/);
    expect(manager).not.toContain('md:grid-cols-2 xl:grid-cols-3');
    expect(manager).not.toContain('สินทรัพย์สำคัญ');
    expect(manager).not.toContain('มูลค่าปัจจุบัน');
    // The reason a today figure can be missing is stated where the figure is.
    expect(manager).not.toContain('ไม่มีราคาปิดวันก่อน');
    expect(portfolio).toContain('ไม่มีราคาปิดวันก่อน');
  });

  it('reaches the manage area from one compact row and keeps every action behind it', () => {
    expect(manager).toContain('testId="portfolio-manage-entry"');
    expect(manager).toContain('title="จัดการพอร์ต"');
    expect(manager).toContain('data-testid="portfolio-manage-panel"');
    expect(manager).toContain('data-testid="portfolio-manage-list"');
    expect(manager).toContain('role="tablist"');
    expect(manager).toContain('เป้าหมายพอร์ตรวม');
    expect(manager).toContain('ย้ายเงินระหว่างพอร์ต');
    // Stepping into a flow leaves the area, so two focus traps never overlap.
    expect(manager).toContain('function leaveManage()');
    for (const opener of ['openEdit', 'openGoal', 'openReset', 'openDelete', 'openAssetTransfer', 'openTransfer', 'requestCreate']) {
      expect(manager).toMatch(new RegExp(`function ${opener}\\([^)]*\\) \\{\\s*leaveManage\\(\\);`));
    }
    expect(options).toContain('เงินสดติดลบ โปรดตรวจเงินฝากย้อนหลังหรือสถานะ Margin');
    expect(options).toContain('Technical details / Copy');
  });

  it('keeps option premium, quote precision, cash warnings and history formatting auditable', () => {
    expect(options).toContain('Premium ต่อหุ้น (USD)');
    expect(options).toContain("$${helperPrice} × ${helperContracts} × ${helperMultiplier}");
    expect(options).toContain('กรอก 194 หมายถึง $19,400');
    expect(optionCard).toContain('maximumFractionDigits: 8');
    expect(optionCard).toContain('Mark precision (raw quote)');
    expect(options).toContain('สัญญา × $');
    expect(options).toContain('ค่าธรรมเนียม');
    expect(options).toContain('Estimated profit %');
    expect(options).toContain('ระยะห่างจาก Mark');
  });
});
