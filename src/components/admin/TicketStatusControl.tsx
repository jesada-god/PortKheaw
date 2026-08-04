'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/src/components/ui/Button';
import { Select } from '@/src/components/ui/Select';
import { adminSetTicketStatusAction } from '@/app/support/actions';
import { TICKET_STATUS_LABEL } from '@/src/lib/support/presentation';
import type { SupportTicketStatus } from '@/src/types/database';

const STATUSES = Object.keys(TICKET_STATUS_LABEL) as SupportTicketStatus[];

/**
 * Moving a ticket.
 *
 * The control offers every status because a ticket queue genuinely needs to go
 * backwards sometimes — reopening a resolved ticket is ordinary. The routine
 * behind it still checks the operator role in the database and writes the audit
 * row, so this select is a convenience over that, not a second authority.
 */
export function TicketStatusControl({
  ticketId,
  current,
}: {
  ticketId: string;
  current: SupportTicketStatus;
}) {
  const router = useRouter();
  const [value, setValue] = useState<SupportTicketStatus>(current);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <div className="min-w-0 flex-1">
          <Select
            aria-label="เปลี่ยนสถานะเรื่อง"
            value={value}
            onChange={(event) => setValue(event.target.value as SupportTicketStatus)}
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>{TICKET_STATUS_LABEL[status]}</option>
            ))}
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          isLoading={pending}
          disabled={value === current}
          className="shrink-0"
          onClick={() => {
            setError(null);
            const formData = new FormData();
            formData.set('ticketId', ticketId);
            formData.set('status', value);
            startTransition(async () => {
              const result = await adminSetTicketStatusAction(formData);
              if (!result.ok) {
                setError(result.message);
                return;
              }
              router.refresh();
            });
          }}
        >
          บันทึกสถานะ
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-[var(--negative)]">{error}</p>}
    </div>
  );
}
