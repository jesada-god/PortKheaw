'use client';

import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, Edit3, FolderOpen, History, Lock, Plus, RotateCcw, Target, Trash2, Undo2 } from 'lucide-react';
import {
  archivePortfolioAction,
  createPortfolioAction,
  restoreDeletedPortfolioAction,
  restorePortfolioAction,
  setPortfolioGoalAction,
  softDeletePortfolioAction,
  transferPortfolioCashAction,
  updatePortfolioAction,
} from '@/app/portfolio/portfolio-actions';
import {
  confirmAssetTransferAction,
  loadPortfolioDeletionSummaryAction,
  loadTransferableAssetsAction,
  previewAssetTransferAction,
} from '@/app/portfolio/transfer-actions';
import { DeletePortfolioDialog } from './DeletePortfolioDialog';
import { TransferAssetsDialog, type TransferSelectionState, type TransferStep } from './TransferAssetsDialog';
import type { PortfolioDeletionSummary, TransferPreview } from '@/src/lib/portfolio/transfer/service';
import type { TransferableAssets } from '@/src/lib/portfolio/transfer/plan';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import { useToast } from '@/src/components/ui/Toast';
import { calculateGoalProgress } from '@/src/lib/portfolio/aggregate';
import { portfolioReturnToneClass } from '@/src/lib/portfolio/presentation';
import {
  buildPortfolioGoalCardModel,
  latestPortfolioPriceTime,
  type PortfolioGoalScope,
} from '@/src/lib/portfolio/goal-card';
import type {
  DeletedPortfolioSummary,
  PortfolioGoal,
  PortfolioRecord,
  PortfolioSummary,
  PortfolioType,
} from '@/src/lib/portfolio/types';
import {
  currentDateTimeLocal,
  maximumTransactionDateTimeLocal,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { DecimalInput, Field } from './FormControls';
import { PortfolioGoalCard } from './PortfolioGoalCard';
import { portfolioCreationEntitlement } from '@/src/lib/subscription/subscription-limits';
import { READ_ONLY_PORTFOLIO_MESSAGE } from '@/src/lib/subscription/entitlement-errors';
import {
  basicWritableStockPortfolioId,
  portfolioWriteBlock,
} from '@/src/lib/subscription/portfolio-write-access';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';

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
  recentlyDeleted,
  timezone,
  effectiveTier,
  showBalances,
  isOnline,
  money,
  signed,
  percent,
  onSelect,
  transferOpenRequest,
  onTransferRequestHandled,
}: {
  portfolios: PortfolioRecord[];
  summaries: Record<string, PortfolioSummary>;
  aggregate: PortfolioSummary;
  aggregateGoal: PortfolioGoal;
  selectedPortfolioId: string;
  optionTargetCounts: Record<string, number>;
  recentlyDeleted: DeletedPortfolioSummary[];
  timezone: string;
  effectiveTier: SubscriptionTier;
  showBalances: boolean;
  isOnline: boolean;
  money: Money;
  signed: (value: number | null) => string;
  percent: (value: number | null) => string;
  onSelect: (portfolioId: string) => void;
  transferOpenRequest: number;
  onTransferRequestHandled: () => void;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const { requestUpgrade } = useEntitlement();
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
  /*
   * Deletion and asset transfer share one target, because they are two answers
   * to the same question. Opening the delete dialog is what offers the move, and
   * finishing the move offers the deletion again — the reader never has to hold
   * a portfolio in their head between two unrelated screens.
   */
  const [deleteTarget, setDeleteTarget] = useState<PortfolioRecord | null>(null);
  const [deleteSummary, setDeleteSummary] = useState<PortfolioDeletionSummary | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [undoTarget, setUndoTarget] = useState<{ id: string; name: string } | null>(null);
  const [assetTransferSource, setAssetTransferSource] = useState<PortfolioRecord | null>(null);
  const [assetStep, setAssetStep] = useState<TransferStep>('destination');
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetError, setAssetError] = useState('');
  const [assetInventory, setAssetInventory] = useState<TransferableAssets | null>(null);
  const [assetDestinations, setAssetDestinations] = useState<{ id: string; name: string; type: PortfolioType }[]>([]);
  const [assetDestinationId, setAssetDestinationId] = useState('');
  const [assetPreview, setAssetPreview] = useState<TransferPreview | null>(null);
  /*
   * Minted with the preview and replayed on confirm. Two clicks on the confirm
   * button therefore carry the same id, and the second one lands on the first
   * one's rows instead of writing a duplicate set.
   */
  const [assetGroupId, setAssetGroupId] = useState('');
  const [assetSelection, setAssetSelection] = useState<TransferSelectionState | null>(null);
  const [assetCompleted, setAssetCompleted] = useState('');
  /*
   * Minted on every opening and used as the dialogs' `key`, so each one starts
   * from a clean form. This is how state is reset here rather than in an effect:
   * a half-typed portfolio name or a stale checkbox surviving into a dialog
   * about a different portfolio is the failure that pattern prevents.
   */
  const [dialogSessionKey, setDialogSessionKey] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferSource, setTransferSource] = useState(selectedPortfolioId);
  const [transferDestination, setTransferDestination] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferDate, setTransferDate] = useState(currentDateTimeLocal(timezone));
  const [transferNote, setTransferNote] = useState('');
  const [transferIdempotencyKey, setTransferIdempotencyKey] = useState('');
  const [error, setError] = useState('');
  const [limitType, setLimitType] = useState<'STOCK' | 'OPTION' | null>(null);

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
  /*
   * The list is rendered in the repository's (created_at, id) order, which is
   * the order the database itself picks the one writable Basic stock portfolio
   * in. Reading it as given keeps the badge and the server's answer in step.
   */
  const writableStockId = basicWritableStockPortfolioId(portfolios);
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

  function run(task: () => Promise<{ ok: boolean; code?: string; message?: string }>, done: string, close: () => void) {
    if (pending || !isOnline) return;
    setError('');
    startTransition(async () => {
      const result = await task();
      if (!result.ok) {
        if (result.code === 'upgrade_required' || result.code === 'read_only') {
          requestUpgrade({ capability: createType === 'OPTION' ? 'portfolio.options.create' : 'portfolio.multiple.create', source: 'portfolio.manager-action' });
          close();
          return;
        }
        if (result.code === 'limit') {
          setLimitType(createType);
          close();
          return;
        }
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

  function requestCreate(type: 'STOCK' | 'OPTION' = tab) {
    const entitlement = portfolioCreationEntitlement(effectiveTier, type);
    const count = active.filter((portfolio) => portfolio.type === type).length;
    if (!entitlement.canCreate) {
      requestUpgrade({ capability: 'portfolio.options.create', source: 'portfolio.create-option' });
      return;
    }
    if (count >= entitlement.maxCount) {
      if (effectiveTier === 'basic') {
        requestUpgrade({ capability: 'portfolio.multiple.create', source: 'portfolio.create-limit' });
      } else {
        setLimitType(type);
      }
      return;
    }
    openCreate(type);
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

  useEffect(() => {
    if (!transferOpenRequest) return;
    let activeRequest = true;
    queueMicrotask(() => {
      if (!activeRequest) return;
      openTransfer();
      onTransferRequestHandled();
    });
    return () => { activeRequest = false; };
    // A monotonically increasing request is the event boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transferOpenRequest]);

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

  /*
   * The dialog's numbers come from the server, every time it opens. The page
   * already has a summary and it is deliberately not reused: this is the screen
   * somebody reads before agreeing to lose a portfolio, and it has to describe
   * the portfolio as it is now.
   */
  function openDelete(portfolio: PortfolioRecord) {
    setDialogSessionKey(crypto.randomUUID());
    setDeleteTarget(portfolio);
    setDeleteSummary(null);
    setDeleteError('');
    setDeleteLoading(true);
    startTransition(async () => {
      const result = await loadPortfolioDeletionSummaryAction({ portfolioId: portfolio.id });
      setDeleteLoading(false);
      if (!result.ok) {
        setDeleteError(result.message);
        return;
      }
      setDeleteSummary(result.summary);
    });
  }

  function closeDelete() {
    setDeleteTarget(null);
    setDeleteSummary(null);
    setDeleteError('');
  }

  function confirmDelete(confirmName: string) {
    if (!deleteTarget || pending || !isOnline) return;
    setDeleteError('');
    startTransition(async () => {
      const result = await softDeletePortfolioAction({ id: deleteTarget.id, confirmName });
      if (!result.ok) {
        setDeleteError(result.message);
        return;
      }
      const removed = { id: deleteTarget.id, name: deleteTarget.name };
      closeDelete();
      // The undo lives on the page rather than inside the toast: a three-second
      // toast is not long enough to notice that the wrong portfolio has gone.
      setUndoTarget(removed);
      addToast({ title: 'ลบพอร์ตแล้ว กู้คืนได้ภายใน 7 วัน', type: 'success' });
      router.refresh();
    });
  }

  function restoreDeleted(id: string) {
    if (pending || !isOnline) return;
    startTransition(async () => {
      const result = await restoreDeletedPortfolioAction(id);
      if (!result.ok) {
        addToast({ title: 'กู้คืนไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      setUndoTarget(null);
      addToast({ title: `กู้คืนพอร์ต “${result.name}” แล้ว`, type: 'success' });
      router.refresh();
    });
  }

  function openAssetTransfer(portfolio: PortfolioRecord) {
    setDialogSessionKey(crypto.randomUUID());
    setAssetTransferSource(portfolio);
    setAssetStep('destination');
    setAssetError('');
    setAssetInventory(null);
    setAssetDestinations([]);
    setAssetDestinationId('');
    setAssetPreview(null);
    setAssetGroupId('');
    setAssetSelection(null);
    setAssetCompleted('');
    setAssetLoading(true);
    startTransition(async () => {
      const result = await loadTransferableAssetsAction({ portfolioId: portfolio.id });
      setAssetLoading(false);
      if (!result.ok) {
        setAssetError(result.message);
        return;
      }
      setAssetInventory(result.assets);
      setAssetDestinations(result.destinations);
      setAssetDestinationId(result.destinations[0]?.id ?? '');
    });
  }

  function closeAssetTransfer() {
    setAssetTransferSource(null);
    setAssetInventory(null);
    setAssetPreview(null);
    setAssetSelection(null);
    setAssetError('');
  }

  /** Quantities only. Every amount on the preview is derived by the server. */
  function selectionPayload(selection: TransferSelectionState) {
    return {
      equities: Object.entries(selection.equities)
        .map(([symbol, quantity]) => ({ symbol, quantity: Number(quantity) }))
        .filter((item) => Number.isFinite(item.quantity) && item.quantity > 0),
      options: Object.entries(selection.options)
        .map(([key, contracts]) => ({ key, contracts: Number(contracts) }))
        .filter((item) => Number.isFinite(item.contracts) && item.contracts > 0),
      cashUsd: Number.isFinite(Number(selection.cash)) && Number(selection.cash) > 0 ? Number(selection.cash) : 0,
    };
  }

  function previewAssetTransfer(selection: TransferSelectionState) {
    if (!assetTransferSource || pending || !isOnline) return;
    setAssetError('');
    setAssetSelection(selection);
    startTransition(async () => {
      const result = await previewAssetTransferAction({
        sourcePortfolioId: assetTransferSource.id,
        destinationPortfolioId: assetDestinationId,
        ...selectionPayload(selection),
      });
      if (!result.ok) {
        setAssetError(result.message);
        return;
      }
      setAssetPreview(result.preview);
      setAssetGroupId(result.groupId);
      setAssetStep('preview');
    });
  }

  function confirmAssetTransfer() {
    if (!assetTransferSource || !assetSelection || !assetGroupId || pending || !isOnline) return;
    setAssetError('');
    startTransition(async () => {
      const result = await confirmAssetTransferAction({
        sourcePortfolioId: assetTransferSource.id,
        destinationPortfolioId: assetDestinationId,
        groupId: assetGroupId,
        ...selectionPayload(assetSelection),
      });
      if (!result.ok) {
        setAssetError(result.message);
        /*
         * A stale plan is the one failure the reader cannot fix by reading the
         * message: the positions moved underneath them. Nothing was written, so
         * the honest response is to go back and show what is actually there.
         */
        if (result.code === 'stale') {
          setAssetStep('items');
          setAssetPreview(null);
          setAssetGroupId('');
          const reload = await loadTransferableAssetsAction({ portfolioId: assetTransferSource.id });
          if (reload.ok) {
            setAssetInventory(reload.assets);
            setAssetDestinations(reload.destinations);
          }
          router.refresh();
        }
        return;
      }
      setAssetCompleted(result.destinationName);
      setAssetStep('done');
      router.refresh();
    });
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
        <Button size="sm" disabled={!isOnline} onClick={() => requestCreate()}><Plus size={16} /> สร้างพอร์ต</Button>
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
        const keyHoldings = [
          ...summary.holdings.map((holding) => holding.symbol),
          ...summary.optionPositions.filter((position) => position.status === 'open').map((position) => position.contractSymbol),
        ].slice(0, 3);
        const updated = latestPortfolioPriceTime(summary);
        const writeBlock = portfolioWriteBlock(effectiveTier, portfolio, writableStockId);
        return <article key={portfolio.id} className={`min-w-0 rounded-2xl border p-4 ${portfolio.id === selectedPortfolioId ? 'border-[#D4FF00]/50 bg-[#D4FF00]/5' : 'border-slate-800 bg-slate-950/35'} ${portfolio.archivedAt ? 'opacity-75' : ''}`}>
          <button type="button" onClick={() => onSelect(portfolio.id)} className="min-h-11 w-full text-left focus-visible:rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#D4FF00]">
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0"><strong className="block break-words text-white">{portfolio.name}</strong><span className="mt-1 block text-xs text-slate-400">{typeLabel(portfolio.type)}{portfolio.archivedAt ? ' · Archived' : ''}{writeBlock ? ' · อ่านอย่างเดียว' : ''}</span></span>
              <FolderOpen className="shrink-0 text-[#D4FF00]" size={18} />
            </span>
          </button>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <CardMetric label="มูลค่าปัจจุบัน" value={money(summary.totalValue)} />
            <CardMetric label="เงินสด" value={money(summary.cashBalance)} />
            <CardMetric
              label="กำไร/ขาดทุนรวม"
              value={`${signed(summary.totalGain)} · ${percent(summary.totalGainPercent)}`}
              tone={portfolioReturnToneClass(showBalances ? summary.totalGain : null, 'text-slate-200')}
            />
            <CardMetric
              label="กำไร/ขาดทุนวันนี้"
              value={summary.todayChange === null ? '—' : signed(summary.todayChange)}
              tone={portfolioReturnToneClass(showBalances ? summary.todayChange : null, 'text-slate-200')}
              helper={summary.todayChange === null ? 'ยังคำนวณกำไร/ขาดทุนวันนี้ไม่ได้ เพราะไม่มีราคาปิดวันก่อน' : undefined}
            />
          </dl>
          <div className="mt-3 min-w-0 text-xs"><span className="text-slate-500">สินทรัพย์สำคัญ</span><div className="mt-2 flex min-w-0 flex-wrap gap-1.5">{keyHoldings.length ? keyHoldings.map((symbol) => <span key={symbol} className="max-w-full truncate rounded-full bg-slate-800 px-2 py-1 font-mono text-slate-200">{symbol}</span>) : <span className="text-slate-500">ยังไม่มี · {positions} positions</span>}</div></div>
          {goal.targetValueUsd !== null && <div className="mt-3 rounded-lg bg-slate-900/70 p-3 text-xs">
            <p className="font-semibold text-slate-200">เป้าหมาย {money(goal.targetValueUsd)} · {goalProgress.progressPercent === null ? '—' : `${goalProgress.progressPercent.toFixed(2)}%`}</p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="h-full bg-[#D4FF00]" style={{ width: `${Math.min(100, Math.max(0, goalProgress.progressPercent ?? 0))}%` }} /></div>
            {goalProgress.reason && <p className="mt-1 text-amber-300">{goalProgress.reason}</p>}
          </div>}
          <p className="mt-3 text-[11px] text-slate-500">{updated ? `ราคาล่าสุด ${displayTime(updated)}` : positions ? 'ยังไม่มีเวลาราคาที่ตรวจสอบได้' : 'ยังไม่มีสถานะเปิด'}</p>
          {writeBlock && <p className="mt-3 flex items-start gap-1.5 text-[11px] text-amber-300">
            <Lock aria-hidden="true" size={12} className="mt-0.5 shrink-0" />
            <span>{READ_ONLY_PORTFOLIO_MESSAGE}</span>
          </p>}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Button size="sm" variant="outline" onClick={() => onSelect(portfolio.id)}>เปิดดู</Button>
            <Button size="sm" variant="outline" disabled={!isOnline || Boolean(writeBlock)} onClick={() => openEdit(portfolio)}><Edit3 size={14} /> ชื่อ</Button>
            <Button size="sm" variant="outline" disabled={!isOnline || Boolean(writeBlock)} onClick={() => openGoal(portfolio)}><Target size={14} /> เป้าหมาย</Button>
            {portfolio.archivedAt && <Button size="sm" variant="outline" disabled={!isOnline} onClick={() => run(() => restorePortfolioAction(portfolio.id), 'นำพอร์ตกลับมาใช้แล้ว', () => undefined)}><RotateCcw size={14} /> เลิก Archive</Button>}
            {/*
              Deleting is now a real, reversible action rather than a euphemism.
              The Default / Legacy portfolio still cannot go — the account is
              anchored to it — so it keeps Archive, which is what it always
              actually offered.
            */}
            {portfolio.isLegacy
              ? !portfolio.archivedAt && <Button size="sm" variant="outline" disabled={!isOnline} onClick={() => { setError(''); setConfirming(portfolio); }}><Archive size={14} /> Archive</Button>
              : <Button
                size="sm"
                variant="outline"
                className="border-[var(--negative)]/50 text-[var(--negative)] hover:bg-[var(--negative)]/10"
                disabled={!isOnline || Boolean(writeBlock)}
                onClick={() => openDelete(portfolio)}
                data-testid={`delete-portfolio-${portfolio.id}`}
              ><Trash2 size={14} /> ลบพอร์ต</Button>}
          </div>
        </article>;
      })}
    </div>

    {/*
      The undo, on the page rather than in a toast. A toast that disappears after
      three seconds is not an offer to reverse a deletion — it is a notice that
      one happened.
    */}
    {undoTarget && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm" data-testid="portfolio-undo-delete">
      <p className="min-w-0 text-[var(--text)]">
        ลบพอร์ต “<strong className="break-words">{undoTarget.name}</strong>” แล้ว กู้คืนได้ภายใน 7 วัน
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={!isOnline || pending} onClick={() => restoreDeleted(undoTarget.id)}>
          <Undo2 aria-hidden="true" size={14} /> กู้คืน
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setUndoTarget(null)}>ปิด</Button>
      </div>
    </div>}

    {recentlyDeleted.length > 0 && <section className="mt-4 rounded-2xl border border-[var(--border)] bg-slate-950/35 p-4" data-testid="recently-deleted-portfolios">
      <div className="flex items-center gap-2">
        <History aria-hidden="true" className="shrink-0 text-slate-400" size={16} />
        <h4 className="text-sm font-bold text-white">พอร์ตที่ลบล่าสุด</h4>
      </div>
      <p className="mt-1 text-xs text-slate-400">กู้คืนได้ภายใน 7 วันนับจากวันที่ลบ หลังจากนั้นข้อมูลจะถูกลบถาวร</p>
      <ul className="mt-3 grid gap-2">
        {recentlyDeleted.map((portfolio) => <li
          key={portfolio.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 p-3"
        >
          <div className="min-w-0">
            <strong className="block break-words text-sm text-white">{portfolio.name}</strong>
            <span className="mt-0.5 block text-xs text-slate-400">
              ลบเมื่อ {displayTime(portfolio.deletedAt)} · กู้คืนได้ถึง {displayTime(portfolio.purgeAfter)}
            </span>
          </div>
          <Button size="sm" variant="outline" disabled={!isOnline || pending} onClick={() => restoreDeleted(portfolio.id)}>
            <RotateCcw aria-hidden="true" size={14} /> กู้คืน
          </Button>
        </li>)}
      </ul>
    </section>}

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
              onClick={() => {
                if (!optionsEntitlement.canCreate) {
                  closeCreate();
                  requestUpgrade({ capability: 'portfolio.options.create', source: 'portfolio.create-option-choice' });
                  return;
                }
                setCreateType('OPTION');
              }}
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

    {/*
      Archive, which is now only reachable for the Default / Legacy portfolio.
      It is not deletion and never was: the portfolio stays, keeps its ledger and
      keeps counting towards the aggregate — it just stops accepting new rows.
    */}
    <Modal isOpen={Boolean(confirming)} onClose={() => !pending && setConfirming(null)} title="Archive พอร์ตนี้หรือไม่">
      <p className="text-sm text-slate-300">
        พอร์ต Default / Legacy ลบไม่ได้เพราะเป็นพอร์ตตั้งต้นของบัญชี แต่ Archive ได้ — ระบบจะเก็บ transaction, position และ P&amp;L history ไว้ครบ และหยุดรับรายการใหม่เท่านั้น
      </p>
      <ActionError value={error} />
      <div className="mt-5 flex gap-2">
        <Button variant="outline" className="flex-1" disabled={pending} onClick={() => setConfirming(null)}>ยกเลิก</Button>
        <Button className="flex-1" disabled={pending || !confirming} onClick={() => {
          if (!confirming) return;
          run(() => archivePortfolioAction(confirming.id), 'Archive พอร์ตแล้ว', () => setConfirming(null));
        }}>Archive</Button>
      </div>
    </Modal>

    <DeletePortfolioDialog
      key={`delete-${dialogSessionKey}`}
      open={Boolean(deleteTarget)}
      loading={deleteLoading}
      summary={deleteSummary}
      error={deleteError}
      pending={pending}
      money={money}
      onClose={closeDelete}
      onTransferFirst={() => {
        const target = deleteTarget;
        closeDelete();
        if (target) openAssetTransfer(target);
      }}
      onConfirm={confirmDelete}
    />

    <TransferAssetsDialog
      key={`transfer-${dialogSessionKey}`}
      open={Boolean(assetTransferSource)}
      step={assetStep}
      loading={assetLoading}
      pending={pending}
      error={assetError}
      sourceName={assetTransferSource?.name ?? ''}
      assets={assetInventory}
      destinations={assetDestinations}
      destinationId={assetDestinationId}
      preview={assetPreview}
      completedDestinationName={assetCompleted}
      money={money}
      onClose={closeAssetTransfer}
      onDestinationChange={setAssetDestinationId}
      onStepChange={setAssetStep}
      onPreview={previewAssetTransfer}
      onConfirm={confirmAssetTransfer}
      onOpenDestination={() => {
        const destination = assetDestinationId;
        closeAssetTransfer();
        if (destination) onSelect(destination);
      }}
      onDeleteSource={() => {
        const source = assetTransferSource;
        closeAssetTransfer();
        if (source) openDelete(source);
      }}
    />

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

    <Modal isOpen={Boolean(limitType)} onClose={() => setLimitType(null)} title="พอร์ตเต็มตามแพ็กเกจ">
      <p className="text-sm text-slate-300">แพ็กเกจ {effectiveTier.toUpperCase()} ใช้พอร์ต {limitType === 'OPTION' ? 'Options' : 'หุ้น/ETF'} ครบ {limitType ? portfolioCreationEntitlement(effectiveTier, limitType).maxCount : 0} พอร์ตแล้ว โปรด Archive พอร์ตที่ไม่ใช้ก่อนสร้างใหม่</p>
      <div className="mt-5"><Button className="w-full" onClick={() => setLimitType(null)}>เข้าใจแล้ว</Button></div>
    </Modal>
  </section>;
}

function CardMetric({ label, value, tone = 'text-slate-200', helper }: {
  label: string;
  value: string;
  tone?: string;
  helper?: string;
}) {
  return <div className="min-w-0">
    <dt className="text-slate-500">{label}</dt>
    <dd className={`mt-1 break-words font-mono font-semibold ${tone}`}>{value}</dd>
    {helper && <dd className="mt-1 text-[11px] font-normal text-slate-500">{helper}</dd>}
  </div>;
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
