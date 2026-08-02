import 'server-only';

import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '@/src/config/env/server';
import type { Database } from '@/src/types/database';
import { isQuietHour, nextQuietHoursEnd } from './quiet-hours';

const MAX_ATTEMPTS = 3;
const STALE_CLAIM_MINUTES = 5;

type PushSubscriptionRow =
  Database['public']['Tables']['push_subscriptions']['Row'];

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface PushDeliverySummary {
  sent: number;
  failed: number;
  retried: number;
  deferred: number;
  skipped: number;
  cleaned: number;
}

export interface ClassifiedPushFailure {
  code: string;
  gone: boolean;
  transient: boolean;
  statusCode: number | null;
}

export function isPushConfigured(): boolean {
  return Boolean(
    serverEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    && serverEnv.VAPID_PRIVATE_KEY
    && serverEnv.VAPID_SUBJECT,
  );
}

export function classifyPushFailure(cause: unknown): ClassifiedPushFailure {
  const rawStatus = (
    typeof cause === 'object'
    && cause
    && 'statusCode' in cause
  ) ? Number(cause.statusCode) : Number.NaN;
  const statusCode = Number.isInteger(rawStatus) && rawStatus > 0
    ? rawStatus
    : null;
  const gone = statusCode === 404 || statusCode === 410;
  const transient = statusCode === null
    || statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || statusCode >= 500;
  return {
    code: gone
      ? 'subscription-gone'
      : statusCode
        ? `push-http-${statusCode}`
        : 'push-failed',
    gone,
    transient,
    statusCode,
  };
}

export function retryDelayMs(attempt: number): number {
  return Math.min(20, 5 * (2 ** Math.max(0, attempt - 1))) * 60_000;
}

function configureWebPush() {
  if (!isPushConfigured()) throw new Error('push-not-configured');
  webpush.setVapidDetails(
    serverEnv.VAPID_SUBJECT as string,
    serverEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY as string,
    serverEnv.VAPID_PRIVATE_KEY as string,
  );
}

export async function sendWebPush(
  subscription: Pick<
    PushSubscriptionRow,
    'endpoint' | 'expiration_time' | 'p256dh' | 'auth'
  >,
  payload: PushPayload,
) {
  configureWebPush();
  return webpush.sendNotification({
    endpoint: subscription.endpoint,
    expirationTime: subscription.expiration_time,
    keys: {
      p256dh: subscription.p256dh,
      auth: subscription.auth,
    },
  }, JSON.stringify(payload), {
    TTL: 60 * 60,
    urgency: 'normal',
  });
}

function notificationPreferenceEnabled(
  notificationType: string,
  settings: {
    push_enabled: boolean;
    price_alerts_enabled: boolean;
    daily_summary_enabled: boolean;
  } | null,
): boolean {
  if (!settings?.push_enabled) return false;
  if (notificationType === 'price_alert') {
    return settings.price_alerts_enabled;
  }
  if (notificationType === 'daily_summary') {
    return settings.daily_summary_enabled;
  }
  return true;
}

