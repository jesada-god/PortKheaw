'use client';

import { useEffect, useMemo, useState, useTransition, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowDownCircle, ArrowLeft, ArrowUpCircle, Edit3, Eye, EyeOff, Repeat2, Trash2,
} from 'lucide-react';
import {
  deletePortfolioTransactionAction,
  updatePortfolioTransactionAction,
} from '@/app/portfolio/actions';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import { useToast } from '@/src/components/ui/Toast';
import { TransactionFormModal, transactionLabels, type TransactionFormState } from './TransactionFormModal';
import { calculatePortfolio } from '@/src/lib/portfolio/calculations';
import { formatPortfolioMoney } from '@/src/lib/portfolio/presentation';
import {
  buildTransactionHistory,
  formatTransactionHistoryDay,
  limitTransactionHistory,
  transactionDirectionToneClass,
  type TransactionHistoryEntry,
} from '@/src/lib/portfolio/transaction-history';
import {
  currentDateTimeLocal,
  formatDateTimeLocal,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { transferProvenance } from '@/src/lib/portfolio/transfer/provenance';
import type { PortfolioRecord, PortfolioTransaction } from '@/src/lib/portfolio/types';
import type { FxResult } from '@/src/lib/market-data/fx/service';
import type { SupportedCurrency } from '@/src/lib/market-data/fx/types';
import { fetchFxRate } from '@/src/lib/market-data/fx/client';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { usePortfolioPrivacy } from '@/src/hooks/usePortfolioPrivacy';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';
import { READ_ONLY_PORTFOLIO_MESSAGE } from '@/src/lib/subscription/entitlement-errors';
import {
  basicWritableStockPortfolioId,
  portfolioWriteBlock,
} from '@/src/lib/subscription/portfolio-write-access';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';

const PAGE_SIZE = 25;

function displayTime(value: string, timezone: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('th-TH', { timeStyle: 'short', timeZone: timezone }).format(parsed);
}

function emptyForm(transaction: PortfolioTransaction, timezone: string): TransactionFormState {
  return {
    portfolioId: transaction.portfolioId,
    type: transaction.type,
    symbol: transaction.symbol ?? '',
    quantity: transaction.quantity ?? '',
    price: transaction.price ?? '',
    amount: transaction.originalAmount ?? transaction.amount ?? '',
    fee: transaction.fee ?? '0',
    originalCurrency: transaction.originalCurrency ?? 'USD',
    fxRateAtTransaction: transaction.fxRateAtTransaction ?? '',
    occurredAt: formatDateTimeLocal(transaction.occurredAtTime ?? transaction.occurredAt, timezone)
      || currentDateTimeLocal(timezone),
    timezone,
    broker: transaction.broker ?? '',
    note: transaction.note ?? '',
    underlyingSymbol: transaction.underlyingSymbol ?? '',
    contractSymbol: transaction.contractSymbol ?? '',
    optionKind: transaction.optionKind ?? 'call',
    optionSide: transaction.optionSide ?? 'long',
    strikePrice: transaction.strikePrice ?? '',
    expirationDate: transaction.expirationDate ?? '',
    multiplier: transaction.multiplier ?? '100',
    idempotencyKey: transaction.idempotencyKey ?? crypto.randomUUID(),
  };
}

/**
 * The bank-statement view of the Transaction Ledger, on its own route.
 *
 * The portfolio page no longer lists a single ledger row; everything historical
 * — buys, sells, deposits, withdrawals, transfers and balance reconciliations —
 * is read here, from the same rows the portfolio is calculated from.
 */
export function TransactionHistoryClient({
  portfolios,
  initialPortfolioId,
  fx,
  timezone,
  effectiveTier,
}: {
  portfolios: PortfolioRecord[];
  initialPortfolioId: string;
  fx: FxResult;
  timezone: string;
  effectiveTier: SubscriptionTier;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const isOnline = useOnlineStatus();
  const { visible: showBalances, toggleVisibility } = usePortfolioPrivacy();
  const [pending, startTransition] = useTransition();
  const [scope, setScope] = useState<string>(initialPortfolioId);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<TransactionHistoryEntry | null>(null);
  const [editing, setEditing] = useState<PortfolioTransaction | null>(null);
  const [form, setForm] = useState<TransactionFormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<PortfolioTransaction | null>(null);
  const [rate, setRate] = useState<string | null>(fx.quote?.rate ?? null);
  const currency: SupportedCurrency = portfolios[0]?.baseCurrency ?? 'USD';

  useEffect(() => {
    if (currency !== 'THB') return;
    let active = true;
    void fetchFxRate(fetch, 1)
      .then((parsed) => { if (active) setRate(parsed.quote?.rate ?? null); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [currency]);

  const writableStockId = useMemo(() => basicWritableStockPortfolioId(portfolios), [portfolios]);
  /*
   * Cash comes out of the ledger alone, so the edit form's "cash after this
   * change" preview is exact here without loading a single market price.
   */
  const cashByPortfolioId = useMemo(
    () => Object.fromEntries(portfolios.map((item) => [item.id, calculatePortfolio(item.transactions).cashBalance])),
    [portfolios],
  );
  const days = useMemo(
    () => buildTransactionHistory(portfolios, timezone, scope),
    [portfolios, scope, timezone],
  );
  const page = useMemo(() => limitTransactionHistory(days, visibleCount), [days, visibleCount]);
  /*
   * A live name is preferred over the snapshot, so renaming a portfolio the
   * reader still has updates what its past transfers say about it. The snapshot
   * only takes over once there is no live portfolio left to name.
   */
  const selectedProvenance = selected
    ? transferProvenance(
      selected.transaction,
      (portfolioId) => portfolios.find((item) => item.id === portfolioId)?.name ?? null,
    )
    : null;

  const money = (value: number) => showBalances
    ? formatPortfolioMoney(value, currency, rate, true)
    : SENSITIVE_VALUE_MASK;

  function openEdit(transaction: PortfolioTransaction) {
    setSelected(null);
    setEditing(transaction);
    setErrors({});
    setForm(emptyForm(transaction, timezone));
  }

  function submitEdit(event: FormEvent) {
    event.preventDefault();
    if (!editing || !form || pending || !isOnline) return;
    const dateTime = validateTransactionDateTime(form.occurredAt, form.timezone);
    if (!dateTime.ok) {
      setErrors((current) => ({ ...current, occurredAt: dateTime.message }));
      return;
    }
    startTransition(async () => {
      const result = await updatePortfolioTransactionAction(editing.id, form);
      if (!result.ok) {
        setErrors(result.fields ?? {});
        addToast({ title: 'บันทึกไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      setEditing(null);
      setForm(null);
      addToast({ title: 'แก้ไขรายการแล้ว', message: 'พอร์ตจะคำนวณใหม่จาก Ledger ทั้งหมด', type: 'success' });
      router.refresh();
    });
  }

  function confirmDelete() {
    if (!deleting || pending || !isOnline) return;
    startTransition(async () => {
      const result = await deletePortfolioTransactionAction(deleting.id);
      if (!result.ok) {
        addToast({ title: 'ลบไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      setDeleting(null);
      addToast({ title: 'ลบรายการแล้ว', message: 'พอร์ตคำนวณใหม่จากรายการที่เหลือ', type: 'success' });
      router.refresh();
    });
  }

  const selectedWriteBlock = selected
    ? portfolioWriteBlock(
      effectiveTier,
      portfolios.find((item) => item.id === selected.transaction.portfolioId)!,
      writableStockId,
    )
    : null;

  return <main className="mx-auto w-full max-w-3xl space-y-4 overflow-x-clip p-3 sm:p-4 md:p-8">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <Link
        href="/portfolio"
        className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-semibold text-slate-300 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]"
      >
        <ArrowLeft aria-hidden="true" size={17} /> กลับไปหน้าพอร์ต
      </Link>
      <button
        type="button"
        onClick={toggleVisibility}
        aria-label={showBalances ? 'ซ่อนยอดเงินทั้งหมด' : 'แสดงยอดเงินชั่วคราว'}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 hover:text-white"
      >
        {showBalances ? <EyeOff size={19} /> : <Eye size={19} />}
      </button>
    </div>

    <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-4 sm:p-5">
      <h2 className="text-lg font-bold text-white">ประวัติเงินเข้า–ออก</h2>
      <p className="mt-1 text-xs text-slate-400">
        ทุกรายการซื้อ ขาย ฝาก ถอน โอน และปรับยอดพอร์ต อ่านจาก Transaction Ledger เดียวกับที่ใช้คำนวณพอร์ต
      </p>
      <div className="mt-3">
        <label className="block text-xs font-medium text-slate-400" htmlFor="transaction-history-scope">พอร์ตที่แสดง</label>
        <select
          id="transaction-history-scope"
          className="form-input mt-1.5 min-h-12"
          value={scope}
          onChange={(event) => { setScope(event.target.value); setVisibleCount(PAGE_SIZE); }}
        >
          <option value="all">รวมทุกพอร์ต</option>
          {portfolios.map((portfolio) => <option key={portfolio.id} value={portfolio.id}>{portfolio.name}</option>)}
        </select>
      </div>
    </section>

    {!isOnline && <aside className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
      โหมดอ่านอย่างเดียวขณะออฟไลน์ — แก้ไขและลบรายการไม่ได้จนกว่าจะเชื่อมต่ออีกครั้ง
    </aside>}

    {page.total === 0
      ? <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-8 text-center" data-testid="transaction-history-empty">
        <p className="font-semibold text-white">ยังไม่มีรายการในช่วงที่เลือก</p>
        <p className="mt-1 text-sm text-slate-400">เมื่อบันทึกการซื้อ ขาย ฝาก ถอน หรือปรับยอดพอร์ต รายการจะมาแสดงที่นี่</p>
        <Button className="mt-5" onClick={() => router.push('/portfolio')}>ไปที่หน้าพอร์ต</Button>
      </section>
      : <section className="space-y-3" data-testid="transaction-history-list">
        {page.days.map((day) => <div key={day.dateKey} className="min-w-0 rounded-2xl border border-slate-800 bg-[#151B28]">
          <h3 className="border-b border-slate-800 px-4 py-2.5 text-xs font-bold text-slate-400">
            {formatTransactionHistoryDay(day.dateKey)}
          </h3>
          <ul className="divide-y divide-slate-800">
            {day.entries.map((entry) => <li key={entry.transaction.id}>
              <button
                type="button"
                onClick={() => setSelected(entry)}
                className="flex min-h-16 w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-slate-800/40 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#D4FF00]"
              >
                <span
                  aria-hidden="true"
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${entry.direction === 'in' ? 'bg-emerald-500/15 text-emerald-300' : entry.direction === 'out' ? 'bg-red-500/15 text-red-300' : 'bg-slate-800 text-slate-400'}`}
                >
                  {entry.direction === 'in' ? <ArrowDownCircle size={18} /> : entry.direction === 'out' ? <ArrowUpCircle size={18} /> : <Repeat2 size={18} />}
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-semibold text-slate-100">
                    {transactionLabels[entry.transaction.type]}
                    {entry.transaction.symbol
                      ? ` · ${entry.transaction.symbol}`
                      : entry.transaction.contractSymbol ? ` · ${entry.transaction.contractSymbol}` : ''}
                  </strong>
                  <span className="block truncate text-xs text-slate-500">
                    {displayTime(entry.occurredAtIso, timezone)} · {entry.portfolioName}
                  </span>
                  {entry.transaction.note && <span className="block truncate text-xs text-slate-500">{entry.transaction.note}</span>}
                </span>
                <strong
                  className={`max-w-[40%] shrink-0 break-all text-right font-mono text-sm ${transactionDirectionToneClass(entry.direction, 'text-slate-400')}`}
                  data-direction={entry.direction}
                >
                  {entry.direction === 'none'
                    ? 'ไม่กระทบเงินสด'
                    : `${entry.direction === 'in' ? '+' : '−'}${money(Math.abs(entry.cashEffect))}`}
                </strong>
              </button>
            </li>)}
          </ul>
        </div>)}
        {page.shown < page.total && <Button
          variant="outline"
          className="w-full"
          onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
        >โหลดรายการเพิ่ม ({page.shown}/{page.total})</Button>}
      </section>}

    <Modal
      isOpen={Boolean(selected)}
      onClose={() => setSelected(null)}
      title={selected ? transactionLabels[selected.transaction.type] : 'รายละเอียดรายการ'}
    >
      {selected && <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <DetailRow label="พอร์ต" value={selected.portfolioName} />
          <DetailRow label="วันและเวลา" value={`${formatTransactionHistoryDay(formatDateTimeLocal(selected.occurredAtIso, timezone).slice(0, 10))} ${displayTime(selected.occurredAtIso, timezone)}`} />
          {selected.transaction.symbol && <DetailRow label="สินทรัพย์" value={selected.transaction.symbol} />}
          {selected.transaction.contractSymbol && <DetailRow label="สัญญา" value={selected.transaction.contractSymbol} />}
          {selected.transaction.quantity && Number(selected.transaction.quantity) > 0
            && <DetailRow label="จำนวน" value={showBalances ? selected.transaction.quantity : SENSITIVE_VALUE_MASK} />}
          <DetailRow
            label="ผลต่อเงินสด"
            value={selected.direction === 'none'
              ? 'ไม่กระทบเงินสด'
              : `${selected.direction === 'in' ? '+' : '−'}${money(Math.abs(selected.cashEffect))}`}
            tone={transactionDirectionToneClass(selected.direction, 'text-slate-300')}
          />
        </dl>
        {selected.transaction.note && <p className="rounded-lg bg-slate-950/50 p-3 text-sm text-slate-300">{selected.transaction.note}</p>}
        {/*
          Where the transfer came from or went to. It reads from the name written
          into the row at transfer time, so it still says something once the
          other portfolio has been purged — the row itself is never touched by
          that purge, and a bare missing id would leave this holding looking as
          though it arrived from nowhere.
        */}
        {selectedProvenance && <p className="text-sm text-slate-300" data-testid="transaction-transfer-provenance">
          {selectedProvenance.label}
        </p>}
        {selected.transaction.transferId
          ? <p className="text-xs text-slate-500">รายการโอนระหว่างพอร์ตเป็นคู่กัน จึงแก้ไขหรือลบทีละด้านไม่ได้</p>
          : selectedWriteBlock
            ? <p className="text-xs text-[var(--warning)]">{READ_ONLY_PORTFOLIO_MESSAGE}</p>
            : <div className="flex gap-2">
              <Button variant="outline" className="flex-1" disabled={!isOnline} onClick={() => openEdit(selected.transaction)}>
                <Edit3 size={15} /> แก้ไขรายการ
              </Button>
              <Button
                variant="outline"
                className="flex-1"
                disabled={!isOnline}
                onClick={() => { setDeleting(selected.transaction); setSelected(null); }}
              >
                <Trash2 size={15} /> ย้อนรายการ
              </Button>
            </div>}
      </div>}
    </Modal>

    {form && <TransactionFormModal
      open={Boolean(editing)}
      editing
      form={form}
      errors={errors}
      pending={pending || !isOnline}
      portfolios={portfolios.filter((item) => item.archivedAt === null)}
      cashByPortfolioId={cashByPortfolioId}
      replacedTransaction={editing}
      onChange={(name, value) => {
        setForm((current) => current ? { ...current, [name]: value } : current);
        setErrors((current) => ({ ...current, [name]: '' }));
      }}
      onClose={() => { if (!pending) { setEditing(null); setForm(null); setErrors({}); } }}
      onSubmit={submitEdit}
    />}

    <Modal
      isOpen={Boolean(deleting)}
      onClose={() => !pending && setDeleting(null)}
      title={`ย้อนรายการ ${deleting ? transactionLabels[deleting.type] : ''} หรือไม่`}
    >
      <p className="text-sm text-slate-300">
        ระบบจะคำนวณจำนวน ต้นทุน เงินสด และกำไร/ขาดทุนใหม่ทั้งหมดจากรายการที่เหลือ
        การย้อนรายการอาจไม่สำเร็จหากทำให้รายการขายภายหลังเกินจำนวนที่มี
      </p>
      <div className="mt-5 flex gap-2">
        <Button variant="outline" className="flex-1" disabled={pending} onClick={() => setDeleting(null)}>ยกเลิก</Button>
        <Button className="flex-1 bg-red-500 text-white hover:bg-red-400" disabled={pending || !isOnline} onClick={confirmDelete}>
          {pending ? 'กำลังย้อนรายการ…' : 'ยืนยัน'}
        </Button>
      </div>
    </Modal>
  </main>;
}

function DetailRow({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0">
    <dt className="text-xs text-slate-500">{label}</dt>
    <dd className={`mt-0.5 break-words font-mono text-sm font-semibold ${tone}`}>{value}</dd>
  </div>;
}
