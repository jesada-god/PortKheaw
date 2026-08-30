/**
 * READING THE RULES, BEFORE THE TABLE EXISTS.
 *
 * ===========================================================================
 * WHY THIS TAKES A FETCHER AND NOT A SUPABASE CLIENT
 * ===========================================================================
 * `supabase/migrations/202608300001_overview_alerts.sql` is written and NOT
 * APPLIED — five migrations ahead of it are in the same state, and applying one
 * out of order is not this task's to do. Until it runs, `overview_alert_rules`
 * is not in `src/types/database.ts`, so `client.from('overview_alert_rules')`
 * does not typecheck against `SupabaseClient<Database>`.
 *
 * There are two ways past that and only one of them is honest. Casting the
 * client through `unknown` compiles today and keeps compiling forever, silently
 * outliving the reason it was added. Taking the query as a parameter does not:
 * the call site supplies it in one line once the generated types know the
 * table, and nothing here has to be unpicked.
 *
 * So this module owns the SHAPE — the table name, the columns, the validation,
 * the normalization — and the caller owns the round trip. That split is also
 * what makes it testable without a database.
 *
 * ===========================================================================
 * A BAD ROW IS DROPPED, NOT REPAIRED
 * ===========================================================================
 * Every row is validated. One that fails is skipped rather than coerced: a rule
 * with a negative threshold or an unrecognised kind is a rule nobody can
 * predict the behaviour of, and evaluating a repaired version of it would fire
 * an alert the reader never wrote. The rest of the reader's rules still work,
 * which is the same degradation every loader on the overview performs.
 */

import { z } from 'zod';
import { OV_ALERT_KINDS, type OvAlertRule } from './types';

/** The table `202608300001_overview_alerts.sql` creates. */
export const OV_ALERT_RULES_TABLE = 'overview_alert_rules';

/**
 * Exactly the columns this module reads, as a Supabase `select` string.
 *
 * Named rather than `*` so a column added later is not silently pulled into
 * every page render, and so the migration and the reader can be diffed against
 * each other by eye.
 */
export const OV_ALERT_RULES_COLUMNS = 'id, symbol, kind, threshold, enabled';

const rowSchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1).max(20),
  kind: z.enum(OV_ALERT_KINDS as unknown as [string, ...string[]]),
  /*
    Postgres `numeric` arrives over PostgREST as a STRING, not a number — the
    driver refuses to silently lose precision, and a schema expecting a number
    would reject every row on a table that is working perfectly. Coerced here,
    then required to be finite and positive, which is the rule the column's own
    check constraint already enforces at the other end.
  */
  threshold: z.coerce.number().finite().positive(),
  enabled: z.boolean(),
});

const rowsSchema = z.array(z.unknown());

/**
 * Rows into rules.
 *
 * `symbol` is upper-cased here rather than trusted, because it is the join key
 * against the page's quote map and one lower-case row would simply never match
 * — a rule that silently never fires is worse than one that errors.
 */
export function parseOvAlertRules(rows: unknown): OvAlertRule[] {
  const list = rowsSchema.safeParse(rows);
  if (!list.success) return [];
  return list.data.flatMap((row) => {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) return [];
    return [{
      id: parsed.data.id,
      symbol: parsed.data.symbol.trim().toUpperCase(),
      kind: parsed.data.kind as OvAlertRule['kind'],
      threshold: parsed.data.threshold,
      enabled: parsed.data.enabled,
    }];
  });
}

/**
 * What the call site supplies: one query, already scoped to the signed-in
 * reader by RLS.
 *
 * It returns `unknown` on purpose. The point of the split is that this module
 * never sees a driver type, so the day the generated types learn the table, the
 * caller changes and nothing here does.
 */
export type OvAlertRuleFetcher = () => Promise<unknown>;

/**
 * The reader's enabled rules, or none.
 *
 * A failed query is an empty list, not a thrown page. An alert section that
 * cannot load is a section that shows nothing; taking down the overview because
 * one optional block could not be read is the trade the whole page is built to
 * avoid.
 */
export async function loadOvAlertRules(fetcher: OvAlertRuleFetcher): Promise<OvAlertRule[]> {
  try {
    return parseOvAlertRules(await fetcher()).filter((rule) => rule.enabled);
  } catch {
    return [];
  }
}
