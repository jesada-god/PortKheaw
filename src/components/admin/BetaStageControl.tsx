'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Select } from '@/src/components/ui/Select';
import { setBetaStageAction } from '@/app/admin/beta/actions';
import {
  BETA_STAGE_DESCRIPTION, BETA_STAGE_LABEL, betaStages, capChoices, stageAcceptsCap,
  type BetaStage,
} from '@/src/lib/beta/beta-stages';

/**
 * The one control that changes who may buy.
 *
 * It asks twice, and the second ask is not a formality: moving to `public` opens
 * a product to everybody, and there is no undo that un-charges the people who
 * bought in the meantime. The confirmation copy therefore names the stage being
 * moved to rather than saying "are you sure?", so an operator reads what they are
 * about to do rather than the shape of a dialog.
 *
 * The select offers only cohort sizes inside the chosen stage's band, and the
 * server refuses anything outside it anyway — this control is a convenience over
 * that rule, never a second authority.
 */
export function BetaStageControl({
  currentStage,
  currentCap,
}: {
  currentStage: BetaStage;
  currentCap: number | null;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<BetaStage>(currentStage);
  const [cap, setCap] = useState<string>(currentCap ? String(currentCap) : '');
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const choices = capChoices(stage);
  const unchanged = stage === currentStage
    && (stageAcceptsCap(stage) ? cap === String(currentCap ?? '') : true);

  function submit() {
    setResult(null);
    const formData = new FormData();
    formData.set('stage', stage);
    if (stageAcceptsCap(stage)) formData.set('cap', cap);
    formData.set('confirm', 'yes');
    startTransition(async () => {
      const outcome = await setBetaStageAction(formData);
      setResult(outcome);
      setConfirming(false);
      if (outcome.ok) router.refresh();
    });
  }

  return (
    <div className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
      <div className="min-w-0 space-y-2">
        <label htmlFor="beta-stage" className="block text-sm font-medium text-[var(--text)]">
          สถานะการเปิดใช้งาน
        </label>
        <Select
          id="beta-stage"
          value={stage}
          disabled={pending}
          onChange={(event) => {
            const next = event.target.value as BetaStage;
            setStage(next);
            setCap(stageAcceptsCap(next) ? String(capChoices(next).at(-1) ?? '') : '');
            setConfirming(false);
            setResult(null);
          }}
        >
          {betaStages.map((value) => (
            <option key={value} value={value}>{BETA_STAGE_LABEL[value]}</option>
          ))}
        </Select>
        <p className="text-xs text-[var(--text-muted)]">{BETA_STAGE_DESCRIPTION[stage]}</p>
      </div>

      {choices.length > 0 && (
        <div className="min-w-0 space-y-2">
          <label htmlFor="beta-cap" className="block text-sm font-medium text-[var(--text)]">
            โควตาผู้ได้รับเชิญสูงสุด
          </label>
          <Select
            id="beta-cap"
            value={cap}
            disabled={pending}
            onChange={(event) => { setCap(event.target.value); setConfirming(false); }}
          >
            {choices.map((value) => (
              <option key={value} value={String(value)}>{value} บัญชี</option>
            ))}
          </Select>
        </div>
      )}

      {!confirming && (
        <Button
          type="button"
          variant="outline"
          disabled={unchanged || pending}
          onClick={() => { setConfirming(true); setResult(null); }}
        >
          เปลี่ยนสถานะ
        </Button>
      )}

      {confirming && (
        <div
          role="alertdialog"
          aria-labelledby="beta-confirm-heading"
          className="min-w-0 space-y-2 rounded-xl border border-[var(--border-strong)] p-3"
        >
          <p id="beta-confirm-heading" className="flex items-start gap-2 text-sm text-[var(--text)]">
            <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--negative)]" />
            <span className="min-w-0">
              ยืนยันเปลี่ยนเป็น “{BETA_STAGE_LABEL[stage]}”
              {stageAcceptsCap(stage) && cap ? ` โควตา ${cap} บัญชี` : ''}
              {stage === 'public'
                ? ' — ผู้ใช้ทุกคนจะสมัครแพ็กเกจได้ทันที และการเปลี่ยนนี้จะถูกบันทึกไว้'
                : ' — การเปลี่ยนนี้จะถูกบันทึกไว้'}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" isLoading={pending} onClick={submit}>ยืนยัน</Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
              ยกเลิก
            </Button>
          </div>
        </div>
      )}

      {result && (
        <p role="alert" className={`text-sm ${result.ok ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
          {result.message}
        </p>
      )}
    </div>
  );
}
