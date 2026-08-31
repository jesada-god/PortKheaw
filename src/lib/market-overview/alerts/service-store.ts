import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import {
  OV_ALERT_RECORD_HIT_SERVICE_RPC,
  OV_ALERT_RULES_COLUMNS,
  OV_ALERT_RULES_TABLE,
  type OvAlertStore,
} from './repository';

/**
 * THE SERVICE-ROLE STORE — every account's rules, for the scheduled sweep.
 *
 * ===========================================================================
 * WHAT MAKES THIS DIFFERENT FROM THE READER STORE
 * ===========================================================================
 * Two things, and both of them are about who is asking.
 *
 * `listRules` returns EVERY account's enabled rules, because the service role
 * bypasses RLS and the sweep is supposed to reach everybody. That is why the
 * select carries `user_id` and the reader store's does not need to: with no RLS
 * to answer "whose is this", the answer has to travel with the row, and
 * `runOvAlertSweep` groups by it.
 *
 * `recordHit` calls `record_overview_alert_hit_service` rather than
 * `record_overview_alert_hit`. The reader's version resolves `auth.uid()`, which
 * is null under the service role, so it would raise 42501 on every write. The
 * service version takes the rule id, derives the owner from the row, and is
 * granted to `service_role` alone — the shape `trigger_price_alert_service`
 * already uses for `price_alerts`.
 *
 * ===========================================================================
 * THE SWEEP DOES NOT KNOW WHICH OF THE TWO IT HAS
 * ===========================================================================
 * Both implement `OvAlertStore` and `runOvAlertSweep` never asks. A reader-scoped
 * sweep is the case where every rule carries a null `userId` and falls into one
 * group; this one produces many groups. Same code path, and no `if` in the
 * sweep to get the branch wrong in.
 *
 * ===========================================================================
 * THE CAST, AND WHY IT CANNOT OUTLIVE ITS REASON
 * ===========================================================================
 * Same situation as `supabase-store.ts`: the migrations that create these
 * objects have not been applied, so neither the table nor the RPC is in
 * `src/types/database.ts`. `OV_ALERT_SERVICE_IS_UNTYPED` is a type-level
 * assertion that the table is STILL unknown, so regenerating the types after the
 * migrations run breaks this file and tells whoever did it to delete the cast.
 *
 * ===========================================================================
 * DO NOT HAND THIS A READER'S CLIENT
 * ===========================================================================
 * With an ordinary session the select returns only that reader's rows — which
 * looks like it works — and every `recordHit` fails, because `authenticated` is
 * revoked from the service RPC. That failure is loud and per owner rather than
 * silent, which is the right direction, but the caller is still wrong. This
 * takes an admin client and nothing else.
 */

/**
 * The store the sweep runs on.
 *
 * `client` must be a SERVICE-ROLE client — `createAdminClient()`. See the header.
 */
export function createOvAlertServiceStore(client: SupabaseClient<Database>): OvAlertStore {
  const admin = client;
  return {
    listRules: async () => {
      /*
        Filtered to enabled rules in the DATABASE rather than in the sweep.

        `loadEnabledOvAlertRules` filters again, and that redundancy is
        deliberate — but doing it only in TypeScript would pull every disabled
        rule in the product across the wire on every fifteen-minute tick, to
        throw them away. The partial index `overview_alert_rules_owner_enabled_idx`
        is on exactly this predicate.
      */
      const { data, error } = await admin
        .from(OV_ALERT_RULES_TABLE)
        .select(OV_ALERT_RULES_COLUMNS)
        .eq('enabled', true);
      if (error) throw error;
      return data;
    },
    /*
      Creating, editing and deleting a rule is a READER's action, performed with
      their own session against RLS. A service-role path for it would be a way to
      write into an account on behalf of a request that never proved it was that
      account — so there isn't one, and reaching for it here fails loudly at the
      call site rather than quietly doing it.
    */
    createRule: async () => {
      throw new Error('createRule is a reader action; use createOvAlertStore');
    },
    updateRule: async () => {
      throw new Error('updateRule is a reader action; use createOvAlertStore');
    },
    deleteRule: async () => {
      throw new Error('deleteRule is a reader action; use createOvAlertStore');
    },
    recordHit: async (record) => {
      const { data, error } = await admin.rpc(OV_ALERT_RECORD_HIT_SERVICE_RPC, {
        target_rule_id: record.ruleId,
        input_symbol: record.symbol,
        input_kind: record.kind,
        input_observed_price: record.observedPrice,
        input_observed_change_percent: record.observedChangePercent,
        input_observed_earnings_days: record.observedEarningsDays,
        input_value_text: record.valueText,
        input_observed_at: record.observedAt,
      });
      if (error) throw error;
      /*
        The function returns NULL for a rule that was disabled or deleted between
        the read and the write, and for an observation the unique index refused
        as a duplicate. `runOvAlertSweep` reads that as "not written" and counts
        it — never as delivered.
      */
      return data;
    },
  };
}
