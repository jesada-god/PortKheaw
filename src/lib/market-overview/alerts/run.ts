/**
 * THE SWEEP — evaluate, write, report. One pass over every owner.
 *
 * ===========================================================================
 * WHERE THE SCHEDULE COMES FROM, AND WHY IT IS NOT IN vercel.json
 * ===========================================================================
 * `/api/cron/alerts` is ALREADY scheduled, from Supabase pg_cron: the job
 * `portkheaw-background-notifications` in
 * `202608020003_supabase_notification_cron.sql` calls it every fifteen minutes.
 * `vercel.json` deliberately does not list it, and
 * `src/lib/market-data/daily-snapshot-run.test.ts` pins that — two schedulers on
 * one endpoint double-fire the pass, each invisible from the other's dashboard.
 *
 * See `docs/operations/alert-sweep-schedule.md` for the UTC-versus-ET arithmetic
 * and why a fifteen-minute cadence is immune to the DST mistake a daily one is
 * not.
 *
 * ===========================================================================
 * ONE CODE PATH FOR ONE OWNER AND FOR ALL OF THEM
 * ===========================================================================
 * There is NO `if (serviceRole)` in this file, and there must not be. The
 * difference between a reader sweeping their own rules and a cron sweeping
 * everybody's lives entirely in which {@link OvAlertStore} is passed in: a
 * reader-scoped store returns rules whose `userId` is null because RLS already
 * answered that question, and the service store returns every account's rules
 * with the id filled in.
 *
 * So this groups by owner unconditionally. A reader-scoped sweep is the case
 * where every rule falls into the single `null` group — not a special case, just
 * a group count of one.
 *
 * ===========================================================================
 * ONE OWNER'S FAILURE IS NOT THE SWEEP'S
 * ===========================================================================
 * Every owner is swept inside its own `try`, and a thrown error is recorded
 * against that owner and nothing else. A cron that gave up on the first bad
 * account would leave every account after it in the list unswept — and which
 * accounts those are would depend on the order Postgres happened to return
 * rows, so the same bug would silence a different set of people every run.
 *
 * A failed WRITE is counted the same way and never reported as delivered:
 * `notificationId` stays null on those, and they do not appear in `hits`.
 */

import 'server-only';

import { evaluateOvAlerts, type OvAlertQuote } from './evaluate';
import {
  loadEnabledOvAlertRules,
  parseWrittenId,
  type OvAlertStore,
} from './repository';
import type { OvAlertHit, OvAlertRule } from './types';

/**
 * How the sweep gets its readings.
 *
 * A LOADER, not a map. The sweep is what discovers what is in play — it comes
 * out of the rules it just read — so a caller that had to supply a map up front
 * would have to read the rules first, and they would be read twice.
 *
 * It takes the RULES rather than a symbol list because which readings are needed
 * is a property of the rules, not of the symbols: only an `earnings` rule needs
 * a calendar lookup, and a loader given bare symbols would have to fetch one for
 * every watched stock to find out. Called once per sweep, keyed by upper-case
 * symbol on the way back.
 */
export type OvAlertQuoteLoader = (
  rules: readonly OvAlertRule[],
) => Promise<ReadonlyMap<string, OvAlertQuote>>;

export interface OvAlertSweepInput {
  store: OvAlertStore;
  loadQuotes: OvAlertQuoteLoader;
  now?: Date | string;
}

/** What went wrong, and for whom. One entry per owner, never per rule. */
export interface OvAlertSweepFailure {
  /** Null for a reader-scoped sweep, where there is only one owner to name. */
  userId: string | null;
  message: string;
}

export interface OvAlertSweepSummary {
  /** Distinct owners with at least one enabled rule. */
  owners: number;
  /** Enabled rules the sweep looked at, across every owner. */
  evaluated: number;
  /** Hits that matched, were out of cooldown, and were written. */
  recorded: number;
  /** Hits that matched but could not be written. Never reported as delivered. */
  failed: number;
  /** The written hits, each carrying the row id it was written as. */
  hits: OvAlertHit[];
  /** Owners whose sweep threw. The rest of the run continued. */
  errors: OvAlertSweepFailure[];
}

/** Rules grouped by owner, preserving the order the store returned them in. */
function byOwner(rules: readonly OvAlertRule[]): Map<string | null, OvAlertRule[]> {
  const groups = new Map<string | null, OvAlertRule[]>();
  for (const rule of rules) {
    const key = rule.userId ?? null;
    const existing = groups.get(key);
    if (existing) existing.push(rule);
    else groups.set(key, [rule]);
  }
  return groups;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * One pass.
 *
 * Quotes are loaded ONCE for every symbol any owner is watching, not once per
 * owner. Two readers with a rule on NVDA are one quote, and the alternative
 * would make the provider bill scale with how many people happen to watch the
 * same stock.
 *
 * Writes are SEQUENTIAL within an owner. Each one stamps `last_fired_at` on a
 * rule under an advisory lock, and parallelising a handful of rows to save
 * milliseconds would only make the lock contend with itself.
 */
export async function runOvAlertSweep({
  store,
  loadQuotes,
  now = new Date(),
}: OvAlertSweepInput): Promise<OvAlertSweepSummary> {
  const rules = await loadEnabledOvAlertRules(store);
  const groups = byOwner(rules);

  const summary: OvAlertSweepSummary = {
    owners: groups.size,
    evaluated: rules.length,
    recorded: 0,
    failed: 0,
    hits: [],
    errors: [],
  };
  if (rules.length === 0) return summary;

  let quotes: ReadonlyMap<string, OvAlertQuote>;
  try {
    quotes = await loadQuotes(rules);
  } catch (cause) {
    /*
      No readings at all is not one owner's problem — it is every owner's, and
      reporting it once against no owner is more honest than repeating the same
      message N times.
    */
    summary.errors.push({ userId: null, message: messageOf(cause) });
    return summary;
  }

  /*
    One entry per owner per distinct message, not one per failed write. An
    account whose every rule fails for the same reason is one problem reported
    once — `failed` is what carries how many rules it cost.
  */
  const reported = new Set<string>();
  const report = (userId: string | null, cause: unknown) => {
    const message = messageOf(cause);
    const key = `${userId ?? ''}|${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    summary.errors.push({ userId, message });
  };

  for (const [userId, owned] of groups) {
    try {
      for (const hit of evaluateOvAlerts(owned, quotes, now)) {
        /*
          Caught per WRITE as well as per owner. One rule whose row could not be
          written must not cost that owner their other rules — the two nested
          catches are the difference between losing one alert and losing an
          account's whole sweep.
        */
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
              The call returned without an id: the rule was disabled or deleted
              between the read and the write, or the observation was a duplicate
              the unique index refused. Either way there is no row to name, and
              claiming delivery on a write we cannot name is the one outcome
              worth refusing outright. Not an error — nothing went wrong.
            */
            summary.failed += 1;
            continue;
          }
          summary.hits.push({ ...hit, notificationId: written });
          summary.recorded += 1;
        } catch (cause) {
          summary.failed += 1;
          report(userId, cause);
        }
      }
    } catch (cause) {
      /*
        Reached when something outside the write fails — evaluating this owner's
        rules, say. The remaining owners still run.
      */
      report(userId, cause);
    }
  }

  return summary;
}
