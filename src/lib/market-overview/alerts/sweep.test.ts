import { describe, expect, it } from 'vitest';
import {
  OV_ALERT_COOLDOWN_HOURS,
  ovAlertCooledDown,
  ovAlertKindsWithoutCooldown,
} from './cooldown';
import { evaluateOvAlerts, ovAlertMatches, type OvAlertQuote } from './evaluate';
import { runOvAlertSweep, type OvAlertQuoteLoader } from './run';
import {
  createOvAlertRule,
  deleteOvAlertRule,
  loadEnabledOvAlertRules,
  loadOvAlertRules,
  updateOvAlertRule,
  type OvAlertHitRecord,
  type OvAlertRuleDraft,
  type OvAlertRulePatch,
  type OvAlertStore,
} from './repository';
import { OV_ALERT_KINDS, type OvAlertKind, type OvAlertRule } from './types';

/**
 * The three claims this file exists for:
 *
 *   1. A rule inside its cooldown does not fire again, however often the sweep
 *      runs. Without it a rule that matches for a week writes a row every
 *      fifteen minutes.
 *   2. A disabled rule never fires, at any layer.
 *   3. The cooldown is measured in elapsed time and is therefore immune to the
 *      DST arithmetic that has already caught this product once.
 */

const HOUR = 60 * 60 * 1_000;

function rule(over: Partial<OvAlertRule> = {}): OvAlertRule {
  return {
    id: 'rule-1',
    userId: null,
    symbol: 'NVDA',
    kind: 'price_above',
    threshold: 150,
    enabled: true,
    lastFiredAt: null,
    ...over,
  };
}

function quotes(quote: Partial<OvAlertQuote> = {}): Map<string, OvAlertQuote> {
  return new Map([['NVDA', { price: 160, changePercent: 2, ...quote }]]);
}

/** The sweep takes a loader now. Every case that does not care about it uses this. */
function loaderFor(map: ReadonlyMap<string, OvAlertQuote>): OvAlertQuoteLoader {
  return async () => map;
}

/** A store with a Map behind it. Nothing is faked away — every method is one call. */
function fakeStore(rules: OvAlertRule[], options: { failWrites?: boolean } = {}) {
  const rows = new Map(rules.map((item) => [item.id, { ...item }]));
  const written: OvAlertHitRecord[] = [];
  let sequence = 0;
  const store: OvAlertStore = {
    listRules: async () => [...rows.values()].map((item) => ({
      id: item.id,
      user_id: item.userId,
      symbol: item.symbol,
      kind: item.kind,
      /* Postgres numeric arrives as a string. The parser has to survive that. */
      threshold: String(item.threshold),
      enabled: item.enabled,
      last_fired_at: item.lastFiredAt,
    })),
    createRule: async (draft: OvAlertRuleDraft) => {
      const id = `rule-${++sequence + rules.length}`;
      const created: OvAlertRule = {
        id,
        userId: null,
        symbol: draft.symbol,
        kind: draft.kind,
        threshold: draft.threshold,
        enabled: draft.enabled ?? true,
        lastFiredAt: null,
      };
      for (const existing of rows.values()) {
        if (existing.symbol === created.symbol && existing.kind === created.kind) {
          throw Object.assign(new Error('duplicate'), { code: '23505' });
        }
      }
      rows.set(id, created);
      return { ...created, threshold: String(created.threshold), last_fired_at: null };
    },
    updateRule: async (id: string, patch: OvAlertRulePatch) => {
      const existing = rows.get(id);
      if (!existing) return null;
      const next = {
        ...existing,
        threshold: patch.threshold ?? existing.threshold,
        enabled: patch.enabled ?? existing.enabled,
      };
      rows.set(id, next);
      return { ...next, threshold: String(next.threshold), last_fired_at: next.lastFiredAt };
    },
    deleteRule: async (id: string) => { rows.delete(id); },
    recordHit: async (record: OvAlertHitRecord) => {
      if (options.failWrites) throw new Error('write failed');
      written.push(record);
      /*
        The stamp and the row are written together, which is the whole point of
        the RPC. The double models that: a test that stamped separately would be
        testing a system this one does not have.
      */
      const target = rows.get(record.ruleId);
      if (target) rows.set(record.ruleId, { ...target, lastFiredAt: record.observedAt });
      return `hit-${written.length}`;
    },
  };
  return { store, rows, written };
}

