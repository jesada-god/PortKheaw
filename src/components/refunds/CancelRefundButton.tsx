'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/src/components/ui/Button';
import { cancelRefundRequestAction } from '@/app/settings/refunds/actions';

/**
 * Withdrawing your own request.
 *
 * Two presses rather than a modal: the first arms, the second commits, and the
 * armed state says plainly what happens. It is a small, reversible action — the
 * reader can simply file again — so a dialog would be heavier than the decision
 * deserves, but a single unguarded press next to a status is easy to hit by
 * accident on a phone.
 */
export function CancelRefundButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="min-w-0 space-y-2">
      <Button
        type="button"
        variant={armed ? 'danger' : 'outline'}
        size="sm"
        isLoading={pending}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          setError(null);
          const formData = new FormData();
          formData.set('requestId', requestId);
          startTransition(async () => {
            const result = await cancelRefundRequestAction(formData);
            if (!result.ok) {
              setError(result.message);
              setArmed(false);
              return;
            }
            router.refresh();
          });
        }}
        onBlur={() => setArmed(false)}
      >
        {armed ? 'กดอีกครั้งเพื่อยืนยันการยกเลิกคำขอ' : 'ยกเลิกคำขอนี้'}
      </Button>
      {error && <p role="alert" className="text-sm text-[var(--negative)]">{error}</p>}
    </div>
  );
}
