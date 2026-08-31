import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import {
  OV_ALERT_CREATE_RULE_RPC,
  OV_ALERT_RULES_TABLE,
  parseOvAlertRules,
  type OvAlertStore,
} from './repository';
import type { OvAlertRule } from './types';

/**
 * THE SUPABASE ADAPTER, OVER A READER'S OWN SESSION.
 *
 * ===========================================================================
 * THE CAST THAT USED TO BE HERE, AND WHAT REMOVED IT
 * ===========================================================================
 * `overview_alert_rules` was created by a migration that had not been applied,
 * so the table was absent from `src/types/database.ts` and
 * `client.from('overview_alert_rules')` did not compile. This file worked around
 * that with `as unknown as`, guarded by a type-level constant
 * (`OV_ALERT_TABLES_ARE_UNTYPED`) asserting the table was STILL unknown — so
 * that regenerating the types would break the build rather than let the
 * workaround outlive its reason.
 *
 * It did exactly that. `202608300001` and `202608310001` are applied, the types
 * carry both tables, the constant resolved to `never`, the build failed, and the
 * cast is gone. What remains is an ordinary typed client: a wrong column name in
 * the select string is a compile error against the real schema now, not against
 * a hand-written interface describing the builder.
 *
 * This paragraph is kept rather than deleted because the mechanism is the point.
 * A comment saying "remove this later" is a wish; a constant that stops
 * compiling is the thing that got it removed.
 *
 * ===========================================================================
 * AN UNREADABLE TABLE IS STILL A NORMAL ANSWER
 * ===========================================================================
 * The table exists now, so "no such relation" is no longer the expected case —
 * but a revoked grant, a dropped connection or a paused project still are, and
 * {@link loadOvAlertCountsBySymbol} keeps distinguishing three outcomes:
 *
 *   null        — could not read: no permission, no network
 *   {}          — read fine, this reader has no rules
 *   { NVDA: 2 } — read fine, and here they are
 *
 * `null` and `{}` must not be collapsed. A card that draws "0 alerts" because
 * the read failed is telling a reader something false about their own settings.
 */

/**
 * Exactly the columns this store reads.
 *
 * Narrower than the sweep's list in `repository.ts` on purpose: RLS scopes every
 * one of these queries to one reader, so `user_id` would be a column whose value
 * is already known and which nothing here consults.
 */
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
  const table = () => client.from(OV_ALERT_RULES_TABLE);
  return {
    listRules: async () => {
      const { data, error } = await table().select(RULE_COLUMNS);
      if (error) throw error;
      return data;
    },
    /*
     * TWO ROUND TRIPS, AND BOTH ARE NECESSARY.
     *
     * This was a direct `insert` and could never have worked: `user_id` is
     * `not null` with no default and no trigger, so every call would have raised
     * 23502. Nothing reached it — there is no CRUD surface yet and the only
     * caller was a test against an in-memory double, which does not enforce
     * `not null`. Regenerating the types is what turned it into a compile error.
     *
     * The fix is not to add `user_id` to the insert. The function is the
     * creation path (see `OV_ALERT_CREATE_RULE_RPC`): it takes the owner from
     * `auth.uid()`, and it holds the fifty-rule cap under an advisory lock.
     * Inserting directly would satisfy the compiler and still walk past the cap.
     *
     * The function returns an id, so the row is read back rather than
     * reconstructed from the draft. That second trip is the point: `numeric`
     * rounds the threshold, the function upper-cases and trims the symbol, and
     * `enabled` comes from the column default. A row assembled here would agree
     * with the database only until one of those three changed.
     */
    createRule: async (draft) => {
      const { data: id, error } = await client.rpc(OV_ALERT_CREATE_RULE_RPC, {
        input_symbol: draft.symbol,
        input_kind: draft.kind,
        input_threshold: draft.threshold,
      });
      if (error) throw error;
      /*
        The function either returns an id or raises. A null with no error is a
        contract this code does not know how to be right about, so it refuses
        rather than reporting a creation it cannot point at a row for.
      */
      if (!id) throw new Error(`${OV_ALERT_CREATE_RULE_RPC} returned no id`);
      const { data, error: readBack } = await table()
        .select(RULE_COLUMNS)
        .eq('id', id)
        .single();
      if (readBack) throw readBack;
      return data;
    },
    updateRule: async (id, patch) => {
      const values: Database['public']['Tables']['overview_alert_rules']['Update'] = {
        updated_at: new Date().toISOString(),
      };
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
        `record_overview_alert_hit` refuses. The service path is
        `createOvAlertServiceStore`, over `record_overview_alert_hit_service`.
        Throwing here is what stops somebody wiring the sweep to this store and
        discovering the mismatch in production instead of at the call site.
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
      revoked grant and a dropped connection are both "we do not know", and a
      caller that treated either as zero would be guessing.
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
