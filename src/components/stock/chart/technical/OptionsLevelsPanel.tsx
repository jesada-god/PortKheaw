'use client';

import { useEffect, useMemo, useState } from 'react';
import { DetailPopover } from '@/src/components/ui/DetailPopover';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import type { OptionsLevel, OptionsSrResult } from '@/src/lib/analytics/options-sr';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import {
  OPTIONS_EMPTY_MESSAGE,
  OPTIONS_FAILURE_MESSAGE,
  presentOptionsProvenance,
  presentOptionsStatus,
  type OptionsStatusTone,
} from '@/src/lib/stock-detail/options-presentation';

interface OptionsLevelsPanelProps {
  chain: OptionsChain | null;
  result: OptionsSrResult | null;
  loading: boolean;
  expirations: readonly string[];
  selectedExpiration: string | null;
  retryAt: number | null;
  currency: string;
  /** False while the section is collapsed — the state that must issue zero requests. */
  expanded: boolean;
  onToggleExpanded(): void;
  onExpirationChange(expiration: string): void;
  onRetry(): void;
}

interface StrikeRow {
  strike: number;
  call: OptionContract | null;
  put: OptionContract | null;
}

const TONE_CLASS: Record<OptionsStatusTone, string> = {
  positive: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  neutral: 'border-slate-600 bg-slate-800/60 text-slate-300',
  danger: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  muted: 'border-slate-700 bg-slate-900/60 text-slate-400',
};

function value(input: number | null | undefined, digits = 4): string {
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

/** The strikes closest to spot, re-sorted ascending — never the whole chain. */
function rowsNearSpot(chain: OptionsChain): StrikeRow[] {
  const byStrike = new Map<number, StrikeRow>();
  for (const contract of [...chain.calls, ...chain.puts]) {
    const row = byStrike.get(contract.strike) ?? { strike: contract.strike, call: null, put: null };
    row[contract.type] = contract;
    byStrike.set(contract.strike, row);
  }
  return [...byStrike.values()]
    .sort((left, right) => Math.abs(left.strike - chain.spot) - Math.abs(right.strike - chain.spot) || left.strike - right.strike)
    .slice(0, 9)
    .sort((left, right) => left.strike - right.strike);
}

/**
 * Options, directly below the chart.
 *
 * The headline is a user-facing load state (loading / success / failure) in the
 * shared vocabulary; provider, delay class, snapshot time and open-interest
 * freshness stay reachable through the ⓘ control. Call Wall, Put Wall and Max
 * Pain are computed from the provider's real open interest only — a field the
 * provider does not supply (IV, Greeks) renders as "—" and is never calculated
 * here.
 */
export function OptionsLevelsPanel({
  chain,
  result,
  loading,
  expirations,
  selectedExpiration,
  retryAt,
  currency,
  expanded,
  onToggleExpanded,
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
  const status = presentOptionsStatus({ expanded, loading, chain, result });
  const provenance = presentOptionsProvenance(chain, result);
  const levels = result?.status === 'available' ? result : null;

  useEffect(() => {
    if (!retryAt || retryAt <= Date.now()) return;
    const initial = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [retryAt]);

  return (
    <section className="border-t border-[#242733] px-3 py-2.5 text-xs" data-testid="options-levels" aria-label="ข้อมูลออปชัน">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="flex items-center gap-1 text-sm font-semibold text-slate-100">
          Options
          <DetailPopover
            triggerLabel="ดูแหล่งที่มาของข้อมูลออปชัน"
            title="ที่มาของข้อมูลออปชัน"
            testId="options-provenance-trigger"
            align="start"
          >
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]" data-testid="options-provenance-detail">
              <dt className="text-slate-500">แหล่งข้อมูล</dt><dd className="text-right text-slate-200">{provenance.source}</dd>
              <dt className="text-slate-500">สถานะข้อมูล</dt><dd className="text-right text-slate-200">{provenance.dataStatus}</dd>
              <dt className="text-slate-500">ข้อมูล ณ</dt><dd className="text-right text-slate-200">{provenance.asOf ? formatMarketDataAsOf(provenance.asOf) : '—'}</dd>
              <dt className="text-slate-500">Open Interest</dt><dd className="text-right text-slate-200">{provenance.openInterest}</dd>
              <dt className="text-slate-500">IV / Greeks</dt><dd className="text-right text-slate-200">{provenance.greeks}</dd>
            </dl>
            {provenance.failure && (
              <p className="mt-2 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-400" data-testid="options-failure-detail">
                {provenance.failure}
              </p>
            )}
          </DetailPopover>
        </h3>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {expanded && expirations.length > 0 && (
            <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span>Expiration</span>
              <select
                aria-label="วันหมดอายุออปชัน"
                value={selectedExpiration ?? ''}
                onChange={(event) => onExpirationChange(event.target.value)}
                disabled={loading}
                className="min-h-9 max-w-[10.5rem] rounded-md border border-slate-700 bg-slate-900 px-2 font-mono text-xs text-slate-200 disabled:opacity-50"
              >
                <option value="" disabled>เลือกวันหมดอายุ</option>
                {expirations.map((expiration) => <option key={expiration} value={expiration}>{expirationLabel(expiration)}</option>)}
              </select>
            </label>
          )}
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggleExpanded}
            data-testid="options-expand-toggle"
            className="min-h-9 rounded-md border border-slate-700 px-2.5 text-[11px] text-slate-300 hover:border-slate-500 focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
          >
            {expanded ? 'ซ่อน' : 'แสดงข้อมูลออปชัน'}
          </button>
        </div>
      </div>

      <p
        role="status"
        aria-live="polite"
        data-testid="options-status"
        className={`mt-1.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${TONE_CLASS[status.tone]}`}
      >
        <span aria-hidden="true">●</span>{status.label}
      </p>

      {(status.state === 'error' || status.state === 'empty') && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2" data-testid="options-failure">
          <span className="text-slate-400">{status.state === 'empty' ? OPTIONS_EMPTY_MESSAGE : OPTIONS_FAILURE_MESSAGE}</span>
          {status.state === 'error' && (
            <button
              type="button"
              disabled={loading || cooldown > 0}
              onClick={onRetry}
              data-testid="options-retry"
              className="min-h-9 rounded-md border border-slate-700 px-3 text-slate-300 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {cooldown > 0 ? `ลองใหม่ใน ${cooldown}s` : 'ลองใหม่'}
            </button>
          )}
        </div>
      )}

      {chain && (
        <>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="options-key-levels">
            <KeyLevelCard title="Call Wall" level={levels?.callWall ?? null} currency={currency} tone="text-rose-300" />
            <KeyLevelCard title="Put Wall" level={levels?.putWall ?? null} currency={currency} tone="text-emerald-300" />
            <KeyLevelCard title="Max Pain" level={levels?.maxPain ?? null} currency={currency} tone="text-fuchsia-300" showOi={false} />
          </div>

          <div className="mt-2 grid gap-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(14rem,.6fr)]">
            <div className="min-w-0">
              <p className="mb-1 text-[11px] text-slate-500">ใกล้ราคาปัจจุบัน {currency}{chain.spot.toFixed(2)}</p>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full min-w-[16rem] border-collapse text-right tabular-nums">
                  <thead className="bg-slate-950/60 text-[10px] uppercase tracking-wide text-slate-500">
                    <tr><th className="px-2 py-1 text-left">Strike</th><th className="px-2 py-1">Call OI</th><th className="px-2 py-1">Put OI</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => <tr key={row.strike} className="border-t border-slate-800/80">
                      <th className="whitespace-nowrap px-2 py-0.5 text-left font-mono font-medium text-slate-200">{currency}{value(row.strike, 2)}</th>
                      <td className="px-1 py-0.5"><ContractButton contract={row.call} selected={selectedContractId} onSelect={setSelectedContractId} /></td>
                      <td className="px-1 py-0.5"><ContractButton contract={row.put} selected={selectedContractId} onSelect={setSelectedContractId} /></td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
              {rows.length === 0 && <p className="mt-2 text-slate-500">{OPTIONS_EMPTY_MESSAGE}</p>}
            </div>

            <article className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/30 p-2" aria-label="รายละเอียดสัญญาออปชัน">
              <h4 className="truncate text-[11px] font-semibold text-slate-300">
                {selectedContract ? `${selectedContract.type.toUpperCase()} ${currency}${selectedContract.strike}` : 'เลือก Call/Put OI เพื่อดูสัญญา'}
              </h4>
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                <Metric label="IV" value={selectedContract?.impliedVolatility == null ? '—' : `${value(selectedContract.impliedVolatility * 100, 2)}%`} />
                <Metric label="Delta" value={value(selectedContract?.delta)} />
                <Metric label="Gamma" value={value(selectedContract?.gamma)} />
                <Metric label="Theta" value={value(selectedContract?.theta)} />
                <Metric label="Vega" value={value(selectedContract?.vega)} />
                <Metric label="OI" value={value(selectedContract?.openInterest, 0)} />
                <Metric label="Volume" value={value(selectedContract?.volume, 0)} />
              </dl>
            </article>
          </div>
        </>
      )}
    </section>
  );
}

