'use client';

import { useCallback, useEffect, useMemo, useState, useTransition, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, Briefcase, ChevronDown, ChevronRight, ChevronUp, Eye, EyeOff,
  ArrowDownCircle, ArrowUpCircle, History, Lock, LoaderCircle, PencilLine, Plus, RefreshCw, Repeat2, WalletCards,
} from 'lucide-react';
import {
  createPortfolioTransactionAction,
  setPortfolioBaseCurrencyAction,
} from '@/app/portfolio/actions';
import { reconcilePortfolioValueAction } from '@/app/portfolio/reconcile-actions';
import { Button } from '@/src/components/ui/Button';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import { useToast } from '@/src/components/ui/Toast';
import { calculatePortfolio } from '@/src/lib/portfolio/calculations';
import { aggregatePortfolioSummaries } from '@/src/lib/portfolio/aggregate';
import type { OptionQuoteInput, OptionTarget } from '@/src/lib/portfolio/options/types';
import type { HoldingSummary, MarketPriceInput, PortfolioGoal, PortfolioRecord, PortfolioTransactionType } from '@/src/lib/portfolio/types';
import type { FxResult } from '@/src/lib/market-data/fx/service';
import type { SupportedCurrency } from '@/src/lib/market-data/fx/types';
import { fetchFxRate, formatFxRate } from '@/src/lib/market-data/fx/client';
import {
  formatPortfolioMoney,
  gainColor,
  portfolioReturnToneClass,
  signedMoney,
  signedPercent,
} from '@/src/lib/portfolio/presentation';
import {
  currentDateTimeLocal,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { OptionsSection } from './OptionsSection';
import { PortfolioManager } from './PortfolioManager';
import { PortfolioValueSheet, type PortfolioValueSubmission } from './PortfolioValueSheet';
import { TransactionFormModal, type TransactionFormState } from './TransactionFormModal';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { usePortfolioPrivacy } from '@/src/hooks/usePortfolioPrivacy';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { READ_ONLY_PORTFOLIO_MESSAGE } from '@/src/lib/subscription/entitlement-errors';
import {
  basicWritableStockPortfolioId,
  portfolioWriteBlock,
} from '@/src/lib/subscription/portfolio-write-access';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';

const emptyForm = (portfolioId = '', timezone = 'Asia/Bangkok'): TransactionFormState => ({
  portfolioId,
  type: 'acquisition',
  symbol: '',
  quantity: '',
  price: '',
  amount: '',
  fee: '0',
  originalCurrency: 'USD',
  fxRateAtTransaction: '',
  occurredAt: currentDateTimeLocal(timezone),
  timezone,
  broker: '',
  note: '',
  underlyingSymbol: '',
  contractSymbol: '',
  optionKind: 'call',
  optionSide: 'long',
  strikePrice: '',
  expirationDate: '',
  multiplier: '100',
  idempotencyKey: crypto.randomUUID(),
});

function number(value: number, maximumFractionDigits = 8) {
  return new Intl.NumberFormat('th-TH', { maximumFractionDigits }).format(value);
}

function transactionDate(value: string, timezone: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone })
    .format(parsed);
}

