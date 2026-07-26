'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, RefreshCw } from 'lucide-react';
import { DataProvenance } from '@/src/components/market-data/DataProvenance';
import { Button } from '@/src/components/ui/Button';
import { Select } from '@/src/components/ui/Select';
import { useAppActive } from '@/src/hooks/useAppActive';
import { calculateAtmIv, calculateExpectedMove, calculateOiConcentration } from '@/src/lib/market-data/options/analytics';
import type { OptionContract, OptionsChain, OptionsExpirations } from '@/src/lib/market-data/options/contracts';
import { optionIntrinsicValue, optionMarketQuote } from '@/src/lib/market-data/quote-model';
import { MarketTracer } from '@/src/lib/market-data/realtime';
import { parseStrikeLines, type StrikeLine } from '@/src/lib/analytics/chart-layers/strike-lines';
import type { MarketDataLabel } from '@/src/lib/stock-detail/market-source';
import { optionsChainCoordinator, optionsExpirationsCoordinator } from '@/src/lib/stock-detail/options-source';

const optionsTracer = new MarketTracer();

interface StrikeRow {
  strike: number;
  call: OptionContract | null;
  put: OptionContract | null;
}

const ROW_HEIGHT = 76;
const VIEWPORT_HEIGHT = 456;
const OVERSCAN = 3;

