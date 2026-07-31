import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'app/qa/portfolio-goal/page.tsx'), 'utf8');
const fixture = readFileSync(resolve(process.cwd(), 'app/qa/portfolio-goal/PortfolioGoalCardFixture.tsx'), 'utf8');

describe('portfolio goal browser fixture guard', () => {
  it('requires explicit local opt-in and always returns not-found on Vercel Production', () => {
    expect(page).toContain("process.env.VERCEL_ENV === 'production'");
    expect(page).toContain("process.env.PORTFOLIO_GOAL_QA_FIXTURE !== '1'");
    expect(page).toContain('notFound()');
  });

  it('covers all six moods plus empty and unavailable states without Production data', () => {
    for (const state of [
      'strong-gain',
      'gain',
      'flat',
      'loss',
      'strong-loss',
      'severe-loss',
      'empty',
      'unavailable',
    ]) {
      expect(fixture).toContain(state);
    }
    expect(fixture).toContain('Local QA fixture');
  });
});
