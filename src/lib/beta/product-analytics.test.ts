import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BETA_FUNNEL_DEDUPE,
  betaFunnelDedupeScope,
  betaFunnelEventKeys,
  clientRecordableEventKeys,
  isBetaFunnelEventKey,
  normalizeBetaFunnelEvent,
} from './funnel-events';

const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');
const migration = read('supabase/migrations/202608160002_product_analytics_and_onboarding.sql');

const PRODUCT_EVENTS = [
  'landing_viewed',
  'trial_started',
  'portfolio_created',
  'stock_detail_viewed',
  'tool_opened',
  'feature_used',
  'onboarding_path_chosen',
] as const;

describe('product analytics vocabulary', () => {
  it('adds the product events to the funnel that already exists', () => {
    for (const event of PRODUCT_EVENTS) {
      expect(isBetaFunnelEventKey(event)).toBe(true);
      expect(BETA_FUNNEL_DEDUPE[event]).toBeDefined();
    }
    // The rollout funnel is untouched.
    expect(betaFunnelEventKeys).toContain('signup_completed');
    expect(betaFunnelEventKeys).toContain('subscription_viewed');
  });

  it('keeps the database and the module agreeing on the approved list', () => {
    for (const event of betaFunnelEventKeys) {
      // Once in the table constraint, once in the routine's own guard.
      expect(migration.split(`'${event}'`).length - 1).toBeGreaterThanOrEqual(2);
    }
  });

  it('lets a browser report only where somebody went, never that money moved', () => {
    expect(clientRecordableEventKeys).toContain('landing_viewed');
    for (const event of ['payment_succeeded', 'checkout_started', 'trial_started', 'portfolio_created']) {
      expect(clientRecordableEventKeys).not.toContain(event);
    }
  });
});

describe('an event lands once', () => {
  it('collapses a repeated feature view into one row per day per feature', () => {
    const scope = (featureKey: string, localDate: string) => betaFunnelDedupeScope({
      event: 'feature_used', featureKey, localDate,
    });
    expect(scope('portfolio', '2026-08-16')).toBe(scope('portfolio', '2026-08-16'));
    expect(scope('portfolio', '2026-08-16')).not.toBe(scope('watchlist', '2026-08-16'));
    expect(scope('portfolio', '2026-08-16')).not.toBe(scope('portfolio', '2026-08-17'));
  });

  it('records a trial and an onboarding answer once per account, forever', () => {
    expect(BETA_FUNNEL_DEDUPE.trial_started).toBe('account');
    expect(BETA_FUNNEL_DEDUPE.onboarding_path_chosen).toBe('account');
    expect(betaFunnelDedupeScope({ event: 'trial_started', localDate: '2026-08-16' }))
      .toBe(betaFunnelDedupeScope({ event: 'trial_started', localDate: '2026-12-25' }));
  });

  it('separates one anonymous landing visit from another', () => {
    const first = betaFunnelDedupeScope({ event: 'landing_viewed', localDate: '2026-08-16', anonymousRef: 'aaa1' });
    const second = betaFunnelDedupeScope({ event: 'landing_viewed', localDate: '2026-08-16', anonymousRef: 'bbb2' });
    expect(first).not.toBe(second);
  });
});

describe('what a product event may never carry', () => {
  it('strips anything that is not a plain configuration segment', () => {
    const normalized = normalizeBetaFunnelEvent({
      event: 'feature_used',
      featureKey: 'portfolio <script>alert(1)</script> reader@example.com',
      localDate: '2026-08-16',
    });
    expect(normalized?.featureKey).not.toContain('@');
    expect(normalized?.featureKey).not.toContain('<');
    expect(normalized?.featureKey).not.toContain(' ');
  });

  it('never records which stock a reader opened', () => {
    expect(BETA_FUNNEL_DEDUPE.stock_detail_viewed).toBe('account_day');
    const page = read('app/stock/[symbol]/page.tsx');
    expect(page).toContain("event: 'stock_detail_viewed'");
    expect(page).not.toMatch(/stock_detail_viewed'[^}]*(symbol|canonicalSymbol)/);
  });

  it('never records a portfolio value, a name or a holding', () => {
    const actions = read('app/portfolio/portfolio-actions.ts');
    expect(actions).toContain("event: 'portfolio_created'");
    expect(actions).not.toMatch(/portfolio_created'[^}]*(input\.data\.name|totalValue|amount)/);
  });

  it('adds no analytics dependency and no third-party collector', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const installed = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
    for (const banned of ['posthog', 'mixpanel', 'amplitude', 'segment', 'ga-', 'gtag']) {
      expect(installed.some((name) => name.includes(banned))).toBe(false);
    }
  });
});

describe('the product events are actually emitted', () => {
  it('records each one from the place that already knows the fact', () => {
    expect(read('app/settings/subscription/actions.ts')).toContain("event: 'trial_started'");
    expect(read('app/portfolio/page.tsx')).toContain("featureKey: 'portfolio'");
    expect(read('app/watchlist/page.tsx')).toContain("featureKey: 'watchlist'");
    expect(read('app/tools/what-if/page.tsx')).toContain("featureKey: 'what-if'");
    expect(read('app/tools/monte-carlo/page.tsx')).toContain("featureKey: 'monte-carlo'");
    expect(read('app/tools/stock-planner/page.tsx')).toContain("featureKey: 'stock-planner'");
    expect(read('src/components/analytics/LandingFunnel.tsx')).toContain("'landing_viewed'");
  });

  it('emits from an effect that cannot fire twice, and stores no durable visitor id', () => {
    const landing = read('src/components/analytics/LandingFunnel.tsx');
    expect(landing).toContain('if (sent.current) return;');
    expect(landing).toContain('sessionStorage');
    expect(landing).not.toContain('localStorage');
  });

  /*
    Two shapes are acceptable, and nothing else: a fire-and-forget promise with a
    handler attached, or the safe wrapper — which also swallows a SYNCHRONOUS
    fault, and is what the paths inside a try/catch use, so recording an event
    can never be why a reader is told their action failed.
  */
  it('never lets telemetry fail the request it rode in on', () => {
    for (const file of [
      'app/stock/[symbol]/page.tsx',
      'app/portfolio/page.tsx',
      'app/watchlist/page.tsx',
      'app/tools/what-if/page.tsx',
      'app/tools/monte-carlo/page.tsx',
      'app/portfolio/portfolio-actions.ts',
      'app/settings/subscription/actions.ts',
      'app/onboarding/actions.ts',
    ]) {
      const source = read(file);
      const calls = [...source.matchAll(/recordBetaFunnelEvent(Safely)?\(\{[^)]*\)/g)];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) {
        const safe = call[1] === 'Safely';
        const tail = source.slice(call.index!, call.index! + call[0].length + 30);
        expect(safe || tail.includes('.catch('), `${file}: ${call[0].slice(0, 60)}`).toBe(true);
      }
    }
    // The wrapper's own promise handler, asserted where it actually lives.
    expect(read('src/lib/beta/beta-server.ts')).toContain('void recordBetaFunnelEvent(input).catch(() => {});');
  });
});
