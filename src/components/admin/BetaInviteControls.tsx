'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { UserPlus } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { addBetaInviteAction, revokeBetaInviteAction } from '@/app/admin/beta/actions';

/**
 * Adding and withdrawing an invitation.
 *
 * The form does no cap arithmetic. It could — the count and the cap are both on
 * the page — but two operators inviting at the same moment would each see a count
 * taken before the other's write, and both would pass. The database holds the
 * program row while it counts, which is the only place that check is correct, so
 * the refusal simply arrives as a message.
 */
export function AddBetaInvite({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Input
          type="email"
          value={email}
          disabled={disabled || pending}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="อีเมลของผู้ที่ต้องการเชิญ"
          aria-label="อีเมลผู้ได้รับเชิญ"
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          isLoading={pending}
          disabled={disabled || !email.trim()}
          className="shrink-0"
          onClick={() => {
            setResult(null);
            const formData = new FormData();
            formData.set('email', email.trim());
            startTransition(async () => {
              const outcome = await addBetaInviteAction(formData);
              setResult(outcome);
              if (outcome.ok) { setEmail(''); router.refresh(); }
            });
          }}
        >
          <UserPlus aria-hidden="true" size={16} className="mr-2" />
          เชิญ
        </Button>
      </div>
      {disabled && (
        <p className="text-xs text-[var(--text-muted)]">
          สถานะปัจจุบันไม่รับคำเชิญเพิ่ม เปลี่ยนเป็นรอบทดลองก่อนจึงจะเชิญได้
        </p>
      )}
      {result && (
        <p role="alert" className={`text-sm ${result.ok ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
          {result.message}
        </p>
      )}
    </div>
  );
}

export function RevokeBetaInvite({ inviteId }: { inviteId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        isLoading={pending}
        onClick={() => {
          setError(null);
          const formData = new FormData();
          formData.set('inviteId', inviteId);
          startTransition(async () => {
            const outcome = await revokeBetaInviteAction(formData);
            if (!outcome.ok) { setError(outcome.message); return; }
            router.refresh();
          });
        }}
      >
        ยกเลิกคำเชิญ
      </Button>
      {error && <span role="alert" className="text-xs text-[var(--negative)]">{error}</span>}
    </>
  );
}
