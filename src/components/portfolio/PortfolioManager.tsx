'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, Edit3, FolderOpen, Lock, Plus, RotateCcw, Target, Trash2 } from 'lucide-react';
import {
  archivePortfolioAction,
  createPortfolioAction,
  deletePortfolioAction,
  restorePortfolioAction,
  setPortfolioGoalAction,
  transferPortfolioCashAction,
  updatePortfolioAction,
} from '@/app/portfolio/portfolio-actions';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import { useToast } from '@/src/components/ui/Toast';
import { calculateGoalProgress } from '@/src/lib/portfolio/aggregate';
import {
  buildPortfolioGoalCardModel,
  latestPortfolioPriceTime,
  type PortfolioGoalScope,
} from '@/src/lib/portfolio/goal-card';
import type { PortfolioGoal, PortfolioRecord, PortfolioSummary, PortfolioType } from '@/src/lib/portfolio/types';
import {
  currentDateTimeLocal,
  maximumTransactionDateTimeLocal,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { DecimalInput, Field } from './FormControls';
import { PortfolioGoalCard } from './PortfolioGoalCard';
import { portfolioCreationEntitlement } from '@/src/lib/subscription/subscription-limits';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';

type Money = (value: number | string | null) => string;

function displayTime(value: string) {
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(value));
}

function typeLabel(type: PortfolioType) {
  if (type === 'STOCK') return 'พอร์ตหุ้น';
  if (type === 'OPTION') return 'พอร์ตออปชัน';
  return 'Default / Legacy';
}

