'use client';

import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { MarketDataEnvelope, SymbolSearchResult } from '@/src/lib/market-data/types';
import { normalizeSymbolInput } from './focus';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';

export function nextSymbolIndex(current: number, key: 'ArrowDown' | 'ArrowUp', count: number): number {
  if (count === 0) return -1;
  if (key === 'ArrowDown') return current >= count - 1 ? 0 : current + 1;
  return current <= 0 ? count - 1 : current - 1;
}

export type SymbolKeyDecision = { action: 'ignore' } | { action: 'move'; index: number } | { action: 'select'; index: number } | { action: 'close' };
export function symbolKeyDecision(key: string, open: boolean, activeIndex: number, count: number): SymbolKeyDecision {
  if (!open) return { action: 'ignore' };
  if (key === 'Escape') return { action: 'close' };
  if (key === 'ArrowDown' || key === 'ArrowUp') return { action: 'move', index: nextSymbolIndex(activeIndex, key, count) };
  if (key === 'Enter' && activeIndex >= 0 && activeIndex < count) return { action: 'select', index: activeIndex };
  return { action: 'ignore' };
}

interface Props { value: string; onChange: (value: string) => void; error?: string; label?: string; placeholder?: string }

export const SymbolPreview = forwardRef<HTMLInputElement, Props>(function SymbolPreview({
  value, onChange, error, label = 'Symbol', placeholder = 'เช่น NVDA',
}, forwardedRef) {
  const listId = useId();
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [warning, setWarning] = useState('');
  const request = useRef(0);

  useEffect(() => {
    const query = value.trim();
    if (!query || !open) { setResults([]); setLoading(false); return; }
    const requestId = ++request.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/market/search?q=${encodeURIComponent(query)}&includeDelisted=true&limit=8`, { signal: controller.signal });
        const payload = await response.json() as MarketDataEnvelope<SymbolSearchResult[]>;
        if (requestId !== request.current || !response.ok || !payload.data) return;
        setResults(payload.data.slice(0, 8)); setActiveIndex(-1);
      } catch {
        if (!controller.signal.aborted && requestId === request.current) setResults([]);
      } finally {
        if (requestId === request.current) setLoading(false);
      }
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [value, open]);

  function choose(result: SymbolSearchResult) {
    if (result.status === 'delisted') { setWarning('Symbol นี้ถูก delisted แล้ว จึงไม่สามารถเพิ่มรายการใหม่ได้'); return; }
    setWarning('');
    onChange(result.symbol.toUpperCase()); setOpen(false); setResults([]); setActiveIndex(-1);
  }
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const decision = symbolKeyDecision(event.key, open, activeIndex, results.length);
    if (decision.action === 'close') {
      event.preventDefault(); event.stopPropagation(); setOpen(false); setActiveIndex(-1); return;
    }
    if (decision.action === 'move') {
      event.preventDefault(); setActiveIndex(decision.index); return;
    }
    if (decision.action === 'select') {
      event.preventDefault(); choose(results[decision.index]);
    }
  }

  return <label className="relative block text-sm font-medium text-slate-200">{label}
    <input ref={forwardedRef} value={value} onChange={(event) => { onChange(normalizeSymbolInput(event.target.value)); setWarning(''); setOpen(true); }}
      onFocus={() => setOpen(true)} onBlur={() => window.setTimeout(() => setOpen(false), 100)} onKeyDown={handleKeyDown}
      role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={20} placeholder={placeholder} className="form-input mt-1.5" />
    {error && <span className="mt-1 block text-xs text-red-400">{error}</span>}
    {warning && <span className="mt-1 block text-xs text-amber-300" role="alert">{warning}</span>}
    {open && value.trim() && <div id={listId} role="listbox" className="absolute z-[70] mt-1 max-h-60 w-full overflow-y-auto overscroll-contain rounded-xl border border-slate-700 bg-slate-950 shadow-2xl">
      {loading && <p className="p-3 text-xs text-slate-400">กำลังค้นหา…</p>}
      {!loading && results.length === 0 && <p className="p-3 text-xs text-slate-500">พิมพ์ Symbol ต่อได้ หรือเลือกเมื่อพบผลลัพธ์</p>}
      {!loading && results.map((result, index) => <button type="button" role="option" aria-selected={index === activeIndex} aria-disabled={result.status === 'delisted'} id={`${listId}-${index}`} key={`${result.symbol}-${result.exchange ?? ''}`}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(result)} onMouseEnter={() => setActiveIndex(index)}
        className={`flex min-h-14 w-full min-w-0 items-center gap-3 border-b border-slate-800 px-3 py-2 text-left last:border-0 ${index === activeIndex ? 'bg-slate-800' : 'hover:bg-slate-900'}`}>
        <InstrumentLogo symbol={result.symbol} companyName={result.name} logoUrl={result.logoUrl ?? null} size={36} />
        <span className="w-20 shrink-0 font-bold text-white">{result.symbol}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs text-slate-200">{result.name}</span><span className="block truncate text-[11px] text-slate-500">{result.exchange ?? 'ไม่ระบุตลาด'} · {result.assetType}</span></span>{result.status === 'delisted' && <span className="rounded bg-amber-500/15 px-2 py-1 text-[10px] font-bold text-amber-300">DELISTED</span>}
      </button>)}
    </div>}
  </label>;
});