describe('the cooldown table', () => {
  it('gives every kind a duration', () => {
    // A kind added without one would silently fire on every sweep.
    expect(ovAlertKindsWithoutCooldown()).toEqual([]);
    expect(Object.keys(OV_ALERT_COOLDOWN_HOURS).sort()).toEqual([...OV_ALERT_KINDS].sort());
  });

  it('keeps earnings quiet for a day and the rest for four hours', () => {
    expect(OV_ALERT_COOLDOWN_HOURS.earnings).toBe(24);
    for (const kind of ['price_above', 'price_below', 'percent_up', 'percent_down'] as const) {
      expect(OV_ALERT_COOLDOWN_HOURS[kind], kind).toBe(4);
    }
  });

  it('lets a rule that has never fired fire', () => {
    expect(ovAlertCooledDown(rule({ lastFiredAt: null }), '2026-09-11T00:00:00.000Z')).toBe(true);
  });

  it('walks the boundary by the named duration, not by a literal', () => {
    const firedAt = Date.parse('2026-09-11T00:00:00.000Z');
    const cooldown = OV_ALERT_COOLDOWN_HOURS.price_above * HOUR;
    const subject = rule({ lastFiredAt: new Date(firedAt).toISOString() });

    expect(ovAlertCooledDown(subject, new Date(firedAt + cooldown - 1))).toBe(false);
    expect(ovAlertCooledDown(subject, new Date(firedAt + cooldown))).toBe(true);
  });

  it('holds an earnings rule for six times as long', () => {
    const firedAt = Date.parse('2026-09-11T00:00:00.000Z');
    const subject = rule({ kind: 'earnings', lastFiredAt: new Date(firedAt).toISOString() });
    expect(ovAlertCooledDown(subject, new Date(firedAt + 23 * HOUR))).toBe(false);
    expect(ovAlertCooledDown(subject, new Date(firedAt + 24 * HOUR))).toBe(true);
  });

  it('treats an unreadable stamp as still cooling, never as never fired', () => {
    /*
      The two failure directions are not symmetric. Reading a corrupt timestamp
      as "go ahead" turns one bad row into a hit on every sweep forever; reading
      it as "wait" costs one rule its alerts until somebody looks.
    */
    expect(ovAlertCooledDown(rule({ lastFiredAt: 'not a date' }), new Date())).toBe(false);
  });
});

describe('the cooldown across a DST transition', () => {
  /*
   * US clocks moved forward at 2026-03-08 07:00 UTC and back at
   * 2026-11-01 06:00 UTC. The sweep never reads a wall clock — the cooldown is
   * elapsed milliseconds between two UTC instants — so a transition inside the
   * window must not lengthen or shorten it.
   *
   * This is the arithmetic the product has already got wrong once, in the
   * snapshot cron: 16:10 ET is 20:10 UTC in summer and 21:10 UTC in winter, and
   * a schedule written for one is broken for four months of the other. Anything
   * that compares two instants is immune, and this proves the cooldown is one of
   * those things.
   */
  const forward = { fired: '2026-03-08T05:00:00.000Z', label: 'spring forward' };
  const back = { fired: '2026-11-01T04:00:00.000Z', label: 'fall back' };

  for (const { fired, label } of [forward, back]) {
    it(`measures four real hours across ${label}`, () => {
      const firedAt = Date.parse(fired);
      const subject = rule({ lastFiredAt: fired });
      // The transition falls inside this window in both directions.
      expect(ovAlertCooledDown(subject, new Date(firedAt + 3 * HOUR + 59 * 60_000))).toBe(false);
      expect(ovAlertCooledDown(subject, new Date(firedAt + 4 * HOUR))).toBe(true);
    });
  }

  it('does not shift when the same instant is given as a string', () => {
    // A caller handing an ISO string and one handing a Date must agree, or the
    // cooldown would depend on the caller rather than on the clock.
    const subject = rule({ lastFiredAt: '2026-03-08T05:00:00.000Z' });
    const at = '2026-03-08T09:00:00.000Z';
    expect(ovAlertCooledDown(subject, at)).toBe(ovAlertCooledDown(subject, new Date(at)));
  });
});

