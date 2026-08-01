'use client';

import { useRef, type FormEvent } from 'react';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import type {
  PortfolioTransaction,
  PortfolioTransactionType,
  PortfolioType,
} from '@/src/lib/portfolio/types';
import { DecimalInput, Field } from './FormControls';
import { SymbolPreview } from './SymbolPreview';
import { estimateCashAfterTransaction } from '@/src/lib/portfolio/cash-preview';
import { maximumTransactionDateTimeLocal } from '@/src/lib/portfolio/transaction-datetime';

export interface TransactionFormState {
  portfolioId: string;
  type: PortfolioTransactionType;
  symbol: string;
  quantity: string;
  price: string;
  amount: string;
  fee: string;
  originalCurrency: 'USD' | 'THB';
  fxRateAtTransaction: string;
  occurredAt: string;
  timezone: string;
  broker: string;
  note: string;
  underlyingSymbol: string;
  contractSymbol: string;
  optionKind: 'call' | 'put';
  optionSide: 'long' | 'short';
  strikePrice: string;
  expirationDate: string;
  multiplier: string;
  idempotencyKey: string;
}

export const transactionLabels: Record<PortfolioTransactionType, string> = {
  acquisition: 'ซื้อหุ้น / ETF',
  disposal: 'ขายหุ้น / ETF',
  initial_position: 'นำเข้าสถานะตั้งต้น',
  dividend: 'รับเงินปันผล (Dividend)',
  deposit: 'ฝากเงิน',
  withdrawal: 'ถอนเงิน',
  fee: 'ค่าธรรมเนียม',
  adjustment: 'ปรับยอดเงินสด',
  transfer_out: 'ย้ายเงินออก',
  transfer_in: 'รับเงินโอนระหว่างพอร์ต',
  buy_to_open: 'Buy to Open',
  sell_to_close: 'Sell to Close',
  sell_to_open: 'Sell to Open',
  buy_to_close: 'Buy to Close',
  exercise: 'Exercise',
  assignment: 'Assignment',
  expired: 'Expired',
};

const selectableTypes: PortfolioTransactionType[] = [
  'acquisition', 'disposal', 'initial_position', 'deposit', 'withdrawal', 'dividend', 'fee', 'adjustment',
];

const helpers: Partial<Record<PortfolioTransactionType, string>> = {
  acquisition: 'เพิ่มจำนวนหุ้นและหักเงินสด รวมค่าธรรมเนียมเข้าในต้นทุน',
  disposal: 'ลดจำนวนหุ้น รับเงินสดหลังหักค่าธรรมเนียม และคำนวณกำไรที่รับรู้',
  initial_position: 'นำเข้าจำนวน ต้นทุนเฉลี่ย และเงินสดตั้งต้น โดยไม่สร้างกำไรในวันนำเข้า',
  dividend: 'เพิ่มเงินสดและนับเป็นกำไรที่รับรู้',
  deposit: 'เพิ่มเงินสดและเงินฝากสุทธิ แต่ไม่ใช่กำไร',
  withdrawal: 'ลดเงินสดและเงินฝากสุทธิ แต่ไม่ใช่ขาดทุน',
  fee: 'หักค่าใช้จ่ายที่เกิดขึ้นแล้วออกจากเงินสด',
  adjustment: 'ปรับยอดเพื่อแก้ข้อมูลย้อนหลัง จำนวนบวกเพิ่มเงินสด จำนวนลบลดเงินสด และไม่สร้าง P&L',
};

