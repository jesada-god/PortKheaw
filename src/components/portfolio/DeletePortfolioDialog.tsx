'use client';

import { useId, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, LoaderCircle, Trash2 } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Modal } from '@/src/components/ui/Modal';
import type { PortfolioDeletionSummary } from '@/src/lib/portfolio/transfer/service';

/*
 * The last thing a reader sees before a portfolio leaves the page.
 *
 * Everything it states comes from the server, fetched when it opens rather than
 * read from whatever the page happened to be holding. That is not caution for
 * its own sake: the counts here are the reader's evidence, and a dialog that
 * quotes an hour-old page can tell somebody they are deleting an empty
 * portfolio when they are not.
 */

export interface DeletePortfolioDialogProps {
  open: boolean;
  loading: boolean;
  summary: PortfolioDeletionSummary | null;
  error: string;
  pending: boolean;
  money: (value: number | string | null) => string;
  onClose: () => void;
  onTransferFirst: () => void;
  onConfirm: (confirmName: string) => void;
}

export function DeletePortfolioDialog({
  open,
  loading,
  summary,
  error,
  pending,
  money,
  onClose,
  onTransferFirst,
  onConfirm,
}: DeletePortfolioDialogProps) {
  /*
   * Two steps, and the second one is not shown until the reader has chosen to
   * skip the first. Offering "move my assets" and "type the name to destroy
   * them" side by side would put the safe path and the irreversible one on the
   * same footing.
   *
   * There is no effect resetting these between openings. The caller remounts the
   * dialog with a fresh `key` each time it opens, which is the same thing the
   * value sheet does — and it means a half-typed portfolio name can never
   * survive into a dialog about a different portfolio.
   */
  const [stage, setStage] = useState<'review' | 'confirm'>('review');
  const [typedName, setTypedName] = useState('');
  const nameFieldId = useId();

  const canOfferTransfer = Boolean(summary?.hasTransferableAssets) && (summary?.destinations.length ?? 0) > 0;
  const nameMatches = summary !== null
    && typedName.trim().toLowerCase() === summary.name.trim().toLowerCase();

  return <Modal
    isOpen={open}
    onClose={() => !pending && onClose()}
    closeDisabled={pending}
    title={summary ? `ลบพอร์ต “${summary.name}”?` : 'ลบพอร์ต'}
  >
    {loading || !summary
      ? <p className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
        <LoaderCircle aria-hidden="true" className="animate-spin" size={16} /> กำลังอ่านข้อมูลล่าสุดของพอร์ตนี้…
      </p>
      : <div className="space-y-4">
        <p className="text-sm text-[var(--text)]">
          ข้อมูลการซื้อขาย เงินสด สินทรัพย์ กำไร/ขาดทุน เป้าหมาย และข้อมูลที่เกี่ยวข้องกับพอร์ตนี้จะถูกนำออก
        </p>
        <p className="text-sm text-[var(--text-muted)]">
          ไม่กระทบบัญชี แผนสมาชิก Trial หรือพอร์ตอื่น
        </p>

        <dl className="grid grid-cols-2 gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-xs" data-testid="delete-portfolio-facts">
          <Fact label="มูลค่าปัจจุบัน" value={money(summary.totalValue)} />
          <Fact
            label="เงินสด"
            value={money(summary.cashBalance)}
            tone={summary.hasNegativeCash ? 'text-[var(--negative)]' : undefined}
          />
          <Fact label="หุ้นที่ยังถืออยู่" value={`${summary.openHoldings} รายการ`} />
          <Fact label="ออปชันที่ยังเปิดอยู่" value={`${summary.openOptionPositions} สัญญา`} />
          <Fact label="ธุรกรรมทั้งหมด" value={`${summary.transactionCount} รายการ`} />
          <Fact label="ประเภทพอร์ต" value={summary.type === 'OPTION' ? 'พอร์ตออปชัน' : summary.type === 'STOCK' ? 'พอร์ตหุ้น' : 'Default / Legacy'} />
        </dl>

        {summary.hasNegativeCash && <Notice tone="warning">
          พอร์ตนี้มียอดเงินสดติดลบ {money(summary.cashBalance)} การลบพอร์ตจะไม่ล้างยอดค้างนี้ และการย้ายสินทรัพย์ก็ไม่ล้างเช่นกัน
        </Notice>}

        {summary.isLastActive && <Notice tone="danger">
          นี่คือพอร์ตที่ใช้งานอยู่พอร์ตสุดท้าย กรุณาสร้างพอร์ตใหม่ก่อนแล้วจึงลบพอร์ตนี้
        </Notice>}

        {/*
          The Basic tier writes to exactly one stock portfolio and picks it by
          age, so deleting the current one silently hands the role to another.
          Saying which one takes over is the difference between a mechanism and
          a surprise.
        */}
        {summary.replacementWritableName && <Notice tone="info">
          หลังลบพอร์ตนี้ ระบบจะใช้ “{summary.replacementWritableName}” เป็นพอร์ตหุ้นหลักแทนโดยอัตโนมัติ
        </Notice>}

        {!summary.hasTransferableAssets && <Notice tone="info">
          พอร์ตนี้ไม่มีสินทรัพย์ที่ถืออยู่ แต่ยังมีประวัติธุรกรรม {summary.transactionCount} รายการ ซึ่งจะถูกลบพร้อมพอร์ต
        </Notice>}

        {stage === 'confirm' && <div className="space-y-2">
          <label htmlFor={nameFieldId} className="block text-sm font-semibold text-[var(--text)]">
            พิมพ์ชื่อพอร์ต “{summary.name}” เพื่อยืนยัน
          </label>
          <input
            id={nameFieldId}
            className="form-input"
            autoComplete="off"
            value={typedName}
            disabled={pending}
            onChange={(event) => setTypedName(event.target.value)}
            data-testid="delete-portfolio-name-input"
          />
          <p className="text-xs text-[var(--text-muted)]">ลบแล้วกู้คืนได้ภายใน 7 วัน หลังจากนั้นข้อมูลจะถูกลบถาวร</p>
        </div>}

        {error && <p role="alert" className="text-sm text-[var(--negative)]">{error}</p>}

        <div className="flex flex-col gap-2">
          {stage === 'review'
            ? <>
              {canOfferTransfer && <Button
                className="w-full"
                disabled={pending}
                onClick={onTransferFirst}
                data-testid="delete-portfolio-transfer-first"
              ><ArrowRightLeft aria-hidden="true" size={16} /> ย้ายสินทรัพย์ก่อน</Button>}
              <Button
                variant="danger"
                className="w-full"
                disabled={pending || summary.isLastActive || summary.isLegacy}
                onClick={() => setStage('confirm')}
                data-testid="delete-portfolio-continue"
              ><Trash2 aria-hidden="true" size={16} /> ลบพร้อมข้อมูลทั้งหมด</Button>
              <Button variant="outline" className="w-full" disabled={pending} onClick={onClose}>ยกเลิก</Button>
            </>
            : <>
              <Button
                variant="danger"
                className="w-full"
                disabled={pending || !nameMatches || summary.isLastActive}
                onClick={() => onConfirm(typedName.trim())}
                data-testid="delete-portfolio-confirm"
              >{pending ? 'กำลังลบ…' : 'ลบพอร์ตนี้'}</Button>
              <Button variant="outline" className="w-full" disabled={pending} onClick={() => setStage('review')}>ย้อนกลับ</Button>
            </>}
        </div>
      </div>}
  </Modal>;
}

function Fact({ label, value, tone = 'text-[var(--text)]' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0">
    <dt className="text-[var(--text-muted)]">{label}</dt>
    <dd className={`mt-1 break-words font-mono font-semibold ${tone}`}>{value}</dd>
  </div>;
}

function Notice({ tone, children }: { tone: 'info' | 'warning' | 'danger'; children: React.ReactNode }) {
  const toneClass = tone === 'danger'
    ? 'border-[var(--negative)]/40 bg-[var(--negative)]/10 text-[var(--negative)]'
    : tone === 'warning'
      ? 'border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]'
      : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]';
  return <p className={`flex items-start gap-2 rounded-lg border p-3 text-xs ${toneClass}`}>
    {tone !== 'info' && <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={14} />}
    <span className="min-w-0">{children}</span>
  </p>;
}
