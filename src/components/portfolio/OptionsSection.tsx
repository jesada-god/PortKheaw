'use client';

import { useMemo, useRef, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Edit3, Plus, Target, Trash2 } from 'lucide-react';
import { createPortfolioTransactionAction, deletePortfolioTransactionAction, updatePortfolioTransactionAction } from '@/app/portfolio/actions';
import { deleteOptionTargetAction, upsertOptionTargetAction } from '@/app/portfolio/target-actions';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import { useToast } from '@/src/components/ui/Toast';
import { calculateOptionTarget } from '@/src/lib/portfolio/options/calculations';
import { isInternalOptionContractSymbol } from '@/src/lib/portfolio/options/contract-symbol-status';
import {
  UNMATCHED_OPTION_MESSAGE,
  optionPositionDescription,
  optionPositionMarketSymbol,
  optionPositionTitle,
} from '@/src/lib/portfolio/options/presentation';
import type { OptionPositionSummary, OptionTarget, OptionTargetMode } from '@/src/lib/portfolio/options/types';
import type { PortfolioRecord, PortfolioTransaction, PortfolioTransactionType } from '@/src/lib/portfolio/types';
import type { SupportedCurrency } from '@/src/lib/market-data/fx/types';
import { formatPortfolioMoney, gainColor, signedMoney, signedPercent } from '@/src/lib/portfolio/presentation';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';
import { estimateCashAfterTransaction } from '@/src/lib/portfolio/cash-preview';
import {
  currentDateTimeLocal,
  formatDateTimeLocal,
  maximumTransactionDateTimeLocal,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { DecimalInput, Field } from './FormControls';
import { SymbolPreview } from './SymbolPreview';
import { transactionLabels, type TransactionFormState } from './TransactionFormModal';

const optionActions: PortfolioTransactionType[] = [
  'buy_to_open', 'sell_to_close', 'sell_to_open', 'buy_to_close', 'exercise', 'assignment', 'expired',
];

function emptyOptionForm(portfolioId = '', timezone = 'Asia/Bangkok'): TransactionFormState {
  return {
    portfolioId,
    type: 'buy_to_open',
    symbol: '',
    quantity: '1',
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
  };
}

function editDateTime(value: string, timezone: string) {
  return formatDateTimeLocal(value, timezone) || `${value}T12:00`;
}

function displayTime(value: string, timezone = 'Asia/Bangkok') {
  const parsed = Date.parse(value);
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone })
    .format(Number.isFinite(parsed) ? new Date(parsed) : new Date(`${value}T12:00:00+07:00`));
}

function quoteNumber(value: number | null, digits?: number) {
  if (value === null) return '—';
  if (digits !== undefined) return value.toFixed(digits);
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
    useGrouping: false,
  }).format(value);
}

