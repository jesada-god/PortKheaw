'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { Info } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import { DecimalInput, Field } from './FormControls';
import {
  planPortfolioReconciliation,
  RECONCILIATION_NOTE_PRESETS,
  type PortfolioReconciliationResult,
} from '@/src/lib/portfolio/reconciliation';
import { formatPortfolioMoney } from '@/src/lib/portfolio/presentation';
import {
  currentDateTimeLocal,
  maximumTransactionDateTimeLocal,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { fixed, fixedDivide, fixedToNumber } from '@/src/lib/money/fixed';
import type { PortfolioRecord, PortfolioSummary } from '@/src/lib/portfolio/types';
import type { SupportedCurrency } from '@/src/lib/market-data/fx/types';

export interface PortfolioValueSubmission {
  portfolioId: string;
  targetValue: number;
  currency: SupportedCurrency;
  occurredAt: string;
  timezone: string;
  note: string;
  idempotencyKey: string;
}

/**
 * "ปรับยอดพอร์ต" — reconcile a portfolio to a total the owner already knows.
 *
 * The sheet never edits a total directly. It previews the one external cash
 * flow that would land on the wanted total, using the same planner the server
 * re-runs before it writes; the server's answer is the one that counts.
 */
export function PortfolioValueSheet({
  open,
  portfolios,
  summaries,
  defaultPortfolioId,
  currency,
  usdThbRate,
  timezone,
  pending,
  isOnline,
  error,
  idempotencyKey,
  onClose,
  onSubmit,
}: {
  open: boolean;
  portfolios: PortfolioRecord[];
  summaries: Record<string, PortfolioSummary>;
  defaultPortfolioId: string;
  currency: SupportedCurrency;
  usdThbRate: string | null;
  timezone: string;
  pending: boolean;
  isOnline: boolean;
  error: string;
  /**
   * Stable for as long as this sheet is open. Resubmitting the same key is a
   * no-op in the ledger, which is what makes a double tap harmless; the parent
   * mints a new one — and remounts this sheet — on every opening.
   */
  idempotencyKey: string;
  onClose: () => void;
  onSubmit: (submission: PortfolioValueSubmission) => void;
}) {
  const [portfolioId, setPortfolioId] = useState(defaultPortfolioId);
  const [targetValue, setTargetValue] = useState('');
  const [occurredAt, setOccurredAt] = useState(() => currentDateTimeLocal(timezone));
  const [note, setNote] = useState('');
  const [dateError, setDateError] = useState('');

  const portfolio = portfolios.find((item) => item.id === portfolioId) ?? portfolios[0];
  const summary = portfolio ? summaries[portfolio.id] : undefined;
  const money = (value: number | null) => value === null
    ? '—'
    : formatPortfolioMoney(value, currency, usdThbRate, true);

  const targetUsd = useMemo(() => {
    const parsed = Number(targetValue);
    if (targetValue.trim() === '' || !Number.isFinite(parsed)) return null;
    if (currency === 'USD') return parsed;
    if (!usdThbRate) return null;
    return fixedToNumber(fixedDivide(fixed(parsed), fixed(usdThbRate)));
  }, [currency, targetValue, usdThbRate]);

  const preview: PortfolioReconciliationResult | null = summary && targetUsd !== null
    ? planPortfolioReconciliation({
      currentTotalUsd: summary.totalValue,
      cashBalanceUsd: summary.cashBalance,
      targetTotalUsd: targetUsd,
    })
    : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !isOnline || !portfolio || targetUsd === null) return;
    const dateTime = validateTransactionDateTime(occurredAt, timezone);
    if (!dateTime.ok) {
      setDateError(dateTime.message);
      return;
    }
    setDateError('');
    onSubmit({
      portfolioId: portfolio.id,
      targetValue: Number(targetValue),
      currency,
      occurredAt,
      timezone,
      note,
      idempotencyKey,
    });
  }

  return <Modal
    isOpen={open}
    onClose={() => !pending && onClose()}
    title="ปรับยอดพอร์ต"
    className="scroll-pb-40"
  >
    <form className="space-y-4 pb-2" onSubmit={submit} data-testid="portfolio-value-sheet">
      <p className="flex gap-2 rounded-lg bg-slate-950/50 p-3 text-xs leading-relaxed text-slate-400">
        <Info aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
        <span>
          มูลค่าพอร์ตรวมมาจาก เงินสด + มูลค่าตลาดของสินทรัพย์ ระบบจึงไม่แก้ตัวเลขนี้โดยตรง
          แต่จะบันทึกรายการฝากหรือถอนเงินใน Transaction Ledger ให้ยอดรวมตรงตามที่ต้องการ
        </span>
      </p>

      {portfolios.length > 1 && <Field label="พอร์ตที่ต้องการปรับยอด">
        <select className="form-input min-h-12" value={portfolio?.id ?? ''} onChange={(event) => setPortfolioId(event.target.value)}>
          {portfolios.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </Field>}

      <Field
        label={`มูลค่าพอร์ตรวมที่ต้องการ (${currency})`}
        helper={currency === 'THB' ? 'ระบบจะแปลงเป็น USD ซึ่งเป็นสกุลเงินหลักของ Ledger ด้วยอัตราจากเซิร์ฟเวอร์' : undefined}
      >
        <DecimalInput value={targetValue} onChange={setTargetValue} placeholder="0.00" />
      </Field>

      <Field label="วันและเวลาที่ปรับยอด" error={dateError}>
        <input
          type="datetime-local"
          className="form-input"
          max={maximumTransactionDateTimeLocal(timezone)}
          value={occurredAt.slice(0, 16)}
          onChange={(event) => { setOccurredAt(event.target.value); setDateError(''); }}
        />
      </Field>

      <div className="flex flex-wrap gap-2" role="group" aria-label="เหตุผลที่ใช้บ่อย">
        {RECONCILIATION_NOTE_PRESETS.map((preset) => <button
          key={preset}
          type="button"
          aria-pressed={note === preset}
          onClick={() => setNote(note === preset ? '' : preset)}
          className={`min-h-9 rounded-full border px-3 text-xs font-semibold ${note === preset ? 'border-[#D4FF00] bg-[#D4FF00]/10 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}
        >{preset}</button>)}
      </div>
      <Field label="หมายเหตุ / เหตุผล (ไม่บังคับ)">
        <textarea
          className="form-input h-auto py-3"
          maxLength={500}
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      {portfolio?.isLegacy && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
        พอร์ต Default / Legacy: การปรับยอดนี้เพิ่มหรือลดเงินสดเท่านั้น ไม่ได้เปลี่ยนต้นทุนหรือจำนวนสินทรัพย์ที่นำเข้ามา
      </p>}

      <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3" data-testid="portfolio-value-preview">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <PreviewRow label="มูลค่าปัจจุบัน" value={money(summary?.totalValue ?? null)} />
          <PreviewRow
            label="มูลค่าใหม่"
            value={preview?.ok ? money(preview.targetTotalUsd) : '—'}
          />
          <PreviewRow
            label="ส่วนต่าง"
            value={preview?.ok ? `${preview.deltaUsd > 0 ? '+' : '−'}${money(Math.abs(preview.deltaUsd))}` : '—'}
            tone={preview?.ok ? (preview.deltaUsd > 0 ? 'text-positive' : 'text-negative') : undefined}
          />
          <PreviewRow
            label="จะบันทึกเป็น"
            value={preview?.ok ? (preview.type === 'deposit' ? 'ฝากเงินเข้าพอร์ต' : 'ถอนเงินออกจากพอร์ต') : '—'}
          />
          <PreviewRow label="เงินสดก่อนปรับ" value={money(summary?.cashBalance ?? null)} />
          <PreviewRow
            label="เงินสดหลังปรับ"
            value={preview?.ok ? money(preview.cashAfterUsd) : '—'}
          />
        </dl>
        <p className="mt-3 text-xs text-slate-400">
          จำนวนหุ้น จำนวนสัญญา และต้นทุนของสินทรัพย์ที่ถืออยู่จะไม่เปลี่ยนแปลง
          และเงินเข้า–ออกนี้ไม่ถูกนับเป็นกำไรหรือขาดทุน
        </p>
      </div>

      {preview && !preview.ok && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
        {preview.message}
        {preview.code === 'insufficient-cash' && preview.maxWithdrawableUsd !== undefined && <span className="mt-1 block text-xs">
          ตอนนี้ถอนได้สูงสุด {money(preview.maxWithdrawableUsd)} ทำให้ยอดต่ำสุดที่ปรับได้คือ {money(preview.minimumTotalUsd ?? null)}
          {' '}หากต้องการต่ำกว่านี้ ให้แก้รายการหรือสถานะที่เกี่ยวข้องใน Transaction Ledger แทน
        </span>}
      </p>}

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

      <div className="sticky bottom-0 -mx-1 flex gap-2 bg-[#151B28] px-1 pb-[max(.25rem,env(safe-area-inset-bottom))] pt-2">
        <Button type="button" variant="outline" className="flex-1" disabled={pending} onClick={onClose}>ยกเลิก</Button>
        <Button type="submit" className="flex-1" disabled={pending || !isOnline || !preview?.ok}>
          {pending ? 'กำลังบันทึก…' : 'ยืนยันการปรับยอด'}
        </Button>
      </div>
    </form>
  </Modal>;
}

function PreviewRow({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0">
    <dt className="text-xs text-slate-500">{label}</dt>
    <dd className={`mt-0.5 break-words font-mono font-semibold ${tone}`}>{value}</dd>
  </div>;
}
