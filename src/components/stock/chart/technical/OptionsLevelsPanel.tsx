'use client';

import { useEffect, useMemo, useState } from 'react';
import type { OptionsSrResult } from '@/src/lib/analytics/options-sr';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';

interface OptionsLevelsPanelProps {
  chain: OptionsChain | null;
  result: OptionsSrResult | null;
  loading: boolean;
  expirations: readonly string[];
  selectedExpiration: string | null;
  retryAt: number | null;
  currency: string;
  onExpirationChange(expiration: string): void;
  onRetry(): void;
}

interface StrikeRow {
  strike: number;
  call: OptionContract | null;
  put: OptionContract | null;
}

function value(input: number | null, digits = 4): string {
  return input == null || !Number.isFinite(input)
    ? '—'
    : input.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function expirationLabel(expiration: string): string {
  const date = new Date(`${expiration}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? expiration
    : date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function unavailableMessage(result: OptionsSrResult | null): string {
  if (result?.status !== 'unavailable') return 'ข้อมูลออปชันยังไม่พร้อมใช้งาน';
  if (result.reason === 'rate-limited') return 'ข้อมูลออปชันถูกจำกัดชั่วคราว กรุณาลองใหม่ภายหลัง';
  if (result.reason === 'no-expirations' || result.reason === 'expired-expiration' || result.reason === 'chain-unavailable') {
    return 'ไม่พบออปชันสำหรับหุ้น/ช่วงเวลานี้';
  }
  if (result.reason === 'entitlement-required') return 'ข้อมูลออปชันยังไม่พร้อมใช้งาน';
  return result.message || 'ข้อมูลออปชันยังไม่พร้อมใช้งาน';
}

function rowsNearSpot(chain: OptionsChain): StrikeRow[] {
  const byStrike = new Map<number, StrikeRow>();
  for (const contract of [...chain.calls, ...chain.puts]) {
    const row = byStrike.get(contract.strike) ?? { strike: contract.strike, call: null, put: null };
    row[contract.type] = contract;
    byStrike.set(contract.strike, row);
  }
  return [...byStrike.values()]
    .sort((left, right) => Math.abs(left.strike - chain.spot) - Math.abs(right.strike - chain.spot) || left.strike - right.strike)
    .slice(0, 7)
    .sort((left, right) => left.strike - right.strike);
}

export function OptionsLevelsPanel({
  chain,
  result,
  loading,
  expirations,
  selectedExpiration,
  retryAt,
  currency,
  onExpirationChange,
  onRetry,
}: OptionsLevelsPanelProps) {
  const [selectedContractId, setSelectedContractId] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const rows = useMemo(() => chain ? rowsNearSpot(chain) : [], [chain]);
  const selectedContract = useMemo(() => {
    if (!chain || !selectedContractId) return null;
    return [...chain.calls, ...chain.puts].find((contract) => contract.contractSymbol === selectedContractId) ?? null;
  }, [chain, selectedContractId]);
  const cooldown = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1_000)) : 0;

  useEffect(() => {
    if (!retryAt || retryAt <= Date.now()) return;
    const initial = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [retryAt]);

  return (
    <section className="border-t border-[#242733] px-3 py-2.5 text-xs" data-testid="options-levels" aria-label="ข้อมูลออปชัน">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-100">Options</h3>
        {expirations.length > 0 && (
          <label className="flex items-center gap-2 text-[11px] text-slate-500">
            <span>Expiration</span>
            <select
              aria-label="วันหมดอายุออปชัน"
              value={selectedExpiration ?? ''}
              onChange={(event) => onExpirationChange(event.target.value)}
              disabled={loading}
              className="min-h-9 rounded-md border border-slate-700 bg-slate-900 px-2 font-mono text-xs text-slate-200 disabled:opacity-50"
            >
              <option value="" disabled>เลือกวันหมดอายุ</option>
              {expirations.map((expiration) => <option key={expiration} value={expiration}>{expirationLabel(expiration)}</option>)}
            </select>
          </label>
        )}
      </div>

      {loading && !chain && <p role="status" aria-live="polite" className="py-3 text-slate-400">กำลังโหลดข้อมูลออปชัน…</p>}

      {!loading && !chain && expirations.length > 0 && !selectedExpiration && (
        <p role="status" className="mt-2 rounded-lg border border-slate-800 bg-slate-950/35 px-3 py-2 text-slate-400">เลือกวันหมดอายุเพื่อโหลดข้อมูลออปชัน</p>
      )}

      {!loading && !chain && (expirations.length === 0 || Boolean(selectedExpiration)) && (
        <div role="status" aria-live="polite" className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-950/35 px-3 py-2 text-slate-400">
          <span>{unavailableMessage(result)}</span>
          <button type="button" disabled={loading || cooldown > 0} onClick={onRetry} className="min-h-9 rounded-md border border-slate-700 px-3 text-slate-300 disabled:cursor-not-allowed disabled:opacity-40">
            {cooldown > 0 ? `ลองใหม่ใน ${cooldown}s` : 'ลองใหม่'}
          </button>
        </div>
      )}

      {chain && (
        <div className="mt-2 grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(15rem,.6fr)]">
          <div className="min-w-0">
            <p className="mb-1.5 text-[11px] text-slate-500">ATM / ใกล้ราคาปัจจุบัน {currency}{chain.spot.toFixed(2)}</p>
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full min-w-[18rem] border-collapse text-right tabular-nums">
                <thead className="bg-slate-950/60 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-2 py-1.5 text-left">Strike</th><th className="px-2 py-1.5">Call OI</th><th className="px-2 py-1.5">Put OI</th></tr></thead>
                <tbody>
                  {rows.map((row) => <tr key={row.strike} className="border-t border-slate-800/80">
                    <th className="whitespace-nowrap px-2 py-1.5 text-left font-mono font-medium text-slate-200">{currency}{value(row.strike, 2)}</th>
                    <td className="px-1 py-1"><ContractButton contract={row.call} onSelect={setSelectedContractId} /></td>
                    <td className="px-1 py-1"><ContractButton contract={row.put} onSelect={setSelectedContractId} /></td>
                  </tr>)}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && <p className="mt-2 text-slate-500">ไม่พบออปชันสำหรับหุ้น/ช่วงเวลานี้</p>}
          </div>

          <div className="grid content-start gap-2 sm:grid-cols-2 lg:grid-cols-1">
            <article className="rounded-lg border border-slate-800 bg-slate-950/30 p-2">
              <h4 className="text-[11px] font-semibold text-slate-300">Key Levels</h4>
              <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-[11px]">
                <dt className="text-slate-500">Call Wall</dt><dd className="font-mono text-rose-300">{result?.status === 'available' && result.callWall ? `${currency}${result.callWall.price.toFixed(2)}` : '—'}</dd>
                <dt className="text-slate-500">Put Wall</dt><dd className="font-mono text-emerald-300">{result?.status === 'available' && result.putWall ? `${currency}${result.putWall.price.toFixed(2)}` : '—'}</dd>
                <dt className="text-slate-500">Max Pain</dt><dd className="font-mono text-fuchsia-300">{result?.status === 'available' && result.maxPain ? `${currency}${result.maxPain.price.toFixed(2)}` : '—'}</dd>
              </dl>
            </article>
            <article className="rounded-lg border border-slate-800 bg-slate-950/30 p-2" aria-label="รายละเอียดสัญญาออปชัน">
              <h4 className="truncate text-[11px] font-semibold text-slate-300">{selectedContract ? `${selectedContract.type.toUpperCase()} ${currency}${selectedContract.strike}` : 'เลือก Call/Put OI เพื่อดูสัญญา'}</h4>
              <dl className="mt-1 grid grid-cols-[repeat(2,minmax(0,1fr))] gap-x-3 gap-y-1 text-[11px]">
                <Metric label="IV" value={selectedContract?.impliedVolatility == null ? '—' : `${value(selectedContract.impliedVolatility * 100, 2)}%`} />
                <Metric label="Delta" value={value(selectedContract?.delta ?? null)} />
                <Metric label="Gamma" value={value(selectedContract?.gamma ?? null)} />
                <Metric label="Theta" value={value(selectedContract?.theta ?? null)} />
                <Metric label="Vega" value={value(selectedContract?.vega ?? null)} />
                <Metric label="OI" value={value(selectedContract?.openInterest ?? null, 0)} />
                <Metric label="Volume" value={value(selectedContract?.volume ?? null, 0)} />
              </dl>
            </article>
          </div>
        </div>
      )}

      {chain && <p className="mt-2 text-[10px] text-slate-600">{chain.provider} · {chain.status === 'live' ? 'DELAYED' : chain.status.toUpperCase()} · {new Date(chain.asOf).toLocaleString('th-TH')} · cache {chain.status === 'cached' || chain.status === 'stale' ? chain.status : 'fresh'}</p>}
    </section>
  );
}

function ContractButton({ contract, onSelect }: { contract: OptionContract | null; onSelect(id: string): void }) {
  if (!contract) return <span className="inline-flex min-h-9 items-center px-2 text-slate-600">—</span>;
  return <button type="button" aria-label={`ดูรายละเอียด ${contract.type} strike ${contract.strike}`} onClick={() => onSelect(contract.contractSymbol)} className="min-h-9 min-w-12 rounded px-2 font-mono text-slate-300 hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-[#D4FF00]">{value(contract.openInterest, 0)}</button>;
}

function Metric({ label, value: display }: { label: string; value: string }) {
  return <div className="flex justify-between gap-2"><dt className="text-slate-500">{label}</dt><dd className="font-mono tabular-nums text-slate-200">{display}</dd></div>;
}

export default OptionsLevelsPanel;
