'use client';

import { useEffect, useMemo, useState } from 'react';
import { DetailPopover } from '@/src/components/ui/DetailPopover';
import { InfoHint } from '@/src/components/ui/InfoHint';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { LockedNotice } from '@/src/components/subscription/EntitlementGate';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import type { OptionsLevel, OptionsSrResult } from '@/src/lib/analytics/options-sr';
import type { GlossaryTermId } from '@/src/lib/analytics/glossary';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import {
  OPTIONS_EMPTY_MESSAGE,
  OPTIONS_FAILURE_MESSAGE,
  optionsProviderLabel,
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

function daysToExpiration(expiration: string, nowMs = Date.now()): string {
  const expiryMs = Date.parse(`${expiration}T23:59:59.999Z`);
  if (!Number.isFinite(expiryMs)) return '—';
  return String(Math.max(0, Math.ceil((expiryMs - nowMs) / 86_400_000)));
}

function contractMoneyness(contract: OptionContract, spot: number): 'ITM' | 'ATM' | 'OTM' {
  if (Math.abs(contract.strike - spot) / spot <= 0.005) return 'ATM';
  const inTheMoney = contract.inTheMoney
    ?? (contract.type === 'call' ? spot > contract.strike : spot < contract.strike);
  return inTheMoney ? 'ITM' : 'OTM';
}

function marketSource(contract: OptionContract): string {
  if (!contract.marketDataProvider) return 'Unavailable';
  const provider = optionsProviderLabel(contract.marketDataProvider);
  return contract.marketDataFeed ? `${provider} · ${contract.marketDataFeed}` : provider;
}

function valuationSource(contract: OptionContract): string {
  if (contract.valuationSource === 'nexora-derived') return 'คำนวณโดย PortKheaw';
  if (contract.valuationSource === 'provider') return marketSource(contract);
  return 'Unavailable';
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
  const { can } = useEntitlement();
  const chainEntitled = can('options.chain.basic');
  const wallsEntitled = can('options.analytics.walls');
  const greeksEntitled = can('options.greeks.full');
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
          <InfoHint term="optionsSection" />
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
              {/* Withheld fields have no provenance to report; saying the provider sent none would be false. */}
              {greeksEntitled && <>
                <dt className="text-slate-500">IV / Greeks</dt><dd className="text-right text-slate-200">{provenance.greeks}</dd>
              </>}
            </dl>
            {provenance.failure && (
              <p className="mt-2 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-400" data-testid="options-failure-detail">
                {provenance.failure}
              </p>
            )}
          </DetailPopover>
        </h3>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {chainEntitled && expanded && expirations.length > 0 && (
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
          {chainEntitled && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={onToggleExpanded}
              data-testid="options-expand-toggle"
              className="min-h-9 rounded-md border border-slate-700 px-2.5 text-[11px] text-slate-300 hover:border-slate-500 focus-visible:ring-2 focus-visible:ring-[#D4FF00]"
            >
              {expanded ? 'ซ่อน' : 'แสดงข้อมูลออปชัน'}
            </button>
          )}
        </div>
      </div>

      {/*
        Without the ledger capability the section keeps its place in the reading
        order and says what it is, but no chain request is issued and no contract
        reaches this component — the locked branch has nothing to conceal.
      */}
      {!chainEntitled && (
        <div className="mt-2 space-y-2" data-testid="options-locked">
          <p className="text-[11px] leading-relaxed text-slate-400">
            สัญญาออปชันจริง ทั้ง strike, วันหมดอายุ, Bid/Ask, Volume และ Open Interest
          </p>
          <LockedNotice capability="options.chain.basic" source="chart.options-panel" />
        </div>
      )}

      {chainEntitled && (
      <p
        role="status"
        aria-live="polite"
        data-testid="options-status"
        className={`mt-1.5 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] ${TONE_CLASS[status.tone]}`}
      >
        <span aria-hidden="true">●</span>{status.label}
      </p>
      )}

      {chainEntitled && (status.state === 'error' || status.state === 'empty') && (
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

      {chainEntitled && chain && (
        <>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="options-key-levels">
            <KeyLevelCard title="Call Wall" term="callWall" helper="จุดที่ Call OI กระจุกตัวมาก" level={wallsEntitled ? levels?.callWall ?? null : null} entitled={wallsEntitled} currency={currency} tone="text-rose-300" />
            <KeyLevelCard title="Put Wall" term="putWall" helper="จุดที่ Put OI กระจุกตัวมาก" level={wallsEntitled ? levels?.putWall ?? null : null} entitled={wallsEntitled} currency={currency} tone="text-emerald-300" />
            <KeyLevelCard title="Max Pain" term="maxPain" helper="ค่าคำนวณจาก OI ของวันหมดอายุที่เลือก" level={wallsEntitled ? levels?.maxPain ?? null : null} entitled={wallsEntitled} currency={currency} tone="text-fuchsia-300" showOi={false} />
          </div>

          <div className="mt-2 grid gap-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(14rem,.6fr)]">
            <div className="min-w-0">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-1 text-[11px] text-slate-500">
                <span>ใกล้ราคาปัจจุบัน {currency}{chain.spot.toFixed(2)}</span>
                <span className="flex items-center gap-1">Open Interest (OI)<InfoHint term="openInterest" align="end" /></span>
              </div>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full min-w-[16rem] border-collapse text-right tabular-nums">
                  <thead className="bg-slate-950/60 text-[10px] uppercase tracking-wide text-slate-500">
                    <tr><th className="px-2 py-1 text-left">Strike</th><th className="px-2 py-1">Call OI</th><th className="px-2 py-1">Put OI</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const active = selectedContractId === row.call?.contractSymbol || selectedContractId === row.put?.contractSymbol;
                      const preferred = selectedContract?.type === 'put' ? row.put ?? row.call : row.call ?? row.put;
                      return <tr key={row.strike} className={`border-t border-slate-800/80 ${active ? 'bg-[#D4FF00]/5' : ''}`}>
                        <th className="whitespace-nowrap px-1 py-0.5 text-left font-mono font-medium text-slate-200">
                          <button
                            type="button"
                            aria-label={`เลือก strike ${row.strike}`}
                            aria-pressed={active}
                            disabled={!preferred}
                            onClick={() => preferred && setSelectedContractId(preferred.contractSymbol)}
                            className="min-h-9 rounded px-1 hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-[#D4FF00] disabled:cursor-default"
                          >{currency}{value(row.strike, 2)}</button>
                        </th>
                        <td className="px-1 py-0.5"><ContractButton contract={row.call} selected={selectedContractId} onSelect={setSelectedContractId} /></td>
                        <td className="px-1 py-0.5"><ContractButton contract={row.put} selected={selectedContractId} onSelect={setSelectedContractId} /></td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
              {rows.length === 0 && <p className="mt-2 text-slate-500">{OPTIONS_EMPTY_MESSAGE}</p>}
            </div>

            <article className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/30 p-2.5" aria-label="รายละเอียดสัญญาออปชัน">
              <h4 className="truncate text-sm font-semibold text-slate-200">
                {selectedContract ? `${selectedContract.type.toUpperCase()} ${currency}${value(selectedContract.strike, 2)}` : 'เลือก Strike หรือ Call/Put OI เพื่อดูสัญญา'}
              </h4>
              {selectedContract && <>
                <p className="mt-0.5 text-[10px] text-slate-500">
                  หมดอายุ {expirationLabel(selectedContract.expiration)} · DTE {daysToExpiration(selectedContract.expiration)}
                </p>

                <DetailGroup title="ราคา">
                  <Metric label="Bid" value={selectedContract.bid == null ? '—' : `${currency}${value(selectedContract.bid, 2)}`} />
                  <Metric label="Ask" value={selectedContract.ask == null ? '—' : `${currency}${value(selectedContract.ask, 2)}`} />
                  <Metric label="Last" value={selectedContract.last == null ? '—' : `${currency}${value(selectedContract.last, 2)}`} />
                  <Metric label="Mark" value={selectedContract.mark == null ? '—' : `${currency}${value(selectedContract.mark, 2)}`} />
                  <Metric label="Spread" value={selectedContract.bid == null || selectedContract.ask == null ? '—' : `${currency}${value(selectedContract.ask - selectedContract.bid, 2)}`} />
                </DetailGroup>

                <DetailGroup title="ตลาด">
                  <Metric label="Volume" value={value(selectedContract.volume, 0)} />
                  <Metric label="OI" value={value(selectedContract.openInterest, 0)} term="openInterest" />
                </DetailGroup>

                {/*
                  IV and the Greeks are stripped from the payload on the server
                  for a reader without them, so rendering "—" here would read as
                  "the provider had none" when the truth is "your plan does not
                  include them". The locked control says which it is.
                */}
                {greeksEntitled ? (
                  <>
                    <DetailGroup title="ความผันผวน">
                      <Metric label="IV" value={selectedContract.impliedVolatility == null ? '—' : `${value(selectedContract.impliedVolatility * 100, 2)}%`} term="impliedVolatility" />
                    </DetailGroup>

                    <DetailGroup title="Greeks">
                      <Metric label="Delta" value={value(selectedContract.delta)} term="delta" />
                      <Metric label="Gamma" value={value(selectedContract.gamma)} term="gamma" />
                      <Metric label="Theta" value={value(selectedContract.theta)} term="theta" />
                      <Metric label="Vega" value={value(selectedContract.vega)} term="vega" />
                    </DetailGroup>
                  </>
                ) : (
                  <section className="mt-2 border-t border-slate-800 pt-1.5">
                    <h5 className="mb-1 text-[10px] font-semibold text-slate-400">ความผันผวนและ Greeks</h5>
                    <LockedNotice capability="options.greeks.full" source="chart.options-contract" variant="row" />
                  </section>
                )}

                <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-slate-800 pt-2 text-[10px]">
                  <dt className="text-slate-500">สถานะ</dt><dd className="text-right font-semibold text-slate-200">{contractMoneyness(selectedContract, chain.spot)}</dd>
                  <dt className="text-slate-500">ราคา / Volume</dt><dd className="break-words text-right text-slate-300">{marketSource(selectedContract)}</dd>
                  <dt className="text-slate-500">Open Interest</dt><dd className="break-words text-right text-slate-300">{optionsProviderLabel(selectedContract.provider)}{selectedContract.oiAsOf ? ` · ${selectedContract.oiAsOf}` : ''}</dd>
                  {greeksEntitled && <>
                    <dt className="text-slate-500">IV / Greeks</dt><dd className="break-words text-right text-slate-300">{valuationSource(selectedContract)}</dd>
                  </>}
                  <dt className="text-slate-500">ข้อมูล ณ</dt><dd className="break-words text-right text-slate-300">{formatMarketDataAsOf(selectedContract.asOf)}</dd>
                </dl>
              </>}
            </article>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * One summary card. A level the real open interest does not support shows "—".
 *
 * Without `options.analytics.walls` the card is a teaser: it still names the
 * level and explains what it means, and in place of the number it carries the
 * control that opens the upgrade prompt. No real value is rendered, blurred or
 * otherwise present — for a reader on Pro the level was never computed.
 */
function KeyLevelCard({ title, term, helper, level, entitled, currency, tone, showOi = true }: {
  title: string;
  term: 'callWall' | 'putWall' | 'maxPain';
  helper: string;
  level: OptionsLevel | null;
  entitled: boolean;
  currency: string;
  tone: string;
  showOi?: boolean;
}) {
  return (
    <article className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/30 px-2.5 py-1.5" data-testid={`options-card-${title.toLowerCase().replace(' ', '-')}`}>
      <h4 className="flex items-center justify-between gap-2 text-[11px] text-slate-500"><span>{title}</span><InfoHint term={term} align="end" /></h4>
      {entitled ? (
        <>
          <p className={`font-mono text-sm font-semibold tabular-nums ${tone}`}>
            {level ? `${currency}${level.price.toFixed(2)}` : '—'}
          </p>
          {showOi && <p className="text-[10px] text-slate-500">OI {value(level?.rawOI, 0)}</p>}
        </>
      ) : (
        <div className="mt-1">
          <LockedNotice capability="options.analytics.walls" source={`chart.options-${term}`} variant="row" />
        </div>
      )}
      <p className="mt-0.5 text-[10px] leading-snug text-slate-600">{helper}</p>
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

function DetailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mt-2 border-t border-slate-800 pt-1.5"><h5 className="mb-1 text-[10px] font-semibold text-slate-400">{title}</h5><dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">{children}</dl></section>;
}

function Metric({ label, value: display, term }: { label: string; value: string; term?: GlossaryTermId }) {
  return <div data-testid={`option-metric-${label.toLowerCase()}`} className="flex min-w-0 items-center justify-between gap-2"><dt className="flex min-w-0 items-center gap-1 text-slate-500"><span>{label}</span>{term && <InfoHint term={term} />}</dt><dd className="whitespace-nowrap font-mono tabular-nums text-slate-200">{display}</dd></div>;
}

export default OptionsLevelsPanel;
