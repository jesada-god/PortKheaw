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

  async markEvaluated(id: string, observedAt: string): Promise<void> {
    const { error } = await this.client.from('price_alerts').update({ last_evaluated_at: observedAt })
      .eq('id', id).eq('user_id', this.userId);
    if (error) throw error;
  }

  async trigger(id: string, price: number, changePercent: number | null, observedAt: string, title: string, message: string): Promise<string | null> {
    const { data, error } = await this.client.rpc('trigger_price_alert', { alert_id: id, observed_price: price,
      observed_change_percent: changePercent ?? 0, observed_at: observedAt, notification_title: title, notification_message: message });
    if (error) throw error;
    return data;
  }
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