/** One summary card. A level the real open interest does not support shows "—". */
function KeyLevelCard({ title, level, currency, tone, showOi = true }: {
  title: string;
  level: OptionsLevel | null;
  currency: string;
  tone: string;
  showOi?: boolean;
}) {
  return (
    <article className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/30 px-2.5 py-1.5" data-testid={`options-card-${title.toLowerCase().replace(' ', '-')}`}>
      <h4 className="text-[11px] text-slate-500">{title}</h4>
      <p className={`font-mono text-sm font-semibold tabular-nums ${tone}`}>
        {level ? `${currency}${level.price.toFixed(2)}` : '—'}
      </p>
      {showOi && <p className="text-[10px] text-slate-500">OI {value(level?.rawOI, 0)}</p>}
    </article>
  );
}

function ContractButton({ contract, selected, onSelect }: {
  contract: OptionContract | null;
  selected: string | null;
  onSelect(id: string): void;
}) {
  if (!contract) return <span className="inline-flex min-h-9 items-center px-2 text-slate-600">—</span>;
  const active = selected === contract.contractSymbol;
  return (
    <button
      type="button"
      aria-label={`ดูรายละเอียด ${contract.type} strike ${contract.strike}`}
      aria-pressed={active}
      onClick={() => onSelect(contract.contractSymbol)}
      className={`min-h-9 min-w-12 rounded px-2 font-mono hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-[#D4FF00] ${active ? 'bg-slate-800 text-white' : 'text-slate-300'}`}
    >
      {value(contract.openInterest, 0)}
    </button>
  );
}

function Metric({ label, value: display }: { label: string; value: string }) {
  return <div className="flex justify-between gap-2"><dt className="text-slate-500">{label}</dt><dd className="font-mono tabular-nums text-slate-200">{display}</dd></div>;
}

export default OptionsLevelsPanel;