function finite(value: number | null, digits = 2): string {
  return value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function moneyness(contract: OptionContract | null, spot: number): string {
  if (!contract) return '—';
  const distance = Math.abs(contract.strike - spot) / spot;
  if (distance <= 0.0025) return 'ATM';
  const inTheMoney = contract.type === 'call' ? spot > contract.strike : spot < contract.strike;
  return inTheMoney ? 'ITM' : 'OTM';
}

function OptionCell({ contract, spot, onOpen, onStrike }: {
  contract: OptionContract | null;
  spot: number;
  onOpen: (contract: OptionContract) => void;
  onStrike: (contract: OptionContract) => void;
}) {
  if (!contract) return <div className="min-w-[290px] px-3 py-2 text-center text-slate-600">—</div>;
  const quote = optionMarketQuote(contract);
  const intrinsic = optionIntrinsicValue(contract, spot);
  const greekValues = [contract.delta, contract.gamma, contract.theta, contract.vega, contract.rho];
  return <div className="min-w-[290px] px-3 py-2 text-xs">
    <div className="flex items-center justify-between gap-2"><span className={moneyness(contract, spot) === 'ITM' ? 'font-semibold text-emerald-300' : moneyness(contract, spot) === 'ATM' ? 'font-semibold text-[#D4FF00]' : 'text-slate-400'}>{contract.type.toUpperCase()} · {moneyness(contract, spot)}</span><span className="truncate font-mono text-[10px] text-slate-500">{contract.contractSymbol}</span></div>
    <div className="mt-1 grid grid-cols-4 gap-2 font-mono"><span title="Bid">Bid {finite(quote.bid)}</span><span title="Ask">Ask {finite(quote.ask)}</span><span title="Midpoint">Mid {finite(quote.midpoint)}</span><span title="Market Last">Last {finite(quote.last)}</span><span title="Volume">Vol {finite(quote.volume, 0)}</span><span title="Open interest">OI {finite(quote.openInterest, 0)}</span><span title="Implied volatility">IV {quote.impliedVolatility === null ? '—' : `${finite(quote.impliedVolatility * 100)}%`}</span><span title="Intrinsic value">Int {finite(intrinsic)}</span></div>
    <div className="mt-1 flex items-center justify-between gap-2"><span className="text-[10px] text-slate-500">{greekValues.some((value) => value !== null) ? `Δ ${finite(contract.delta, 4)} · Γ ${finite(contract.gamma, 4)} · Θ ${finite(contract.theta, 4)}` : 'Greeks unavailable'}</span><span className="flex gap-1"><button type="button" onClick={() => onStrike(contract)} className="min-h-8 rounded border border-slate-700 px-2 text-sky-300">Strike line</button><button type="button" onClick={() => onOpen(contract)} className="min-h-8 rounded border border-[#D4FF00]/40 px-2 text-[#D4FF00]">Simulator</button></span></div>
  </div>;
}

function VirtualOptionsTable({ rows, spot, expectedMove, onOpen, onStrike }: {
  rows: StrikeRow[];
  spot: number;
  expectedMove?: { lower: number | null; upper: number | null };
  onOpen: (contract: OptionContract) => void;
  onStrike: (contract: OptionContract) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, start + visibleCount + OVERSCAN * 2);
  const shown = rows.slice(start, end);
  const onScroll = (event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop);
  return <div className="overflow-x-auto rounded-xl border border-slate-700">
    <div className="min-w-[760px]"><div className="sticky top-0 z-20 grid grid-cols-[1fr_110px_1fr] border-b border-slate-700 bg-slate-900 px-1 py-2 text-center text-xs font-semibold text-slate-300"><span>Call</span><span>Strike</span><span>Put</span></div>
      <div style={{ height: Math.min(VIEWPORT_HEIGHT, rows.length * ROW_HEIGHT) }} className="overflow-y-auto" onScroll={onScroll} aria-label="Virtualized options chain">
        <div style={{ height: start * ROW_HEIGHT }} />
        {shown.map((row) => { const outsideExpectedMove = expectedMove?.lower !== null && expectedMove?.lower !== undefined && expectedMove.upper !== null && expectedMove.upper !== undefined && (row.strike < expectedMove.lower || row.strike > expectedMove.upper); return <div key={row.strike} style={{ height: ROW_HEIGHT }} className={`grid grid-cols-[1fr_110px_1fr] border-b border-slate-800 ${Math.abs(row.strike - spot) / spot <= 0.0025 ? 'bg-[#D4FF00]/5' : ''}`}>
          <OptionCell contract={row.call} spot={spot} onOpen={onOpen} onStrike={onStrike} />
          <div className="sticky left-0 flex flex-col items-center justify-center border-x border-slate-700 bg-slate-950/95 font-mono font-bold text-white"><span>${finite(row.strike)}</span>{outsideExpectedMove && <span className="mt-1 text-center text-[8px] font-normal text-amber-300">อยู่นอกกรอบ Expected Move</span>}</div>
          <OptionCell contract={row.put} spot={spot} onOpen={onOpen} onStrike={onStrike} />
        </div>; })}
        <div style={{ height: Math.max(0, (rows.length - end) * ROW_HEIGHT) }} />
      </div>
    </div>
  </div>;
}

function errorLabel(code: string | undefined): string {
  if (code === 'forbidden' || code === 'entitlement-required') return 'ข้อมูลออปชันยังไม่พร้อมใช้งาน';
  if (code === 'rate-limited') return 'ข้อมูลออปชันถูกจำกัดชั่วคราว กรุณาลองใหม่ภายหลัง';
  if (code === 'provider-not-configured') return 'ยังไม่ได้ตั้งค่าผู้ให้บริการ Options';
  if (code === 'unsupported') return 'ผู้ให้บริการนี้ไม่รองรับ Options Chain';
  return 'ข้อมูลออปชันยังไม่พร้อมใช้งาน';
}

export function OptionsChainPanel({ symbol, acceptedPrice, underlyingLabel }: {
  symbol: string;
  acceptedPrice: number | null;
  underlyingLabel: MarketDataLabel | null;
}) {
  const router = useRouter();
  const appActive = useAppActive();
  const [expirations, setExpirations] = useState<OptionsExpirations | null>(null);
  const [expiration, setExpiration] = useState('');
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [strikeRange, setStrikeRange] = useState(20);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(0);
  const [saveData] = useState(() => typeof navigator !== 'undefined' && Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData));
  const [userStarted, setUserStarted] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const requestExpirations = useCallback(async () => {
    if (!navigator.onLine) { setError({ code: 'offline', message: 'ออฟไลน์อยู่ จึงไม่เรียกผู้ให้บริการ' }); return; }
    const requestGeneration = ++generation.current;
    setLoading(true); setError(null);
    try {
      const outcome = await optionsExpirationsCoordinator.load(symbol);
      if (!outcome.ok) {
        const retry = outcome.retryAfterSeconds ?? 0;
        if (retry > 0) { const deadline = Date.now() + retry * 1_000; setNow(Date.now()); setCooldownUntil(deadline); }
        throw Object.assign(new Error(errorLabel(outcome.classification?.reason)), { code: outcome.classification?.reason });
      }
      if (generation.current !== requestGeneration) return;
      if (!outcome.data) throw Object.assign(new Error('Expiration response validation failed'), { code: 'invalid-response' });
      setExpirations(outcome.data);
      setExpiration((current) => outcome.expirations.includes(current) ? current : '');
      if (!outcome.expirations.length) setError({ code: 'not-found', message: 'ไม่พบวันหมดอายุจริงจากผู้ให้บริการ' });
    } catch (cause) {
      if (generation.current !== requestGeneration) return;
      setExpirations(null); setChain(null);
      setError({ code: (cause as { code?: string }).code, message: cause instanceof Error ? cause.message : 'Options expirations unavailable' });
    } finally { if (generation.current === requestGeneration) setLoading(false); }
  }, [symbol]);

  const requestChain = useCallback(async (targetExpiration: string, force = false) => {
    if (!targetExpiration || !navigator.onLine || (!force && Date.now() < cooldownUntil)) return;
    const requestGeneration = ++generation.current;
    setLoading(true); setError(null); setChain(null);
    try {
      if (force && !optionsChainCoordinator.reset(symbol, targetExpiration)) return;
      const outcome = await optionsChainCoordinator.load(symbol, targetExpiration, acceptedPrice);
      if (!outcome.ok || !outcome.chain) {
        const retry = outcome.retryAfterSeconds ?? 0;
        if (retry > 0) { const deadline = Date.now() + retry * 1_000; setNow(Date.now()); setCooldownUntil(deadline); }
        throw Object.assign(new Error(errorLabel(outcome.classification?.reason)), { code: outcome.classification?.reason });
      }
      if (generation.current !== requestGeneration) return;
      setChain(outcome.chain); setCooldownUntil(0); setNow(Date.now());
    } catch (cause) {
      if (generation.current !== requestGeneration) return;
      setError({ code: (cause as { code?: string }).code, message: cause instanceof Error ? cause.message : 'Options chain unavailable' });
    } finally { if (generation.current === requestGeneration) setLoading(false); }
  }, [acceptedPrice, cooldownUntil, symbol]);

  useEffect(() => {
    if (!appActive || (saveData && !userStarted) || expirations || error) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void requestExpirations(); });
    return () => { cancelled = true; };
  }, [appActive, error, expirations, requestExpirations, saveData, userStarted]);
  useEffect(() => {
    if (!appActive || !expiration || chain?.expiration === expiration || error) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) void requestChain(expiration); });
    return () => { cancelled = true; };
  }, [appActive, chain?.expiration, error, expiration, now, requestChain]);

  const spot = acceptedPrice !== null && Number.isFinite(acceptedPrice) && acceptedPrice > 0
    ? acceptedPrice
    : null;
  const canonicalChain = useMemo(() => {
    if (!chain || spot === null) return null;
    const underlyingStatus: NonNullable<OptionsChain['underlyingStatus']> = underlyingLabel?.mode === 'REAL-TIME' ? 'live'
      : underlyingLabel?.mode === 'CACHED' ? 'cached'
        : underlyingLabel?.mode === 'STALE' ? 'stale'
          : underlyingLabel?.mode === 'UNAVAILABLE' ? 'unavailable'
            : 'delayed';
    return {
      ...chain,
      spot,
      underlyingProvider: underlyingLabel?.provider ?? chain.underlyingProvider ?? null,
      underlyingAsOf: underlyingLabel?.exchangeTimestamp ?? chain.underlyingAsOf ?? null,
      underlyingStatus,
    };
  }, [chain, spot, underlyingLabel]);
  useEffect(() => {
    if (spot === null || !underlyingLabel) return;
    const exchangeTimestampMs = underlyingLabel.exchangeTimestamp
      ? Date.parse(underlyingLabel.exchangeTimestamp)
      : Number.NaN;
    optionsTracer.trace({
      stage: 'options_underlying_updated', symbol, price: spot,
      exchangeTimestampMs: Number.isFinite(exchangeTimestampMs) ? exchangeTimestampMs : undefined,
    });
  }, [spot, symbol, underlyingLabel]);
  const rows = useMemo(() => {
    if (!canonicalChain) return [];
    const lower = canonicalChain.spot * (1 - strikeRange / 100);
    const upper = canonicalChain.spot * (1 + strikeRange / 100);
    const byStrike = new Map<number, StrikeRow>();
    for (const contract of [...canonicalChain.calls, ...canonicalChain.puts]) {
      if (contract.strike < lower || contract.strike > upper) continue;
      const row = byStrike.get(contract.strike) ?? { strike: contract.strike, call: null, put: null };
      row[contract.type] = contract;
      byStrike.set(contract.strike, row);
    }
    return [...byStrike.values()].sort((left, right) => left.strike - right.strike);
  }, [canonicalChain, strikeRange]);
  const analytics = useMemo(() => canonicalChain ? {
    atm: calculateAtmIv(canonicalChain),
    expectedMove: calculateExpectedMove(canonicalChain),
    oi: calculateOiConcentration(canonicalChain),
  } : null, [canonicalChain]);
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1_000));

  const addChartLine = (line: StrikeLine) => {
    const key = `nexora:strike-lines:${symbol.toUpperCase()}:v1`;
    const current = parseStrikeLines(window.localStorage.getItem(key));
    window.localStorage.setItem(key, JSON.stringify([...current.filter((item) => item.id !== line.id), line]));
  };
  const addStrike = (contract: OptionContract) => {
    addChartLine({ id: `option:${contract.contractSymbol}`, price: contract.strike, label: `${contract.type === 'call' ? 'Call' : 'Put'} ${contract.expiration}`, optionType: contract.type, expiration: contract.expiration, visible: true });
  };
  const addExpectedMove = () => {
    if (!chain || !analytics || analytics.expectedMove.lower === null || analytics.expectedMove.upper === null) return;
    addChartLine({ id: `expected-move:${chain.expiration}:lower`, price: analytics.expectedMove.lower, label: `Expected Move lower ${chain.expiration}`, optionType: 'put', expiration: chain.expiration, visible: true });
    addChartLine({ id: `expected-move:${chain.expiration}:upper`, price: analytics.expectedMove.upper, label: `Expected Move upper ${chain.expiration}`, optionType: 'call', expiration: chain.expiration, visible: true });
  };
  const openSimulator = (contract: OptionContract) => {
    const query = new URLSearchParams({ symbol, expiration: contract.expiration, contract: contract.contractSymbol });
    if (spot !== null && underlyingLabel) {
      query.set('underlyingPrice', String(spot));
      query.set('underlyingMode', underlyingLabel.mode);
      if (underlyingLabel.provider) query.set('underlyingProvider', underlyingLabel.provider);
      if (underlyingLabel.exchangeTimestamp) query.set('underlyingAsOf', underlyingLabel.exchangeTimestamp);
    }
    router.push(`/tools/monte-carlo?${query.toString()}`);
  };

  if (saveData && !userStarted) return <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-5"><Activity className="text-sky-300"/><h2 className="mt-2 font-bold text-white">Options Chain</h2><p className="mt-2 text-sm text-slate-400">Data Saver เปิดอยู่ ระบบจึงรอให้คุณเริ่มโหลดข้อมูล Options โดยตรง</p><Button className="mt-3" onClick={() => { setUserStarted(true); setError(null); }}>โหลด Options Chain</Button></section>;

  return <section className="space-y-4 rounded-2xl border border-slate-800 bg-[#151B28] p-4 md:p-6" data-testid="options-chain-panel">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-bold text-white">Options Chain · {symbol}</h2><p className="mt-1 text-xs text-slate-400">ข้อมูลสัญญาจริงแบบอ่านอย่างเดียว พร้อม ATM IV, Expected Move และ OI concentration</p></div><Button variant="outline" disabled={loading || cooldown > 0 || !appActive} onClick={() => chain ? void requestChain(expiration, true) : void requestExpirations()}><RefreshCw size={14}/>{cooldown ? ` ${cooldown}s` : ' Refresh'}</Button></div>
    <DataProvenance status={chain?.status ?? expirations?.status ?? (error ? 'unavailable' : 'delayed')} provider={chain?.provider ?? expirations?.provider} asOf={chain?.asOf ?? expirations?.asOf} timestampKind={chain?.timestampKind ?? expirations?.timestampKind} delayedMinutes={chain?.delayedMinutes ?? expirations?.delayedMinutes} reason={error?.message ?? null}/>
    <p className="text-xs text-slate-400" data-testid="options-underlying-provenance">
      Underlying: {spot === null ? 'Unavailable' : `$${finite(spot)}`}
      {spot !== null ? ` · ${underlyingLabel?.provider ?? 'unknown source'} · ${underlyingLabel?.mode ?? 'UNAVAILABLE'} · ${underlyingLabel?.exchangeTimestamp ?? 'unknown time'}` : ''}
    </p>
    {error && <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200"><p>{error.message}</p><p className="mt-1 text-xs text-slate-400">ไม่มีการสร้างหรือเติม Options data ทดแทน</p><Button className="mt-3" variant="outline" disabled={loading || cooldown > 0} onClick={() => { setUserStarted(true); setError(null); }}>ลองใหม่</Button></div>}
    {loading && !chain && <div className="h-64 animate-pulse rounded-xl bg-slate-800/60" aria-label="Loading options chain"/>}
    {expirations && expirations.expirations.length > 0 && <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs text-slate-400">Expiration<Select className="mt-1" value={expiration} onChange={(event) => { setError(null); setExpiration(event.target.value); }}><option value="" disabled>เลือกวันหมดอายุ</option>{expirations.expirations.map((value) => <option key={value} value={value}>{value}</option>)}</Select></label><label className="text-xs text-slate-400">Strike range<Select className="mt-1" value={strikeRange} onChange={(event) => setStrikeRange(Number(event.target.value))}>{[5, 10, 20, 50].map((value) => <option key={value} value={value}>±{value}% around spot</option>)}</Select></label></div>}
    {chain && analytics && <>
      <div className="grid gap-3 md:grid-cols-3"><article className="rounded-xl border border-slate-700 p-3"><p className="text-xs text-slate-500">ATM IV</p><p className="mt-1 text-xl font-bold text-white">{analytics.atm.iv === null ? 'Unavailable' : `${finite(analytics.atm.iv * 100)}%`}</p><p className="mt-1 text-[10px] text-slate-400">robust median · {analytics.atm.sampledContracts.length} contracts · DTE {analytics.atm.dte} · confidence {finite(analytics.atm.confidence)}%</p></article>
        <article className="rounded-xl border border-slate-700 p-3"><p className="text-xs text-slate-500">Expected Move</p><p className="mt-1 text-xl font-bold text-white">{analytics.expectedMove.move === null ? 'Unavailable' : `±$${finite(analytics.expectedMove.move)} (${finite((analytics.expectedMove.movePercent ?? 0) * 100)}%)`}</p><p className="mt-1 text-[10px] text-slate-400">{analytics.expectedMove.lower === null ? 'No valid provider IV' : `$${finite(analytics.expectedMove.lower)} – $${finite(analytics.expectedMove.upper)}`}</p>{analytics.expectedMove.move !== null && <button type="button" onClick={addExpectedMove} className="mt-2 min-h-9 rounded border border-sky-500/30 px-2 text-xs text-sky-300">เพิ่มกรอบลงกราฟ</button>}</article>
        <article className="rounded-xl border border-slate-700 p-3"><p className="text-xs text-slate-500">Spot / Expiration</p><p className="mt-1 text-xl font-bold text-white">${finite(spot)}</p><p className="mt-1 text-[10px] text-slate-400">{chain.expiration} · completeness {finite(chain.completeness * 100)}%</p></article></div>
      <p className="rounded-lg bg-sky-500/5 p-3 text-xs text-sky-200">Expected Move เป็นกรอบความผันผวนเชิงสถิติ ราคาอาจอยู่นอกกรอบได้ และกรอบนี้ไม่ใช่การรับประกัน</p>
      <VirtualOptionsTable rows={rows} spot={spot!} expectedMove={analytics.expectedMove} onOpen={openSimulator} onStrike={addStrike}/>
      {rows.length === 0 && <p className="rounded-lg border border-amber-500/20 p-3 text-sm text-amber-200">ไม่มีสัญญาจริงในช่วง strike ที่เลือก</p>}
      <div className="grid gap-3 lg:grid-cols-2">{([['Call OI Concentration', analytics.oi.calls], ['Put OI Concentration', analytics.oi.puts]] as const).map(([title, levels]) => <article key={title} className="rounded-xl border border-slate-700 p-3"><h3 className="text-sm font-semibold text-white">{title}</h3><div className="mt-2 space-y-2">{levels.length ? levels.map((level) => <div key={level.contractSymbol} className="grid grid-cols-[repeat(5,minmax(0,1fr))_auto] items-center gap-2 rounded-lg bg-slate-950/50 p-2 text-xs"><span className="font-mono text-white">${finite(level.strike)}</span><span>OI {finite(level.openInterest, 0)}</span><span>Vol {finite(level.volume, 0)}</span><span>Dist ${finite(level.distance)}</span><span>Score {finite(level.score)}</span><button type="button" onClick={() => addChartLine({ id: `oi:${level.contractSymbol}`, price: level.strike, label: `${level.type === 'call' ? 'Call' : 'Put'} OI ${chain.expiration}`, optionType: level.type, expiration: chain.expiration, visible: true })} className="min-h-8 rounded border border-slate-700 px-2 text-sky-300">กราฟ</button></div>) : <p className="text-xs text-slate-500">Unavailable</p>}</div><p className="mt-2 text-[10px] text-slate-500">ระดับความกระจุกตัวเชิงสถิติ ไม่ใช่กำแพงราคาและไม่รับประกันการตอบสนองของราคา</p></article>)}</div>
      <details className="rounded-xl border border-slate-700 p-3 text-xs text-slate-400"><summary className="cursor-pointer text-slate-200">Methodology / warnings</summary><p className="mt-2">{analytics.oi.methodology}</p><p className="mt-1">ATM samples: {analytics.atm.sampledContracts.map((item) => `${item.type} ${item.strike}`).join(', ') || 'none'}</p><ul className="mt-2 list-disc pl-5">{[...new Set([...chain.warnings, ...analytics.atm.warnings, ...analytics.oi.warnings])].map((warning) => <li key={warning}>{warning}</li>)}</ul></details>
    </>}
  </section>;
}
