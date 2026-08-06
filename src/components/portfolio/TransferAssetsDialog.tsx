'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, LoaderCircle } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import type { TransferableAssets } from '@/src/lib/portfolio/transfer/plan';
import type { TransferPreview } from '@/src/lib/portfolio/transfer/service';

/*
 * Moving assets, in the three questions the move actually has: where to, what,
 * and are you sure.
 *
 * Nothing on this screen is a source of truth. The lists come from the server's
 * replay of the ledger, the preview is built by the server from the same replay,
 * and the confirmation sends back only which positions and how many. The reader
 * cannot type a cost basis here, and neither can this component.
 */

export type TransferStep = 'destination' | 'items' | 'preview' | 'done';

export interface TransferSelectionState {
  equities: Record<string, string>;
  options: Record<string, string>;
  cash: string;
}

export interface TransferAssetsDialogProps {
  open: boolean;
  step: TransferStep;
  loading: boolean;
  pending: boolean;
  error: string;
  sourceName: string;
  assets: TransferableAssets | null;
  destinations: { id: string; name: string; type: 'STOCK' | 'OPTION' | 'LEGACY' }[];
  destinationId: string;
  preview: TransferPreview | null;
  completedDestinationName: string;
  money: (value: number | string | null) => string;
  onClose: () => void;
  onDestinationChange: (id: string) => void;
  onStepChange: (step: TransferStep) => void;
  onPreview: (selection: TransferSelectionState) => void;
  onConfirm: () => void;
  onOpenDestination: () => void;
  onDeleteSource: () => void;
}

const STEP_LABELS: Record<Exclude<TransferStep, 'done'>, string> = {
  destination: '1. เลือกพอร์ตปลายทาง',
  items: '2. เลือกรายการที่จะย้าย',
  preview: '3. ตรวจสอบก่อนยืนยัน',
};

