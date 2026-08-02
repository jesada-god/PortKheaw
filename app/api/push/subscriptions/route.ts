import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import { isPushConfigured } from '@/src/lib/push/service';
import { deviceLabelFromUserAgent } from '@/src/lib/push/device';

const subscriptionSchema = z.object({
  endpoint: z.url().max(2048),
  expirationTime: z.number().int().nonnegative().nullable(),
  keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(512) }),
});
const removeSchema = z.object({ endpoint: z.url().max(2048) });

async function authenticated() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? { client, user } : null;
}

export async function GET() {
  const auth = await authenticated();
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  return NextResponse.json({ data: { configured: isPushConfigured() } });
}

export async function POST(request: NextRequest) {
  const auth = await authenticated();
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!isPushConfigured()) return NextResponse.json({ error: 'Push is not configured' }, { status: 503 });
  const parsed = subscriptionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid push subscription' }, { status: 400 });
  const now = new Date().toISOString();
  const { error: settingsError } = await auth.client.from('user_settings').upsert({
    user_id: auth.user.id,
    push_enabled: true,
    updated_at: now,
  }, { onConflict: 'user_id' });
  if (settingsError) {
    return NextResponse.json({ error: 'Could not enable push notifications' }, { status: 503 });
  }
  const userAgent = request.headers.get('user-agent')?.slice(0, 200) ?? null;
  const { error } = await auth.client.rpc('upsert_push_subscription', {
    input_endpoint: parsed.data.endpoint,
    input_expiration_time: parsed.data.expirationTime,
    input_p256dh: parsed.data.keys.p256dh,
    input_auth: parsed.data.keys.auth,
    input_user_agent: userAgent,
    input_device_label: deviceLabelFromUserAgent(userAgent),
    input_now: now,
  });
  if (error) return NextResponse.json({ error: 'Could not save push subscription' }, { status: 503 });
  return NextResponse.json({ data: { subscribed: true } });
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticated();
  if (!auth) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const parsed = removeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid push subscription' }, { status: 400 });
  const { error } = await auth.client.from('push_subscriptions').delete().eq('user_id', auth.user.id).eq('endpoint', parsed.data.endpoint);
  if (error) return NextResponse.json({ error: 'Could not remove push subscription' }, { status: 503 });
  const { count } = await auth.client.from('push_subscriptions').select('id', { count: 'exact', head: true })
    .eq('user_id', auth.user.id).eq('enabled', true);
  if (!count) await auth.client.from('user_settings').update({ push_enabled: false, updated_at: new Date().toISOString() }).eq('user_id', auth.user.id);
  return NextResponse.json({ data: { subscribed: false } });
}
