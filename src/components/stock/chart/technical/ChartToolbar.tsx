'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { InfoHint } from '@/src/components/ui/InfoHint';
import { LockedFeatureButton } from '@/src/components/subscription/LockedFeatureButton';
import { resolveAnchoredPanel, type AnchoredPanelPlacement } from '@/src/components/ui/anchored-panel';
import { useHydrated } from '@/src/hooks/useHydrated';
import type { CandleInterval, CandleRange } from '@/src/lib/market-data/candles/contracts';
import type { ChartDisplayType, ChartPreferences } from '@/src/lib/analytics/timeframe';
import { CHART_TYPE_OPTIONS, chartTypeOption } from '@/src/lib/analytics/chart-types/catalog';
import { TimeframeSelector } from './TimeframeSelector';

export type ToolbarToggleKey = Extract<
  keyof ChartPreferences,
  'ema20' | 'ema50' | 'ema100' | 'ema200' | 'rsi' | 'macd' | 'vpvr' | 'supportResistance' | 'options'
>;

const TOGGLE_BASE = 'min-h-11 rounded-md border px-3 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]';
const ON = 'border-[#D4FF00] bg-[#D4FF00]/15 text-[#D4FF00]';
const OPTIONS_ON = 'border-[#D4FF00]/50 bg-[#D4FF00]/[.06] text-slate-100';
const OFF = 'border-slate-700 bg-slate-900 text-slate-300 hover:border-slate-500';

/** Wide enough to contain an InfoHint popover (`w-64`), so no row can push a
 *  horizontal scrollbar inside the menu. */
const MENU_WIDTH = 288;
const MENU_MAX_HEIGHT = 420;

/**
 * A compact anchored menu that closes on outside click, Escape and selection.
 *
 * The panel is portalled to `document.body` and positioned as `fixed`. Anchored
 * absolutely inside the toolbar it was clipped by the chart card's
 * `overflow-hidden`, and its `right-0`/`100vw` sizing could reach past the card
 * and widen the page — the source of the stray horizontal scrollbar. Fixed
 * placement resolved against the real viewport can do neither.
 */
function Menu({ label, testId, children }: { label: ReactNode; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<AnchoredPanelPlacement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mounted = useHydrated();

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    setPlacement(resolveAnchoredPanel({
      rect: trigger.getBoundingClientRect(),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      width: MENU_WIDTH,
      preferredMaxHeight: MENU_MAX_HEIGHT,
      minHeight: 180,
    }));
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div className="relative">
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
      {mounted && open && placement && createPortal(
        <div
          ref={panelRef}
          role="menu"
          style={{ position: 'fixed', top: placement.top, left: placement.left, width: placement.width, maxHeight: placement.maxHeight }}
          // `pr-3.5` is the InfoHint's tap target, not decoration: its ⓘ expands to
          // ≥44px with an absolutely positioned `-inset-[13px]` pseudo-element, and
          // at the row's right edge that reached 5px past an 8px padding. In a
          // scroll container (overflow-y:auto forces overflow-x:auto) those 5px
          // became a horizontal scrollbar inside the menu.
          className="z-[110] overflow-y-auto overscroll-contain rounded-xl border border-slate-700 bg-[#0F1420] p-2 pr-3.5 shadow-2xl"
          data-testid={`${testId}-menu`}
        >
          {children}
        </div>,
        document.body,
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
  /** Whether options exist on this instrument. False removes the toggle. */
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

      {/*
        Every drawable form comes from the shared chart-type catalog, so the menu,
        the persisted preference and the series factory can never disagree.
        Switching one is pure presentation: it re-draws bars already in memory.
      */}
      <Menu testId="chart-type-trigger" label={chartTypeOption(preferences.chartType).short}>
        {CHART_TYPE_OPTIONS.map((option) => (
          <div key={option.id} className="flex items-center gap-1">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={preferences.chartType === option.id}
              onClick={() => onChartType(option.id)}
              data-testid={`chart-type-${option.id}`}
              className={`flex min-h-11 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm ${preferences.chartType === option.id ? 'text-[#D4FF00]' : 'text-slate-200'} hover:bg-slate-800/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]`}
            >
              <span aria-hidden="true" className="w-3 shrink-0 text-xs">{preferences.chartType === option.id ? '●' : ''}</span>
              <span className="min-w-0 truncate">{option.label}</span>
            </button>
            {option.id === 'heikin-ashi' && <InfoHint term="heikinAshi" align="end" />}
          </div>
        ))}
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

      {/*
        A locked overlay keeps its button rather than losing it. The control is
        still there, still labelled, and carries a padlock; pressing it opens the
        upgrade prompt instead of switching the overlay on. Because the toggle
        never flips, the calculation behind it never runs.
      */}
      <div className="flex shrink-0 items-center gap-1" data-testid="overlay-toggles">
        <button
          type="button"
          aria-pressed={preferences.supportResistance}
          onClick={() => onToggle('supportResistance')}
          className={`${TOGGLE_BASE} px-2.5 ${preferences.supportResistance ? ON : OFF}`}
          data-testid="toggle-sr"
        >
          S/R
        </button>
        <LockedFeatureButton
          capability="chart.vpvr"
          source="chart.toolbar-vpvr"
          pressed={preferences.vpvr}
          onActivate={() => onToggle('vpvr')}
          className={`${TOGGLE_BASE} px-2.5 ${preferences.vpvr ? ON : OFF}`}
          data-testid="toggle-vpvr"
        >
          VPVR
        </LockedFeatureButton>
        {/*
          Not rendered at all when nothing lists options on this instrument.
          It used to be rendered disabled, which reads as "you cannot use this
          yet" — an upgrade or a loading state — when the truth is that there
          are no contracts on a barrel of crude for anybody, at any tier, ever.
          A control that can never be enabled is not a control.
        */}
        {optionsAvailable && (
          <LockedFeatureButton
            capability="options.chain.basic"
            source="chart.toolbar-options"
            pressed={preferences.options}
            onActivate={() => onToggle('options')}
            className={`${TOGGLE_BASE} px-2.5 ${preferences.options ? OPTIONS_ON : OFF}`}
            data-testid="toggle-options"
          >
            Options
          </LockedFeatureButton>
        )}
      </div>
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
