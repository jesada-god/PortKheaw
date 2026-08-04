import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/src/types/database';

export const PROMPTPAY_REMINDER_THRESHOLDS = [7, 3, 1] as const;
export type PromptPayReminderThreshold = typeof PROMPTPAY_REMINDER_THRESHOLDS[number];

const DAY_MS = 86_400_000;

export function promptPayReminderThreshold(input: {
  periodEnd: string | null;
  now: string | number | Date;
}): PromptPayReminderThreshold | null {
  if (!input.periodEnd) return null;
  const end = Date.parse(input.periodEnd);
  const now = new Date(input.now).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(now)) return null;
  const remaining = end - now;
  if (remaining <= 0) return null;
  const days = Math.ceil(remaining / DAY_MS);
  return PROMPTPAY_REMINDER_THRESHOLDS.includes(days as PromptPayReminderThreshold)
    ? days as PromptPayReminderThreshold
    : null;
}

export function promptPayReminderIdempotencyKey(input: {
  subscriptionId: string;
  periodEnd: string;
  threshold: PromptPayReminderThreshold;
}): string {
  const digest = createHash('sha256')
    .update(`${input.subscriptionId}:${input.periodEnd}:${input.threshold}`)
    .digest('hex');
  return `promptpay-renewal:${digest}`;
}

function reminderMessage(threshold: PromptPayReminderThreshold): string {
  return threshold === 1
    ? 'แพ็กเกจ PromptPay จะหมดอายุในวันนี้ เปิดหน้าสมาชิกเพื่อดูการชำระรอบถัดไป'
    : `แพ็กเกจ PromptPay จะหมดอายุในอีก ${threshold} วัน เปิดหน้าสมาชิกเพื่อดูการชำระรอบถัดไป`;
}

export interface PromptPayReminderRun {
  due: number;
  unavailable: number;
}

/** Add subscription reminders to the existing Inbox/quiet-hours/push pipeline. */
export async function runPromptPayRenewalReminders(
  client: SupabaseClient<Database>,
  now = new Date(),
): Promise<PromptPayReminderRun> {
  const result: PromptPayReminderRun = { due: 0, unavailable: 0 };
  const { data, error } = await client
    .from('user_subscriptions')
    .select('user_id, billing_subscription_id, current_period_end, status')
    .eq('billing_collection_method', 'send_invoice')
    .in('status', ['active', 'past_due'])
    .not('billing_subscription_id', 'is', null)
    .not('current_period_end', 'is', null)
    .order('current_period_end', { ascending: true })
    .limit(100);
  if (error) throw error;

  for (const subscription of data ?? []) {
    const threshold = promptPayReminderThreshold({
      periodEnd: subscription.current_period_end,
      now,
    });
    if (!threshold || !subscription.billing_subscription_id || !subscription.current_period_end) continue;

    const metadata: Json = {
      href: '/settings/subscription',
      paymentMethod: 'promptpay',
      periodEnd: subscription.current_period_end,
      thresholdDays: threshold,
    };
    try {
      const { error: enqueueError } = await client.rpc('enqueue_account_notification_service', {
        input_user_id: subscription.user_id,
        input_type: 'system',
        input_title: 'เตือนต่ออายุสมาชิก PromptPay',
        input_message: reminderMessage(threshold),
        input_metadata: metadata,
        input_idempotency_key: promptPayReminderIdempotencyKey({
          subscriptionId: subscription.billing_subscription_id,
          periodEnd: subscription.current_period_end,
          threshold,
        }),
        input_observed_at: now.toISOString(),
      });
      if (enqueueError) throw enqueueError;
      result.due += 1;
    } catch {
      result.unavailable += 1;
    }
  }
  return result;
}
