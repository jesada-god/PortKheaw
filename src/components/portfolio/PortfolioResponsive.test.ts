import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const portfolio = readFileSync(resolve(process.cwd(), 'src/components/portfolio/PortfolioClient.tsx'), 'utf8');
const options = readFileSync(resolve(process.cwd(), 'src/components/portfolio/OptionsSection.tsx'), 'utf8');
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

  it('exposes expanded state and complete mobile option information', () => {
    expect(portfolio).toContain('aria-expanded={expanded}');
    expect(options).toContain('aria-expanded={expanded}');
    for (const label of ['Bid / Ask / Mark', 'Today P&L', 'Unrealized P&L', 'Breakeven', 'DTE', 'Delta', 'Theta']) {
      expect(options).toContain(label);
    }
  });
});