export function PortfolioClient({ portfolios, aggregateGoal, marketPrices, optionQuotes, optionTargets, fx, timezone, effectiveTier }: {
  portfolios: PortfolioRecord[];
  aggregateGoal: PortfolioGoal;
  marketPrices: Record<string, MarketPriceInput | null>;
  optionQuotes: Record<string, OptionQuoteInput | null>;
  optionTargets: OptionTarget[];
  fx: FxResult;
  timezone: string;
  effectiveTier: SubscriptionTier;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const { requestUpgrade } = useEntitlement();
  const [pending, startTransition] = useTransition();
  const { visible: showBalances, toggleVisibility } = usePortfolioPrivacy();
  const isOnline = useOnlineStatus();
  const [formOpen, setFormOpen] = useState(false);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(portfolios.find((item) => item.archivedAt === null)?.id ?? portfolios[0]?.id ?? '');
  const portfolio = (portfolios.find((item) => item.id === selectedPortfolioId) ?? portfolios[0])!;
  const [currency, setCurrency] = useState<SupportedCurrency>(portfolio?.baseCurrency ?? 'USD');
  const [currentFx, setCurrentFx] = useState(fx);
  const [fxLoading, setFxLoading] = useState(true);
  const [fxError, setFxError] = useState(fx.quote === null);
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [valueSheetOpen, setValueSheetOpen] = useState(false);
  const [valueSheetError, setValueSheetError] = useState('');
  /*
   * Minted when the sheet opens, and used both as the sheet's `key` — so every
   * opening starts from a clean form — and as the ledger idempotency key, so a
   * double submit lands on the same row instead of two.
   */
  const [valueSheetKey, setValueSheetKey] = useState('');
  const [form, setForm] = useState<TransactionFormState>(() => emptyForm(portfolio?.id, timezone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const [optionActionRequest, setOptionActionRequest] = useState<{ id: number; type: 'buy' | 'sell' } | null>(null);
  const [transferRequest, setTransferRequest] = useState(0);
  const prices = useMemo(
    () => Object.fromEntries(Object.entries(marketPrices).filter((entry): entry is [string, MarketPriceInput] => entry[1] != null)),
    [marketPrices],
  );
  const summaries = useMemo(
    () => Object.fromEntries(portfolios.map((item) => [
      item.id,
      calculatePortfolio(item.transactions, prices, optionQuotes),
    ])),
    [optionQuotes, portfolios, prices],
  );
  const summary = summaries[portfolio.id];
  /*
   * `portfolios` arrives ordered by (created_at, id) from the repository, which
   * is the same order the database resolves its writable choice in — so the
   * list must be read as given, not re-sorted.
   */
  const writableStockId = useMemo(() => basicWritableStockPortfolioId(portfolios), [portfolios]);
  const writeBlock = portfolioWriteBlock(effectiveTier, portfolio, writableStockId);
  const aggregateSummary = useMemo(
    () => aggregatePortfolioSummaries(portfolios.map((item) => summaries[item.id])),
    [portfolios, summaries],
  );

  async function loadFx() {
    setFxLoading(true);
    setFxError(false);
    try {
      const parsed = await fetchFxRate(fetch, 1);
      setCurrentFx({ quote: parsed.quote, unavailable: parsed.unavailable });
    } catch {
      setFxError(true);
    } finally {
      setFxLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetchFxRate(fetch, 1)
      .then((parsed) => {
        if (active) {
          setCurrentFx({ quote: parsed.quote, unavailable: parsed.unavailable });
          setFxError(false);
        }
      })
      .catch(() => { if (active) setFxError(true); })
      .finally(() => { if (active) setFxLoading(false); });
    return () => { active = false; };
  }, []);

  function openCreate(type: PortfolioTransactionType = 'acquisition', symbol = '', quantity = '') {
    setErrors({});
    setForm({ ...emptyForm(portfolio.id, timezone), type, symbol, quantity });
    setFormOpen(true);
  }

  function openValueSheet() {
    setValueSheetKey(crypto.randomUUID());
    setValueSheetError('');
    setValueSheetOpen(true);
  }

  function requestPortfolioWrite() {
    if (portfolio.archivedAt || !isOnline) return false;
    if (writeBlock) {
      requestUpgrade({
        capability: portfolio.type === 'OPTION' ? 'portfolio.options.create' : 'portfolio.multiple.create',
        source: 'portfolio.add-transaction',
      });
      return false;
    }
    return true;
  }

  const handleOptionActionRequest = useCallback(() => setOptionActionRequest(null), []);

  function closeForm() {
    setFormOpen(false);
    setErrors({});
    setForm(emptyForm(portfolio.id, timezone));
  }

  function change(name: keyof TransactionFormState, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: '' }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!isOnline) {
      addToast({ title: 'บันทึกไม่ได้ขณะออฟไลน์', message: 'เชื่อมต่ออินเทอร์เน็ตก่อนเพื่อป้องกันข้อมูลขัดแย้ง', type: 'error' });
      return;
    }
    const dateTime = validateTransactionDateTime(form.occurredAt, form.timezone);
    if (!dateTime.ok) {
      setErrors((current) => ({ ...current, occurredAt: dateTime.message }));
      return;
    }
    startTransition(async () => {
      const result = await createPortfolioTransactionAction(form);
      if (!result.ok) {
        setErrors(result.fields ?? {});
        addToast({ title: 'บันทึกไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      closeForm();
      addToast({ title: 'เพิ่มรายการแล้ว', message: 'พอร์ตจะคำนวณใหม่จาก Ledger ทั้งหมด', type: 'success' });
      router.refresh();
    });
  }

  /*
   * The wanted total goes to the server as typed; the server recomputes the
   * portfolio from the ledger, decides the delta itself and writes one deposit
   * or one withdrawal. Nothing here is trusted as the source of the change.
   */
  function submitPortfolioValue(submission: PortfolioValueSubmission) {
    if (pending || !isOnline) return;
    setValueSheetError('');
    startTransition(async () => {
      const result = await reconcilePortfolioValueAction(submission);
      if (!result.ok) {
        setValueSheetError(result.message);
        return;
      }
      setValueSheetOpen(false);
      addToast({
        title: result.plan.type === 'deposit' ? 'ปรับยอดขึ้นแล้ว' : 'ปรับยอดลงแล้ว',
        message: 'บันทึกเป็นเงินเข้า–ออกใน Ledger จำนวนสินทรัพย์และกำไร/ขาดทุนไม่เปลี่ยน',
        type: 'success',
      });
      router.refresh();
    });
  }

  const hidden = (value: string) => showBalances ? value : SENSITIVE_VALUE_MASK;
  const rate = currentFx.quote?.rate ?? null;
  const hasValidRate = rate !== null;
  const money = (value: number | string | null) => value === null ? '—' : formatPortfolioMoney(value, currency, rate, showBalances);
  const signed = (value: number | null) => value === null ? '—' : signedMoney(value, currency, rate, showBalances);
  const percent = (value: number | null) => value === null ? '—' : signedPercent(value, showBalances);

  function selectCurrency(next: SupportedCurrency) {
    if (next === currency || pending || !isOnline || (next === 'THB' && !hasValidRate)) return;
    setCurrency(next);
    startTransition(async () => {
      const result = await setPortfolioBaseCurrencyAction(next);
      if (!result.ok) {
        setCurrency(currency);
        addToast({ title: 'บันทึกสกุลเงินไม่สำเร็จ', message: result.message, type: 'error' });
      }
    });
  }

  return <main className="mx-auto w-full max-w-7xl space-y-5 overflow-x-clip p-3 pb-24 sm:p-4 md:p-8">
    {!isOnline && <aside className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
      โหมดอ่านอย่างเดียวขณะออฟไลน์ — ปิดการเพิ่ม แก้ไข และลบเพื่อป้องกันข้อมูลขัดแย้ง
    </aside>}
    <aside className="flex gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100" role="note">
      <AlertTriangle className="mt-0.5 shrink-0 text-amber-300" size={19} />
      <p><strong>พอร์ตจำลองเพื่อบันทึกย้อนหลังเท่านั้น</strong><br />ไม่มีการส่งคำสั่งไปยังตลาดหลักทรัพย์ โบรกเกอร์ หรือผู้ให้บริการซื้อขายใด ๆ</p>
    </aside>

    <section className="overflow-hidden rounded-3xl border border-slate-800 bg-gradient-to-br from-[#151B28] to-[#0A0E17] p-4 sm:p-7">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs font-medium uppercase tracking-widest text-slate-400">มูลค่าพอร์ตรวม</p>
            <div className="inline-flex rounded-lg border border-slate-700 bg-slate-950 p-1" aria-label="สกุลเงินที่แสดง">
              {(['USD', 'THB'] as const).map((item) => <button
                key={item}
                type="button"
                disabled={pending || (item === 'THB' && !hasValidRate)}
                onClick={() => selectCurrency(item)}
                className={`min-h-9 rounded-md px-3 text-xs font-bold ${currency === item ? 'bg-[#D4FF00] text-slate-950' : 'text-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40'}`}
              >{item}</button>)}
            </div>
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 break-all font-mono text-3xl font-bold tracking-tight text-white sm:text-5xl">{money(aggregateSummary.totalValue)}</h2>
            <button
              type="button"
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center text-slate-400 hover:text-white disabled:opacity-40"
              disabled={!isOnline || Boolean(portfolio.archivedAt)}
              onClick={() => { if (requestPortfolioWrite()) openValueSheet(); }}
              aria-label="ปรับยอดพอร์ต"
              data-testid="portfolio-value-edit"
            >
              <PencilLine size={19} />
            </button>
            <button type="button" className="flex min-h-11 min-w-11 shrink-0 items-center justify-center text-slate-400 hover:text-white" onClick={toggleVisibility} aria-label={showBalances ? 'ซ่อนยอดเงินทั้งหมด' : 'แสดงยอดเงินชั่วคราว'}>
              {showBalances ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
          {/*
            One profit/loss colour mapping, shared with the goal card. Masking
            passes `null` on purpose — a green or red figure behind the mask
            still says which way the portfolio moved.
          */}
          <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            <Metric
              label="กำไร/ขาดทุนวันนี้"
              value={`${signed(aggregateSummary.todayChange)} · ${percent(aggregateSummary.todayChangePercent)}`}
              tone={portfolioReturnToneClass(showBalances ? aggregateSummary.todayChange : null, 'text-slate-400')}
            />
            <Metric
              label="กำไร/ขาดทุนรวม"
              value={`${signed(aggregateSummary.totalGain)} · ${percent(aggregateSummary.totalGainPercent)}`}
              tone={portfolioReturnToneClass(showBalances ? aggregateSummary.totalGain : null, 'text-slate-400')}
            />
            <Metric label="เงินสด" value={money(aggregateSummary.cashBalance)} />
          </div>
          {aggregateSummary.hasMissingPrices && <p className="mt-2 text-xs text-amber-300">มูลค่ารวมแสดง “—” เพราะมีสินทรัพย์ที่ยังไม่มีราคาจริง ระบบไม่แทนราคาด้วย 0</p>}
          {aggregateSummary.todayChange === null && <p className="mt-1 text-xs text-slate-400" data-testid="portfolio-today-unavailable">ยังคำนวณกำไร/ขาดทุนวันนี้ไม่ได้ เพราะไม่มีราคาปิดวันก่อน</p>}
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto">
          <Button disabled={!isOnline || Boolean(portfolio.archivedAt)} onClick={() => { if (requestPortfolioWrite()) setActionSheetOpen(true); }}><Plus size={17} /> เพิ่มรายการ</Button>
          <Link
            href="/portfolio/transactions"
            className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
            data-testid="portfolio-history-link"
          ><History aria-hidden="true" size={17} /> ประวัติเงินเข้า–ออก</Link>
        </div>
      </div>
      <div className="mt-7 grid grid-cols-2 gap-4 border-t border-slate-800 pt-5 sm:grid-cols-3 lg:grid-cols-5">
        <Metric label="เงินฝากสุทธิ (Net deposits)" value={money(aggregateSummary.netDepositedCapital)} />
        <Metric label="มูลค่าหุ้น" value={money(aggregateSummary.equityMarketValue)} />
        <Metric label="มูลค่าออปชันสุทธิ" value={money(aggregateSummary.optionsMarketValue)} />
        <Metric label="ต้นทุนคงเหลือ" value={money(aggregateSummary.costBasis + aggregateSummary.optionRemainingCost)} />
        <Metric label="Realized P&L" value={signed(aggregateSummary.realizedGain)} tone={gainColor(aggregateSummary.realizedGain)} />
        <Metric label="Unrealized P&L" value={signed(aggregateSummary.unrealizedGain)} tone={aggregateSummary.unrealizedGain === null ? 'text-slate-400' : gainColor(aggregateSummary.unrealizedGain)} />
      </div>
      <div className="mt-5 flex flex-col gap-2 border-t border-slate-800 pt-4 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {fxLoading && <p className="flex items-center gap-2"><LoaderCircle className="animate-spin" size={14} /> กำลังโหลดอัตราแลกเปลี่ยน…</p>}
          {hasValidRate && <p>1 USD = {formatFxRate(rate)} THB · อัปเดต {transactionDate(currentFx.quote!.asOf, timezone)} · แหล่งข้อมูล {currentFx.quote!.source}</p>}
          {!fxLoading && !hasValidRate && <p className="text-amber-300">ไม่มีอัตราแลกเปลี่ยนจริง จึงปิดการแสดงผล THB</p>}
          {currentFx.quote?.stale && <p className="mt-1 text-amber-300">กำลังใช้อัตราแลกเปลี่ยนล่าสุดที่บันทึกไว้ (Stale)</p>}
          {fxError && hasValidRate && <p className="mt-1 text-amber-300">โหลดอัตราใหม่ไม่สำเร็จ แต่ยังใช้อัตราที่มีอยู่ได้</p>}
        </div>
        <button type="button" onClick={() => void loadFx()} disabled={fxLoading} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start rounded-lg border border-slate-700 px-3 text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-50">
          <RefreshCw className={fxLoading ? 'animate-spin' : ''} size={14} /> โหลดอัตราใหม่
        </button>
      </div>
    </section>

    <PortfolioManager
      portfolios={portfolios}
      summaries={summaries}
      aggregate={aggregateSummary}
      aggregateGoal={aggregateGoal}
      selectedPortfolioId={portfolio.id}
      optionTargetCounts={Object.fromEntries(portfolios.map((item) => [item.id, optionTargets.filter((target) => target.portfolioId === item.id).length]))}
      timezone={timezone}
      effectiveTier={effectiveTier}
      showBalances={showBalances}
      isOnline={isOnline}
      money={money}
      signed={signed}
      percent={percent}
      onSelect={(portfolioId) => {
        setSelectedPortfolioId(portfolioId);
        closeForm();
      }}
      transferOpenRequest={transferRequest}
      onTransferRequestHandled={() => setTransferRequest(0)}
    />

    <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-xs uppercase tracking-wider text-slate-500">กำลังดูพอร์ต</p><h3 className="mt-1 text-lg font-bold text-white">{portfolio.name} · {portfolio.type}</h3></div>
        <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <Metric label="มูลค่าพอร์ต" value={money(summary.totalValue)} />
          <Metric label="เงินสด" value={money(summary.cashBalance)} />
          <Metric
            label="กำไร/ขาดทุนรวม"
            value={`${signed(summary.totalGain)} · ${percent(summary.totalGainPercent)}`}
            tone={portfolioReturnToneClass(showBalances ? summary.totalGain : null, 'text-slate-400')}
          />
          <Metric
            label="กำไร/ขาดทุนวันนี้"
            value={summary.todayChange === null ? '—' : signed(summary.todayChange)}
            tone={portfolioReturnToneClass(showBalances ? summary.todayChange : null, 'text-slate-400')}
          />
        </div>
      </div>
      {summary.todayChange === null && <p className="mt-2 text-xs text-slate-400">ยังคำนวณกำไร/ขาดทุนวันนี้ไม่ได้ เพราะไม่มีราคาปิดวันก่อน</p>}
      {portfolio.archivedAt && <p className="mt-3 text-xs text-amber-300">พอร์ตนี้ถูก Archive แล้ว จึงรับ transaction ใหม่ไม่ได้ แต่ยังรวมในพอร์ตรวมและเก็บ history ครบถ้วน</p>}
      {/*
        Says what is still possible before what is not: the ledger is fully
        readable on the statement route, and only writing needs a higher tier.
        The database is what actually refuses the write; this explains it first.
      */}
      {writeBlock && <p className="mt-3 flex items-start gap-2 text-xs text-[var(--warning)]">
        <Lock aria-hidden="true" size={13} className="mt-0.5 shrink-0" />
        <span>
          {writeBlock === 'upgrade'
            ? 'พอร์ต Options นี้ยังเปิดดูได้ครบ แต่ต้องใช้ Pro เพื่อแก้ไขต่อ'
            : READ_ONLY_PORTFOLIO_MESSAGE}
          {' '}
          <Link href="/settings/subscription" className="font-medium underline underline-offset-2">
            ดูแพ็กเกจ
          </Link>
        </span>
      </p>}
    </section>

    {/*
      No ledger rows live on this page any more — not even a preview of the
      latest one. A portfolio page is about what is held now; what happened is
      a statement, and it has its own route.
    */}
    <Link
      href={`/portfolio/transactions?portfolio=${portfolio.id}`}
      className="flex min-w-0 items-center gap-3 rounded-2xl border border-slate-800 bg-[#151B28] p-4 hover:border-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
      data-testid="portfolio-history-entry"
    >
      <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-800 text-[#D4FF00]">
        <History size={19} />
      </span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm font-bold text-white">ประวัติเงินเข้า–ออก</strong>
        <span className="mt-0.5 block text-xs text-slate-400">ดูรายการซื้อ ขาย ฝาก ถอน โอน และปรับยอดทั้งหมด</span>
      </span>
      <ChevronRight aria-hidden="true" className="shrink-0 text-slate-500" size={18} />
    </Link>

    {portfolio.type !== 'OPTION' && <>
    <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#151B28] shadow-xl">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Briefcase aria-hidden="true" className="shrink-0 text-[#D4FF00]" size={20} />
          <h3 className="min-w-0 font-bold text-white">สินทรัพย์ที่ถืออยู่</h3>
        </div>
        <Button size="sm" disabled={!isOnline || Boolean(writeBlock) || Boolean(portfolio.archivedAt)} onClick={() => openCreate('acquisition')}><Plus size={16} /> เพิ่มสินทรัพย์ที่ถืออยู่</Button>
      </div>
      {summary.holdings.length === 0
        ? <div className="p-8 text-center sm:p-10">
          <p className="font-semibold text-white">ยังไม่มีหุ้นหรือ ETF ในพอร์ต</p>
          <p className="mt-1 text-sm text-slate-400">เพิ่มรายการซื้อ หรือนำเข้าสถานะตั้งต้นเพื่อเริ่มคำนวณ</p>
          <Button className="mt-5" disabled={!isOnline || Boolean(writeBlock) || Boolean(portfolio.archivedAt)} onClick={() => openCreate('acquisition')}><Plus size={17} /> เพิ่มสินทรัพย์ที่ถืออยู่</Button>
        </div>
        : <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[1040px] text-left text-sm" data-testid="holdings-desktop-table">
              <thead><tr className="border-b border-slate-800 text-xs text-slate-500">
                {['Symbol', 'จำนวน', 'ต้นทุนเฉลี่ย', 'ราคาปัจจุบัน', 'มูลค่าตลาด', 'Today P&L', 'Total P&L', 'น้ำหนัก'].map((label, index) =>
                  <th key={label} className={`px-3 py-3 ${index ? 'text-right' : ''}`}>{label}</th>)}
              </tr></thead>
              <tbody>{summary.holdings.map((holding) => <HoldingDesktopRows
                key={holding.symbol}
                holding={holding}
                expanded={expandedSymbol === holding.symbol}
                showBalances={showBalances}
                timezone={timezone}
                money={money}
                signed={signed}
                hidden={hidden}
                onToggle={() => setExpandedSymbol((current) => current === holding.symbol ? null : holding.symbol)}
                onBuy={() => openCreate('acquisition', holding.symbol)}
                onSell={() => openCreate('disposal', holding.symbol)}
                onClose={() => openCreate('disposal', holding.symbol, String(holding.quantity))}
                portfolioId={portfolio.id}
              />)}</tbody>
            </table>
          </div>
          <div className="divide-y divide-slate-800 md:hidden" data-testid="holdings-mobile-cards">
            {summary.holdings.map((holding) => <HoldingMobileCard
              key={holding.symbol}
              holding={holding}
              expanded={expandedSymbol === holding.symbol}
              showBalances={showBalances}
              timezone={timezone}
              money={money}
              signed={signed}
              hidden={hidden}
              onToggle={() => setExpandedSymbol((current) => current === holding.symbol ? null : holding.symbol)}
              onBuy={() => openCreate('acquisition', holding.symbol)}
              onSell={() => openCreate('disposal', holding.symbol)}
              onClose={() => openCreate('disposal', holding.symbol, String(holding.quantity))}
              portfolioId={portfolio.id}
            />)}
          </div>
        </>}
      <p className="border-t border-slate-800 px-4 py-3 text-xs text-slate-500">
        ทุกสถานะคำนวณจาก Transaction Ledger เท่านั้น การเพิ่มซื้อ ขาย แก้ไข หรือลบจะสร้างหรือเปลี่ยนรายการต้นทางแล้วคำนวณใหม่ทั้งพอร์ต
      </p>
    </section>
    </>}

    {portfolio.type !== 'STOCK' &&
    <OptionsSection
      portfolio={portfolio}
      portfolios={portfolios.filter((item) => item.archivedAt === null && (item.type === 'OPTION' || item.type === 'LEGACY'))}
      positions={summary.optionPositions}
      targets={optionTargets.filter((target) => target.portfolioId === portfolio.id)}
      cashByPortfolioId={Object.fromEntries(portfolios.map((item) => [item.id, summaries[item.id].cashBalance]))}
      currency={currency}
      usdThbRate={rate}
      showBalances={showBalances}
      isOnline={isOnline}
      timezone={timezone}
      readOnly={Boolean(writeBlock)}
      actionRequest={optionActionRequest}
      onActionRequestHandled={handleOptionActionRequest}
    />}

    <ResponsiveDialog isOpen={actionSheetOpen} onClose={() => setActionSheetOpen(false)} title="+ เพิ่มรายการ">
      <p className="mb-4 text-sm text-slate-400">บันทึกใน {portfolio.name} โดยใช้ Ledger เดิม</p>
      <div className="grid gap-3 sm:grid-cols-2" data-testid="portfolio-add-action-sheet">
        <ActionChoice icon={<WalletCards size={20} />} title="ซื้อหุ้น / ออปชัน" detail="เพิ่มสินทรัพย์และหักเงินสด" onClick={() => { setActionSheetOpen(false); if (portfolio.type === 'OPTION') setOptionActionRequest({ id: Date.now(), type: 'buy' }); else openCreate('acquisition'); }} />
        <ActionChoice icon={<ArrowUpCircle size={20} />} title="ขาย" detail="ลดสถานะและบันทึกเงินเข้า" onClick={() => { setActionSheetOpen(false); if (portfolio.type === 'OPTION') setOptionActionRequest({ id: Date.now(), type: 'sell' }); else openCreate('disposal'); }} />
        <ActionChoice icon={<ArrowDownCircle size={20} />} title="เติมเงินจำลอง" detail="เพิ่มเงินสดเข้าพอร์ต" onClick={() => { setActionSheetOpen(false); openCreate('deposit'); }} />
        <ActionChoice icon={<ArrowUpCircle size={20} />} title="ถอนเงินจำลอง" detail="ลดเงินสดออกจากพอร์ต" onClick={() => { setActionSheetOpen(false); openCreate('withdrawal'); }} />
        <ActionChoice icon={<Repeat2 size={20} />} title="โอนพอร์ต" detail="ย้ายเงินด้วยรายการคู่ใน Ledger" disabled={portfolios.filter((item) => item.archivedAt === null).length < 2} onClick={() => { setActionSheetOpen(false); setTransferRequest(Date.now()); }} />
      </div>
    </ResponsiveDialog>

    <TransactionFormModal
      open={formOpen}
      editing={false}
      form={form}
      errors={errors}
      pending={pending || !isOnline}
      portfolios={portfolios.filter((item) => item.archivedAt === null)}
      cashByPortfolioId={Object.fromEntries(portfolios.map((item) => [item.id, summaries[item.id].cashBalance]))}
      replacedTransaction={null}
      onChange={change}
      onClose={() => !pending && closeForm()}
      onSubmit={submit}
    />
    <PortfolioValueSheet
      key={valueSheetKey}
      idempotencyKey={valueSheetKey}
      open={valueSheetOpen}
      portfolios={portfolios.filter((item) => item.archivedAt === null)}
      summaries={summaries}
      defaultPortfolioId={portfolio.id}
      currency={currency}
      usdThbRate={rate}
      timezone={timezone}
      pending={pending}
      isOnline={isOnline}
      error={valueSheetError}
      onClose={() => { setValueSheetOpen(false); setValueSheetError(''); }}
      onSubmit={submitPortfolioValue}
    />
  </main>;
}

function quoteMeta(holding: HoldingSummary, timezone: string) {
  if (holding.marketPrice === null) {
    return <span className="block text-[10px] text-amber-300">ข้อมูลราคายังไม่พร้อม</span>;
  }
  return (
    <span className={`block text-[10px] ${holding.priceStale ? 'text-amber-300' : 'text-slate-500'}`}>
      {holding.priceStale || holding.priceCached
        ? 'ข้อมูลล่าสุดที่บันทึกไว้'
        : 'ข้อมูลตลาด'}
      {holding.priceAsOf ? ` · ${transactionDate(holding.priceAsOf, timezone)}` : ''}
    </span>
  );
}

function totalPnlPercent(holding: HoldingSummary) {
  return holding.unrealizedGain === null || holding.costBasis === 0 ? null : holding.unrealizedGain / holding.costBasis * 100;
}

function HoldingDesktopRows({ holding, expanded, showBalances, timezone, portfolioId, money, signed, hidden, onToggle, onBuy, onSell, onClose }: HoldingViewProps) {
  return <>
    <tr className="border-b border-slate-800/60 last:border-0 hover:bg-slate-800/30">
      <td className="p-0">
        <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex min-h-14 w-full items-center gap-2 px-3 text-left font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]">
          {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          <InstrumentLogo symbol={holding.symbol} companyName={holding.symbol} logoUrl={null} size={32} />
          {holding.symbol}
        </button>
      </td>
      <td className="px-3 py-3 text-right font-mono">{hidden(number(holding.quantity))}</td>
      <td className="px-3 py-3 text-right font-mono">{money(holding.averageCost)}</td>
      <td className="px-3 py-3 text-right font-mono">{money(holding.marketPrice)}{quoteMeta(holding, timezone)}</td>
      <td className="px-3 py-3 text-right font-mono text-white">{money(holding.marketValue)}</td>
      <td className={`px-3 py-3 text-right font-mono ${holding.todayChange === null ? 'text-slate-400' : gainColor(holding.todayChange)}`}>{signed(holding.todayChange)}</td>
      <td className={`px-3 py-3 text-right font-mono ${holding.unrealizedGain === null ? 'text-slate-400' : gainColor(holding.unrealizedGain)}`}>{signed(holding.unrealizedGain)}<span className="block text-[10px]">{holding.unrealizedGain === null ? '—' : signedPercent(totalPnlPercent(holding)!, showBalances)}</span></td>
      <td className="px-3 py-3 text-right font-mono">{showBalances ? `${holding.allocation.toFixed(2)}%` : SENSITIVE_VALUE_MASK}</td>
    </tr>
    {expanded && <tr className="border-b border-slate-800"><td colSpan={8} className="bg-slate-950/35 p-4"><HoldingDetails holding={holding} timezone={timezone} portfolioId={portfolioId} money={money} hidden={hidden} onBuy={onBuy} onSell={onSell} onClose={onClose} /></td></tr>}
  </>;
}

function HoldingMobileCard(props: HoldingViewProps) {
  const { holding, expanded, showBalances, timezone, money, signed, hidden, onToggle } = props;
  return <article className="p-4">
    <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex min-h-11 w-full items-center justify-between gap-3 text-left">
      <InstrumentLogo symbol={holding.symbol} companyName={holding.symbol} logoUrl={null} size={40} />
      <span><strong className="text-lg text-white">{holding.symbol}</strong><span className="mt-1 block text-xs text-slate-400">{hidden(number(holding.quantity))} หน่วย · น้ำหนัก {showBalances ? `${holding.allocation.toFixed(2)}%` : SENSITIVE_VALUE_MASK}</span></span>
      {expanded ? <ChevronUp className="shrink-0" size={18} /> : <ChevronDown className="shrink-0" size={18} />}
    </button>
    <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-4 text-sm">
      <MobileMetric label="ต้นทุนเฉลี่ย" value={money(holding.averageCost)} />
      <MobileMetric label="ราคาปัจจุบัน" value={money(holding.marketPrice)} extra={quoteMeta(holding, timezone)} />
      <MobileMetric label="มูลค่าตลาด" value={money(holding.marketValue)} />
      <MobileMetric label="Today P&L" value={signed(holding.todayChange)} tone={holding.todayChange === null ? 'text-slate-400' : gainColor(holding.todayChange)} />
      <MobileMetric label="Total P&L" value={signed(holding.unrealizedGain)} tone={holding.unrealizedGain === null ? 'text-slate-400' : gainColor(holding.unrealizedGain)} />
      <MobileMetric label="Total P&L %" value={holding.unrealizedGain === null ? '—' : signedPercent(totalPnlPercent(holding)!, showBalances)} tone={holding.unrealizedGain === null ? 'text-slate-400' : gainColor(holding.unrealizedGain)} />
    </dl>
    {expanded && <div className="mt-4 border-t border-slate-800 pt-4"><HoldingDetails {...props} /></div>}
  </article>;
}

interface HoldingViewProps {
  holding: HoldingSummary;
  expanded: boolean;
  showBalances: boolean;
  timezone: string;
  money: (value: number | string | null) => string;
  signed: (value: number | null) => string;
  hidden: (value: string) => string;
  onToggle: () => void;
  onBuy: () => void;
  onSell: () => void;
  onClose: () => void;
  portfolioId: string;
}

function HoldingDetails({ holding, timezone, portfolioId, money, hidden, onBuy, onSell, onClose }: Pick<HoldingViewProps, 'holding' | 'timezone' | 'portfolioId' | 'money' | 'hidden' | 'onBuy' | 'onSell' | 'onClose'>) {
  return <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={onBuy}>เพิ่มซื้อ</Button>
      <Button size="sm" variant="outline" onClick={onSell}>ขายบางส่วน</Button>
      <Button size="sm" variant="outline" onClick={onClose}>ปิดทั้งหมด</Button>
    </div>
    <div>
      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Lots ที่เหลือ</h4>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">{holding.lots.map((lot) => <div key={lot.transactionId} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs">
        <p className="font-mono text-white">{hidden(number(lot.remainingQuantity))} / {hidden(number(lot.originalQuantity))} หน่วย</p>
        <p className="mt-1 text-slate-400">{transactionDate(lot.occurredAt, timezone)} · ต้นทุนคงเหลือ {money(lot.remainingCost)}</p>
        {lot.broker && <p className="text-slate-500">{lot.broker}</p>}
      </div>)}</div>
    </div>
    {/*
      Lots describe what is still held, so they belong here. The transactions
      behind them are history, and history lives on the statement route where
      it can be read, filtered and corrected in one place.
    */}
    <Link
      href={`/portfolio/transactions?portfolio=${portfolioId}`}
      className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-700 px-3 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
    >
      <History aria-hidden="true" size={14} /> ดูประวัติของ {holding.symbol} ในประวัติเงินเข้า–ออก
    </Link>
  </div>;
}

function MobileMetric({ label, value, tone = 'text-white', extra }: { label: string; value: string; tone?: string; extra?: React.ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-slate-500">{label}</dt><dd className={`mt-1 break-words font-mono font-semibold ${tone}`}>{value}</dd>{extra}</div>;
}

function Metric({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0"><p className="text-xs text-slate-500">{label}</p><p className={`mt-1 break-all font-mono text-sm font-semibold sm:text-base ${tone}`}>{value}</p></div>;
}

function ActionChoice({ icon, title, detail, onClick, disabled = false }: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return <button type="button" disabled={disabled} onClick={onClick} className="flex min-h-20 min-w-0 items-start gap-3 rounded-xl border border-slate-700 bg-slate-950/45 p-3 text-left hover:border-[#D4FF00]/60 disabled:cursor-not-allowed disabled:opacity-40">
    <span className="mt-0.5 shrink-0 text-[#D4FF00]">{icon}</span>
    <span className="min-w-0"><strong className="block break-words text-sm text-white">{title}</strong><span className="mt-1 block break-words text-xs text-slate-400">{detail}</span></span>
  </button>;
}