export function TransferAssetsDialog({
  open,
  step,
  loading,
  pending,
  error,
  sourceName,
  assets,
  destinations,
  destinationId,
  preview,
  completedDestinationName,
  money,
  onClose,
  onDestinationChange,
  onStepChange,
  onPreview,
  onConfirm,
  onOpenDestination,
  onDeleteSource,
}: TransferAssetsDialogProps) {
  /*
   * The selection lives here and is reset by remounting, not by an effect: the
   * caller gives this dialog a fresh `key` every time it opens. Carrying a stale
   * selection into a second opening is exactly the bug that produces a transfer
   * of positions the reader thought they had deselected.
   */
  const [selection, setSelection] = useState<TransferSelectionState>({ equities: {}, options: {}, cash: '' });

  const selectedCount = useMemo(() =>
    Object.values(selection.equities).filter((value) => Number(value) > 0).length
    + Object.values(selection.options).filter((value) => Number(value) > 0).length
    + (Number(selection.cash) > 0 ? 1 : 0),
  [selection]);

  function toggleEquity(symbol: string, quantity: number) {
    setSelection((current) => {
      const next = { ...current.equities };
      if (next[symbol] === undefined) next[symbol] = String(quantity);
      else delete next[symbol];
      return { ...current, equities: next };
    });
  }

  function toggleOption(key: string, contracts: number) {
    setSelection((current) => {
      const next = { ...current.options };
      if (next[key] === undefined) next[key] = String(contracts);
      else delete next[key];
      return { ...current, options: next };
    });
  }

  function selectAll() {
    if (!assets) return;
    setSelection({
      equities: Object.fromEntries(assets.equities.map((item) => [item.symbol, String(item.quantity)])),
      options: Object.fromEntries(assets.options.map((item) => [item.key, String(item.contracts)])),
      cash: assets.transferableCash > 0 ? String(assets.transferableCash) : '',
    });
  }

  const title = step === 'done' ? 'ย้ายสินทรัพย์สำเร็จ' : `ย้ายสินทรัพย์จาก “${sourceName}”`;

  return <Modal isOpen={open} onClose={() => !pending && onClose()} closeDisabled={pending} title={title}>
    {step !== 'done' && <ol className="mb-4 flex flex-wrap gap-2 text-[11px]" aria-label="ขั้นตอนการย้ายสินทรัพย์">
      {(Object.keys(STEP_LABELS) as Exclude<TransferStep, 'done'>[]).map((item) => <li
        key={item}
        aria-current={step === item ? 'step' : undefined}
        className={`rounded-full px-2.5 py-1 ${step === item
          ? 'bg-[var(--accent)] font-bold text-[var(--accent-fg)]'
          : 'border border-[var(--border)] text-[var(--text-muted)]'}`}
      >{STEP_LABELS[item]}</li>)}
    </ol>}

    {loading && <p className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
      <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> กำลังอ่านสินทรัพย์ที่ยังถืออยู่จริง…
    </p>}

    {!loading && step === 'destination' && <div className="space-y-4">
      <p className="text-sm text-[var(--text-muted)]">
        เลือกพอร์ตที่จะรับสินทรัพย์ ระบบแสดงเฉพาะพอร์ตของคุณที่ยังใช้งานอยู่
      </p>
      {destinations.length === 0
        ? <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-muted)]">
          ยังไม่มีพอร์ตปลายทางที่ใช้งานอยู่ กรุณาสร้างพอร์ตใหม่ก่อน
        </p>
        : <div className="grid gap-2" role="radiogroup" aria-label="พอร์ตปลายทาง">
          {destinations.map((item) => <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={destinationId === item.id}
            onClick={() => onDestinationChange(item.id)}
            className={`min-h-14 rounded-xl border px-3 py-2 text-left text-sm ${destinationId === item.id
              ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]'
              : 'border-[var(--border)] text-[var(--text-muted)]'}`}
          >
            <span className="block break-words font-bold text-[var(--text)]">{item.name}</span>
            <span className="mt-0.5 block text-xs">{item.type === 'OPTION' ? 'พอร์ตออปชัน' : item.type === 'STOCK' ? 'พอร์ตหุ้น' : 'Default / Legacy'}</span>
          </button>)}
        </div>}
      {error && <p role="alert" className="text-sm text-[var(--negative)]">{error}</p>}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={onClose}>ยกเลิก</Button>
        <Button className="flex-1" disabled={!destinationId} onClick={() => onStepChange('items')}>
          ถัดไป <ArrowRight aria-hidden="true" size={15} />
        </Button>
      </div>
    </div>}

    {!loading && step === 'items' && assets && <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-[var(--text-muted)]">เลือกได้ทั้งหมดหรือทีละรายการ</p>
        <Button size="sm" variant="outline" onClick={selectAll}>เลือกทั้งหมด</Button>
      </div>

      {assets.equities.length > 0 && <section>
        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">หุ้นที่ยังถืออยู่</h4>
        <div className="mt-2 grid gap-2" data-testid="transfer-equities">
          {assets.equities.map((item) => <AssetRow
            key={item.symbol}
            checked={selection.equities[item.symbol] !== undefined}
            title={item.symbol}
            subtitle={`ถืออยู่ ${item.quantity} หน่วย · ต้นทุน ${money(item.costBasis)}`}
            amount={selection.equities[item.symbol] ?? ''}
            max={item.quantity}
            unit="หน่วย"
            onToggle={() => toggleEquity(item.symbol, item.quantity)}
            onAmount={(value) => setSelection((current) => ({
              ...current,
              equities: { ...current.equities, [item.symbol]: value },
            }))}
          />)}
        </div>
      </section>}

      {assets.options.length > 0 && <section>
        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">ออปชันที่ยังเปิดอยู่</h4>
        <div className="mt-2 grid gap-2" data-testid="transfer-options">
          {assets.options.map((item) => <AssetRow
            key={item.key}
            checked={selection.options[item.key] !== undefined}
            title={item.contractSymbol}
            subtitle={`${item.side === 'long' ? 'Long' : 'Short'} ${item.optionKind === 'call' ? 'Call' : 'Put'} ${item.strikePrice} · หมดอายุ ${item.expirationDate} · เปิดอยู่ ${item.contracts} สัญญา`}
            amount={selection.options[item.key] ?? ''}
            max={item.contracts}
            unit="สัญญา"
            onToggle={() => toggleOption(item.key, item.contracts)}
            onAmount={(value) => setSelection((current) => ({
              ...current,
              options: { ...current.options, [item.key]: value },
            }))}
          />)}
        </div>
      </section>}

      <section>
        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">เงินสด</h4>
        {assets.hasNegativeCash
          ? <p className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-xs text-[var(--warning)]">
            <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
            <span>พอร์ตนี้มียอดเงินสดติดลบ การย้ายสินทรัพย์จะไม่ล้างยอดค้างนี้</span>
          </p>
          : <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              className="form-input max-w-[180px]"
              inputMode="decimal"
              placeholder="0.00"
              value={selection.cash}
              onChange={(event) => setSelection((current) => ({ ...current, cash: event.target.value }))}
              aria-label="จำนวนเงินสดที่จะย้าย (USD)"
              data-testid="transfer-cash-amount"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={assets.transferableCash <= 0}
              onClick={() => setSelection((current) => ({ ...current, cash: String(assets.transferableCash) }))}
            >ทั้งหมด ({money(assets.transferableCash)})</Button>
          </div>}
      </section>

      {assets.equities.length === 0 && assets.options.length === 0 && !assets.hasNegativeCash && assets.transferableCash <= 0
        && <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-muted)]">
          พอร์ตนี้ไม่มีสินทรัพย์ที่ถืออยู่ให้ย้าย
        </p>}

      {error && <p role="alert" className="text-sm text-[var(--negative)]">{error}</p>}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" onClick={() => onStepChange('destination')}>ย้อนกลับ</Button>
        <Button
          className="flex-1"
          disabled={pending || selectedCount === 0}
          onClick={() => onPreview(selection)}
          data-testid="transfer-preview"
        >{pending ? 'กำลังคำนวณ…' : 'ดูตัวอย่าง'}</Button>
      </div>
    </div>}

    {!loading && step === 'preview' && preview && <div className="space-y-4">
      <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs text-[var(--text-muted)]">
        การย้ายไม่ใช่การขายและไม่ส่งคำสั่งซื้อขายจริง ต้นทุน วันที่ได้มา และค่าธรรมเนียมเดิมจะถูกย้ายไปพร้อมสินทรัพย์
      </p>

      <div className="space-y-2" data-testid="transfer-preview-lines">
        {preview.plan.lines.map((line) => <div
          key={`${line.kind}-${line.label}`}
          className="flex items-start justify-between gap-3 rounded-lg border border-[var(--border)] p-3 text-sm"
        >
          <span className="min-w-0">
            <strong className="block break-words text-[var(--text)]">{line.label}</strong>
            <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
              {line.detail}{line.whole ? ' · ย้ายทั้งหมด' : ' · ย้ายบางส่วน'}
            </span>
          </span>
          <span className="shrink-0 text-right font-mono text-xs">
            <span className="block text-[var(--text)]">{money(line.marketValue)}</span>
            <span className="block text-[var(--text-muted)]">ต้นทุน {money(line.costBasis)}</span>
          </span>
        </div>)}
      </div>

      <dl className="grid grid-cols-2 gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs">
        <Fact label={`ออกจาก ${preview.sourceName}`} value={money(preview.plan.movedMarketValue)} />
        <Fact label={`เข้าสู่ ${preview.destinationName}`} value={money(preview.plan.movedMarketValue)} />
        <Fact
          label="เงินสดต้นทางหลังย้าย"
          value={money(preview.sourceCashAfter)}
          tone={preview.sourceCashAfter < 0 ? 'text-[var(--negative)]' : undefined}
        />
        <Fact label="เงินสดปลายทางหลังย้าย" value={money(preview.destinationCashAfter)} />
      </dl>

      {preview.hasNegativeCash && <p className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-xs text-[var(--warning)]">
        <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
        <span>พอร์ตต้นทางมียอดเงินสดติดลบ การย้ายสินทรัพย์จะไม่ล้างยอดค้างนี้</span>
      </p>}

      {error && <p role="alert" className="text-sm text-[var(--negative)]">{error}</p>}
      <div className="flex gap-2">
        <Button variant="outline" className="flex-1" disabled={pending} onClick={() => onStepChange('items')}>ย้อนกลับ</Button>
        <Button
          className="flex-1"
          disabled={pending}
          onClick={onConfirm}
          data-testid="transfer-confirm"
        >{pending ? 'กำลังย้าย…' : 'ยืนยันการย้ายสินทรัพย์'}</Button>
      </div>
    </div>}

    {step === 'done' && <div className="space-y-4">
      <p className="flex items-start gap-2 text-sm text-[var(--text)]">
        <Check aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--positive)]" size={18} />
        <span>ย้ายสินทรัพย์ไปยัง “{completedDestinationName}” สำเร็จ</span>
      </p>
      <div className="flex flex-col gap-2">
        <Button className="w-full" onClick={onOpenDestination}>เปิดพอร์ตปลายทาง</Button>
        <Button variant="danger" className="w-full" onClick={onDeleteSource}>ลบพอร์ตเดิม</Button>
        <Button variant="outline" className="w-full" onClick={onClose}>ปิด</Button>
      </div>
    </div>}
  </Modal>;
}

