/**
 * THE SWEEP — evaluate, write, report.
 *
 * ===========================================================================
 * WHERE THE SCHEDULE COMES FROM, AND WHY IT IS NOT IN vercel.json
 * ===========================================================================
 * `/api/cron/alerts` is ALREADY scheduled, from Supabase pg_cron: the job
 * `portkheaw-background-notifications` in
 * `202608020003_supabase_notification_cron.sql` calls it every fifteen minutes.
 * `vercel.json` deliberately does not list it, and
 * `src/lib/market-data/daily-snapshot-run.test.ts` pins that — two schedulers on
 * one endpoint double-fire the pass, each invisible from the other's dashboard,
 * and the obvious way to "restore" `vercel.json` is to put back what was
 * removed.
 *
 * So this sweep inherits that schedule rather than asking for a second one. See
 * `docs/operations/alert-sweep-schedule.md` for the UTC-versus-ET arithmetic and
 * why a fifteen-minute cadence is immune to the DST mistake a daily one is not.
 *
 * ===========================================================================
 * A FAILED WRITE IS NOT A FAILED SWEEP
 * ===========================================================================
 * One rule's hit failing to persist must not stop the next rule's from being
 * tried. Every write is caught individually and counted, and the run reports
 * what it managed rather than throwing — the caller is a cron endpoint, and an
 * exception there is a run that looks entirely broken because one row did.
 *
 * The reverse is also true and matters more: a hit that was NOT written must not
 * be reported as though it was. `notificationId` stays null on those, and
 * {@link OvAlertSweepSummary.failed} counts them.
 */

import 'server-only';

import { evaluateOvAlerts, type OvAlertQuote } from './evaluate';
import {
  loadEnabledOvAlertRules,
  parseWrittenId,
  type OvAlertStore,
} from './repository';
import type { OvAlertHit } from './types';

export interface OvAlertSweepInput {
  store: OvAlertStore;
  /** Readings, keyed by upper-case symbol. The caller owns where they came from. */
  quotes: ReadonlyMap<string, OvAlertQuote>;
  now?: Date | string;
}

export interface OvAlertSweepSummary {
  /** Enabled rules the sweep looked at. */
  evaluated: number;
  /** Hits that matched, were out of cooldown, and were written. */
  recorded: number;
  /** Hits that matched but could not be written. Never reported as delivered. */
  failed: number;
  /** The written hits, each carrying the row id it was written as. */
  hits: OvAlertHit[];
}

/**
 * One pass over one reader's rules.
 *
 * The store is scoped to a reader by RLS, so there is no user id here and no way
 * to sweep somebody else's rules by passing the wrong one.
 *
 * Writes are SEQUENTIAL rather than parallel. Each one stamps `last_fired_at` on
 * a rule, and two rules of the same reader firing at once is not a race worth
 * saving milliseconds on when the whole set is at most fifty rows.
 */
export async function runOvAlertSweep({
  store,
  quotes,
  now = new Date(),
}: OvAlertSweepInput): Promise<OvAlertSweepSummary> {
  const rules = await loadEnabledOvAlertRules(store);
  const candidates = evaluateOvAlerts(rules, quotes, now);

  const hits: OvAlertHit[] = [];
  let failed = 0;

  for (const hit of candidates) {
    try {
      const written = parseWrittenId(await store.recordHit({
        ruleId: hit.ruleId,
        symbol: hit.symbol,
        kind: hit.kind,
        observedPrice: hit.observedPrice,
        observedChangePercent: hit.observedChangePercent,
        observedEarningsDays: hit.observedEarningsDays,
        observedAt: hit.observedAt,
        valueText: hit.valueText,
      }));
      if (written === null) {
        /*
          The call returned without an id. That is not a hit — the row may or
          may not exist and the stamp may or may not have been written, and
          claiming delivery on a write we cannot name is the one outcome worth
          refusing outright.
        */
        failed += 1;
        continue;
      }
      hits.push({ ...hit, notificationId: written });
    } catch {
      failed += 1;
    }
  }

  return { evaluated: rules.length, recorded: hits.length, failed, hits };
}
