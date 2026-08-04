import { describe, expect, it, vi } from 'vitest';
import {
  promptPayReminderIdempotencyKey,
  promptPayReminderThreshold,
  runPromptPayRenewalReminders,
} from './promptpay-reminders';

const NOW = new Date('2026-08-04T12:00:00.000Z');
const day = 86_400_000;
const end = (days: number) => new Date(NOW.getTime() + days * day).toISOString();

function clientWith(rows: Array<Record<string, unknown>>) {
  const rpc = vi.fn(async () => ({ data: 'notification-id', error: null }));
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    not: () => chain,
    order: () => chain,
    limit: async () => ({ data: rows, error: null }),
  };
  return {
    client: { from: vi.fn(() => chain), rpc },
    rpc,
  };
}

describe('PromptPay renewal reminders', () => {
  it('selects only the 7-day, 3-day and final-day thresholds', () => {
    expect(promptPayReminderThreshold({ periodEnd: end(7), now: NOW })).toBe(7);
    expect(promptPayReminderThreshold({ periodEnd: end(3), now: NOW })).toBe(3);
    expect(promptPayReminderThreshold({ periodEnd: end(1), now: NOW })).toBe(1);
    expect(promptPayReminderThreshold({ periodEnd: end(6), now: NOW })).toBeNull();
    expect(promptPayReminderThreshold({ periodEnd: end(-1), now: NOW })).toBeNull();
  });

  it('dedupes by subscription, paid period and threshold', () => {
    const first = promptPayReminderIdempotencyKey({
      subscriptionId: 'sub_one', periodEnd: end(7), threshold: 7,
    });
    expect(promptPayReminderIdempotencyKey({
      subscriptionId: 'sub_one', periodEnd: end(7), threshold: 7,
    })).toBe(first);
    expect(promptPayReminderIdempotencyKey({
      subscriptionId: 'sub_one', periodEnd: end(3), threshold: 3,
    })).not.toBe(first);
    expect(first).not.toContain('sub_one');
  });

  it('uses the existing notification RPC and emits no reminder after the paid period moved', async () => {
    const { client, rpc } = clientWith([
      {
        user_id: 'user-1',
        billing_subscription_id: 'sub_one',
        current_period_end: end(3),
        status: 'active',
      },
      {
        user_id: 'user-2',
        billing_subscription_id: 'sub_paid',
        current_period_end: end(30),
        status: 'active',
      },
    ]);
    const result = await runPromptPayRenewalReminders(client as never, NOW);
    expect(result).toEqual({ due: 1, unavailable: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('enqueue_account_notification_service', expect.objectContaining({
      input_user_id: 'user-1',
      input_type: 'system',
      input_metadata: expect.objectContaining({ thresholdDays: 3 }),
    }));
  });
});