describe('evaluateOvAlerts', () => {
  it('does not fire a rule that is switched off', () => {
    const hits = evaluateOvAlerts([rule({ enabled: false })], quotes(), '2026-09-11T00:00:00.000Z');
    expect(hits).toEqual([]);
  });

  it('does not fire a rule inside its cooldown, even when it matches', () => {
    const firedAt = '2026-09-11T00:00:00.000Z';
    const hits = evaluateOvAlerts(
      [rule({ lastFiredAt: firedAt })],
      quotes(),
      new Date(Date.parse(firedAt) + HOUR),
    );
    expect(hits).toEqual([]);
  });

  it('fires again once the cooldown has passed', () => {
    const firedAt = '2026-09-11T00:00:00.000Z';
    const hits = evaluateOvAlerts(
      [rule({ lastFiredAt: firedAt })],
      quotes(),
      new Date(Date.parse(firedAt) + 4 * HOUR),
    );
    expect(hits).toHaveLength(1);
  });

  it('leaves notificationId null, because nothing has been written', () => {
    const hits = evaluateOvAlerts([rule()], quotes(), '2026-09-11T00:00:00.000Z');
    expect(hits[0]!.notificationId).toBeNull();
  });

  it('matches an earnings rule on days, and stays silent without a date', () => {
    const earnings = rule({ kind: 'earnings', threshold: 7 });
    expect(ovAlertMatches(earnings, { price: 160, changePercent: 1, earningsDays: 5 })).toBe(true);
    expect(ovAlertMatches(earnings, { price: 160, changePercent: 1, earningsDays: 7 })).toBe(true);
    expect(ovAlertMatches(earnings, { price: 160, changePercent: 1, earningsDays: 8 })).toBe(false);
    // No date is silence, not "far away".
    expect(ovAlertMatches(earnings, { price: 160, changePercent: 1, earningsDays: null })).toBe(false);
    expect(ovAlertMatches(earnings, { price: 160, changePercent: 1 })).toBe(false);
  });

  it('carries the earnings day count only on an earnings hit', () => {
    const at = '2026-09-11T00:00:00.000Z';
    const [earningsHit] = evaluateOvAlerts(
      [rule({ kind: 'earnings', threshold: 7 })],
      new Map([['NVDA', { price: 160, changePercent: 1, earningsDays: 5 }]]),
      at,
    );
    const [priceHit] = evaluateOvAlerts(
      [rule()],
      new Map([['NVDA', { price: 160, changePercent: 1, earningsDays: 5 }]]),
      at,
    );
    expect(earningsHit!.observedEarningsDays).toBe(5);
    expect(priceHit!.observedEarningsDays).toBeNull();
  });
});

