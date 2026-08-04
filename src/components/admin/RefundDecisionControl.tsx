'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Select } from '@/src/components/ui/Select';
import { adminSetRefundStatusAction } from '@/app/settings/refunds/actions';
import {
  REFUND_ADMIN_TRANSITIONS,
  REFUND_STATUS_LABEL,
  refundTransitionNeedsConfirmation,
} from '@/src/lib/support/presentation';
import type { RefundRequestStatus } from '@/src/types/database';

/**
 * Deciding a refund request.
 *
 * The control offers only the transitions the database will accept from the
 * current status, and asks for a completion reference on exactly one of them.
 * That asymmetry is the point of the whole feature: approving is a decision an
 * operator can make from this page, but recording that money moved requires the
 * provider's own reference for a refund performed *there*.
 *
 * Nothing in this component, or in the action behind it, calls the payment
 * provider. There is no button here that issues a refund, by design — an
 * automatic refund path would be a second way to move money, reachable from a
 * browser, guarded by nothing but this page's own gate.
 */
export function RefundDecisionControl({
  requestId,
  current,
}: {
  requestId: string;
  current: RefundRequestStatus;
}) {
  const router = useRouter();
  const allowed = REFUND_ADMIN_TRANSITIONS[current] ?? [];
  const [next, setNext] = useState<RefundRequestStatus | ''>(allowed[0] ?? '');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (allowed.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--border-strong)] px-4 py-3 text-sm text-[var(--text-muted)]">
        คำขอนี้อยู่ในสถานะสุดท้ายแล้ว จึงเปลี่ยนสถานะต่อไม่ได้
      </p>
    );
  }

  const needsReference = next !== '' && refundTransitionNeedsConfirmation(next);

  return (
    <div className="min-w-0 space-y-3">
      <div className="min-w-0 space-y-1.5">
        <label htmlFor="refund-next-status" className="text-sm font-medium text-[var(--text)]">
          เปลี่ยนสถานะเป็น
        </label>
        <Select
          id="refund-next-status"
          value={next}
          onChange={(event) => setNext(event.target.value as RefundRequestStatus)}
        >
          {allowed.map((status) => (
            <option key={status} value={status}>{REFUND_STATUS_LABEL[status]}</option>
          ))}
        </Select>
      </div>

      {needsReference && (
        <div className="min-w-0 space-y-1.5">
          <label htmlFor="refund-reference" className="text-sm font-medium text-[var(--text)]">
            หมายเลขอ้างอิงการคืนเงินจากผู้ให้บริการชำระเงิน
          </label>
          <Input
            id="refund-reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            placeholder="เช่น re_… ที่ได้จากการคืนเงินในระบบผู้ให้บริการ"
            autoComplete="off"
          />
          <p className="text-xs text-[var(--text-muted)]">
            บันทึกสถานะนี้ได้ก็ต่อเมื่อคุณคืนเงินในระบบผู้ให้บริการชำระเงินเรียบร้อยแล้ว
            ระบบนี้ไม่ได้สั่งคืนเงินให้อัตโนมัติ
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-[var(--negative)]">
          <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{error}</span>
        </p>
      )}

      <Button
        type="button"
        isLoading={pending}
        disabled={next === '' || (needsReference && reference.trim().length === 0)}
        onClick={() => {
          setError(null);
          const formData = new FormData();
          formData.set('requestId', requestId);
          formData.set('status', next);
          if (needsReference) formData.set('completionReference', reference.trim());
          startTransition(async () => {
            const result = await adminSetRefundStatusAction(formData);
            if (!result.ok) {
              setError(result.message);
              return;
            }
            setReference('');
            router.refresh();
          });
        }}
      >
        บันทึกการตัดสิน
      </Button>
    </div>
  );
}
