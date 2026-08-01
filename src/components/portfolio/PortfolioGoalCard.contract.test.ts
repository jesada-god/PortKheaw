import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const component = readFileSync(resolve(process.cwd(), 'src/components/portfolio/PortfolioGoalCard.tsx'), 'utf8');
const mascot = readFileSync(resolve(process.cwd(), 'src/components/portfolio/PortfolioGoalMascot.tsx'), 'utf8');
const css = readFileSync(resolve(process.cwd(), 'src/components/portfolio/PortfolioGoalCard.module.css'), 'utf8');
const manager = readFileSync(resolve(process.cwd(), 'src/components/portfolio/PortfolioManager.tsx'), 'utf8');

describe('PortfolioGoalCard responsive and accessibility contract', () => {
  it('renders the financial priority before the mascot in mobile DOM order', () => {
    const primary = component.indexOf('data-testid="portfolio-goal-primary"');
    const mascot = component.indexOf('data-testid="portfolio-goal-mascot"');
    const metadata = component.indexOf('<dl className=');
    expect(primary).toBeGreaterThan(-1);
    expect(mascot).toBeGreaterThan(primary);
    expect(metadata).toBeGreaterThan(mascot);
  });

  it('uses the requested mobile and desktop mascot sizes without horizontal overflow', () => {
    expect(mascot).toContain("'h-20 sm:h-24 lg:h-28'");
    expect(mascot).toContain('w-auto object-contain');
    expect(component).toContain('overflow-hidden');
    expect(component).toContain('min-w-0');
    expect(component).toContain('break-words');
  });

  it('keeps motion subtle and disables it for reduced-motion users', () => {
    expect(css).toContain('animation: kheaw-goal-breathe 5.5s ease-in-out infinite');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
  });

  it('exposes scope, progress and mascot semantics while keeping Total P/L out', () => {
    expect(component).toContain('aria-labelledby="portfolio-goal-title"');
    expect(component).toContain('aria-label="ขอบเขตเป้าหมายพอร์ต"');
    expect(component).toContain('role="progressbar"');
    expect(mascot).toContain('alt={`น้อง Kheaw สไตล์ Glossy Tech');
    expect(component).not.toContain('Total P&L');
    expect(manager).toContain("useState<PortfolioGoalScope>('selected')");
    expect(manager).toContain("goalScope === 'aggregate' ? aggregate : summaries[selectedPortfolio.id]");
  });
});