export function OptionsSection({ portfolio, portfolios, positions, targets, cashByPortfolioId, currency, usdThbRate, showBalances, isOnline, timezone, readOnly = false }: {
  portfolio: PortfolioRecord;
  portfolios: PortfolioRecord[];
  positions: OptionPositionSummary[];
  targets: OptionTarget[];
  cashByPortfolioId: Record<string, number>;
  currency: SupportedCurrency;
  usdThbRate: string | null;
  showBalances: boolean;
  isOnline: boolean;
  timezone: string;
  /** True when the subscription may read this portfolio but not write to it. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<string | null>(positions.find((item) => item.status === 'open')?.key ?? null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PortfolioTransaction | null>(null);
  const [deleting, setDeleting] = useState<PortfolioTransaction | null>(null);
  const [form, setForm] = useState<TransactionFormState>(() => emptyOptionForm(portfolio.id, timezone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [targetPosition, setTargetPosition] = useState<OptionPositionSummary | null>(null);
  const [targetDeleting, setTargetDeleting] = useState<OptionTarget | null>(null);
  const [targetMode, setTargetMode] = useState<OptionTargetMode>('premium');
  const [targetValue, setTargetValue] = useState('');
  const [targetFee, setTargetFee] = useState('0');
  const [targetError, setTargetError] = useState('');
  const money = (value: number | null) => value === null ? '—' : formatPortfolioMoney(value, currency, usdThbRate, showBalances);
  const signed = (value: number | null) => value === null ? '—' : signedMoney(value, currency, usdThbRate, showBalances);
  const targetDeletingPosition = targetDeleting
    ? positions.find((position) => position.contractSymbol === targetDeleting.contractSymbol) ?? null
    : null;

  function change(name: keyof TransactionFormState, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: '' }));
  }

  function openCreate(position?: OptionPositionSummary, type?: PortfolioTransactionType) {
    setEditing(null);
    setErrors({});
    const base = emptyOptionForm(portfolio.id, timezone);
    if (position) {
      const closeType = type ?? (position.side === 'long' ? 'sell_to_close' : 'buy_to_close');
      setForm({
        ...base,
        type: closeType,
        quantity: String(position.contracts),
        price: closeType === 'exercise' || closeType === 'assignment' || closeType === 'expired' ? '0' : '',
        underlyingSymbol: position.underlyingSymbol,
        contractSymbol: position.contractSymbol,
        optionKind: position.optionKind,
        optionSide: position.side,
        strikePrice: String(position.strikePrice),
        expirationDate: position.expirationDate,
        multiplier: String(position.multiplier),
      });
    } else {
      setForm(base);
    }
    setFormOpen(true);
  }

  function openEdit(transaction: PortfolioTransaction) {
    setEditing(transaction);
    setErrors({});
    setForm({
      ...emptyOptionForm(transaction.portfolioId, timezone),
      portfolioId: transaction.portfolioId,
      type: transaction.type,
      quantity: transaction.quantity ?? '',
      price: transaction.price ?? '0',
      fee: transaction.fee ?? '0',
      originalCurrency: transaction.originalCurrency ?? 'USD',
      fxRateAtTransaction: transaction.fxRateAtTransaction ?? '',
      occurredAt: editDateTime(transaction.occurredAtTime ?? transaction.occurredAt, timezone),
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
    });
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditing(null);
    setErrors({});
    setForm(emptyOptionForm(portfolio.id, timezone));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !isOnline) return;
    const dateTime = validateTransactionDateTime(form.occurredAt, form.timezone);
    if (!dateTime.ok) {
      setErrors((current) => ({ ...current, occurredAt: dateTime.message }));
      return;
    }
    startTransition(async () => {
      const result = editing
        ? await updatePortfolioTransactionAction(editing.id, form)
        : await createPortfolioTransactionAction(form);
      if (!result.ok) {
        setErrors(result.fields ?? {});
        addToast({ title: 'บันทึกออปชันไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      closeForm();
      addToast({ title: editing ? 'แก้ไขรายการออปชันแล้ว' : 'เพิ่มรายการออปชันแล้ว', message: 'เงินสด ต้นทุน และ P&L คำนวณใหม่จาก Ledger', type: 'success' });
      router.refresh();
    });
  }

  function confirmDelete() {
    if (!deleting || pending || !isOnline) return;
    startTransition(async () => {
      const result = await deletePortfolioTransactionAction(deleting.id);
      if (!result.ok) {
        addToast({ title: 'ลบรายการไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      setDeleting(null);
      addToast({ title: 'ลบรายการออปชันแล้ว', type: 'success' });
      router.refresh();
    });
  }

  function openTarget(position: OptionPositionSummary) {
    const target = targets.find((item) => item.contractSymbol === position.contractSymbol);
    setTargetPosition(position);
    setTargetMode(target?.mode ?? 'premium');
    setTargetValue(target ? String(target.targetValue) : '');
    setTargetFee(target ? String(target.estimatedFee) : '0');
    setTargetError('');
  }

  const targetPreview = useMemo(() => {
    if (!targetPosition || targetValue === '' || !Number.isFinite(Number(targetValue)) || !Number.isFinite(Number(targetFee || 0))) return null;
    try {
      return calculateOptionTarget(targetPosition, targetMode, Number(targetValue), Number(targetFee || 0));
    } catch {
      return null;
    }
  }, [targetFee, targetMode, targetPosition, targetValue]);

  function submitTarget(event: FormEvent) {
    event.preventDefault();
    if (!targetPosition || !targetPreview || pending || !isOnline) {
      setTargetError('กรุณากรอกเป้าหมายที่คำนวณได้');
      return;
    }
    const existing = targets.find((item) => item.contractSymbol === targetPosition.contractSymbol);
    startTransition(async () => {
      const result = await upsertOptionTargetAction({
        portfolioId: portfolio.id,
        id: existing?.id,
        contractSymbol: targetPosition.contractSymbol,
        mode: targetMode,
        targetValue: Number(targetValue),
        estimatedFee: Number(targetFee || 0),
      });
      if (!result.ok) {
        setTargetError(result.message);
        return;
      }
      setTargetPosition(null);
      addToast({ title: 'บันทึกเป้าหมายขายแล้ว', message: 'ระบบติดตามในแอปเมื่อเปิดหรือรีเฟรชหน้าพอร์ต และไม่ส่งคำสั่งซื้อขาย', type: 'success' });
      router.refresh();
    });
  }

  function confirmTargetDelete() {
    if (!targetDeleting || pending || !isOnline) return;
    startTransition(async () => {
      const result = await deleteOptionTargetAction(targetDeleting.id);
      if (!result.ok) {
        addToast({ title: 'ลบเป้าหมายไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      setTargetDeleting(null);
      addToast({ title: 'ลบเป้าหมายขายแล้ว', type: 'success' });
      router.refresh();
    });
  }

  return <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#151B28] shadow-xl">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4 sm:px-5">
      <div>
        <h3 className="font-bold text-white">สัญญาออปชันที่ถืออยู่</h3>
        <p className="mt-1 text-xs text-slate-500">ทุก Action เป็นรายการใน Transaction Ledger และไม่ส่ง Order ไปโบรกเกอร์</p>
      </div>
      <Button size="sm" disabled={!isOnline || readOnly || Boolean(portfolio.archivedAt)} onClick={() => openCreate()}><Plus size={16} /> เพิ่มรายการออปชัน</Button>
    </div>
    <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
      ราคาและมูลค่าปิดเป็นการประเมินจากข้อมูลตลาดจริง ไม่ใช่ราคาที่รับประกัน: Long ใช้ Bid สำหรับประมาณการปิด และ Short ใช้ Ask สำหรับประมาณการซื้อคืน
    </div>

    {positions.length === 0
      ? <div className="p-8 text-center"><p className="font-semibold text-white">ยังไม่มีรายการออปชันใน Ledger</p><Button className="mt-4" disabled={!isOnline || readOnly || Boolean(portfolio.archivedAt)} onClick={() => openCreate()}><Plus size={16} /> เพิ่มรายการออปชัน</Button></div>
      : <>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1180px] text-left text-xs" data-testid="options-desktop-table">
            <thead><tr className="border-b border-slate-800 text-slate-500">
              {['สัญญา', 'ฝั่ง', 'จำนวน', 'Avg premium', 'ต้นทุนคงเหลือ', 'Bid / Ask / Mark', 'มูลค่าปัจจุบัน', 'Today P&L', 'Unrealized P&L', 'สถานะ'].map((label, index) =>
                <th key={label} className={`px-3 py-3 ${index > 1 ? 'text-right' : ''}`}>{label}</th>)}
            </tr></thead>
            <tbody>{positions.map((position) => <OptionDesktopRows
              key={position.key}
              position={position}
              target={targets.find((item) => item.contractSymbol === position.contractSymbol)}
              expanded={expanded === position.key}
              showBalances={showBalances}
              timezone={timezone}
              money={money}
              signed={signed}
              onToggle={() => setExpanded((current) => current === position.key ? null : position.key)}
              onAction={(type) => openCreate(position, type)}
              onEdit={openEdit}
              onDelete={setDeleting}
              onTarget={() => openTarget(position)}
              onDeleteTarget={setTargetDeleting}
            />)}</tbody>
          </table>
        </div>
        <div className="divide-y divide-slate-800 md:hidden" data-testid="options-mobile-cards">
          {positions.map((position) => <OptionMobileCard
            key={position.key}
            position={position}
            target={targets.find((item) => item.contractSymbol === position.contractSymbol)}
            expanded={expanded === position.key}
            showBalances={showBalances}
            timezone={timezone}
            money={money}
            signed={signed}
            onToggle={() => setExpanded((current) => current === position.key ? null : position.key)}
            onAction={(type) => openCreate(position, type)}
            onEdit={openEdit}
            onDelete={setDeleting}
            onTarget={() => openTarget(position)}
            onDeleteTarget={setTargetDeleting}
          />)}
        </div>
      </>}

    <OptionTransactionModal
      open={formOpen}
      editing={Boolean(editing)}
      form={form}
      errors={errors}
      pending={pending || !isOnline}
      portfolios={portfolios}
      cashByPortfolioId={cashByPortfolioId}
      replacedTransaction={editing}
      onChange={change}
      onClose={() => !pending && closeForm()}
      onSubmit={submit}
    />
    <Modal isOpen={Boolean(deleting)} onClose={() => !pending && setDeleting(null)} title={`ลบ ${deleting ? transactionLabels[deleting.type] : 'รายการออปชัน'} หรือไม่`}>
      <p className="text-sm text-slate-300">การลบจะคำนวณเงินสด จำนวนสัญญา ต้นทุน และ P&amp;L ใหม่จาก Ledger ทั้งหมด และอาจถูกปฏิเสธหากทำให้รายการปิดภายหลังเกินจำนวนที่มี</p>
      <div className="mt-5 flex gap-2"><Button variant="outline" className="flex-1" onClick={() => setDeleting(null)}>ยกเลิก</Button><Button className="flex-1 bg-red-500 text-white hover:bg-red-400" disabled={pending || !isOnline || readOnly} onClick={confirmDelete}>ยืนยันการลบ</Button></div>
    </Modal>
    <Modal isOpen={Boolean(targetPosition)} onClose={() => !pending && setTargetPosition(null)} title={`เป้าหมายขาย ${targetPosition ? optionPositionTitle(targetPosition) : ''}`}>
      <form className="space-y-4" onSubmit={submitTarget}>
        <Field label="ตั้งเป้าหมายจาก">
          <select className="form-input" value={targetMode} onChange={(event) => setTargetMode(event.target.value as OptionTargetMode)}>
            <option value="premium">Target premium</option>
            <option value="profit_percent">Target profit %</option>
          </select>
        </Field>
        <Field label={targetMode === 'premium' ? 'Premium เป้าหมายต่อหุ้น' : 'กำไรเป้าหมาย (%)'}>
          <DecimalInput value={targetValue} onChange={setTargetValue} />
        </Field>
        <Field label="ค่าธรรมเนียมตอนปิดโดยประมาณ (USD)">
          <DecimalInput value={targetFee} onChange={setTargetFee} />
        </Field>
        {targetPreview && <dl className="grid grid-cols-2 gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs">
          <TargetMetric label="Target premium" value={`$${targetPreview.targetPremium.toFixed(2)}`} />
          <TargetMetric label={targetPosition?.side === 'long' ? 'Estimated proceeds' : 'Estimated close cost'} value={money(Math.abs(targetPreview.estimatedProceeds))} />
          <TargetMetric label="Estimated P&L หลัง fee" value={signed(targetPreview.estimatedProfit)} tone={gainColor(targetPreview.estimatedProfit)} />
          <TargetMetric label="Estimated profit %" value={signedPercent(targetPreview.estimatedProfitPercent, showBalances)} tone={gainColor(targetPreview.estimatedProfit)} />
          <TargetMetric label="Fee" value={money(Number(targetFee || 0))} />
          <TargetMetric label="ระยะจาก Mark ปัจจุบัน" value={targetPreview.distanceFromCurrent === null ? '—' : `${targetPreview.distanceFromCurrent >= 0 ? '+' : ''}${targetPreview.distanceFromCurrent.toFixed(2)} (${targetPreview.distancePercent?.toFixed(2)}%)`} />
        </dl>}
        {targetError && <p role="alert" className="text-xs text-red-400">{targetError}</p>}
        <p className="text-xs text-slate-500">ติดตามในแอปเมื่อเปิดหรือรีเฟรชพอร์ต ไม่รับประกัน Push Notification และไม่ส่ง Order</p>
        <div className="flex gap-2"><Button type="button" variant="outline" className="flex-1" onClick={() => setTargetPosition(null)}>ยกเลิก</Button><Button type="submit" className="flex-1" disabled={pending || readOnly || !targetPreview}>บันทึกเป้าหมาย</Button></div>
      </form>
    </Modal>
    <Modal isOpen={Boolean(targetDeleting)} onClose={() => !pending && setTargetDeleting(null)} title="ลบเป้าหมายขายหรือไม่">
      <p className="text-sm text-slate-300">ระบบจะหยุดติดตามเป้าหมายของ {targetDeletingPosition ? optionPositionTitle(targetDeletingPosition) : 'สัญญาออปชันนี้'}</p>
      <div className="mt-5 flex gap-2"><Button variant="outline" className="flex-1" onClick={() => setTargetDeleting(null)}>ยกเลิก</Button><Button className="flex-1 bg-red-500 text-white hover:bg-red-400" disabled={pending || !isOnline || readOnly} onClick={confirmTargetDelete}>ยืนยันการลบ</Button></div>
    </Modal>
  </section>;
}

interface OptionViewProps {
  position: OptionPositionSummary;
  target?: OptionTarget;
  expanded: boolean;
  showBalances: boolean;
  timezone: string;
  money: (value: number | null) => string;
  signed: (value: number | null) => string;
  onToggle: () => void;
  onAction: (type: PortfolioTransactionType) => void;
  onEdit: (transaction: PortfolioTransaction) => void;
  onDelete: (transaction: PortfolioTransaction) => void;
  onTarget: () => void;
  onDeleteTarget: (target: OptionTarget) => void;
}

function OptionDesktopRows(props: OptionViewProps) {
  const { position, expanded, showBalances, money, signed, onToggle } = props;
  return <>
    <tr className="border-b border-slate-800/60 hover:bg-slate-800/30">
      <td className="p-0"><button type="button" aria-expanded={expanded} onClick={onToggle} className="flex min-h-16 w-full items-center gap-2 px-3 text-left"><span>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</span><span className="min-w-0"><strong className="block text-sm text-white">{optionPositionTitle(position)}</strong><span className="block text-[10px] text-slate-400">{optionPositionDescription(position)}</span></span></button></td>
      <td className="px-3 py-3"><SideBadge side={position.side} /></td>
      <td className="px-3 py-3 text-right font-mono">{showBalances ? position.contracts : SENSITIVE_VALUE_MASK}</td>
      <td className="px-3 py-3 text-right font-mono">${position.averagePremium.toFixed(2)}</td>
      <td className="px-3 py-3 text-right font-mono">{money(position.remainingCost)}</td>
      <td className="px-3 py-3 text-right font-mono">{quoteNumber(position.bid)} / {quoteNumber(position.ask)} / {quoteNumber(position.mark)}<QuoteMeta position={position} /></td>
      <td className="px-3 py-3 text-right font-mono">{money(position.marketValue)}</td>
      <td className={`px-3 py-3 text-right font-mono ${position.todayChange === null ? 'text-slate-400' : gainColor(position.todayChange)}`}>{position.todayChange === null ? <><span>—</span><span className="block max-w-32 text-[10px] font-sans">ไม่มีราคาปิดวันก่อน</span></> : signed(position.todayChange)}</td>
      <td className={`px-3 py-3 text-right font-mono ${position.unrealizedGain === null ? 'text-slate-400' : gainColor(position.unrealizedGain)}`}>{signed(position.unrealizedGain)}<span className="block text-[10px]">{position.unrealizedGainPercent === null ? '—' : signedPercent(position.unrealizedGainPercent, showBalances)}</span></td>
      <td className="px-3 py-3 text-right"><StatusBadge position={position} /></td>
    </tr>
    {expanded && <tr className="border-b border-slate-800"><td colSpan={10} className="bg-slate-950/35 p-4"><OptionDetails {...props} /></td></tr>}
  </>;
}

function OptionMobileCard(props: OptionViewProps) {
  const { position, expanded, showBalances, money, signed, onToggle } = props;
  return <article className="min-w-0 p-4">
    <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex min-h-11 w-full items-start justify-between gap-3 text-left">
      <span className="min-w-0"><span className="flex flex-wrap items-center gap-2"><strong className="text-white">{optionPositionTitle(position)}</strong><SideBadge side={position.side} /><StatusBadge position={position} /></span><span className="mt-1 block text-[10px] text-slate-400">{optionPositionDescription(position)}</span></span>
      {expanded ? <ChevronUp className="shrink-0" size={18} /> : <ChevronDown className="shrink-0" size={18} />}
    </button>
    <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-4 text-sm">
      <OptionMetric label="จำนวน" value={showBalances ? `${position.contracts} สัญญา` : SENSITIVE_VALUE_MASK} />
      <OptionMetric label="Avg premium" value={`$${position.averagePremium.toFixed(2)}`} />
      <OptionMetric label="ต้นทุนคงเหลือ" value={money(position.remainingCost)} />
      <OptionMetric label="มูลค่าปัจจุบัน" value={money(position.marketValue)} />
      <OptionMetric label="Today P&L" value={position.todayChange === null ? 'ไม่มีราคาปิดวันก่อน' : signed(position.todayChange)} tone={position.todayChange === null ? 'text-slate-400' : gainColor(position.todayChange)} />
      <OptionMetric label="Unrealized P&L" value={`${signed(position.unrealizedGain)} ${position.unrealizedGainPercent === null ? '' : `(${signedPercent(position.unrealizedGainPercent, showBalances)})`}`} tone={position.unrealizedGain === null ? 'text-slate-400' : gainColor(position.unrealizedGain)} />
      <div className="col-span-2"><dt className="text-xs text-slate-500">Bid / Ask / Mark</dt><dd className="mt-1 font-mono text-white">{quoteNumber(position.bid)} / {quoteNumber(position.ask)} / {quoteNumber(position.mark)}</dd><QuoteMeta position={position} /></div>
    </dl>
    {expanded && <div className="mt-4 border-t border-slate-800 pt-4"><OptionDetails {...props} /></div>}
  </article>;
}

function OptionDetails({ position, target, money, signed, timezone, onAction, onEdit, onDelete, onTarget, onDeleteTarget }: OptionViewProps) {
  const actionTypes: PortfolioTransactionType[] = position.side === 'long'
    ? ['buy_to_open', 'sell_to_close', 'exercise', 'expired']
    : ['sell_to_open', 'buy_to_close', 'assignment', 'expired'];
  const targetCalculation = (() => {
    if (!target || position.contracts <= 0) return null;
    try {
      return calculateOptionTarget(position, target.mode, target.targetValue, target.estimatedFee);
    } catch {
      return null;
    }
  })();
  return <div className="min-w-0 space-y-5">
    {position.status === 'open' && <div className="flex flex-wrap gap-2">
      {actionTypes.map((type) => <Button key={type} size="sm" variant={type === 'buy_to_open' || type === 'sell_to_open' ? 'default' : 'outline'} onClick={() => onAction(type)}>{transactionLabels[type]}</Button>)}
    </div>}
    <details className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-400">
      <summary className="min-h-11 cursor-pointer py-3 font-semibold text-slate-300">Technical details / Copy</summary>
      <div className="mt-2 flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 break-all">{optionPositionMarketSymbol(position) ?? position.contractSymbol}</code>
        <button
          type="button"
          className="min-h-11 rounded-lg border border-slate-700 px-3 text-slate-200"
          onClick={() => void navigator.clipboard?.writeText(optionPositionMarketSymbol(position) ?? position.contractSymbol)}
        >Copy</button>
      </div>
    </details>
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
      <OptionMetric label="Mark precision (raw quote)" value={quoteNumber(position.mark)} />
      <OptionMetric label="ราคาปิดโดยประมาณ" value={position.estimatedClosePrice === null ? '—' : `$${position.estimatedClosePrice.toFixed(2)}`} />
      <OptionMetric label="มูลค่าปิดโดยประมาณ" value={money(position.estimatedCloseValue)} />
      <OptionMetric label="Underlying" value={position.underlyingPrice === null ? '—' : `$${position.underlyingPrice.toFixed(2)}`} />
      <OptionMetric label="Breakeven" value={`$${position.breakeven.toFixed(2)}`} />
      <OptionMetric label="DTE" value={String(position.dte)} />
      <OptionMetric label="IV" value={position.impliedVolatility === null ? '—' : `${(position.impliedVolatility * 100).toFixed(2)}%`} />
      <OptionMetric label="Delta" value={quoteNumber(position.delta, 4)} />
      <OptionMetric label="Theta" value={quoteNumber(position.theta, 4)} />
      <OptionMetric label="Realized P&L" value={signed(position.realizedGain)} tone={gainColor(position.realizedGain)} />
    </dl>
    <section className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h4 className="flex items-center gap-2 text-sm font-bold text-white"><Target size={16} className="text-[#D4FF00]" /> เป้าหมายขาย</h4><p className="mt-1 text-xs text-slate-500">ติดตามในแอปเท่านั้น ไม่ส่ง Order</p></div>
        {position.status === 'open' && optionPositionMarketSymbol(position) && <Button size="sm" variant="outline" onClick={onTarget}>{target ? 'แก้ไขเป้าหมาย' : 'เพิ่มเป้าหมาย'}</Button>}
      </div>
      {target && targetCalculation ? <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-900/60 p-3 text-xs">
        <div className="min-w-0 flex-1">
          <p><strong className="text-slate-200">{target.mode === 'premium' ? `Target premium $${target.targetValue.toFixed(2)}` : `Target profit ${target.targetValue.toFixed(2)}%`}</strong>{target.triggeredAt ? <span className="mt-1 block text-slate-500">ถึงเป้าหมาย {displayTime(target.triggeredAt, timezone)}</span> : null}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <TargetMetric label="Target premium" value={`$${quoteNumber(target.targetPremium)}`} />
            <TargetMetric label={position.side === 'long' ? 'Estimated proceeds' : 'Estimated close cost'} value={money(Math.abs(targetCalculation.estimatedProceeds))} />
            <TargetMetric label="Estimated profit $ / %" value={`${signed(targetCalculation.estimatedProfit)} / ${targetCalculation.estimatedProfitPercent.toFixed(2)}%`} tone={gainColor(targetCalculation.estimatedProfit)} />
            <TargetMetric label="Fee" value={money(target.estimatedFee)} />
            <TargetMetric label="ระยะห่างจาก Mark" value={targetCalculation.distanceFromCurrent === null ? '—' : `${targetCalculation.distanceFromCurrent >= 0 ? '+' : ''}${quoteNumber(targetCalculation.distanceFromCurrent)} (${targetCalculation.distancePercent?.toFixed(2)}%)`} />
          </dl>
        </div>
        <button type="button" aria-label="ลบเป้าหมายขาย" onClick={() => onDeleteTarget(target)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-red-400"><Trash2 size={16} /></button>
      </div> : <p className="mt-3 text-xs text-slate-500">{isInternalOptionContractSymbol(position.contractSymbol) && !optionPositionMarketSymbol(position) ? 'ตั้งเป้าหมายได้เมื่อจับคู่สัญญากับข้อมูลตลาดแล้ว' : 'ยังไม่ได้ตั้งเป้าหมาย'}</p>}
    </section>
    <section>
      <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Transaction history</h4>
      <div className="mt-2 divide-y divide-slate-800">{position.transactions.map((transaction) => <div key={transaction.id} className="flex min-w-0 items-center gap-2 py-2 text-xs">
        <span className="min-w-0 flex-1"><strong className="text-slate-200">{transactionLabels[transaction.type]}</strong><span className="block text-slate-500">{displayTime(transaction.occurredAtTime ?? transaction.occurredAt, timezone)} · {Number(transaction.quantity).toLocaleString('th-TH', { maximumFractionDigits: 8 })} สัญญา × ${Number(transaction.normalizedPriceUsd ?? transaction.price ?? 0).toFixed(2)} · ค่าธรรมเนียม {money(Number(transaction.normalizedFeeUsd ?? transaction.fee ?? 0))}</span></span>
        <button type="button" aria-label={`แก้ไข ${transactionLabels[transaction.type]}`} onClick={() => onEdit(transaction)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"><Edit3 size={16} /></button>
        <button type="button" aria-label={`ลบ ${transactionLabels[transaction.type]}`} onClick={() => onDelete(transaction)} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-red-400"><Trash2 size={16} /></button>
      </div>)}</div>
    </section>
  </div>;
}

function OptionTransactionModal({ open, editing, form, errors, pending, portfolios, cashByPortfolioId, replacedTransaction, onChange, onClose, onSubmit }: {
  open: boolean;
  editing: boolean;
  form: TransactionFormState;
  errors: Record<string, string>;
  pending: boolean;
  portfolios: PortfolioRecord[];
  cashByPortfolioId: Record<string, number>;
  replacedTransaction?: PortfolioTransaction | null;
  onChange: (name: keyof TransactionFormState, value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const firstRef = useRef<HTMLSelectElement>(null);
  const noPremium = form.type === 'exercise' || form.type === 'assignment' || form.type === 'expired';
  const premiumTotal = Number(form.price || 0) * Number(form.quantity || 0) * Number(form.multiplier || 0);
  const helperPrice = form.price || '1.94';
  const helperContracts = form.quantity || '1';
  const helperMultiplier = form.multiplier || '100';
  const helperPremiumTotal = Number(helperPrice) * Number(helperContracts) * Number(helperMultiplier);
  const fee = Number(form.fee || 0);
  const isCredit = form.type === 'sell_to_open' || form.type === 'sell_to_close';
  const estimatedCashFlow = noPremium ? 0 : isCredit ? premiumTotal - fee : -(premiumTotal + fee);
  const cashAfter = estimateCashAfterTransaction(cashByPortfolioId[form.portfolioId] ?? 0, form, replacedTransaction);
  return <Modal isOpen={open} onClose={onClose} initialFocusRef={firstRef} title={editing ? 'แก้ไขรายการออปชัน' : 'เพิ่มรายการออปชัน'} className="max-w-2xl overflow-x-hidden">
    <form className="min-w-0 space-y-4" data-testid="option-transaction-form" onSubmit={onSubmit}>
      <Field label="พอร์ตปลายทาง" error={errors.portfolioId} helper={editing ? 'รายการเดิมเปลี่ยนพอร์ตไม่ได้ เพื่อรักษา audit trail' : 'รายการนี้จะบันทึกใน Transaction Ledger ของพอร์ตที่เลือกเท่านั้น'}>
        <select ref={firstRef} className="form-input" value={form.portfolioId} disabled={editing} onChange={(event) => onChange('portfolioId', event.target.value)}>
          {portfolios.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </Field>
      <p className="rounded-lg bg-slate-950/50 p-3 text-xs text-slate-400">บันทึกรายการที่เกิดขึ้นแล้วเท่านั้น ไม่มีการส่งคำสั่งซื้อขายไปยังโบรกเกอร์</p>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className={form.type === 'expired' ? undefined : 'sm:col-span-2'}>
          <Field label="ประเภทรายการ (Action)" error={errors.type}><select className="form-input" value={form.type} onChange={(event) => onChange('type', event.target.value)}>{optionActions.map((type) => <option key={type} value={type}>{transactionLabels[type]}</option>)}</select></Field>
        </div>
        {form.type === 'expired' && <Field label="ฝั่งสัญญา (Long / Short)" error={errors.optionSide}><select className="form-input" value={form.optionSide} onChange={(event) => onChange('optionSide', event.target.value)}><option value="long">Long</option><option value="short">Short</option></select></Field>}
        <SymbolPreview label="หุ้นแม่ (Underlying)" value={form.underlyingSymbol} onChange={(value) => onChange('underlyingSymbol', value)} error={errors.underlyingSymbol} />
        <Field label="ประเภทออปชัน (Call / Put)" error={errors.optionKind}><select className="form-input" value={form.optionKind} onChange={(event) => onChange('optionKind', event.target.value)}><option value="call">Call</option><option value="put">Put</option></select></Field>
        <Field label="ราคาใช้สิทธิ (Strike)" error={errors.strikePrice}><DecimalInput value={form.strikePrice} onChange={(value) => onChange('strikePrice', value)} /></Field>
        <Field label="วันหมดอายุ (Expiration)" error={errors.expirationDate}><input type="date" className="form-input" value={form.expirationDate} onChange={(event) => onChange('expirationDate', event.target.value)} /></Field>
        <Field label="จำนวนสัญญา (Contracts)" error={errors.quantity}><DecimalInput value={form.quantity} onChange={(value) => onChange('quantity', value)} /></Field>
        <Field
          label={form.originalCurrency === 'USD' ? 'Premium ต่อหุ้น (USD)' : 'Premium ต่อหุ้น (THB)'}
          error={errors.price}
          helper={noPremium ? 'Exercise / Assignment / Expired ใช้ 0' : `$${helperPrice} × ${helperContracts} × ${helperMultiplier} = ${isCredit ? 'เครดิต' : 'ต้นทุน'} $${helperPremiumTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}`}
        ><DecimalInput value={form.price} onChange={(value) => onChange('price', value)} /></Field>
        <Field label="ตัวคูณต่อสัญญา (Multiplier)" error={errors.multiplier} helper="ค่าเริ่มต้น 100 และแก้ไขได้"><DecimalInput value={form.multiplier} onChange={(value) => onChange('multiplier', value)} /></Field>
        <Field label={`ค่าธรรมเนียม (Fee · ${form.originalCurrency})`} error={errors.fee}><DecimalInput value={form.fee} onChange={(value) => onChange('fee', value)} /></Field>
        <Field label="สกุลเงินต้นฉบับ" error={errors.originalCurrency}><select className="form-input" value={form.originalCurrency} onChange={(event) => onChange('originalCurrency', event.target.value)}><option value="USD">USD ($)</option><option value="THB">THB (฿)</option></select></Field>
        {form.originalCurrency === 'THB' && <Field label="USD/THB ณ เวลารายการ" error={errors.fxRateAtTransaction}><DecimalInput value={form.fxRateAtTransaction} onChange={(value) => onChange('fxRateAtTransaction', value)} /></Field>}
        <div className={form.originalCurrency === 'THB' ? 'sm:col-span-2' : undefined}>
          <Field label="วันและเวลารายการ (Date)" error={errors.occurredAt}><input type="datetime-local" className="form-input" value={form.occurredAt.slice(0, 16)} max={maximumTransactionDateTimeLocal(form.timezone)} onChange={(event) => onChange('occurredAt', event.target.value)} /></Field>
        </div>
      </div>
      {!noPremium && <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-300">
        <p>Estimated {isCredit ? 'credit' : 'debit'}: <strong className="font-mono">{form.originalCurrency === 'USD' ? '$' : '฿'}{Math.abs(estimatedCashFlow).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></p>
        <p className="mt-1 text-xs text-slate-500">Premium × contracts × multiplier {isCredit ? '− fee' : '+ fee'}</p>
        {form.originalCurrency === 'USD' && Number(form.price) >= 100 && <p role="alert" className="mt-2 text-xs text-amber-300">ตรวจสอบหน่วย Premium: เมื่อกรอก {form.price} ต้นทุน/เครดิตก่อนค่าธรรมเนียมคือ ${premiumTotal.toLocaleString('en-US', { maximumFractionDigits: 2 })}{form.price === '194' ? ' (กรอก 194 หมายถึง $19,400 สำหรับ 1 สัญญา × 100)' : ''}</p>}
      </div>}
      <div className={`rounded-xl border p-3 text-sm ${cashAfter !== null && cashAfter < 0 ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-slate-800 bg-slate-950/50 text-slate-300'}`}>
        <p>เงินสดหลังรายการ: <strong className="font-mono">{cashAfter === null ? 'คำนวณไม่ได้จนกว่าข้อมูลจะครบ' : `$${cashAfter.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</strong></p>
        {cashAfter !== null && cashAfter < 0 && <p className="mt-1 text-xs">เงินสดติดลบ โปรดตรวจเงินฝากย้อนหลังหรือสถานะ Margin</p>}
      </div>
      <Field label="หมายเหตุ (Note · ไม่บังคับ)" error={errors.note}><textarea className="form-input h-auto py-3" rows={3} maxLength={500} value={form.note} onChange={(event) => onChange('note', event.target.value)} /></Field>
      <div className="sticky bottom-0 flex gap-2 bg-[#151B28] py-2"><Button type="button" variant="outline" className="flex-1" onClick={onClose}>ยกเลิก</Button><Button type="submit" className="flex-1" disabled={pending}>{pending ? 'กำลังบันทึก…' : 'บันทึกรายการ'}</Button></div>
    </form>
  </Modal>;
}

function QuoteMeta({ position }: { position: OptionPositionSummary }) {
  if (isInternalOptionContractSymbol(position.contractSymbol) && position.quoteFreshness === 'missing') {
    return <span className="mt-1 block text-[10px] text-amber-300">{UNMATCHED_OPTION_MESSAGE}</span>;
  }
  if (position.quoteFreshness === 'missing') return <span className="mt-1 block text-[10px] text-amber-300">ไม่มีราคา · แสดง —</span>;
  return <span className={`mt-1 block text-[10px] ${position.quoteFreshness === 'stale' ? 'text-amber-300' : 'text-slate-500'}`}>
    {position.quoteFreshness === 'stale' ? 'ราคาเก่า (Stale)' : position.quoteFreshness} · {position.quoteSource ?? 'ไม่ทราบแหล่ง'}{position.quoteAsOf ? ` · ${displayTime(position.quoteAsOf)}` : ''}
  </span>;
}

function SideBadge({ side }: { side: 'long' | 'short' }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase ${side === 'long' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'}`}>{side}</span>;
}

function StatusBadge({ position }: { position: OptionPositionSummary }) {
  const style = position.status === 'open'
    ? 'bg-emerald-500/15 text-emerald-300'
    : position.status === 'expired'
      ? 'bg-amber-500/15 text-amber-300'
      : 'bg-slate-700 text-slate-300';
  return <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase ${style}`}>{position.status}</span>;
}

function OptionMetric({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0"><dt className="text-xs text-slate-500">{label}</dt><dd className={`mt-1 break-words font-mono text-sm font-semibold ${tone}`}>{value}</dd></div>;
}

function TargetMetric({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0"><dt className="text-slate-500">{label}</dt><dd className={`mt-1 break-words font-mono font-semibold ${tone}`}>{value}</dd></div>;
}
