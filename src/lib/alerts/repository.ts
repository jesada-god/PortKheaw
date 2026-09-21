import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type { AlertCondition, AppNotification, PriceAlert } from './types';

type AlertWrite = { symbol: string; condition: AlertCondition; targetValue: number; cooldownMinutes: number; enabled: boolean };

function mapAlert(row: Database['public']['Tables']['price_alerts']['Row']): PriceAlert {
  return { id: row.id, symbol: row.symbol, condition: row.condition, targetValue: Number(row.target_value), enabled: row.enabled,
    cooldownMinutes: row.cooldown_minutes, lastEvaluatedAt: row.last_evaluated_at, lastTriggeredAt: row.last_triggered_at, createdAt: row.created_at };
}

export class AlertsRepository {
  constructor(private readonly client: SupabaseClient<Database>, private readonly userId: string) {}

  async list(): Promise<PriceAlert[]> {
    const { data, error } = await this.client.from('price_alerts').select('*').eq('user_id', this.userId).order('created_at', { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapAlert);
  }

  async create(input: AlertWrite): Promise<PriceAlert> {
    const { data, error } = await this.client.from('price_alerts').insert({ user_id: this.userId, symbol: input.symbol,
      condition: input.condition, target_value: String(input.targetValue), cooldown_minutes: input.cooldownMinutes, enabled: input.enabled })
      .select('*').single();
    if (error || !data) throw error ?? new Error('Alert was not created');
    return mapAlert(data);
  }

  async update(id: string, input: AlertWrite): Promise<PriceAlert | null> {
    const { data, error } = await this.client.from('price_alerts').update({ symbol: input.symbol, condition: input.condition,
      target_value: String(input.targetValue), cooldown_minutes: input.cooldownMinutes, enabled: input.enabled,
      was_matching: false, last_observed_price: null, last_observed_session: null,
      last_observed_source: null, last_observed_at: null, updated_at: new Date().toISOString() })
      .eq('id', id).eq('user_id', this.userId).select('*').maybeSingle();
    if (error) throw error;
    return data ? mapAlert(data) : null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const { data, error } = await this.client.from('price_alerts').update({
      enabled, was_matching: false, updated_at: new Date().toISOString(),
    })
      .eq('id', id).eq('user_id', this.userId).select('id');
    if (error) throw error;
    return Boolean(data?.length);
  }

  async remove(id: string): Promise<boolean> {
    const { data, error } = await this.client.from('price_alerts').delete().eq('id', id).eq('user_id', this.userId).select('id');
    if (error) throw error;
    return Boolean(data?.length);
  }

  /*
    THERE IS NO `trigger` AND NO `markEvaluated` HERE, AND THAT IS THE POINT.

    Evaluating an alert is the scheduled sweep's job and nobody else's:
    `runBackgroundAlerts` reads the batch with the service role and
    `trigger_price_alert_service` decides the match, stamps the row and writes
    the Inbox item in one transaction under a row lock. A reader-scoped trigger
    used to sit here for a "ตรวจสอบตอนนี้" button that evaluated alerts inside a
    browser request; that path is gone, and `202609200001` dropped the function
    behind it.

    This class is the reader's CRUD over their own rules. Adding a second way to
    fire one would be a second evaluator, which is exactly how the product came
    to have two alert systems that disagreed about what an alert means.
  */
}

export class NotificationsRepository {
  constructor(private readonly client: SupabaseClient<Database>, private readonly userId: string) {}

  async list(limit = 100): Promise<AppNotification[]> {
    const { data, error } = await this.client.from('notifications').select('id, price_alert_id, type, title, message, metadata, read_at, created_at')
      .eq('user_id', this.userId).order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data ?? []).map((row) => {
      const href = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        && typeof row.metadata.href === 'string'
        ? row.metadata.href
        : null;
      return {
        id: row.id,
        priceAlertId: row.price_alert_id,
        type: row.type,
        title: row.title,
        message: row.message,
        metadata: row.metadata,
        href,
        readAt: row.read_at,
        createdAt: row.created_at,
      };
    });
  }

  async unreadCount(): Promise<number> {
    const { count, error } = await this.client.from('notifications').select('id', { count: 'exact', head: true })
      .eq('user_id', this.userId).is('read_at', null);
    if (error) throw error;
    return count ?? 0;
  }

  async markRead(id: string): Promise<boolean> {
    const { data, error } = await this.client.from('notifications').update({ read_at: new Date().toISOString() })
      .eq('id', id).eq('user_id', this.userId).is('read_at', null).select('id');
    if (error) throw error;
    return Boolean(data?.length);
  }

  async markAllRead(): Promise<number> {
    const { data, error } = await this.client.from('notifications').update({ read_at: new Date().toISOString() })
      .eq('user_id', this.userId).is('read_at', null).select('id');
    if (error) throw error;
    return data?.length ?? 0;
  }
}

