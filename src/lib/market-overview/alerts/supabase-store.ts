import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { parseOvAlertRules, type OvAlertStore } from './repository';
import type { OvAlertRule } from './types';

/**
 * THE SUPABASE ADAPTER FOR A TABLE THE GENERATED TYPES DO NOT KNOW YET.
 *
 * ===========================================================================
 * WHY THERE IS A CAST HERE AT ALL
 * ===========================================================================
 * `overview_alert_rules` is created by `202608300001_overview_alerts.sql`, which
 * has not been applied — it sits behind five older migrations in the same state.
 * Until it runs, the table is not in `src/types/database.ts` and
 * `client.from('overview_alert_rules')` is a compile error against
 * `SupabaseClient<Database>`.
 *
 * `repository.ts` avoided the problem by taking a port. This file is the other
 * half: something has to actually talk to Postgres, and it cannot do that
 * through types that have never heard of the table.
 *
 * ===========================================================================
 * WHY THE CAST CANNOT OUTLIVE ITS REASON
 * ===========================================================================
 * The objection to `as unknown as` — recorded in `docs/PHASE2_CONTRACT.md` §5.5
 * — is that it compiles today and keeps compiling forever, silently surviving
 * the thing it was working around. {@link OV_ALERT_TABLES_ARE_UNTYPED} removes
 * that property: it is a type-level assertion that the table is STILL unknown,
 * so the day the migration is applied and the types are regenerated, this file
 * stops compiling and whoever regenerated them is told to delete the cast.
 *
 * A comment saying "remove this later" is a wish. This is a build failure.
 *
 * ===========================================================================
 * A MISSING TABLE IS A NORMAL ANSWER
 * ===========================================================================
 * Every deployment today is in the "table does not exist" state, and the
 * Overview must render identically in both. PostgREST answers an unknown
 * relation with an error rather than an empty result, so
 * {@link loadOvAlertCountsBySymbol} distinguishes three outcomes and the caller
 * can too:
 *
 *   null        — could not read: no table, no permission, no network
 *   {}          — read fine, this reader has no rules
 *   { NVDA: 2 } — read fine, and here they are
 *
 * `null` and `{}` must not be collapsed. A card that draws "0 alerts" because
 * the table is missing is telling a reader something false about their own
 * settings.
 */

/**
 * True while `overview_alert_rules` is absent from the generated types.
 *
 * When the migration is applied and `src/types/database.ts` is regenerated, the
 * conditional below resolves to `never` and this assignment fails to compile.
 * That is the intended signal: delete the `asUntyped` cast, use
 * `client.from('overview_alert_rules')` directly, and delete this constant.
 */
export const OV_ALERT_TABLES_ARE_UNTYPED:
  'overview_alert_rules' extends keyof Database['public']['Tables'] ? never : true = true;

/** The narrow slice of the query builder this adapter uses. Nothing more. */
interface UntypedTable {
  select(columns: string): PromiseLike<{ data: unknown; error: unknown }>;
  insert(values: Record<string, unknown>): {
    select(columns: string): {
      single(): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
  update(values: Record<string, unknown>): {
    eq(column: string, value: string): {
      select(columns: string): {
        maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
  delete(): {
    eq(column: string, value: string): PromiseLike<{ data: unknown; error: unknown }>;
  };
}

/**
 * The one cast, in one place, guarded by the constant above.
 *
 * Widening only the TABLE NAME — the builder shape is still declared, so a typo
 * in a column list or a missing `.eq` is still a compile error. This is not
 * `any` with extra steps.
 */
function asUntyped(client: SupabaseClient<Database>, table: string): UntypedTable {
  void OV_ALERT_TABLES_ARE_UNTYPED;
  return (client as unknown as { from(name: string): UntypedTable }).from(table);
}

const RULES_TABLE = 'overview_alert_rules';
const RULE_COLUMNS = 'id, symbol, kind, threshold, enabled, last_fired_at';

/**
 * The store, over a reader's own session.
 *
 * RLS is what scopes every one of these to one reader — no user id is passed
 * and none may be, because an id that can be passed is an id that can be
 * substituted. Do NOT hand this an admin client: with the service role there is
 * no `auth.uid()`, RLS does not apply, and `listRules` would return every
 * reader's rules to whoever asked.
 */
export function createOvAlertStore(client: SupabaseClient<Database>): OvAlertStore {
  const table = () => asUntyped(client, RULES_TABLE);
  return {
    listRules: async () => {
      const { data, error } = await table().select(RULE_COLUMNS);
      if (error) throw error;
      return data;
    },
    createRule: async (draft) => {
      const { data, error } = await table()
        .insert({
          symbol: draft.symbol,
          kind: draft.kind,
          threshold: draft.threshold,
          enabled: draft.enabled ?? true,
        })
        .select(RULE_COLUMNS)
        .single();
      if (error) throw error;
      return data;
    },
    updateRule: async (id, patch) => {
      const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.threshold !== undefined) values.threshold = patch.threshold;
      if (patch.enabled !== undefined) values.enabled = patch.enabled;
      const { data, error } = await table()
        .update(values)
        .eq('id', id)
        .select(RULE_COLUMNS)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    deleteRule: async (id) => {
      const { error } = await table().delete().eq('id', id);
      if (error) throw error;
    },
    recordHit: async () => {
      /*
        Deliberately not implemented on the reader-scoped store.

        Recording a hit is the SWEEP's job, and a sweep runs from a cron with an
        admin client where `auth.uid()` is null — which is exactly what
        `record_overview_alert_hit` refuses. Wiring it needs a `_service` variant
        of that function, in the shape `trigger_price_alert_service` already
        uses. Throwing here is what stops somebody wiring the sweep to this
        store and discovering the mismatch in production instead of at the call
        site.
      */
      throw new Error('record_overview_alert_hit requires a service-role path; see alerts/run.ts');
    },
  };
}

/**
 * How many enabled rules each symbol has, or `null` when the rules could not be
 * read at all.
 *
 * The three outcomes are described in this file's header and the difference
 * between `null` and `{}` is the whole point: the Watchlist row draws NOTHING
 * for an unreadable count and nothing for a zero, but only one of those two is
 * a statement about the reader's settings.
 *
 * DISABLED RULES ARE NOT COUNTED. A switched-off alert will not fire, and a row
 * that counted it would tell a reader they are being watched when they are not.
 */
export async function loadOvAlertCountsBySymbol(
  client: SupabaseClient<Database>,
): Promise<Record<string, number> | null> {
  try {
    const rows = await createOvAlertStore(client).listRules();
    return ovAlertCountsBySymbol(parseOvAlertRules(rows));
  } catch {
    /*
      Every failure lands here and produces the same answer, on purpose: a
      missing table, a revoked grant and a dropped connection are all "we do not
      know", and a caller that treated one of them as zero would be guessing.
    */
    return null;
  }
}

/** Enabled rules per symbol. Pure, so the counting is testable without a database. */
export function ovAlertCountsBySymbol(rules: readonly OvAlertRule[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const symbol = rule.symbol.trim().toUpperCase();
    if (!symbol) continue;
    counts[symbol] = (counts[symbol] ?? 0) + 1;
  }
  return counts;
}
