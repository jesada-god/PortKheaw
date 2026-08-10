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

  /*
   * Kheaw is the card's visual identity, not a badge on it. He is drawn at the
   * scale of the goal figures beside him and, from `lg` up, in his own column to
   * their right — while the Overview tile keeps the small size it needs.
   */
  it('draws the mascot large enough to read as the card’s subject, without horizontal overflow', () => {
    expect(mascot).toContain("'h-28 sm:h-36 lg:h-44'");
    expect(mascot).toContain("compact\n    ? 'h-16 sm:h-20 lg:h-24'");
    expect(mascot).toContain('w-auto max-w-full object-contain');
    expect(component).toContain('lg:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]');
    expect(component).toContain('h-28 items-end justify-center sm:h-36 lg:h-44');
    expect(component).toContain('overflow-hidden');
    expect(component).toContain('min-w-0');
    expect(component).toContain('break-words');
  });

  /*
   * The card used to be a hardcoded dark gradient with slate lettering, which is
   * the one thing on this page that could not follow a light or a paid theme.
   * Only the mood accent stays a literal colour, and it is the mascot's own.
   */
  it('draws itself from the semantic tokens rather than a fixed dark palette', () => {
    expect(component).not.toMatch(/from-\[#|to-\[#|text-white|text-slate-|bg-slate-|border-slate-|text-amber-/);
    expect(component).toContain('bg-[linear-gradient(140deg,var(--surface-elevated),var(--surface))]');
    expect(component).toContain('border-[var(--border)]');
    expect(component).toContain('text-[var(--text)]');
    expect(component).toContain('text-[var(--warning)]');
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
    expect(mascot).toContain('alt={`น้อง Kheaw สี');
    expect(component).toContain('data-mood-source={model.mascot.source}');
    expect(component).toContain("data-special-event={model.mascot.specialEvent ?? 'none'}");
    expect(css).not.toContain('hue-rotate');
    expect(component).not.toContain('Total P&L');
    expect(manager).toContain("useState<PortfolioGoalScope>('selected')");
    expect(manager).toContain("goalScope === 'aggregate' ? aggregate : summaries[selectedPortfolio.id]");
  });
});