export async function deliverPendingPushes(
  client: SupabaseClient<Database>,
  limit = 50,
  now = new Date(),
): Promise<PushDeliverySummary> {
  const summary: PushDeliverySummary = {
    sent: 0,
    failed: 0,
    retried: 0,
    deferred: 0,
    skipped: 0,
    cleaned: 0,
  };
  const nowIso = now.toISOString();
  const staleDisabled = new Date(
    now.getTime() - 30 * 24 * 60 * 60_000,
  ).toISOString();
  const { data: expired, error: expiredError } = await client
    .from('push_subscriptions')
    .delete()
    .not('expiration_time', 'is', null)
    .lt('expiration_time', now.getTime())
    .select('id');
  if (expiredError) throw expiredError;
  const { data: disabled, error: disabledError } = await client
    .from('push_subscriptions')
    .delete()
    .eq('enabled', false)
    .lt('updated_at', staleDisabled)
    .select('id');
  if (disabledError) throw disabledError;
  summary.cleaned += (expired?.length ?? 0) + (disabled?.length ?? 0);

  if (!isPushConfigured()) return summary;

  const claimToken = randomUUID();
  const { data: claimed, error: claimError } = await client.rpc(
    'claim_push_deliveries_service',
    {
      input_limit: limit,
      input_now: nowIso,
      input_claim_token: claimToken,
    },
  );
  if (claimError) throw claimError;
  if (!claimed?.length) return summary;

  const { data, error } = await client.from('push_deliveries')
    .select(
      '*, notification:notifications(title, message, metadata, type, user_id), subscription:push_subscriptions(*)',
    )
    .eq('claim_token', claimToken)
    .eq('status', 'processing')
    .order('created_at');
  if (error) throw error;

  for (const delivery of data ?? []) {
    const notification = delivery.notification as unknown as {
      title: string;
      message: string;
      metadata: unknown;
      type: string;
      user_id: string;
    } | null;
    const subscription = delivery.subscription as unknown as
      PushSubscriptionRow | null;
    if (!notification || !subscription || !subscription.enabled) {
      await client.from('push_deliveries').update({
        status: 'skipped',
        provider_status: 'inactive-subscription',
        last_error_code: 'inactive-subscription',
        claim_token: null,
        claimed_at: null,
        updated_at: nowIso,
      }).eq('id', delivery.id).eq('claim_token', claimToken);
      summary.skipped += 1;
      continue;
    }

    const { data: settings, error: settingsError } = await client
      .from('user_settings')
      .select(
        'push_enabled, price_alerts_enabled, daily_summary_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, timezone',
      )
      .eq('user_id', notification.user_id)
      .maybeSingle();
    if (settingsError) throw settingsError;
    if (!notificationPreferenceEnabled(notification.type, settings)) {
      await client.from('push_deliveries').update({
        status: 'skipped',
        provider_status: 'preference-disabled',
        last_error_code: 'preference-disabled',
        claim_token: null,
        claimed_at: null,
        updated_at: nowIso,
      }).eq('id', delivery.id).eq('claim_token', claimToken);
      summary.skipped += 1;
      continue;
    }

    if (
      settings?.quiet_hours_enabled
      && isQuietHour(
        now,
        settings.timezone,
        settings.quiet_hours_start,
        settings.quiet_hours_end,
      )
    ) {
      const releaseAt = nextQuietHoursEnd(
        now,
        settings.timezone,
        settings.quiet_hours_start,
        settings.quiet_hours_end,
      );
      await client.from('push_deliveries').update({
        status: 'retrying',
        next_attempt_at: releaseAt.toISOString(),
        provider_status: 'quiet-hours',
        claim_token: null,
        claimed_at: null,
        updated_at: nowIso,
      }).eq('id', delivery.id).eq('claim_token', claimToken);
      summary.deferred += 1;
      continue;
    }

    try {
      const result = await sendWebPush(subscription, {
        title: notification.title,
        body: notification.message,
        url: (
          notification.metadata
          && typeof notification.metadata === 'object'
          && !Array.isArray(notification.metadata)
          && 'href' in notification.metadata
          && typeof notification.metadata.href === 'string'
        ) ? notification.metadata.href : '/notifications',
        tag: `notification-${delivery.notification_id}`,
      });
      await client.from('push_deliveries').update({
        status: 'sent',
        attempt_count: delivery.attempt_count + 1,
        sent_at: nowIso,
        provider_status: `http-${result.statusCode}`,
        last_error_code: null,
        claim_token: null,
        claimed_at: null,
        updated_at: nowIso,
      }).eq('id', delivery.id).eq('claim_token', claimToken);
      await client.from('push_subscriptions').update({
        failure_count: 0,
        last_success_at: nowIso,
        last_seen_at: nowIso,
        updated_at: nowIso,
      }).eq('id', subscription.id);
      summary.sent += 1;
    } catch (cause) {
      const failure = classifyPushFailure(cause);
      const attempts = delivery.attempt_count + 1;
      const terminal = (
        failure.gone
        || !failure.transient
        || attempts >= MAX_ATTEMPTS
      );
      await client.from('push_deliveries').update({
        status: terminal ? 'failed' : 'retrying',
        attempt_count: attempts,
        next_attempt_at: new Date(
          now.getTime() + retryDelayMs(attempts),
        ).toISOString(),
        provider_status: failure.statusCode
          ? `http-${failure.statusCode}`
          : 'provider-error',
        last_error_code: failure.code,
        claim_token: null,
        claimed_at: null,
        updated_at: nowIso,
      }).eq('id', delivery.id).eq('claim_token', claimToken);

      if (failure.gone) {
        const { data: removed, error: cleanupError } = await client
          .from('push_subscriptions')
          .delete()
          .eq('id', subscription.id)
          .select('id');
        if (cleanupError) throw cleanupError;
        summary.cleaned += removed?.length ?? 0;
      } else {
        await client.from('push_subscriptions').update({
          failure_count: subscription.failure_count + 1,
          updated_at: nowIso,
        }).eq('id', subscription.id);
      }
      if (terminal) summary.failed += 1;
      else summary.retried += 1;
    }
  }
  return summary;
}

export const pushDeliveryLeaseMinutes = STALE_CLAIM_MINUTES;
