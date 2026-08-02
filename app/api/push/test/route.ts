import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import {
  classifyPushFailure,
  isPushConfigured,
  sendWebPush,
} from '@/src/lib/push/service';

export const runtime = 'nodejs';

const testSchema = z.object({
  endpoint: z.url().max(2048),
});

export async function POST(request: NextRequest) {
  const client = await createClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Push test is unavailable' },
      { status: 503 },
    );
  }
  const { data: { user } } = await client.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 },
    );
  }
  if (!isPushConfigured()) {
    return NextResponse.json(
      { error: 'Push test is unavailable' },
      { status: 503 },
    );
  }
  const parsed = testSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid push test request' },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const { data: claims, error: claimError } = await client.rpc(
    'claim_push_test',
    {
      input_endpoint: parsed.data.endpoint,
      input_now: now,
    },
  );
  if (claimError) {
    return NextResponse.json(
      { error: 'Push test is unavailable' },
      { status: 503 },
    );
  }
  const claim = claims?.[0];
  if (!claim) {
    return NextResponse.json(
      { error: 'Push subscription was not found' },
      { status: 404 },
    );
  }
  if (!claim.allowed) {
    return NextResponse.json({
      error: 'Push test rate limited',
      retryAfterSeconds: claim.retry_after_seconds,
    }, {
      status: 429,
      headers: {
        'Retry-After': String(claim.retry_after_seconds),
      },
    });
  }

  const { data: subscription, error: subscriptionError } = await client
    .from('push_subscriptions')
    .select('*')
    .eq('id', claim.subscription_id)
    .eq('user_id', user.id)
    .eq('enabled', true)
    .maybeSingle();
  if (subscriptionError || !subscription) {
    return NextResponse.json(
      { error: 'Push subscription was not found' },
      { status: 404 },
    );
  }

  try {
    await sendWebPush(subscription, {
      title: 'PortKheaw',
      body: 'PortKheaw พร้อมแจ้งเตือนแล้ว',
      url: '/notifications',
      tag: `portkheaw-test-${subscription.id}`,
    });
    await client.from('push_subscriptions').update({
      failure_count: 0,
      last_success_at: now,
      last_seen_at: now,
      updated_at: now,
    }).eq('id', subscription.id).eq('user_id', user.id);
    return NextResponse.json({
      data: {
        sent: true,
      },
    });
  } catch (cause) {
    const failure = classifyPushFailure(cause);
    if (failure.gone) {
      await client.from('push_subscriptions')
        .delete()
        .eq('id', subscription.id)
        .eq('user_id', user.id);
      return NextResponse.json(
        { error: 'Push subscription expired' },
        { status: 404 },
      );
    }
    await client.from('push_subscriptions').update({
      failure_count: subscription.failure_count + 1,
      updated_at: now,
    }).eq('id', subscription.id).eq('user_id', user.id);
    return NextResponse.json(
      { error: 'Push test failed' },
      { status: 503 },
    );
  }
}
