import 'server-only';

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/src/types/database';
import { loadPortfolioPrices } from '@/src/lib/overview/service';
import { calculatePortfolio } from '@/src/lib/portfolio/calculations';
import { aggregatePortfolioSummaries } from '@/src/lib/portfolio/aggregate';
import { loadPortfoliosForUser } from '@/src/lib/portfolio/repository';
import { calculateOptionLedger } from '@/src/lib/portfolio/options/calculations';
import { loadPortfolioOptionQuotes } from '@/src/lib/portfolio/options/quote-pipeline';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { isDailySummaryDue, zonedClock } from '@/src/lib/notifications/schedule';
import { runPromptPayRenewalReminders } from '@/src/lib/billing/promptpay-reminders';
import { targetObservation } from './observation';
import { describeCondition } from './logic';

const ALERT_BATCH_SIZE = 20;
const SUMMARY_BATCH_SIZE = 50;
const MIN_EVALUATION_INTERVAL_MS = 15 * 60_000;
const SCHEDULE_WINDOW_MS = 15 * 60_000;

function windowStart(now: Date): string {
  return new Date(Math.floor(now.getTime() / SCHEDULE_WINDOW_MS) * SCHEDULE_WINDOW_MS).toISOString();
}

function crossingKey(alertId: string, observedAt: string, session: string): string {
  return createHash('sha256').update(`${alertId}:${observedAt}:${session}`).digest('hex');
}

