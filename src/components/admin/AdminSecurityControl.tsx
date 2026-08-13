'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { createClient } from '@/src/lib/supabase/client';

/**
 * Where an operator enrols, presents and manages their second factor.
 *
 * Everything here runs in the **browser** against Supabase, and that is a
 * requirement rather than a convenience: a successful `verify` is what mints the
 * `aal2` session, and only the browser client writes that new session back to
 * the cookie the server then reads. Verifying through a server action would
 * upgrade a session the browser never receives, and the console would stay shut
 * behind a factor the operator had just used.
 *
 * The secret is handled accordingly. The TOTP secret and its QR exist only for
 * the seconds between `enroll` and `verify`, only in this component's state, and
 * are never sent to our server, never logged, and never persisted. Supabase
 * holds the authoritative copy; we hold a transcription aid.
 *
 * Recovery, stated plainly because a locked-out operator is a real outage: the
 * recovery mechanism is a **second enrolled factor**, which this page asks for
 * as soon as the first one is verified. Two factors on two devices means losing
 * one is an inconvenience rather than an incident. There is deliberately no
 * recovery code, no bypass flag and no "skip for now" — every one of those is a
 * credential that is weaker than the factor it replaces, and a second factor is
 * the same mechanism with none of that surface. If every factor is lost, the
 * documented break-glass in `docs/operations/admin-mfa.md` requires database
 * credentials and leaves an audit trail; it is not something this page can do.
 */

interface Factor {
  id: string;
  friendlyName: string | null;
  status: 'verified' | 'unverified';
  createdAt: string | null;
}

export interface AdminSecurityControlProps {
  /** What the server decided is outstanding, so the first paint is already right. */
  requirement: 'enroll' | 'verify' | 'satisfied';
  /** Where to send the operator once the requirement is met. */
  returnTo: string;
}

type Enrollment = { factorId: string; qr: string; secret: string };

const CODE_PATTERN = /^\d{6}$/;

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

/**
 * Supabase surfaces MFA failures as provider strings. Only two of them mean
 * anything to the person typing, and neither is worth echoing verbatim — a raw
 * provider message is where internal identifiers and endpoint names leak into a
 * screenshot.
 */
function describeMfaError(error: { message?: string } | null): string {
  const detail = error?.message ?? '';
  if (/invalid.*code|verification failed|incorrect/i.test(detail)) {
    return 'รหัสยืนยันไม่ถูกต้องหรือหมดอายุแล้ว กรุณาลองรหัสใหม่จากแอปยืนยันตัวตน';
  }
  if (/rate|too many/i.test(detail)) {
    return 'คุณลองยืนยันถี่เกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง';
  }
  return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่อีกครั้ง';
}

/** Supabase's factor rows, narrowed to what this screen shows. */
function toFactors(rows: ReadonlyArray<{
  id: string; friendly_name?: string | null; status: string; created_at?: string | null;
}> | undefined): Factor[] {
  return (rows ?? []).map((factor) => ({
    id: factor.id,
    friendlyName: factor.friendly_name ?? null,
    status: factor.status === 'verified' ? 'verified' : 'unverified',
    createdAt: factor.created_at ?? null,
  }));
}

