'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Star, X } from 'lucide-react';
import type { CandleInterval, CandleRange } from '@/src/lib/market-data/candles/contracts';
import {
  INTERVAL_GROUP_LABEL,
  RANGE_OPTIONS,
  RANGE_SECTION_LABEL,
  intervalOption,
  intervalsByGroup,
  isRangeEnabled,
  rangeOption,
  unsupportedReason,
  type IntervalGroup,
} from '@/src/lib/analytics/timeframe';
import { DESKTOP_QUERY, useMediaQuery } from '@/src/hooks/useMediaQuery';
import { useHydrated } from '@/src/hooks/useHydrated';
import { resolveAnchoredPanel } from '@/src/components/ui/anchored-panel';

const GROUPS: IntervalGroup[] = ['minute', 'hour', 'day'];
const PANEL_WIDTH = 288;
const PANEL_MAX_HEIGHT = 520;
const PANEL_MIN_HEIGHT = 200;

export interface TimeframeSelectorProps {
  interval: CandleInterval;
  range: CandleRange;
  favoriteIntervals: readonly CandleInterval[];
  favoriteRanges: readonly CandleRange[];
  onSelectInterval(interval: CandleInterval): void;
  onSelectRange(range: CandleRange): void;
  onToggleFavoriteInterval(interval: CandleInterval): void;
  onToggleFavoriteRange(range: CandleRange): void;
}

interface PanelPosition { top: number; left: number; width: number; maxHeight: number; }