function money(value: number): string {
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function signedMoney(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${money(Math.abs(value))}`;
}

function signedPercent(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function latestTime(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

interface DailySummaryResult {
  generated: number;
  unavailable: number;
}

async function createDailySummary(
  client: SupabaseClient<Database>,
  setting: Database['public']['Tables']['user_settings']['Row'],
  now: Date,
): Promise<boolean> {
  const clock = zonedClock(now, setting.timezone);
  const portfolios = await loadPortfoliosForUser(client, setting.user_id);
  const idempotencyKey = `daily-summary:${clock.date}:daily_summary`;
  const observedAt = now.toISOString();

  const title = 'สรุปพอร์ตรายวัน';
  let message = 'วันนี้ยังไม่มีข้อมูลพอร์ตเพียงพอสำหรับทำสรุป';
  let metadata: Json = {
    status: 'insufficient',
    localDate: clock.date,
    timezone: setting.timezone,
    href: '/portfolio',
  };

  if (portfolios.some((portfolio) => portfolio.transactions.length > 0)) {
    const stockSymbols = [...new Set(portfolios.flatMap((portfolio) => portfolio.transactions)
      .filter((transaction) =>
        transaction.type === 'acquisition'
        || transaction.type === 'disposal'
        || transaction.type === 'initial_position')
      .map((transaction) => transaction.symbol)
      .filter((symbol): symbol is string => Boolean(symbol)))];
    const canonicalPrices = await loadPortfolioPrices(stockSymbols, now);
    const marketPrices = Object.fromEntries(stockSymbols.flatMap((symbol) => {
      const display = canonicalPrices.get(symbol)?.display;
      if (
        !display
        || display.price === null
        || display.freshness?.status === 'stale'
        || display.freshness?.status === 'unavailable'
      ) return [];
      return [[symbol, {
        price: display.price,
        previousClose: display.change === null ? null : display.price - display.change,
        cached: display.status === 'saved',
        stale: false,
        source: display.source ?? 'canonical-market-snapshot',
        asOf: display.asOf,
      }]];
    }));

    const optionPreviews = new Map(portfolios.map((portfolio) => [
      portfolio.id,
      calculateOptionLedger(portfolio.transactions),
    ]));
    let optionService: ReturnType<typeof getOptionsMarketDataService> | null = null;
    try { optionService = getOptionsMarketDataService(); } catch { optionService = null; }
    const optionQuotes = await loadPortfolioOptionQuotes(
      [...optionPreviews.values()]
        .flatMap((preview) => preview.positions.filter((position) => position.status === 'open')),
      optionService
        ? async (underlying, expiration) => (await optionService!.getChain(underlying, expiration)).data
        : undefined,
    );
    const summaries = portfolios.map((portfolio) =>
      calculatePortfolio(portfolio.transactions, marketPrices, optionQuotes));
    const summary = aggregatePortfolioSummaries(summaries);
    const contributors = [
      ...summary.holdings.flatMap((holding) => holding.todayChange === null ? [] : [{
        symbol: holding.symbol,
        amount: holding.todayChange,
      }]),
      ...summary.optionPositions.flatMap((position) => position.todayChange === null ? [] : [{
        symbol: `${position.underlyingSymbol} ออปชัน`,
        amount: position.todayChange,
      }]),
    ].sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount));
    const top = contributors[0] ?? null;
    const valuedAt = latestTime([
      ...summary.holdings.map((holding) => holding.priceAsOf),
      ...summary.optionPositions.map((position) => position.quoteAsOf),
    ]);

    if (
      summary.totalValue !== null
      && summary.todayChange !== null
      && summary.todayChangePercent !== null
      && valuedAt
    ) {
      const updated = new Intl.DateTimeFormat('th-TH', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: setting.timezone,
      }).format(new Date(valuedAt));
      message = [
        `มูลค่าพอร์ตรวม ${money(summary.totalValue)}`,
        `วันนี้ ${signedMoney(summary.todayChange)} (${signedPercent(summary.todayChangePercent)})`,
        top ? `ส่งผลมากที่สุด ${top.symbol} ${signedMoney(top.amount)}` : 'วันนี้ยังไม่มีสินทรัพย์ที่เปลี่ยนแปลง',
        `ข้อมูลล่าสุด ${updated}`,
      ].join(' · ');
      metadata = {
        status: 'ready',
        localDate: clock.date,
        timezone: setting.timezone,
        totalValue: summary.totalValue,
        todayChange: summary.todayChange,
        todayChangePercent: summary.todayChangePercent,
        topContributor: top ? { symbol: top.symbol, amount: top.amount } : null,
        valuedAt,
        href: '/portfolio',
      };
    } else {
      message = 'ข้อมูลราคาหรือราคาปิดวันก่อนยังไม่ครบ จึงยังสรุปมูลค่าและผลของวันนี้ไม่ได้';
      metadata = {
        status: 'insufficient',
        localDate: clock.date,
        timezone: setting.timezone,
        valuedAt,
        href: '/portfolio',
      };
    }
  }

  const { error } = await client.rpc('enqueue_account_notification_service', {
    input_user_id: setting.user_id,
    input_type: 'daily_summary',
    input_title: title,
    input_message: message,
    input_metadata: metadata,
    input_idempotency_key: idempotencyKey,
    input_observed_at: observedAt,
  });
  if (error) throw error;
  const { error: updateError } = await client.from('user_settings')
    .update({
      daily_summary_last_local_date: clock.date,
      updated_at: observedAt,
    })
    .eq('user_id', setting.user_id);
  if (updateError) throw updateError;
  return true;
}

export async function runDailySummaries(
  client: SupabaseClient<Database>,
  now = new Date(),
): Promise<DailySummaryResult> {
  const result: DailySummaryResult = { generated: 0, unavailable: 0 };
  const { data: settings, error } = await client.from('user_settings').select('*')
    .eq('daily_summary_enabled', true)
    .order('daily_summary_last_local_date', { ascending: true, nullsFirst: true })
    .limit(SUMMARY_BATCH_SIZE);
  if (error) throw error;

  for (const setting of settings ?? []) {
    let due = false;
    try {
      due = isDailySummaryDue({
        now,
        timeZone: setting.timezone,
        summaryTime: setting.daily_summary_time,
        lastLocalDate: setting.daily_summary_last_local_date,
      });
    } catch {
      result.unavailable += 1;
      continue;
    }
    if (!due) continue;
    try {
      if (await createDailySummary(client, setting, now)) result.generated += 1;
    } catch {
      result.unavailable += 1;
    }
  }
  return result;
}

export interface BackgroundAlertSummary {
  duplicateRun: boolean;
  evaluated: number;
  triggered: number;
  unavailable: number;
  dailySummaries: number;
  dailySummaryUnavailable: number;
  promptPayRenewalReminders: number;
  promptPayRenewalUnavailable: number;
  quietItemsReleased: number;
}

export async function runBackgroundAlerts(
  client: SupabaseClient<Database>,
  now = new Date(),
): Promise<BackgroundAlertSummary> {
  const scheduleWindow = windowStart(now);
  const empty: BackgroundAlertSummary = {
    duplicateRun: false,
    evaluated: 0,
    triggered: 0,
    unavailable: 0,
    dailySummaries: 0,
    dailySummaryUnavailable: 0,
    promptPayRenewalReminders: 0,
    promptPayRenewalUnavailable: 0,
    quietItemsReleased: 0,
  };
  let { data: run, error: runError } = await client.from('alert_evaluation_runs')
    .insert({ schedule_window: scheduleWindow }).select('id').maybeSingle();
  if (runError?.code === '23505') {
    const { data: existing, error: existingError } = await client.from('alert_evaluation_runs')
      .select('id, status').eq('schedule_window', scheduleWindow).maybeSingle();
    if (existingError || !existing) throw existingError ?? new Error('Could not inspect alert run');
    if (existing.status !== 'failed') return { ...empty, duplicateRun: true };
    const { data: resumed, error: resumeError } = await client.from('alert_evaluation_runs')
      .update({ status: 'running', error_code: null, started_at: now.toISOString(), completed_at: null })
      .eq('id', existing.id).eq('status', 'failed').select('id').maybeSingle();
    if (resumeError || !resumed) return { ...empty, duplicateRun: true };
    run = resumed;
    runError = null;
  }
  if (runError || !run) throw runError ?? new Error('Could not start alert run');

  try {
    const { data: quietReleased, error: quietError } = await client.rpc(
      'flush_queued_notifications_service',
      { input_now: now.toISOString() },
    );
    if (quietError) throw quietError;
    empty.quietItemsReleased = quietReleased ?? 0;

    const cutoff = new Date(now.getTime() - MIN_EVALUATION_INTERVAL_MS).toISOString();
    const { data: alerts, error } = await client.from('price_alerts').select('*')
      .eq('enabled', true)
      .or(`last_evaluated_at.is.null,last_evaluated_at.lt.${cutoff}`)
      .order('last_evaluated_at', { ascending: true, nullsFirst: true })
      .limit(ALERT_BATCH_SIZE);
    if (error) throw error;

    const symbols = [...new Set((alerts ?? []).map((alert) => alert.symbol))];
    const canonicalPrices = await loadPortfolioPrices(symbols, now);
    for (const alert of alerts ?? []) {
      const display = canonicalPrices.get(alert.symbol)?.display;
      const observation = display ? targetObservation(display) : null;
      if (!observation) {
        empty.unavailable += 1;
        await client.from('price_alerts')
          .update({ last_evaluated_at: now.toISOString(), updated_at: now.toISOString() })
          .eq('id', alert.id);
        continue;
      }
      const condition = describeCondition(alert.condition, Number(alert.target_value));
      const { data: notificationId, error: triggerError } = await client.rpc(
        'trigger_price_alert_service',
        {
          alert_id: alert.id,
          observed_price: observation.price,
          observed_change_percent: observation.changePercent,
          observed_at: observation.observedAt,
          observed_session: observation.session,
          observed_source: observation.source,
          notification_title: `${alert.symbol} ถึงราคาเป้าหมายแล้ว`,
          notification_message: `${condition} · ราคาที่ตรวจพบ ${observation.price.toLocaleString('th-TH')}`,
          input_idempotency_key: crossingKey(
            alert.id,
            observation.observedAt,
            observation.session,
          ),
        },
      );
      if (triggerError) throw triggerError;
      empty.evaluated += 1;
      if (notificationId) empty.triggered += 1;
    }

    const daily = await runDailySummaries(client, now);
    empty.dailySummaries = daily.generated;
    empty.dailySummaryUnavailable = daily.unavailable;
    const promptPay = await runPromptPayRenewalReminders(client, now);
    empty.promptPayRenewalReminders = promptPay.due;
    empty.promptPayRenewalUnavailable = promptPay.unavailable;
    const status = empty.unavailable
      || empty.dailySummaryUnavailable
      || empty.promptPayRenewalUnavailable
      ? 'partial'
      : 'completed';
    await client.from('alert_evaluation_runs').update({
      status,
      evaluated_count: empty.evaluated,
      triggered_count: empty.triggered,
      unavailable_count: empty.unavailable
        + empty.dailySummaryUnavailable
        + empty.promptPayRenewalUnavailable,
      completed_at: new Date().toISOString(),
    }).eq('id', run.id);
    console.info('background-notifications', {
      status,
      evaluated: empty.evaluated,
      triggered: empty.triggered,
      unavailable: empty.unavailable,
      dailySummaries: empty.dailySummaries,
      promptPayRenewalReminders: empty.promptPayRenewalReminders,
      quietItemsReleased: empty.quietItemsReleased,
    });
    return empty;
  } catch (cause) {
    await client.from('alert_evaluation_runs').update({
      status: 'failed',
      error_code: 'run-failed',
      completed_at: new Date().toISOString(),
    }).eq('id', run.id);
    console.error('background-notifications', { status: 'failed', code: 'run-failed' });
    throw cause;
  }
}