export function AdminSecurityControl({ requirement, returnTo }: AdminSecurityControlProps) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [, startTransition] = useTransition();

  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [satisfied, setSatisfied] = useState(requirement === 'satisfied');

  /** Read the account's factors from Supabase. Used by the handlers below. */
  const refreshFactors = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.auth.mfa.listFactors();
    setFactors(error ? [] : toFactors(data?.all));
  }, [supabase]);

  /*
   * Reconcile the server's answer with the provider's, once, on mount.
   *
   * The state is written from the promise callback rather than from the effect
   * body — this is a subscription to an external system (Supabase's view of this
   * account's factors), not one piece of React state derived from another. The
   * `mounted` flag guards the write: this resolves after a network round trip and
   * the operator may well have navigated away by then.
   */
  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    void supabase.auth.mfa.listFactors()
      .then(({ data, error }) => {
        if (mounted) setFactors(error ? [] : toFactors(data?.all));
      })
      .catch(() => {
        if (mounted) setFactors([]);
      });
    return () => { mounted = false; };
  }, [supabase]);

  const verified = (factors ?? []).filter((factor) => factor.status === 'verified');

  /** Begin a new TOTP enrolment and show its QR/secret for transcription. */
  const beginEnrollment = async (): Promise<void> => {
    if (!supabase) return;
    setBusy(true);
    setProblem(null);
    setOutcome(null);
    /*
     * An abandoned enrolment leaves an `unverified` factor behind, and Supabase
     * refuses a duplicate friendly name — so a second attempt after a closed tab
     * would fail forever on a name collision. Clearing the unverified leftovers
     * first makes retrying work, and removes nothing that could ever have been
     * used: an unverified factor has never authenticated anything.
     */
    for (const stale of (factors ?? []).filter((factor) => factor.status !== 'verified')) {
      await supabase.auth.mfa.unenroll({ factorId: stale.id }).catch(() => undefined);
    }

    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `PortKheaw ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    });
    setBusy(false);
    if (error || !data) {
      setProblem(describeMfaError(error));
      return;
    }
    setEnrollment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    setCode('');
    void refreshFactors();
  };

  /**
   * Present a code. The same handler finishes an enrolment and satisfies a
   * step-up, because Supabase treats both as a challenge against a factor id —
   * and keeping one path means there is one place where a code is checked.
   */
  const presentCode = async (factorId: string): Promise<void> => {
    if (!supabase) return;
    if (!CODE_PATTERN.test(code.trim())) {
      setProblem('กรุณากรอกรหัสยืนยัน 6 หลัก');
      return;
    }
    setBusy(true);
    setProblem(null);

    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (error) {
      setProblem(describeMfaError(error));
      setCode('');
      return;
    }

    setCode('');
    setEnrollment(null);
    setSatisfied(true);
    setOutcome(enrollment ? 'เปิดใช้ยืนยันตัวตนสองชั้นเรียบร้อยแล้ว' : 'ยืนยันตัวตนเรียบร้อยแล้ว');
    await refreshFactors();
    // The cookie now carries an `aal2` session. `refresh()` is what makes the
    // server re-read it, so the console opens without a manual reload.
    startTransition(() => router.refresh());
  };

  /**
   * Remove a factor. Reachable only at `aal2` — the server enforces that
   * independently, and Supabase refuses an `aal1` unenroll of a verified factor
   * on its own terms, which is the layer that actually matters here.
   */
  const removeFactor = async (factorId: string): Promise<void> => {
    if (!supabase) return;
    setBusy(true);
    setProblem(null);
    setOutcome(null);
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    setBusy(false);
    if (error) {
      setProblem(describeMfaError(error));
      return;
    }
    setOutcome('นำอุปกรณ์ยืนยันตัวตนออกแล้ว');
    await refreshFactors();
    startTransition(() => router.refresh());
  };

  if (!supabase) {
    return <Notice tone="warn">ระบบยืนยันตัวตนยังไม่พร้อมใช้งาน</Notice>;
  }

  const stepUpFactor = !enrollment && !satisfied && verified.length > 0 ? verified[0].id : null;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          {satisfied
            ? <ShieldCheck className="size-5 text-[var(--accent)]" aria-hidden />
            : <ShieldAlert className="size-5 text-amber-400" aria-hidden />}
          <h1 className="text-lg font-semibold text-[var(--text)]">ความปลอดภัยบัญชีผู้ดูแลระบบ</h1>
        </div>
        <p className="text-sm text-[var(--text-muted)]">
          บัญชีผู้ดูแลระบบต้องยืนยันตัวตนสองชั้นทุกครั้งที่เข้าใช้งานคอนโซล
          เพื่อไม่ให้ผู้ที่ได้เซสชันไปสามารถใช้สิทธิ์ผู้ดูแลได้
        </p>
      </header>

      {problem ? <Notice tone="error">{problem}</Notice> : null}
      {outcome ? <Notice tone="ok">{outcome}</Notice> : null}

      {satisfied ? (
        <Notice tone="ok">
          เซสชันนี้ยืนยันตัวตนสองชั้นแล้ว{' '}
          <a className="underline underline-offset-2" href={returnTo}>กลับไปที่คอนโซล</a>
        </Notice>
      ) : null}

      {/* ---- Step up: a factor exists, it just has not been used yet ---- */}
      {stepUpFactor ? (
        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
          <h2 className="font-medium text-[var(--text)]">กรอกรหัสจากแอปยืนยันตัวตน</h2>
          <CodeField value={code} onChange={setCode} disabled={busy} />
          <Button onClick={() => void presentCode(stepUpFactor)} disabled={busy}>
            {busy ? 'กำลังยืนยัน…' : 'ยืนยัน'}
          </Button>
        </section>
      ) : null}

      {/* ---- Enrolment: show the QR, then take the first code ---- */}
      {enrollment ? (
        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
          <h2 className="font-medium text-[var(--text)]">สแกน QR ด้วยแอปยืนยันตัวตน</h2>
          {/*
            A `data:` SVG that Supabase generated for this enrolment. `img-src …
            data:` in the CSP admits it, and an image cannot execute regardless of
            what it encodes.

            Deliberately not `next/image`: the optimizer exists to fetch, resize
            and re-encode a remote asset, and there is nothing here to fetch. It
            is a few hundred bytes that already exist in memory, it lives for the
            seconds between enrol and verify, and routing a one-time secret
            through an image CDN is the opposite of what this page is for.
          */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={enrollment.qr}
            alt="QR code สำหรับตั้งค่ายืนยันตัวตนสองชั้น"
            className="size-44 rounded-lg bg-white p-2"
          />
          <p className="text-xs text-[var(--text-muted)]">
            หากสแกนไม่ได้ ให้กรอกรหัสนี้ในแอปด้วยตนเอง
          </p>
          <code className="block rounded-lg border border-[var(--border)] bg-[var(--surface-hover)] px-3 py-2 font-mono text-sm break-all text-[var(--text)]">
            {enrollment.secret}
          </code>
          <CodeField value={code} onChange={setCode} disabled={busy} />
          <Button onClick={() => void presentCode(enrollment.factorId)} disabled={busy}>
            {busy ? 'กำลังยืนยัน…' : 'ยืนยันและเปิดใช้งาน'}
          </Button>
        </section>
      ) : null}

      {/* ---- Enrol a first or a backup factor ---- */}
      {!enrollment && (verified.length === 0 || satisfied) ? (
        <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
          <h2 className="font-medium text-[var(--text)]">
            {verified.length === 0 ? 'เปิดใช้ยืนยันตัวตนสองชั้น' : 'เพิ่มอุปกรณ์สำรอง'}
          </h2>
          <p className="text-sm text-[var(--text-muted)]">
            {verified.length === 0
              ? 'ใช้แอปยืนยันตัวตน เช่น Google Authenticator หรือ 1Password'
              : 'แนะนำให้เพิ่มอุปกรณ์ที่สองไว้คนละเครื่อง เพื่อให้ยังเข้าคอนโซลได้หากอุปกรณ์แรกหาย '
                + 'นี่คือช่องทางกู้คืนของบัญชีผู้ดูแลระบบ'}
          </p>
          <Button variant="outline" onClick={() => void beginEnrollment()} disabled={busy}>
            <KeyRound className="size-4" aria-hidden />
            {verified.length === 0 ? 'เริ่มตั้งค่า' : 'เพิ่มอุปกรณ์'}
          </Button>
        </section>
      ) : null}

      {/* ---- What is enrolled now ---- */}
      <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
        <h2 className="font-medium text-[var(--text)]">อุปกรณ์ยืนยันตัวตนของบัญชีนี้</h2>
        {factors === null ? (
          <p className="text-sm text-[var(--text-muted)]">กำลังโหลด…</p>
        ) : verified.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">ยังไม่มีอุปกรณ์ที่ยืนยันแล้ว</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {verified.map((factor) => (
              <li key={factor.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-[var(--text)]">{factor.friendlyName ?? 'อุปกรณ์ยืนยันตัวตน'}</p>
                  <p className="text-xs text-[var(--text-muted)]">เพิ่มเมื่อ {when(factor.createdAt)}</p>
                </div>
                {/* Removing the last factor is allowed only while another one
                    exists, so the console can never be left with a requirement
                    nobody can satisfy. */}
                {satisfied && verified.length > 1 ? (
                  <Button
                    variant="ghost"
                    onClick={() => void removeFactor(factor.id)}
                    disabled={busy}
                    aria-label="นำอุปกรณ์นี้ออก"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CodeField({
  value, onChange, disabled,
}: { value: string; onChange: (next: string) => void; disabled: boolean }) {
  return (
    <Input
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="000000"
      aria-label="รหัสยืนยัน 6 หลัก"
      disabled={disabled}
      className="max-w-40 text-center font-mono text-lg tracking-[0.4em]"
    />
  );
}

function Notice({ tone, children }: { tone: 'ok' | 'warn' | 'error'; children: React.ReactNode }) {
  const palette = tone === 'ok'
    ? 'border-[var(--positive)]/40 bg-[var(--positive)]/10 text-[var(--positive)]'
    : tone === 'warn'
      ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
      : 'border-[var(--negative)]/40 bg-red-500/10 text-[var(--negative)]';
  return <p className={`rounded-lg border px-3 py-2 text-sm ${palette}`}>{children}</p>;
}