export function TransactionFormModal({ open, editing, form, errors, pending, portfolios, cashByPortfolioId, replacedTransaction, onChange, onClose, onSubmit }: {
  open: boolean;
  editing: boolean;
  form: TransactionFormState;
  errors: Record<string, string>;
  pending: boolean;
  portfolios: Array<{ id: string; name: string; type: PortfolioType }>;
  cashByPortfolioId: Record<string, number>;
  replacedTransaction?: PortfolioTransaction | null;
  onChange: (name: keyof TransactionFormState, value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const assetType = form.type === 'acquisition' || form.type === 'disposal' || form.type === 'initial_position';
  const signedAmount = form.type === 'adjustment';
  const cashAfter = estimateCashAfterTransaction(cashByPortfolioId[form.portfolioId] ?? 0, form, replacedTransaction);
  const destinationType = portfolios.find((portfolio) => portfolio.id === form.portfolioId)?.type ?? 'LEGACY';
  const allowedTypes = destinationType === 'OPTION'
    ? (['deposit', 'withdrawal', 'fee', 'adjustment'] as PortfolioTransactionType[])
    : selectableTypes;
  const visibleTypes = editing && !allowedTypes.includes(form.type) ? [form.type, ...allowedTypes] : allowedTypes;
  return <Modal
    isOpen={open}
    onClose={onClose}
    initialFocusRef={firstFieldRef}
    title={editing ? 'แก้ไขรายการใน Transaction Ledger' : 'เพิ่มรายการใน Transaction Ledger'}
    className="scroll-pb-40"
  >
    <form onSubmit={onSubmit} className="space-y-4 pb-2">
      <Field label="พอร์ตปลายทาง" error={errors.portfolioId} helper={editing ? 'รายการเดิมเปลี่ยนพอร์ตไม่ได้ เพื่อรักษา audit trail' : 'รายการนี้จะบันทึกใน Transaction Ledger ของพอร์ตที่เลือกเท่านั้น'}>
        <select
          ref={firstFieldRef}
          value={form.portfolioId}
          disabled={editing}
          onChange={(event) => {
            const nextId = event.target.value;
            const nextType = portfolios.find((portfolio) => portfolio.id === nextId)?.type;
            onChange('portfolioId', nextId);
            if (nextType === 'OPTION' && !['deposit', 'withdrawal', 'fee', 'adjustment'].includes(form.type)) onChange('type', 'deposit');
          }}
          className="form-input min-h-12"
        >
          {portfolios.map((portfolio) => <option key={portfolio.id} value={portfolio.id}>{portfolio.name}</option>)}
        </select>
      </Field>
      <p className="rounded-lg bg-slate-950/50 p-3 text-xs text-slate-400">
        ใช้บันทึกรายการที่เกิดขึ้นแล้วเท่านั้น ระบบนี้ไม่เชื่อมต่อและไม่ส่งคำสั่งไปยังตลาดหรือโบรกเกอร์
      </p>
      <Field label="ประเภทรายการ" error={errors.type} helper={helpers[form.type]}>
        <select value={form.type} onChange={(event) => onChange('type', event.target.value)} className="form-input min-h-12">
          {visibleTypes.map((value) => <option key={value} value={value}>{transactionLabels[value]}</option>)}
        </select>
      </Field>

      {assetType ? <div className="grid gap-4 sm:grid-cols-2">
        <SymbolPreview value={form.symbol} onChange={(value) => onChange('symbol', value)} error={errors.symbol} />
        <Field label="จำนวน (Quantity)" error={errors.quantity}>
          <DecimalInput value={form.quantity} onChange={(value) => onChange('quantity', value)} />
        </Field>
        <Field label={`ราคา / ต้นทุนเฉลี่ยต่อหน่วย (${form.originalCurrency})`} error={errors.price}>
          <DecimalInput value={form.price} onChange={(value) => onChange('price', value)} />
        </Field>
        <Field label={`ค่าธรรมเนียม (${form.originalCurrency})`} error={errors.fee}>
          <DecimalInput value={form.fee} onChange={(value) => onChange('fee', value)} placeholder="0.00" />
        </Field>
        {form.type === 'initial_position' && <Field label={`เงินสดตั้งต้น (${form.originalCurrency})`} error={errors.amount} helper="ใส่ 0 ได้ หากต้องการนำเข้าเฉพาะสถานะหุ้น">
          <DecimalInput value={form.amount} onChange={(value) => onChange('amount', value)} placeholder="0.00" />
        </Field>}
      </div> : <Field label={`จำนวนเงิน (${form.originalCurrency})`} error={errors.amount}>
        <DecimalInput value={form.amount} onChange={(value) => onChange('amount', value)} signed={signedAmount} />
      </Field>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="สกุลเงินต้นฉบับ" error={errors.originalCurrency}>
          <select value={form.originalCurrency} onChange={(event) => onChange('originalCurrency', event.target.value)} className="form-input">
            <option value="USD">USD ($)</option>
            <option value="THB">THB (฿)</option>
          </select>
        </Field>
        {form.originalCurrency === 'THB' && <Field label="อัตรา USD/THB ณ เวลารายการ" error={errors.fxRateAtTransaction} helper="จำนวน THB ต่อ 1 USD เก็บไว้กับรายการต้นฉบับ">
          <DecimalInput value={form.fxRateAtTransaction} onChange={(value) => onChange('fxRateAtTransaction', value)} />
        </Field>}
        <div className={form.originalCurrency === 'THB' ? 'sm:col-span-2' : undefined}>
          <Field label="วันและเวลาที่เกิดรายการ" error={errors.occurredAt}>
          <input type="datetime-local" value={form.occurredAt.slice(0, 16)} max={maximumTransactionDateTimeLocal(form.timezone)} onChange={(event) => onChange('occurredAt', event.target.value)} className="form-input" />
          </Field>
        </div>
      </div>
      <Field label="หมายเหตุ (ไม่บังคับ)" error={errors.note}>
        <textarea value={form.note} onChange={(event) => onChange('note', event.target.value)} maxLength={500} rows={3} className="form-input h-auto py-3" />
      </Field>
      <div className={`rounded-xl border p-3 text-sm ${cashAfter !== null && cashAfter < 0 ? 'border-amber-500/40 bg-amber-500/10 text-amber-200' : 'border-slate-800 bg-slate-950/50 text-slate-300'}`}>
        <p>เงินสดหลังรายการ: <strong className="font-mono">{cashAfter === null ? 'คำนวณไม่ได้จนกว่าข้อมูลจำนวนเงินจะครบ' : `$${cashAfter.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</strong></p>
        {cashAfter !== null && cashAfter < 0 && <p className="mt-1 text-xs">เงินสดติดลบ โปรดตรวจเงินฝากย้อนหลังหรือสถานะ Margin</p>}
      </div>
      <div className="sticky bottom-0 -mx-1 flex gap-2 bg-[#151B28] px-1 pb-[max(.25rem,env(safe-area-inset-bottom))] pt-2">
        <Button type="button" variant="outline" className="flex-1" disabled={pending} onClick={onClose}>ยกเลิก</Button>
        <Button type="submit" className="flex-1" disabled={pending}>{pending ? 'กำลังบันทึก…' : 'บันทึกรายการ'}</Button>
      </div>
    </form>
  </Modal>;
}
