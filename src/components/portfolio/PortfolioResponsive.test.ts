import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const portfolio = readFileSync(resolve(process.cwd(), 'src/components/portfolio/PortfolioClient.tsx'), 'utf8');
const options = readFileSync(resolve(process.cwd(), 'src/components/portfolio/OptionsSection.tsx'), 'utf8');
const manager = readFileSync(resolve(process.cwd(), 'src/components/portfolio/PortfolioManager.tsx'), 'utf8');
const modal = readFileSync(resolve(process.cwd(), 'src/components/ui/Modal.tsx'), 'utf8');

describe('portfolio responsive and accessibility contract', () => {
  it('uses compact desktop tables and dedicated mobile cards without page overflow', () => {
    expect(portfolio).toContain('overflow-x-clip');
    expect(portfolio).toContain('data-testid="holdings-desktop-table"');
    expect(portfolio).toContain('data-testid="holdings-mobile-cards"');
    expect(portfolio).toContain('hidden overflow-x-auto md:block');
    expect(portfolio).toContain('divide-y divide-slate-800 md:hidden');
    expect(options).toContain('data-testid="options-desktop-table"');
    expect(options).toContain('data-testid="options-mobile-cards"');
    expect(options).not.toMatch(/md:hidden[^"]*min-w-\[/);
  });

  it('keeps forms inside the viewport and preserves keyboard dialog semantics', () => {
    expect(modal).toContain('role="dialog"');
    expect(modal).toContain('aria-modal="true"');
    expect(modal).toContain('max-h-dvh');
    expect(modal).toContain('overflow-y-auto');
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

  it('exposes expanded state and complete mobile option information', () => {
    expect(portfolio).toContain('aria-expanded={expanded}');
    expect(options).toContain('aria-expanded={expanded}');
    for (const label of ['Bid / Ask / Mark', 'Today P&L', 'Unrealized P&L', 'Breakeven', 'DTE', 'Delta', 'Theta']) {
      expect(options).toContain(label);
    }
  });

  it('keeps internal option identifiers out of every user-facing label', () => {
    expect(options).toContain('optionPositionTitle(position)');
    expect(options).toContain('optionPositionDescription(position)');
    expect(options).toContain('UNMATCHED_OPTION_MESSAGE');
    expect(options).not.toContain('targetPosition?.contractSymbol');
    expect(options).not.toContain('targetDeleting?.contractSymbol');
    expect(options).not.toContain('>{position.contractSymbol}</span>');
  });

  it('provides stacked portfolio cards, goal/transfer controls and explicit unavailable reasons', () => {
    expect(manager).toContain('พอร์ตของฉัน');
    expect(manager).toContain('role="tablist"');
    expect(manager).toContain('md:grid-cols-2 xl:grid-cols-3');
    expect(manager).toContain('เป้าหมายพอร์ตรวม');
    expect(manager).toContain('ย้ายเงินระหว่างพอร์ต');
    expect(manager).toContain('ไม่มีราคาปิดวันก่อน');
    expect(options).toContain('เงินสดติดลบ โปรดตรวจเงินฝากย้อนหลังหรือสถานะ Margin');
    expect(options).toContain('Technical details / Copy');
  });

  it('keeps option premium, quote precision, cash warnings and history formatting auditable', () => {
    expect(options).toContain('Premium ต่อหุ้น (USD)');
    expect(options).toContain("$${helperPrice} × ${helperContracts} × ${helperMultiplier}");
    expect(options).toContain('กรอก 194 หมายถึง $19,400');
    expect(options).toContain('maximumFractionDigits: 8');
    expect(options).toContain('Mark precision (raw quote)');
    expect(options).toContain('สัญญา × $');
    expect(options).toContain('ค่าธรรมเนียม');
    expect(options).toContain('Estimated profit %');
    expect(options).toContain('ระยะห่างจาก Mark');
  });
});