describe('runOvAlertSweep', () => {
  const now = '2026-09-11T00:00:00.000Z';

  it('writes a hit, stamps the rule, and returns the row id', () => {
    const { store, rows, written } = fakeStore([rule()]);
    return runOvAlertSweep({ store, loadQuotes: loaderFor(quotes()), now }).then((summary) => {
      expect(summary).toMatchObject({ owners: 1, evaluated: 1, recorded: 1, failed: 0 });
      expect(summary.hits[0]!.notificationId).toBe('hit-1');
      expect(written).toHaveLength(1);
      expect(rows.get('rule-1')!.lastFiredAt).toBe(now);
    });
  });

  it('does not fire the same rule twice on two sweeps inside the cooldown', async () => {
    /*
      The requirement, end to end: the sweep runs every fifteen minutes, and a
      rule that stays true must produce ONE row, not one per run.
    */
    const { store, written } = fakeStore([rule()]);
    await runOvAlertSweep({ store, loadQuotes: loaderFor(quotes()), now });
    const second = await runOvAlertSweep({
      store,
      loadQuotes: loaderFor(quotes()),
      now: new Date(Date.parse(now) + 15 * 60_000),
    });
    expect(second.recorded).toBe(0);
    expect(written).toHaveLength(1);
  });

  it('fires again on the sweep after the cooldown expires', async () => {
    const { store, written } = fakeStore([rule()]);
    await runOvAlertSweep({ store, loadQuotes: loaderFor(quotes()), now });
    await runOvAlertSweep({
      store,
      loadQuotes: loaderFor(quotes()),
      now: new Date(Date.parse(now) + 4 * HOUR),
    });
    expect(written).toHaveLength(2);
  });

  it('never looks at a disabled rule', async () => {
    const { store, written } = fakeStore([rule({ enabled: false })]);
    const summary = await runOvAlertSweep({ store, loadQuotes: loaderFor(quotes()), now });
    expect(summary.evaluated).toBe(0);
    expect(written).toEqual([]);
  });

  it('counts a failed write as failed and never as delivered', async () => {
    /*
      The asymmetry that matters: a hit that was not written must not be
      reported as though it was, or a caller would believe a reader had been
      told something they were not.
    */
    const { store } = fakeStore([rule()], { failWrites: true });
    const summary = await runOvAlertSweep({ store, loadQuotes: loaderFor(quotes()), now });
    expect(summary).toMatchObject({ recorded: 0, failed: 1 });
    expect(summary.hits).toEqual([]);
  });

  it('is silent for a symbol whose price did not load', async () => {
    const { store, written } = fakeStore([rule()]);
    const summary = await runOvAlertSweep({
      store,
      loadQuotes: loaderFor(new Map([['NVDA', { price: null, changePercent: null }]])),
      now,
    });
    expect(summary.recorded).toBe(0);
    expect(written).toEqual([]);
  });
});

