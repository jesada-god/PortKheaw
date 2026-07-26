'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { InfoHint } from '@/src/components/ui/InfoHint';
import type { CandleInterval, CandleRange } from '@/src/lib/market-data/candles/contracts';
import type { ChartDisplayType, ChartPreferences } from '@/src/lib/analytics/timeframe';
import { TimeframeSelector } from './TimeframeSelector';

export type ToolbarToggleKey = Extract<
  keyof ChartPreferences,
  'ema20' | 'ema50' | 'ema100' | 'ema200' | 'rsi' | 'macd' | 'vpvr' | 'supportResistance' | 'options'
>;

const TOGGLE_BASE = 'min-h-11 rounded-md border px-3 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]';
const ON = 'border-[#D4FF00] bg-[#D4FF00]/15 text-[#D4FF00]';
const OFF = 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500';

/** A compact anchored menu that closes on outside click, Escape and selection. */
function Menu({ label, testId, children }: { label: ReactNode; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        className={`${TOGGLE_BASE} ${OFF} flex items-center gap-1.5`}
      >
        {label}
        <ChevronDown aria-hidden="true" size={14} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 max-h-[60vh] w-60 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-slate-700 bg-[#0F1420] p-2 shadow-2xl"
          data-testid={`${testId}-menu`}
        >
          {children}
        </div>
      )}
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onToggle,
  hint,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        onClick={onToggle}
        className={`flex min-h-11 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm ${checked ? 'text-[#D4FF00]' : 'text-slate-200'} hover:bg-slate-800/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]`}
      >
        <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${checked ? 'border-[#D4FF00] bg-[#D4FF00]/20' : 'border-slate-600'}`}>
          {checked ? '✓' : ''}
        </span>
        <span className="min-w-0 truncate">{label}</span>
      </button>
      {hint}
    </div>
  );
}

export interface ChartToolbarProps {
  interval: CandleInterval;
  range: CandleRange;
  preferences: ChartPreferences;
  optionsAvailable: boolean;
  onSelectInterval(interval: CandleInterval): void;
  onSelectRange(range: CandleRange): void;
  onToggleFavoriteInterval(interval: CandleInterval): void;
  onToggleFavoriteRange(range: CandleRange): void;
  onChartType(type: ChartDisplayType): void;
  onToggle(key: ToolbarToggleKey): void;
  onResetView(): void;
}

/**
 * The chart's control surface.
 *
 * Every control here is presentation-only: chart type, indicators, overlays and
 * favourites all re-derive from candles already in memory, so no button in this
 * toolbar can cause a market request. Only the timeframe picker changes what is
 * loaded, and only when the selected value actually changes.
 */
export function ChartToolbar({
  interval,
  range,
  preferences,
  optionsAvailable,
  onSelectInterval,
  onSelectRange,
  onToggleFavoriteInterval,
  onToggleFavoriteRange,
  onChartType,
  onToggle,
  onResetView,
}: ChartToolbarProps) {
  const emaAllOn = preferences.ema20 && preferences.ema50 && preferences.ema100 && preferences.ema200;
  const emaAnyOn = preferences.ema20 || preferences.ema50 || preferences.ema100 || preferences.ema200;

  const setAllEma = (next: boolean) => {
    (['ema20', 'ema50', 'ema100', 'ema200'] as const).forEach((key) => {
      if (preferences[key] !== next) onToggle(key);
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-[#242733] p-2" data-testid="chart-toolbar">
      <TimeframeSelector
        interval={interval}
        range={range}
        favoriteIntervals={preferences.favoriteIntervals}
        favoriteRanges={preferences.favoriteRanges}
        onSelectInterval={onSelectInterval}
        onSelectRange={onSelectRange}
        onToggleFavoriteInterval={onToggleFavoriteInterval}
        onToggleFavoriteRange={onToggleFavoriteRange}
      />

      <Menu testId="chart-type-trigger" label={preferences.chartType === 'heikin-ashi' ? 'Heikin-Ashi' : 'Candles'}>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={preferences.chartType === 'candlestick'}
          onClick={() => onChartType('candlestick')}
          className={`flex min-h-11 w-full items-center rounded-md px-2 text-left text-sm ${preferences.chartType === 'candlestick' ? 'text-[#D4FF00]' : 'text-slate-200'} hover:bg-slate-800/70`}
        >
          แท่งเทียนจริง (Candles)
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            role="menuitemradio"
            aria-checked={preferences.chartType === 'heikin-ashi'}
            onClick={() => onChartType('heikin-ashi')}
            className={`flex min-h-11 flex-1 items-center rounded-md px-2 text-left text-sm ${preferences.chartType === 'heikin-ashi' ? 'text-[#D4FF00]' : 'text-slate-200'} hover:bg-slate-800/70`}
          >
            Heikin-Ashi
          </button>
          <InfoHint term="heikinAshi" align="end" />
        </div>
      </Menu>

      <Menu testId="indicators-trigger" label="Indicators">
        <div className="flex items-center justify-between gap-1 border-b border-slate-800 pb-1">
          <span className="px-2 text-[11px] font-semibold text-slate-500">EMA</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setAllEma(!emaAllOn)}
              aria-pressed={emaAnyOn}
              className="min-h-11 rounded-md px-2 text-[11px] text-slate-300 hover:bg-slate-800/70"
            >
              {emaAllOn ? 'ปิดทั้งหมด' : 'เปิดทั้งหมด'}
            </button>
            <InfoHint term="ema" align="end" />
          </div>
        </div>
        <CheckRow label="EMA 20" checked={preferences.ema20} onToggle={() => onToggle('ema20')} />
        <CheckRow label="EMA 50" checked={preferences.ema50} onToggle={() => onToggle('ema50')} />
        <CheckRow label="EMA 100" checked={preferences.ema100} onToggle={() => onToggle('ema100')} />
        <CheckRow label="EMA 200" checked={preferences.ema200} onToggle={() => onToggle('ema200')} />
        <div className="mt-1 border-t border-slate-800 pt-1">
          <CheckRow label="RSI (14)" checked={preferences.rsi} onToggle={() => onToggle('rsi')} hint={<InfoHint term="rsi" align="end" />} />
          <CheckRow label="MACD (12, 26, 9)" checked={preferences.macd} onToggle={() => onToggle('macd')} hint={<InfoHint term="macd" align="end" />} />
        </div>
      </Menu>

      <button
        type="button"
        aria-pressed={preferences.supportResistance}
        onClick={() => onToggle('supportResistance')}
        className={`${TOGGLE_BASE} ${preferences.supportResistance ? ON : OFF}`}
        data-testid="toggle-sr"
      >
        S/R
      </button>
      <button
        type="button"
        aria-pressed={preferences.vpvr}
        onClick={() => onToggle('vpvr')}
        className={`${TOGGLE_BASE} ${preferences.vpvr ? ON : OFF}`}
        data-testid="toggle-vpvr"
      >
        VPVR
      </button>
      <button
        type="button"
        aria-pressed={preferences.options}
        disabled={!optionsAvailable}
        onClick={() => onToggle('options')}
        className={`${TOGGLE_BASE} ${preferences.options ? ON : OFF} disabled:cursor-not-allowed disabled:opacity-40`}
        data-testid="toggle-options"
      >
        Options
      </button>
      <button
        type="button"
        onClick={onResetView}
        className={`${TOGGLE_BASE} ${OFF} ml-auto`}
        data-testid="reset-view"
      >
        ↻ รีเซ็ต
      </button>
    </div>
  );
}

export default ChartToolbar;
