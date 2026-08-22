/**
 * Every INPUT the card depends on, named, so "ความครบของข้อมูล" can mean what it
 * says.
 *
 * Completeness used to be measured one level too high: it counted FACTORS that
 * had produced a number, so a card carrying a yellow "ข้อมูลบางส่วน" badge, an IV
 * Rank reading "ไม่พร้อมใช้งาน", an IV percentile 59 days short and a Put/Call
 * percentile 19 days short still published 100%. Every factor had produced a
 * number, and the number each one produced was standing on less than it needed.
 *
 * So the registry is the list of the things underneath. A factor is complete when
 * all of its own inputs arrived, and the share that did arrive is what its weight
 * contributes.
 *
 * TWO rules, both deliberate:
 *
 *  - INSIDE a factor every input weighs the same. RVOL is arguably worth less
 *    than the momentum histogram it scales, but any split between them would be
 *    a number invented to look precise, and the equal split is at least a claim
 *    anybody can check.
 *  - ACROSS factors the weights are the model's own 15/25/25/10/15. Nothing here
 *    re-tunes anything; a factor's say in how complete the picture is, is its say
 *    in the picture.
 *
 * A factor that could not be judged at all (`fallback-neutral`, or missing)
 * contributes ZERO however many of its raw inputs arrived — its inputs were
 * present and still did not add up to a reading, which is exactly the state
 * completeness exists to report.
 */

import { OPTIONS_SIGNAL_CONFIG } from './config';
import {
  OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS,
  OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT,
} from './config';
import type {
  OptionsSignalCompleteness,
  OptionsSignalCompletenessInput,
  OptionsSignalFactorScore,
  OptionsSignalInput,
  OptionsSignalInputSlot,
} from './types';

/** Groups that carry a completeness weight. The five factors, plus the risk gate. */
export type CompletenessGroupId = keyof typeof OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS;

interface RegistryEntry {
  id: string;
  group: CompletenessGroupId;
  /** Shown in the "ขาด: …" list, so it has to name the thing a reader would look for. */
  label: string;
}

const present = (value: unknown): boolean => (
  typeof value === 'number' ? Number.isFinite(value) : value !== null && value !== undefined
);

function slotValue<T>(slot: OptionsSignalInputSlot<T> | undefined): T | null {
  return slot && slot.status === 'available' ? slot.value : null;
}

/**
 * The registry itself, as one function per input: given the engine's input, is
 * this particular thing there?
 *
 * Written as predicates rather than as a static list because "is it there" is a
 * question about the payload, and a table of field names would drift from the
 * payload the first time a field moved.
 */