describe('the sweep across many owners', () => {
  const now = '2026-09-11T00:00:00.000Z';

  /*
   * The service-role case. A reader-scoped store returns rules with a null
   * `userId` because RLS already answered that question; the service store fills
   * it in. The sweep groups by it either way and has no `if` to get wrong.
   */
  it('sweeps every owner in one pass', async () => {
    const { store, written } = fakeStore([
      rule({ id: 'a', userId: 'user-1', symbol: 'NVDA' }),
      rule({ id: 'b', userId: 'user-2', symbol: 'NVDA' }),
      rule({ id: 'c', userId: 'user-3', symbol: 'NVDA' }),
    ]);
    const summary = await runOvAlertSweep({ store, loadQuotes: loaderFor(quotes()), now });
    expect(summary.owners).toBe(3);
    expect(summary.recorded).toBe(3);
    expect(written.map((item) => item.ruleId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('loads the readings once for a symbol many owners watch', async () => {
    /*
      Two readers watching NVDA is one quote. The alternative makes the provider
      bill scale with how many people happen to watch the same stock.
    */
    const { store } = fakeStore([
      rule({ id: 'a', userId: 'user-1' }),
      rule({ id: 'b', userId: 'user-2' }),
    ]);
    const seen: string[][] = [];
    await runOvAlertSweep({
      store,
      now,
      loadQuotes: async (rules) => {
        seen.push(rules.map((item) => item.symbol));
        return quotes();
      },
    });
    expect(seen).toHaveLength(1);
  });

  it('keeps sweeping when one owner throws', async () => {
    /*
      A cron that gave up on the first bad account would leave every account
      after it unswept — and which ones those are would depend on the order
      Postgres happened to return rows.
    */
    const { store, written } = fakeStore([
      rule({ id: 'a', userId: 'user-1' }),
      rule({ id: 'b', userId: 'user-2' }),
      rule({ id: 'c', userId: 'user-3' }),
    ]);
    const guarded: typeof store = {
      ...store,
      recordHit: async (record) => {
        if (record.ruleId === 'b') throw new Error('user-2 is broken');
        return store.recordHit(record);
      },
    };
    const summary = await runOvAlertSweep({ store: guarded, loadQuotes: loaderFor(quotes()), now });
    expect(summary.recorded).toBe(2);
    expect(summary.errors).toEqual([{ userId: 'user-2', message: 'user-2 is broken' }]);
    expect(written.map((item) => item.ruleId).sort()).toEqual(['a', 'c']);
  });

  it('holds the cooldown per rule, not per symbol across owners', async () => {
    /*
      Two owners, same symbol, one of them already fired. The cooldown is a
      property of the RULE, so the other owner is not silenced by somebody
      else's alert.
    */
    const firedAt = now;
    const { store, written } = fakeStore([
      rule({ id: 'cooled', userId: 'user-1', lastFiredAt: firedAt }),
      rule({ id: 'ready', userId: 'user-2', lastFiredAt: null }),
    ]);
    const summary = await runOvAlertSweep({
      store,
      loadQuotes: loaderFor(quotes()),
      now: new Date(Date.parse(firedAt) + HOUR),
    });
    expect(summary.recorded).toBe(1);
    expect(written.map((item) => item.ruleId)).toEqual(['ready']);
  });

  it('reports a total readings failure once, against no owner', async () => {
    const { store, written } = fakeStore([
      rule({ id: 'a', userId: 'user-1' }),
      rule({ id: 'b', userId: 'user-2' }),
    ]);
    const summary = await runOvAlertSweep({
      store,
      now,
      loadQuotes: async () => { throw new Error('provider down'); },
    });
    expect(summary.errors).toEqual([{ userId: null, message: 'provider down' }]);
    expect(written).toEqual([]);
  });

  it('treats a reader-scoped store as one owner', async () => {
    const { store } = fakeStore([rule({ id: 'a' }), rule({ id: 'b', symbol: 'NVDA', kind: 'price_below', threshold: 500 })]);
    const summary = await runOvAlertSweep({ store, loadQuotes: loaderFor(quotes()), now });
    expect(summary.owners).toBe(1);
  });
});

describe('the rule repository', () => {
  it('lists disabled rules but does not evaluate them', async () => {
    const { store } = fakeStore([rule({ enabled: false })]);
    expect(await loadOvAlertRules(store)).toHaveLength(1);
    expect(await loadEnabledOvAlertRules(store)).toEqual([]);
  });

  it('reads a numeric threshold that arrived as a string', async () => {
    const { store } = fakeStore([rule({ threshold: 150.25 })]);
    expect((await loadOvAlertRules(store))[0]!.threshold).toBe(150.25);
  });

  it('creates a rule and upper-cases the symbol it will be joined on', async () => {
    const { store } = fakeStore([]);
    const created = await createOvAlertRule(store, { symbol: ' nvda ', kind: 'price_above', threshold: 150 });
    expect(created.ok).toBe(true);
    expect(created.ok && created.rule.symbol).toBe('NVDA');
  });

  it('refuses a threshold that is not positive, whatever the kind', async () => {
    const { store } = fakeStore([]);
    for (const threshold of [0, -5, Number.NaN]) {
      const result = await createOvAlertRule(store, { symbol: 'NVDA', kind: 'percent_down', threshold });
      expect(result, String(threshold)).toEqual({ ok: false, code: 'invalid' });
    }
  });

  it('reports a duplicate as a duplicate rather than swallowing it', async () => {
    const { store } = fakeStore([rule()]);
    const again = await createOvAlertRule(store, { symbol: 'NVDA', kind: 'price_above', threshold: 200 });
    expect(again).toEqual({ ok: false, code: 'duplicate' });
  });

  it('updates a threshold and switches a rule off', async () => {
    const { store } = fakeStore([rule()]);
    expect(await updateOvAlertRule(store, 'rule-1', { threshold: 200 }))
      .toMatchObject({ ok: true, rule: { threshold: 200 } });
    expect(await updateOvAlertRule(store, 'rule-1', { enabled: false }))
      .toMatchObject({ ok: true, rule: { enabled: false } });
  });

  it('refuses an update that changes nothing', async () => {
    const { store } = fakeStore([rule()]);
    expect(await updateOvAlertRule(store, 'rule-1', {})).toEqual({ ok: false, code: 'invalid' });
  });

  it('reports a missing id as not-found rather than as a database failure', async () => {
    const { store } = fakeStore([rule()]);
    expect(await updateOvAlertRule(store, 'nope', { enabled: false }))
      .toEqual({ ok: false, code: 'not-found' });
  });

  it('deletes a rule', async () => {
    const { store, rows } = fakeStore([rule()]);
    expect(await deleteOvAlertRule(store, 'rule-1')).toEqual({ ok: true });
    expect(rows.size).toBe(0);
  });

  it('degrades a failed list to an empty one rather than throwing', async () => {
    const store: OvAlertStore = {
      listRules: async () => { throw new Error('down'); },
      createRule: async () => null,
      updateRule: async () => null,
      deleteRule: async () => {},
      recordHit: async () => null,
    };
    expect(await loadOvAlertRules(store)).toEqual([]);
  });

  it('drops a row whose kind is not one this system knows', async () => {
    const store: OvAlertStore = {
      listRules: async () => [
        { id: 'a', symbol: 'NVDA', kind: 'moon_phase', threshold: '1', enabled: true },
        { id: 'b', symbol: 'NVDA', kind: 'price_above', threshold: '150', enabled: true },
      ],
      createRule: async () => null,
      updateRule: async () => null,
      deleteRule: async () => {},
      recordHit: async () => null,
    };
    expect((await loadOvAlertRules(store)).map((item) => item.id)).toEqual(['b']);
  });
});

describe('the schedule this sweep rides', () => {
  /*
   * `/api/cron/alerts` runs from Supabase pg_cron every fifteen minutes. A
   * Vercel cron beside it would double-fire the pass, which is the mistake
   * `daily-snapshot-run.test.ts` was written to prevent — this asserts the same
   * property from the side of the feature that depends on it.
   */
  it('is not scheduled a second time in vercel.json', async () => {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(
      readFileSync(new URL('../../../../vercel.json', import.meta.url), 'utf8'),
    ) as { crons?: Array<{ path: string }> };
    expect(config.crons?.map((job) => job.path)).toEqual(['/api/cron/daily-snapshot']);
  });

  it('has its UTC-to-ET arithmetic written down where an operator will look', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(
      new URL('../../../../docs/operations/alert-sweep-schedule.md', import.meta.url),
      'utf8',
    );
    // The specific trap: 16:10 ET is not 20:10 UTC all year.
    expect(doc).toContain('20:10');
    expect(doc).toContain('21:10');
    expect(doc).toContain('EST');
    expect(doc).toContain('EDT');
  });
});

/** A kind added to the union must be handled everywhere before this passes. */
describe('the five kinds stay in step', () => {
  it('has a word, a unit and a cooldown for each', async () => {
    const { OV_ALERT_UNIT, OV_ALERT_WORD } = await import('./types');
    for (const kind of OV_ALERT_KINDS as readonly OvAlertKind[]) {
      expect(OV_ALERT_UNIT[kind], `${kind} unit`).toBeDefined();
      expect(OV_ALERT_WORD[kind], `${kind} word`).toBeTruthy();
      expect(OV_ALERT_COOLDOWN_HOURS[kind], `${kind} cooldown`).toBeGreaterThan(0);
    }
  });
});