function FavoriteButton({ active, label, onToggle }: { active: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      // Favourites are presentation state only: toggling one never asks the
      // provider for anything.
      onClick={(event) => { event.stopPropagation(); onToggle(); }}
      aria-pressed={active}
      aria-label={active ? `นำ ${label} ออกจากรายการโปรด` : `${label} เพิ่มเป็นรายการโปรด`}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate-500 hover:text-[#D4FF00] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
    >
      <Star aria-hidden="true" size={15} fill={active ? '#D4FF00' : 'none'} stroke={active ? '#D4FF00' : 'currentColor'} />
    </button>
  );
}

function OptionRow({
  label,
  selected,
  disabled,
  disabledReason,
  favorite,
  onSelect,
  onToggleFavorite,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  favorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        data-timeframe-option="true"
        role="option"
        aria-selected={selected}
        disabled={disabled}
        title={disabled ? disabledReason ?? undefined : undefined}
        aria-label={selected ? `${label} เลือกอยู่` : label}
        onClick={onSelect}
        className={`flex min-h-11 flex-1 items-center justify-between gap-2 rounded-md px-3 text-left text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00] ${
          selected
            ? 'bg-[#D4FF00]/15 font-semibold text-[#D4FF00]'
            : 'text-slate-200 hover:bg-slate-800/70'
        } ${disabled ? 'cursor-not-allowed opacity-35 hover:bg-transparent' : ''}`}
      >
        <span className="min-w-0 truncate">{label}</span>
        {selected && <span aria-hidden="true" className="text-xs">●</span>}
      </button>
      <FavoriteButton active={favorite} label={label} onToggle={onToggleFavorite} />
    </div>
  );
}

/**
 * Timeframe picker.
 *
 * Candle **interval** and historical **range** are two separate sections and two
 * separate favourite lists — the popup never lets one be mistaken for the other.
 * "12 เดือน" lives under ช่วงข้อมูล and selects the canonical `1y` range key; it is
 * not, and cannot become, a twelve-month candle.
 *
 * Desktop/tablet renders a collision-aware anchored popover; phones get a
 * full-width bottom sheet. Both share the same content, the same keyboard model
 * (arrows move, Enter/Space select, Escape closes and restores focus) and the
 * same ≥44px touch targets.
 */
export function TimeframeSelector({
  interval,
  range,
  favoriteIntervals,
  favoriteRanges,
  onSelectInterval,
  onSelectRange,
  onToggleFavoriteInterval,
  onToggleFavoriteRange,
}: TimeframeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  // The portal must never exist in the server markup, so it can only appear
  // after hydration and an explicit open.
  const mounted = useHydrated();
  const titleId = `timeframe-title-${useId().replaceAll(':', '')}`;

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Selecting the value that is already active must not restart the chart's data
  // pipeline, so the handler closes without emitting a change.
  const selectInterval = useCallback((next: CandleInterval) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (next !== interval) onSelectInterval(next);
  }, [interval, onSelectInterval]);
  const selectRange = useCallback((next: CandleRange) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (next !== range) onSelectRange(next);
  }, [range, onSelectRange]);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || !desktop) return;
    const rect = trigger.getBoundingClientRect();
    // Shared collision rules: flip when below is cramped, clamp to every viewport
    // edge, and cap the height at the room that exists so the list — not the
    // page — is what scrolls.
    setPosition(resolveAnchoredPanel({
      rect,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      width: PANEL_WIDTH,
      preferredMaxHeight: PANEL_MAX_HEIGHT,
      minHeight: PANEL_MIN_HEIGHT,
    }));
  }, [desktop]);

  useLayoutEffect(() => {
    if (!open || !desktop) return;
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, desktop, reposition]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      const panel = panelRef.current;
      if (!panel) return;
      const options = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-timeframe-option]:not([disabled])'));
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!options.length) return;
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const next = current === -1 ? 0 : (current + step + options.length) % options.length;
        options[next].focus();
        return;
      }
      if (event.key !== 'Tab' || !panel.contains(document.activeElement)) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('[data-timeframe-option][aria-selected="true"]')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // `min-h-0` lets this box shrink to its parent's max-height; an auto flex basis
  // then makes the pinned header/favourites and the scrolling list share exactly
  // that height.
  const content = (
    <div ref={panelRef} role="dialog" aria-modal={!desktop} aria-labelledby={titleId} className="flex min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-slate-800 px-3">
        <h2 id={titleId} className="text-xs font-semibold uppercase tracking-wide text-slate-400">เลือก Timeframe</h2>
        <button
          type="button"
          onClick={close}
          aria-label="ปิดหน้าต่างเลือก Timeframe"
          className="flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
        >
          <X aria-hidden="true" size={17} />
        </button>
      </div>

      {/*
        Header and favourites are pinned: they are the quick path, so they must
        never scroll out of reach. Only the grouped list below them scrolls.
      */}
      {(favoriteIntervals.length > 0 || favoriteRanges.length > 0) && (
        <section aria-label="รายการโปรด" className="shrink-0 border-b border-slate-800 px-2 py-2" data-testid="timeframe-favorites">
          <h3 className="px-1 pb-1 text-[11px] font-semibold text-slate-500">รายการโปรด</h3>
          <div className="flex flex-wrap gap-1">
            {favoriteIntervals.map((id) => (
              <button
                key={`fav-interval-${id}`}
                type="button"
                onClick={() => selectInterval(id)}
                aria-label={id === interval ? `${intervalOption(id).label} เลือกอยู่` : intervalOption(id).label}
                className={`min-h-11 min-w-11 rounded-md border px-2.5 font-mono text-xs ${
                  id === interval ? 'border-[#D4FF00] bg-[#D4FF00]/15 text-[#D4FF00]' : 'border-slate-700 text-slate-200'
                }`}
              >
                {intervalOption(id).short}
              </button>
            ))}
            {favoriteRanges.map((id) => (
              <button
                key={`fav-range-${id}`}
                type="button"
                onClick={() => selectRange(id)}
                aria-label={id === range ? `${rangeOption(id).label} เลือกอยู่` : rangeOption(id).label}
                className={`min-h-11 min-w-11 rounded-md border px-2.5 font-mono text-xs ${
                  id === range ? 'border-sky-400 bg-sky-400/15 text-sky-300' : 'border-slate-700 text-slate-300'
                }`}
              >
                {rangeOption(id).short}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" data-testid="timeframe-scroll-area">
        {GROUPS.map((group) => (
          <section key={group} role="listbox" aria-label={`แท่งเทียน ${INTERVAL_GROUP_LABEL[group]}`} className="mb-1 border-b border-slate-800 pb-1 last-of-type:border-0">
            <h3 className="px-1 pb-1 text-[11px] font-semibold text-slate-500">{INTERVAL_GROUP_LABEL[group]}</h3>
            {intervalsByGroup(group).map((option) => (
              <OptionRow
                key={option.id}
                label={option.label}
                selected={option.id === interval}
                favorite={favoriteIntervals.includes(option.id)}
                onSelect={() => selectInterval(option.id)}
                onToggleFavorite={() => onToggleFavoriteInterval(option.id)}
              />
            ))}
          </section>
        ))}

        <section role="listbox" aria-label={RANGE_SECTION_LABEL} className="pt-1">
          <h3 className="px-1 pb-1 text-[11px] font-semibold text-slate-500">
            {RANGE_SECTION_LABEL}
            <span className="ml-1 font-normal text-slate-600">· ความยาวข้อมูลย้อนหลัง ไม่ใช่ขนาดแท่งเทียน</span>
          </h3>
          {RANGE_OPTIONS.map((option) => {
            const enabled = isRangeEnabled(interval, option.id);
            return (
              <OptionRow
                key={option.id}
                label={option.label}
                selected={option.id === range}
                disabled={!enabled}
                disabledReason={unsupportedReason(interval, option.id)}
                favorite={favoriteRanges.includes(option.id)}
                onSelect={() => selectRange(option.id)}
                onToggleFavorite={() => onToggleFavoriteRange(option.id)}
              />
            );
          })}
        </section>
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="timeframe-trigger"
        className="flex min-h-11 items-center gap-1.5 rounded-md border border-slate-700 bg-slate-900 px-3 font-mono text-xs font-semibold text-slate-100 hover:border-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
      >
        <span>{intervalOption(interval).short}</span>
        <span aria-hidden="true" className="text-slate-600">·</span>
        <span className="text-sky-300">{rangeOption(range).short}</span>
        <ChevronDown aria-hidden="true" size={14} />
      </button>

      {mounted && open && desktop && position && createPortal(
        // `flex` is load-bearing, not decoration: the panel body is only bounded
        // by `maxHeight` when it is a flex item of this box. As a plain block
        // child it kept its full content height, the inner `overflow-y-auto` had
        // nothing to overflow, and the surplus was simply clipped by
        // `overflow-hidden` — the list could not be scrolled or reached at all.
        <div
          style={{ position: 'fixed', top: position.top, left: position.left, width: position.width, maxHeight: position.maxHeight }}
          className="z-[110] flex flex-col overflow-hidden rounded-xl border border-slate-700 bg-[#0F1420] shadow-2xl"
          data-testid="timeframe-popover"
        >
          {content}
        </div>,
        document.body,
      )}

      {mounted && open && !desktop && createPortal(
        <div
          className="fixed inset-0 z-[110] flex items-end bg-black/70"
          data-testid="timeframe-sheet-backdrop"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}
        >
          <div
            className="flex max-h-[min(80dvh,100%)] w-full min-w-0 flex-col overflow-hidden rounded-t-2xl border-t border-slate-700 bg-[#0F1420] pb-[env(safe-area-inset-bottom)]"
            data-testid="timeframe-sheet"
          >
            {content}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export default TimeframeSelector;
