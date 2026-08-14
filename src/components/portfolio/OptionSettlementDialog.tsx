'use client';

import { useMemo, useRef, useState, type FormEvent } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import {
  OPTION_EXPIRY_ITM_WARNING,
  OPTION_SETTLEMENT_TITLE,
  optionSettlementSubject,
  planOptionSettlement,
  type OptionSettlementAction,
} from '@/src/lib/portfolio/options/settlement';
import { optionPositionDescription, optionPositionTitle } from '@/src/lib/portfolio/options/presentation';
import type { OptionPositionSummary } from '@/src/lib/portfolio/options/types';
import {
  maximumTransactionDateTimeLocal,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { Field } from './FormControls';

/**
 * ใช้สิทธิ์ / หมดอายุ, as one short confirmation instead of a whole form.
 *
 * Both actions used to reopen "เพิ่มรายการออปชัน" — sixteen fields, every one of
 * them already known from the position that was clicked, and the reader was
 * asked to retype the strike, the expiry, the multiplier and the side of a
 * contract sitting three inches above the button. Retyping them is not just
 * tedious: a mistyped strike writes a settlement against a contract the reader
 * does not hold.
 *
 * So the contract identity is not editable here at all. It is read from the
 * position summary, shown once as a summary card, and sent to the server as a
 * position key that the server resolves against the ledger itself. What is left
 * is what genuinely varies: how many contracts, when, and an optional note.
 *
 * The preview under them is a preview and says so. It comes from
 * `planOptionSettlement`, the same function the server action authorises with,
 * so the sentence here and the rule there cannot disagree — but the server runs
 * it again over fresh ledger state at the moment of writing, because cash and
 * shares can move between opening this dialog and confirming it.
 */

export interface OptionSettlementSubmission {
  action: OptionSettlementAction;
  contracts: number;
  occurredAt: string;
  note: string;
}

function money(value: number) {
  return `$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shares(value: number) {
  return value.toLocaleString('th-TH', { maximumFractionDigits: 8 });
}

export function OptionSettlementDialog({
  action,
  position,
  cashBalance,
  underlyingShares,
  timezone,
  defaultOccurredAt,
  pending,
  serverError,
  onClose,
  onSubmit,
}: {
  action: OptionSettlementAction | null;
  position: OptionPositionSummary | null;
  /** The portfolio's cash, straight off the ledger summary this page computed. */
  cashBalance: number;
  /** Shares of the underlying in that same portfolio, likewise from the ledger. */
  underlyingShares: number;
  timezone: string;
  defaultOccurredAt: string;
  pending: boolean;
  serverError: string;
  onClose: () => void;
  onSubmit: (submission: OptionSettlementSubmission) => void;
}) {
  const open = Boolean(action && position);
  return open
    ? <SettlementForm
      key={`${action}-${position!.key}`}
      action={action!}
      position={position!}
      cashBalance={cashBalance}
      underlyingShares={underlyingShares}
      timezone={timezone}
      defaultOccurredAt={defaultOccurredAt}
      pending={pending}
      serverError={serverError}
      onClose={onClose}
      onSubmit={onSubmit}
    />
    : null;
}

function SettlementForm({
  action, position, cashBalance, underlyingShares, timezone, defaultOccurredAt,
  pending, serverError, onClose, onSubmit,
}: {
  action: OptionSettlementAction;
  position: OptionPositionSummary;
  cashBalance: number;
  underlyingShares: number;
  timezone: string;
  defaultOccurredAt: string;
  pending: boolean;
  serverError: string;
  onClose: () => void;
  onSubmit: (submission: OptionSettlementSubmission) => void;
}) {
  const firstRef = useRef<HTMLInputElement>(null);
  const [contracts, setContracts] = useState(String(position.contracts));
  const [occurredAt, setOccurredAt] = useState(defaultOccurredAt);
  const [note, setNote] = useState('');
  const [dateError, setDateError] = useState('');

  const requested = Number(contracts);
  const outcome = useMemo(() => planOptionSettlement({
    action,
    subject: optionSettlementSubject(position),
    contracts: Number.isInteger(requested) ? requested : Number.NaN,
    cashBalance,
    underlyingShares,
  }), [action, cashBalance, position, requested, underlyingShares]);
  const plan = outcome.ok ? outcome.plan : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !plan) return;
    const validated = validateTransactionDateTime(occurredAt, timezone);
    if (!validated.ok) { setDateError(validated.message); return; }
    setDateError('');
    onSubmit({ action, contracts: plan.contracts, occurredAt, note });
  }

  const call = position.optionKind === 'call';
  return <Modal
    isOpen
    onClose={() => { if (!pending) onClose(); }}
    initialFocusRef={firstRef}
    title={OPTION_SETTLEMENT_TITLE[action]}
    className="max-w-md"
  >
    <form className="min-w-0 space-y-4" data-testid={`option-settlement-form-${action}`} onSubmit={submit}>
      <section className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3.5" data-testid="option-settlement-summary">
        <p className="break-words text-sm font-bold text-[var(--text)]">
          {optionPositionTitle(position)}
        </p>
        <p className="mt-1 break-words text-xs text-[var(--text-muted)]">
          {optionPositionDescription(position)}
        </p>
        <p className="mt-1 break-words text-xs text-[var(--text-muted)]">
          ถืออยู่ {position.contracts} สัญญา · {position.multiplier} หุ้น/สัญญา
        </p>
      </section>

      <Field
        label="จำนวนสัญญาที่ต้องการทำรายการ"
        error={outcome.ok ? undefined : outcome.message}
        helper={`ทำได้สูงสุด ${position.contracts} สัญญา`}
      >
        <input
          ref={firstRef}
          type="number"
          inputMode="numeric"
          min={1}
          max={position.contracts}
          step={1}
          className="form-input"
          data-testid="option-settlement-contracts"
          value={contracts}
          onChange={(event) => setContracts(event.target.value)}
        />
      </Field>

      <Field label="วันและเวลารายการ" error={dateError}>
        <input
          type="datetime-local"
          className="form-input"
          value={occurredAt.slice(0, 16)}
          max={maximumTransactionDateTimeLocal(timezone)}
          onChange={(event) => { setOccurredAt(event.target.value); setDateError(''); }}
        />
      </Field>

      <Field label="หมายเหตุ (ไม่บังคับ)">
        <textarea
          className="form-input h-auto py-3"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      {plan && <section
        className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3.5 text-sm text-[var(--text-secondary)]"
        data-testid="option-settlement-preview"
      >
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">สิ่งที่จะเกิดขึ้น</p>
        {action === 'exercise'
          ? <ul className="mt-2 space-y-1.5">
            <li className="break-words">
              {call
                ? `คุณจะได้รับ ${position.underlyingSymbol} ${shares(plan.shares)} หุ้น`
                : `คุณจะขาย ${position.underlyingSymbol} ${shares(plan.shares)} หุ้นที่ $${position.strikePrice}`}
            </li>
            <li className="break-words">
              เงินสดจะ{call ? 'ลดลง' : 'เพิ่มขึ้น'}ประมาณ <strong className="font-mono">{money(plan.cashDelta)}</strong>
            </li>
            <li className="break-words text-xs text-[var(--text-muted)]">
              เงินสดหลังรายการประมาณ <span className="font-mono">{money(plan.cashAfter)}</span>
              {' · '}
              สัญญาคงเหลือ {plan.contractsRemaining} สัญญา
            </li>
          </ul>
          : <ul className="mt-2 space-y-1.5">
            <li className="break-words">ปิดสัญญา {plan.contracts} สัญญา โดยไม่ใช้สิทธิ์</li>
            <li className="break-words">ไม่มีเงินสดเข้าหรือออกจากรายการนี้</li>
            <li className="break-words text-xs text-[var(--text-muted)]">สัญญาคงเหลือ {plan.contractsRemaining} สัญญา</li>
          </ul>}
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          ตัวเลขนี้เป็นการประมาณจาก Ledger ล่าสุด ระบบจะตรวจสอบอีกครั้งตอนบันทึก
        </p>
      </section>}

      {plan?.inTheMoneyWarning && <p
        role="alert"
        data-testid="option-settlement-itm-warning"
        className="flex min-w-0 items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] p-3 text-xs text-[var(--warning)]"
      >
        <TriangleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{OPTION_EXPIRY_ITM_WARNING}</span>
      </p>}

      {action === 'expired' && <p className="text-xs text-[var(--text-muted)]">
        ยืนยันให้สัญญานี้หมดอายุโดยไม่ใช้สิทธิ์? ระบบจะบันทึกเฉพาะการปิดสัญญา และไม่สร้างรายการหุ้นหรือเงินสดให้อัตโนมัติ
      </p>}

      {serverError && <p role="alert" className="break-words text-xs text-[var(--negative)]">{serverError}</p>}

      <div className="sticky bottom-0 flex gap-2 bg-[var(--surface)] py-2">
        <Button type="button" variant="outline" className="flex-1" disabled={pending} onClick={onClose}>ยกเลิก</Button>
        <Button type="submit" className="flex-1" disabled={pending || !plan} data-testid="option-settlement-confirm">
          {pending ? 'กำลังบันทึก…' : action === 'exercise' ? 'ยืนยันใช้สิทธิ์' : 'ยืนยันหมดอายุ'}
        </Button>
      </div>
    </form>
  </Modal>;
}