function registry(input: OptionsSignalInput): Array<RegistryEntry & { available: boolean; note: string | null }> {
  const macro = slotValue(input.macro);
  const trend = slotValue(input.trend);
  const momentum = slotValue(input.momentum);
  const sentiment = slotValue(input.sentiment);
  const riskReward = slotValue(input.riskReward);
  const pricing = slotValue(input.pricing);

  const entries: Array<RegistryEntry & { available: boolean; note: string | null }> = [];
  const add = (
    entry: RegistryEntry,
    available: boolean,
    note: string | null = null,
  ) => entries.push({ ...entry, available, note });

  // --- Macro: one EMA20 comparison per configured benchmark ----------------
  for (const symbol of OPTIONS_SIGNAL_CONFIG.macroBenchmarks) {
    const benchmark = macro?.benchmarks.find((candidate) => candidate.symbol === symbol);
    add(
      { id: `macro.${symbol.toLowerCase()}-ema20`, group: 'macro', label: `EMA20 ของ ${symbol}` },
      Boolean(benchmark) && present(benchmark?.ema20),
    );
  }

  // --- Trend: the two moving averages the structure is read from -----------
  add({ id: 'trend.ema20', group: 'trend', label: 'EMA20 ของหุ้น' }, present(trend?.ema20));
  add({ id: 'trend.ema50', group: 'trend', label: 'EMA50 ของหุ้น' }, present(trend?.ema50));

  // --- Momentum: the histogram, the scale it is normalized by, the state,
  //     and the volume that confirms it -------------------------------------
  add({ id: 'momentum.histogram', group: 'momentum', label: 'TTM momentum histogram' }, present(momentum?.squeezeMomentum));
  add({ id: 'momentum.atr', group: 'momentum', label: 'ATR14 (ใช้ normalize momentum)' }, present(momentum?.atr));
  add({ id: 'momentum.squeeze', group: 'momentum', label: 'สถานะ TTM Squeeze' }, present(momentum?.squeeze));
  add({ id: 'momentum.rvol', group: 'momentum', label: 'RVOL 20 วัน' }, present(momentum?.relativeVolume));

  // --- Sentiment: the two ratios, and the baseline that makes them readable -
  add({ id: 'sentiment.put-call-oi', group: 'sentiment', label: 'Put/Call จาก Open Interest' }, present(sentiment?.putCallRatio));
  add({ id: 'sentiment.put-call-volume', group: 'sentiment', label: 'Put/Call จาก Volume' }, present(sentiment?.volumeRatio));
  {
    const required = OPTIONS_SIGNAL_CONFIG.sentiment.minimumPercentileObservations;
    const observations = sentiment?.percentileObservations ?? 0;
    const ready = observations >= required && present(sentiment?.ownPercentile);
    add(
      { id: 'sentiment.own-percentile', group: 'sentiment', label: 'Put/Call percentile ของหุ้นตัวเอง' },
      ready,
      ready ? null : `ขาดอีก ${Math.max(0, required - observations)} วัน`,
    );
  }

  // --- Risk/Reward: the geometry, and the two yardsticks it is quoted in ----
  add({ id: 'riskReward.support', group: 'riskReward', label: 'แนวรับที่ยืนยันแล้ว' }, present(riskReward?.support));
  add({ id: 'riskReward.resistance', group: 'riskReward', label: 'แนวต้านที่ยืนยันแล้ว' }, present(riskReward?.resistance));
  add({ id: 'riskReward.atr', group: 'riskReward', label: 'ATR14 (ใช้บอกระยะเป็นช่วงวัน)' }, present(riskReward?.atr));
  add({ id: 'riskReward.expected-move', group: 'riskReward', label: 'Expected Move จาก ATM straddle' }, present(riskReward?.expectedMove));

  // --- The risk gate: a reading, and something to judge it against ---------
  add({ id: 'pricing.implied-volatility', group: 'pricing', label: 'Implied Volatility (ATM)' }, pricing !== null);
  {
    /*
     * A SELF-REFERENTIAL baseline: an IV Rank, or this symbol's own IV
     * percentile. Not "which of the three bases fired" — `iv-rank` is supplied by
     * no provider the product is entitled to, so counting it as a missing input
     * would charge every symbol for a gap none of them can ever close.
     *
     * `iv-vs-realized` is a real measurement and is why the factor still has a
     * verdict, but it compares today's forward-looking IV against backward-looking
     * realized volatility, which is a weaker basis than the symbol's own history
     * and is the one the card must not present as though it were the same thing.
     */
    const required = OPTIONS_SIGNAL_CONFIG.iv.minimumPercentileObservations;
    const basis = pricing?.basis ?? null;
    const ready = basis === 'iv-rank' || basis === 'iv-percentile';
    const pending = input.ivPercentilePending ?? null;
    add(
      { id: 'pricing.own-baseline', group: 'pricing', label: 'ฐานเทียบความแพงของตัวเอง (IV Rank / IV percentile)' },
      ready,
      ready ? null : pending ? `ขาดอีก ${pending.missingDays} วัน` : `ต้องมีประวัติ ${required} วัน`,
    );
  }

  return entries;
}

/**
 * Completeness, weighted over the registry above.
 *
 * `factors` is consulted so that a factor which could not be JUDGED contributes
 * nothing regardless of how many of its raw inputs arrived. Options Sentiment
 * holding a real Put/Call it has no baseline to rank is the case: two of its
 * three inputs are present, and the reading they produce is not usable, so
 * reporting it as two-thirds complete would be the same overstatement one level
 * down.
 */
export function measureCompleteness(
  input: OptionsSignalInput,
  factors: Partial<Record<CompletenessGroupId, OptionsSignalFactorScore>>,
): OptionsSignalCompleteness {
  const entries = registry(input);
  const inputs: OptionsSignalCompletenessInput[] = [];
  let earned = 0;

  for (const group of Object.keys(OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS) as CompletenessGroupId[]) {
    const weight = OPTIONS_SIGNAL_COMPLETENESS_WEIGHTS[group];
    const groupEntries = entries.filter((entry) => entry.group === group);
    if (!groupEntries.length) continue;

    const factor = factors[group];
    const judged = factor === undefined || factor.measurement === 'measured';
    const availableCount = groupEntries.filter((entry) => entry.available).length;
    // Equal share inside the group; zero for the whole group when nothing usable
    // came out of it, however many of its parts arrived.
    earned += judged ? weight * availableCount / groupEntries.length : 0;

    for (const entry of groupEntries) {
      /*
       * `available` stays TRUTHFUL about the raw input even when the group
       * scored nothing. Options Sentiment really does hold a Put/Call of 1.51;
       * listing it under "ขาด" would be a second wrong statement told to fix a
       * first one. `counted` is the separate fact that it earned no weight,
       * because the factor it feeds could not be judged.
       */
      inputs.push({
        id: entry.id,
        group,
        label: entry.label,
        available: entry.available,
        counted: entry.available && judged,
        note: entry.available && !judged
          ? (factor?.fallbackReason ?? 'ปัจจัยนี้ยังตัดสินไม่ได้')
          : entry.note,
      });
    }
  }

  const value = OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT > 0
    ? earned / OPTIONS_SIGNAL_COMPLETENESS_TOTAL_WEIGHT
    : 0;

  return {
    value: Math.max(0, Math.min(1, value)),
    inputs,
    missing: inputs.filter((entry) => !entry.available).map((entry) => entry.label),
    notCounted: inputs.filter((entry) => entry.available && !entry.counted).map((entry) => entry.label),
  };
}