function AssetRow({ checked, title, subtitle, amount, max, unit, onToggle, onAmount }: {
  checked: boolean;
  title: string;
  subtitle: string;
  amount: string;
  max: number;
  unit: string;
  onToggle: () => void;
  onAmount: (value: string) => void;
}) {
  return <div className={`min-w-0 rounded-xl border p-3 ${checked ? 'border-[var(--accent)]/60 bg-[var(--accent)]/5' : 'border-[var(--border)]'}`}>
    <label className="flex min-w-0 items-start gap-2.5">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-[var(--accent)]"
        checked={checked}
        onChange={onToggle}
      />
      <span className="min-w-0 flex-1">
        <strong className="block break-words text-sm text-[var(--text)]">{title}</strong>
        <span className="mt-0.5 block break-words text-xs text-[var(--text-muted)]">{subtitle}</span>
      </span>
    </label>
    {checked && <div className="mt-2 flex flex-wrap items-center gap-2 pl-7">
      <input
        className="form-input max-w-[140px]"
        inputMode="decimal"
        value={amount}
        onChange={(event) => onAmount(event.target.value)}
        aria-label={`จำนวน${unit}ที่จะย้ายของ ${title}`}
      />
      <span className="text-xs text-[var(--text-muted)]">{unit} · สูงสุด {max}</span>
    </div>}
  </div>;
}

function Fact({ label, value, tone = 'text-[var(--text)]' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0">
    <dt className="break-words text-[var(--text-muted)]">{label}</dt>
    <dd className={`mt-1 break-words font-mono font-semibold ${tone}`}>{value}</dd>
  </div>;
}
