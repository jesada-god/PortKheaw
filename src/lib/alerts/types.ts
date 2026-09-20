import type { AlertConditionValue } from '@/src/types/database';

/**
 * The five comparisons a reader may ask for.
 *
 * Two absolute, two relative, one calendar. `earnings` — "tell me when this
 * reports within N days" — joined the other four in `202609200001` rather than
 * getting a table of its own, because it has the same shape: one positive
 * number, compared against one reading. What differs is only WHICH reading, and
 * `ALERT_UNIT` in `./logic.ts` is where that is written down.
 */
export type AlertCondition =
  | 'above'
  | 'below'
  | 'percent_change_up'
  | 'percent_change_down'
  | 'earnings';

/**
 * THE FIVE CONDITIONS ARE WRITTEN DOWN IN THREE PLACES. THESE TWO LINES PIN TWO
 * OF THEM TOGETHER.
 *
 * The three:
 *
 *   1. `price_alerts_condition_check`                 — the column
 *   2. `trigger_price_alert_service`                  — the evaluator
 *   3. {@link AlertCondition} here, and `AlertConditionValue` in `database.ts`
 *
 * The product has already paid for this drift once. The dropped overview alert
 * table widened its column CHECK to admit `earnings` and left its writer on
 * four, so a kind could be stored, evaluated and recorded — and created by
 * nobody. Nothing detected it.
 *
 * Each pair is now held together by something that fails rather than by care:
 *
 *   * (3) against itself — the two assignments below, mutually exclusive unless
 *     the unions are identical. Adding a condition to one and not the other
 *     makes one of them `never` and the BUILD stops.
 *   * (1) against (2), and the sweep's argument list against the function's —
 *     `./service-path.contract.test.ts`, which reads them out of the migration's
 *     text. TypeScript cannot see inside SQL, so that pair needs a test rather
 *     than a type.
 */
const SCHEMA_CONDITION_COVERS_DOMAIN: AlertConditionValue = null as unknown as AlertCondition;
const DOMAIN_CONDITION_COVERS_SCHEMA: AlertCondition = null as unknown as AlertConditionValue;
void SCHEMA_CONDITION_COVERS_DOMAIN;
void DOMAIN_CONDITION_COVERS_SCHEMA;

export interface PriceAlert {
  id: string;
  symbol: string;
  condition: AlertCondition;
  targetValue: number;
  enabled: boolean;
  cooldownMinutes: number;
  lastEvaluatedAt: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
}

export interface AppNotification {
  id: string;
  priceAlertId: string | null;
  type: 'price_alert' | 'daily_summary' | 'quiet_hours_digest' | 'system';
  title: string;
  message: string;
  metadata: import('@/src/types/database').Json;
  href: string | null;
  readAt: string | null;
  createdAt: string;
}

export type AlertActionResult = { ok: true; alert?: PriceAlert } | { ok: false; code: string; message: string };