export function PortfolioManager({
  portfolios,
  summaries,
  aggregate,
  aggregateGoal,
  selectedPortfolioId,
  optionTargetCounts,
  timezone,
  effectiveTier,
  showBalances,
  isOnline,
  money,
  signed,
  percent,
  onSelect,
}: {
  portfolios: PortfolioRecord[];
  summaries: Record<string, PortfolioSummary>;
  aggregate: PortfolioSummary;
  aggregateGoal: PortfolioGoal;
  selectedPortfolioId: string;
  optionTargetCounts: Record<string, number>;
  timezone: string;
  effectiveTier: SubscriptionTier;
  showBalances: boolean;
  isOnline: boolean;
  money: Money;
  signed: (value: number | null) => string;
  percent: (value: number | null) => string;
  onSelect: (portfolioId: string) => void;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const [pending, startTransition] = useTransition();
  const [goalScope, setGoalScope] = useState<PortfolioGoalScope>('selected');
  const [tab, setTab] = useState<'STOCK' | 'OPTION'>('STOCK');
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createType, setCreateType] = useState<'STOCK' | 'OPTION'>('STOCK');
  const [editing, setEditing] = useState<PortfolioRecord | null>(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState<PortfolioType>('STOCK');
  const [goalPortfolio, setGoalPortfolio] = useState<PortfolioRecord | 'aggregate' | null>(null);
  const [goalValue, setGoalValue] = useState('');
  const [goalDate, setGoalDate] = useState('');
  const [confirming, setConfirming] = useState<PortfolioRecord | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferSource, setTransferSource] = useState(selectedPortfolioId);
  const [transferDestination, setTransferDestination] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferDate, setTransferDate] = useState(currentDateTimeLocal(timezone));
  const [transferNote, setTransferNote] = useState('');
  const [transferIdempotencyKey, setTransferIdempotencyKey] = useState('');
  const [error, setError] = useState('');

  const visible = portfolios.filter((portfolio) => {
    if (portfolio.type === tab) return true;
    if (!portfolio.isLegacy) return false;
    const summary = summaries[portfolio.id];
    return tab === 'OPTION'
      ? summary.optionPositions.length > 0
      : summary.holdings.length > 0 || summary.optionPositions.length === 0;
  });
  const active = portfolios.filter((portfolio) => portfolio.archivedAt === null);
  const optionsEntitlement = portfolioCreationEntitlement(effectiveTier, 'OPTION');
  const selectedPortfolio = portfolios.find((portfolio) => portfolio.id === selectedPortfolioId) ?? portfolios[0];
  const goalSummary = goalScope === 'aggregate' ? aggregate : summaries[selectedPortfolio.id];
  const goal = goalScope === 'aggregate'
    ? aggregateGoal
    : { targetValueUsd: selectedPortfolio.targetValueUsd, targetDate: selectedPortfolio.targetDate };
  const goalCard = buildPortfolioGoalCardModel({
    scope: goalScope,
    summary: goalSummary,
    goal,
    activePortfolios: active.length,
    totalPortfolios: portfolios.length,
  });

  function complete(message: string) {
    addToast({ title: message, type: 'success' });
    router.refresh();
  }

  function run(task: () => Promise<{ ok: boolean; message?: string }>, done: string, close: () => void) {
    if (pending || !isOnline) return;
    setError('');
    startTransition(async () => {
      const result = await task();
      if (!result.ok) {
        setError(result.message ?? 'บันทึกไม่สำเร็จ');
        return;
      }
      close();
      complete(done);
    });
  }

  function openCreate(type: 'STOCK' | 'OPTION' = tab) {
    setCreateName('');
    setCreateType(type === 'OPTION' && !optionsEntitlement.canCreate ? 'STOCK' : type);
    setError('');
    setCreateOpen(true);
  }

  function closeCreate() {
    setCreateOpen(false);
    setCreateName('');
    setCreateType('STOCK');
    setError('');
  }

  function openEdit(portfolio: PortfolioRecord) {
    setEditing(portfolio);
    setEditName(portfolio.name);
    setEditType(portfolio.type);
    setError('');
  }

  function closeEdit() {
    setEditing(null);
    setEditName('');
    setEditType('STOCK');
    setError('');
  }

  function openGoal(portfolio: PortfolioRecord | 'aggregate') {
    const goal = portfolio === 'aggregate'
      ? aggregateGoal
      : { targetValueUsd: portfolio.targetValueUsd, targetDate: portfolio.targetDate };
    setGoalPortfolio(portfolio);
    setGoalValue(goal.targetValueUsd === null ? '' : String(goal.targetValueUsd));
    setGoalDate(goal.targetDate ?? '');
    setError('');
  }

  function closeGoal() {
    setGoalPortfolio(null);
    setGoalValue('');
    setGoalDate('');
    setError('');
  }

  function openTransfer() {
    const source = active.some((portfolio) => portfolio.id === selectedPortfolioId)
      ? selectedPortfolioId
      : active[0]?.id ?? '';
    setTransferSource(source);
    setTransferDestination(active.find((portfolio) => portfolio.id !== source)?.id ?? '');
    setTransferAmount('');
    setTransferDate(currentDateTimeLocal(timezone));
    setTransferNote('');
    setTransferIdempotencyKey(crypto.randomUUID());
    setError('');
    setTransferOpen(true);
  }

  function closeTransfer() {
    setTransferOpen(false);
    setTransferSource('');
    setTransferDestination('');
    setTransferAmount('');
    setTransferDate(currentDateTimeLocal(timezone));
    setTransferNote('');
    setTransferIdempotencyKey('');
    setError('');
  }

  function submitGoal(event: FormEvent) {
    event.preventDefault();
    if (!goalPortfolio) return;
    const targetValueUsd = goalValue.trim() === '' ? null : Number(goalValue);
    if (targetValueUsd !== null && (!Number.isFinite(targetValueUsd) || targetValueUsd <= 0)) {
      setError('มูลค่าเป้าหมายต้องมากกว่า 0');
      return;
    }
    run(
      () => setPortfolioGoalAction({
        portfolioId: goalPortfolio === 'aggregate' ? null : goalPortfolio.id,
        targetValueUsd,
        targetDate: targetValueUsd === null || goalDate === '' ? null : goalDate,
      }),
      'บันทึกเป้าหมายแล้ว',
      closeGoal,
    );
  }

  const transferAmountNumber = Number(transferAmount);
  const transferCashAfter = (summaries[transferSource]?.cashBalance ?? 0)
    - (Number.isFinite(transferAmountNumber) ? transferAmountNumber : 0);

  return <section className="rounded-2xl border border-slate-800 bg-[#151B28] p-4 shadow-xl sm:p-5">
    <div className="flex flex-col gap-4 border-b border-slate-800 pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h3 className="text-lg font-bold text-white">พอร์ตของฉัน</h3>
        <p className="mt-1 text-xs text-slate-400">แต่ละพอร์ตใช้ Transaction Ledger และยอดเงินสดของตัวเอง พอร์ตรวมเป็นผลรวมเท่านั้น</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!isOnline || active.length < 2} onClick={openTransfer}>ย้ายเงิน</Button>
        <Button size="sm" disabled={!isOnline} onClick={() => openCreate()}><Plus size={16} /> สร้างพอร์ต</Button>
      </div>
    </div>

    <div className="mt-4">
      <PortfolioGoalCard
        model={goalCard}
        selectedPortfolioName={selectedPortfolio.name}
        showBalances={showBalances}
        isOnline={isOnline}
        money={money}
        signed={signed}
        percent={percent}
        onScopeChange={setGoalScope}
        onEditGoal={() => openGoal(goalScope === 'aggregate' ? 'aggregate' : selectedPortfolio)}
      />
    </div>

    <div className="mt-4 flex gap-2" role="tablist" aria-label="ประเภทพอร์ต">
      {(['STOCK', 'OPTION'] as const).map((type) => <button
        key={type}
        type="button"
        role="tab"
        aria-selected={tab === type}
        onClick={() => setTab(type)}
        className={`min-h-11 flex-1 rounded-xl px-3 text-sm font-bold sm:flex-none ${tab === type ? 'bg-[#D4FF00] text-slate-950' : 'border border-slate-700 text-slate-300'}`}
      >{type === 'STOCK' ? 'พอร์ตหุ้น' : 'พอร์ตออปชัน'}</button>)}
    </div>

    <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {visible.map((portfolio) => {
        const summary = summaries[portfolio.id];
        const goal = { targetValueUsd: portfolio.targetValueUsd, targetDate: portfolio.targetDate };
        const goalProgress = calculateGoalProgress(summary.totalValue, goal);
        const positions = summary.holdings.length + summary.optionPositions.filter((position) => position.status === 'open').length;
        const updated = latestPortfolioPriceTime(summary);
        const canDelete = !portfolio.isLegacy
          && portfolio.transactions.length === 0
          && portfolio.targetValueUsd === null
          && (optionTargetCounts[portfolio.id] ?? 0) === 0
          && summary.cashBalance === 0
          && positions === 0;
        return <article key={portfolio.id} className={`min-w-0 rounded-2xl border p-4 ${portfolio.id === selectedPortfolioId ? 'border-[#D4FF00]/50 bg-[#D4FF00]/5' : 'border-slate-800 bg-slate-950/35'} ${portfolio.archivedAt ? 'opacity-75' : ''}`}>
          <button type="button" onClick={() => onSelect(portfolio.id)} className="min-h-11 w-full text-left focus-visible:rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]">
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0"><strong className="block break-words text-white">{portfolio.name}</strong><span className="mt-1 block text-xs text-slate-400">{typeLabel(portfolio.type)}{portfolio.archivedAt ? ' · Archived' : ''}</span></span>
              <FolderOpen className="shrink-0 text-[#D4FF00]" size={18} />
            </span>
          </button>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <CardMetric label="มูลค่าปัจจุบัน" value={money(summary.totalValue)} />
            <CardMetric label="จำนวน Positions" value={String(positions)} />
            <CardMetric label="Total P&L" value={`${signed(summary.totalGain)} · ${percent(summary.totalGainPercent)}`} />
            <CardMetric label="Today P&L" value={summary.todayChange === null ? 'ไม่มีราคาปิดวันก่อน' : signed(summary.todayChange)} />
          </dl>
          {goal.targetValueUsd !== null && <div className="mt-3 rounded-lg bg-slate-900/70 p-3 text-xs">
            <p className="font-semibold text-slate-200">เป้าหมาย {money(goal.targetValueUsd)} · {goalProgress.progressPercent === null ? '—' : `${goalProgress.progressPercent.toFixed(2)}%`}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="h-full bg-[#D4FF00]" style={{ width: `${Math.min(100, Math.max(0, goalProgress.progressPercent ?? 0))}%` }} /></div>
            {goalProgress.reason && <p className="mt-1 text-amber-300">{goalProgress.reason}</p>}
          </div>}
          <p className="mt-3 text-[11px] text-slate-500">{updated ? `ราคาล่าสุด ${displayTime(updated)}` : positions ? 'ยังไม่มีเวลาราคาที่ตรวจสอบได้' : 'ยังไม่มีสถานะเปิด'}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Button size="sm" variant="outline" onClick={() => onSelect(portfolio.id)}>เปิดดู</Button>
            <Button size="sm" variant="outline" disabled={!isOnline} onClick={() => openEdit(portfolio)}><Edit3 size={14} /> ชื่อ</Button>
            <Button size="sm" variant="outline" disabled={!isOnline} onClick={() => openGoal(portfolio)}><Target size={14} /> เป้าหมาย</Button>
            {portfolio.archivedAt
              ? <Button size="sm" variant="outline" disabled={!isOnline} onClick={() => run(() => restorePortfolioAction(portfolio.id), 'นำพอร์ตกลับมาใช้แล้ว', () => undefined)}><RotateCcw size={14} /> คืนค่า</Button>
              : <Button size="sm" variant="outline" disabled={!isOnline} onClick={() => { setError(''); setConfirming(portfolio); }}>{canDelete ? <Trash2 size={14} /> : <Archive size={14} />}{canDelete ? 'ลบ' : 'Archive'}</Button>}
          </div>
        </article>;
      })}
    </div>

    <Modal isOpen={createOpen} onClose={() => !pending && closeCreate()} title="สร้างพอร์ตใหม่">
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        run(() => createPortfolioAction({ name: createName, type: createType }), 'สร้างพอร์ตแล้ว', closeCreate);
      }}>
        <Field label="ประเภทพอร์ต">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="ประเภทพอร์ต">
            <button
              type="button"
              role="radio"
              aria-checked={createType === 'STOCK'}
              onClick={() => setCreateType('STOCK')}
              className={`min-h-14 rounded-xl border px-3 py-2 text-left text-sm ${createType === 'STOCK' ? 'border-[#D4FF00] bg-[#D4FF00]/10 text-white' : 'border-slate-700 text-slate-300'}`}
            >
              <span className="block font-bold">พอร์ตหุ้น/ETF</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={createType === 'OPTION'}
              disabled={!optionsEntitlement.canCreate}
              onClick={() => setCreateType('OPTION')}
              className={`min-h-14 rounded-xl border px-3 py-2 text-left text-sm ${!optionsEntitlement.canCreate ? 'cursor-not-allowed border-slate-800 bg-slate-900/60 text-slate-500' : createType === 'OPTION' ? 'border-[#D4FF00] bg-[#D4FF00]/10 text-white' : 'border-slate-700 text-slate-300'}`}
            >
              <span className="flex items-center gap-2 font-bold">{!optionsEntitlement.canCreate && <Lock size={14} aria-hidden="true" />} พอร์ต Options</span>
              {!optionsEntitlement.canCreate && <span className="mt-1 block text-xs text-amber-300">ใช้ได้ใน Pro</span>}
            </button>
          </div>
        </Field>
        <Field label="ชื่อพอร์ต" helper="1–40 ตัวอักษร และห้ามซ้ำในประเภทเดียวกัน"><input className="form-input" maxLength={40} value={createName} onChange={(event) => setCreateName(event.target.value)} /></Field>
        <ActionError value={error} />
        <ModalActions pending={pending} onCancel={closeCreate} submitLabel="สร้างพอร์ต" />
      </form>
    </Modal>

    <Modal isOpen={Boolean(editing)} onClose={() => !pending && closeEdit()} title="แก้ไขพอร์ต">
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        if (!editing) return;
        run(() => updatePortfolioAction({ id: editing.id, name: editName, type: editType }), 'บันทึกพอร์ตแล้ว', closeEdit);
      }}>
        <Field label="ชื่อพอร์ต" helper="ระบบตรวจชื่อซ้ำหลัง trim และไม่แยกตัวพิมพ์เล็ก/ใหญ่"><input className="form-input" maxLength={editing?.isLegacy ? 80 : 40} value={editName} onChange={(event) => setEditName(event.target.value)} /></Field>
        {!editing?.isLegacy && <Field label="ประเภทพอร์ต" helper={editing?.transactions.length ? 'เปลี่ยนประเภทไม่ได้หลังมี transaction' : 'เปลี่ยนได้เฉพาะพอร์ตที่ยังไม่มี transaction'}>
          <select className="form-input" disabled={Boolean(editing?.transactions.length)} value={editType} onChange={(event) => setEditType(event.target.value as PortfolioType)}><option value="STOCK">พอร์ตหุ้น</option><option value="OPTION">พอร์ตออปชัน</option></select>
        </Field>}
        <ActionError value={error} />
        <ModalActions pending={pending} onCancel={closeEdit} submitLabel="บันทึก" />
      </form>
    </Modal>

    <Modal isOpen={Boolean(goalPortfolio)} onClose={() => !pending && closeGoal()} title={goalPortfolio === 'aggregate' ? 'เป้าหมายพอร์ตรวม' : `เป้าหมาย ${goalPortfolio?.name ?? ''}`}>
      <form className="space-y-4" onSubmit={submitGoal}>
        <p className="rounded-lg bg-slate-950/50 p-3 text-xs text-slate-400">เป้าหมายเก็บฐาน USD และใช้ติดตามความคืบหน้าเท่านั้น ไม่ใช่ P&amp;L คำแนะนำ หรือคำสั่งซื้อขาย</p>
        <Field label="มูลค่าเป้าหมาย (USD)" helper="เว้นว่างเพื่อล้างเป้าหมาย"><DecimalInput value={goalValue} onChange={setGoalValue} /></Field>
        <Field label="วันที่เป้าหมาย (ไม่บังคับ)"><input type="date" className="form-input" value={goalDate} disabled={goalValue === ''} onChange={(event) => setGoalDate(event.target.value)} /></Field>
        <ActionError value={error} />
        <ModalActions pending={pending} onCancel={closeGoal} submitLabel="บันทึกเป้าหมาย" />
      </form>
    </Modal>

    <Modal isOpen={Boolean(confirming)} onClose={() => !pending && setConfirming(null)} title={confirming?.transactions.length ? 'Archive พอร์ตนี้หรือไม่' : 'ลบหรือ Archive พอร์ตนี้'}>
      <p className="text-sm text-slate-300">{confirming?.transactions.length ? 'พอร์ตมีประวัติใน Ledger จึงจะ Archive โดยไม่ลบ transaction, position หรือ P&L history' : confirming?.isLegacy ? 'Default / Legacy ลบถาวรไม่ได้ แต่ Archive ได้' : 'ลบถาวรได้เฉพาะพอร์ตว่างที่ไม่มี transaction, position, target และ cash balance'}</p>
      <ActionError value={error} />
      <div className="mt-5 flex gap-2">
        <Button variant="outline" className="flex-1" disabled={pending} onClick={() => setConfirming(null)}>ยกเลิก</Button>
        <Button className="flex-1" disabled={pending || !confirming} onClick={() => {
          if (!confirming) return;
          const summary = summaries[confirming.id];
          const canDelete = !confirming.isLegacy && confirming.transactions.length === 0 && confirming.targetValueUsd === null
            && (optionTargetCounts[confirming.id] ?? 0) === 0 && summary.cashBalance === 0
            && summary.holdings.length === 0 && summary.optionPositions.length === 0;
          run(
            () => canDelete ? deletePortfolioAction(confirming.id) : archivePortfolioAction(confirming.id),
            canDelete ? 'ลบพอร์ตว่างแล้ว' : 'Archive พอร์ตแล้ว',
            () => setConfirming(null),
          );
        }}>{confirming && !confirming.isLegacy && confirming.transactions.length === 0 ? 'ดำเนินการอย่างปลอดภัย' : 'Archive'}</Button>
      </div>
    </Modal>

    <Modal isOpen={transferOpen} onClose={() => !pending && closeTransfer()} title="ย้ายเงินระหว่างพอร์ต">
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        const dateTime = validateTransactionDateTime(transferDate, timezone);
        if (!dateTime.ok) {
          setError(dateTime.message);
          return;
        }
        run(() => transferPortfolioCashAction({
          sourcePortfolioId: transferSource,
          destinationPortfolioId: transferDestination,
          amountUsd: Number(transferAmount),
          occurredAt: transferDate,
          timezone,
          note: transferNote,
          idempotencyKey: transferIdempotencyKey,
        }), 'บันทึก transfer_out / transfer_in แล้ว', closeTransfer);
      }}>
        <p className="rounded-lg bg-slate-950/50 p-3 text-xs text-slate-400">ระบบสร้างรายการคู่ใน Ledger เดิม และไม่นับเป็น Net deposits หรือ P&amp;L ของพอร์ตรวม</p>
        <Field label="พอร์ตต้นทาง"><select className="form-input" value={transferSource} onChange={(event) => { const value = event.target.value; setTransferSource(value); if (transferDestination === value) setTransferDestination(active.find((portfolio) => portfolio.id !== value)?.id ?? ''); }}>{active.map((portfolio) => <option key={portfolio.id} value={portfolio.id}>{portfolio.name}</option>)}</select></Field>
        <Field label="พอร์ตปลายทาง"><select className="form-input" value={transferDestination} onChange={(event) => setTransferDestination(event.target.value)}>{active.filter((portfolio) => portfolio.id !== transferSource).map((portfolio) => <option key={portfolio.id} value={portfolio.id}>{portfolio.name}</option>)}</select></Field>
        <Field label="จำนวนเงิน (USD)"><DecimalInput value={transferAmount} onChange={setTransferAmount} /></Field>
        <Field label="วันและเวลา"><input type="datetime-local" className="form-input" max={maximumTransactionDateTimeLocal(timezone)} value={transferDate} onChange={(event) => setTransferDate(event.target.value)} /></Field>
        <Field label="หมายเหตุ (ไม่บังคับ)"><textarea className="form-input h-auto py-3" rows={2} maxLength={500} value={transferNote} onChange={(event) => setTransferNote(event.target.value)} /></Field>
        <div className={`rounded-lg p-3 text-sm ${transferCashAfter < 0 ? 'bg-amber-500/10 text-amber-200' : 'bg-slate-950/50 text-slate-300'}`}>
          เงินสดพอร์ตต้นทางหลังย้าย: <strong className="font-mono">${transferCashAfter.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
          {transferCashAfter < 0 && <p className="mt-1 text-xs">เงินสดติดลบ โปรดตรวจเงินฝากย้อนหลังหรือสถานะ Margin</p>}
        </div>
        <ActionError value={error} />
        <ModalActions pending={pending} onCancel={closeTransfer} submitLabel="ยืนยันการย้ายเงิน" />
      </form>
    </Modal>
  </section>;
}

function CardMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-slate-500">{label}</dt><dd className="mt-1 break-words font-mono font-semibold text-slate-200">{value}</dd></div>;
}

function ActionError({ value }: { value: string }) {
  return value ? <p role="alert" className="mt-3 text-sm text-red-400">{value}</p> : null;
}

function ModalActions({ pending, onCancel, submitLabel }: { pending: boolean; onCancel: () => void; submitLabel: string }) {
  return <div className="flex gap-2">
    <Button type="button" variant="outline" className="flex-1" disabled={pending} onClick={onCancel}>ยกเลิก</Button>
    <Button type="submit" className="flex-1" disabled={pending}>{pending ? 'กำลังบันทึก…' : submitLabel}</Button>
  </div>;
}
