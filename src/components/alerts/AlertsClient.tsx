'use client';

import { useId, useRef, useState, useTransition } from 'react';
import { BellRing, Edit3, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createAlertAction, deleteAlertAction, setAlertEnabledAction, updateAlertAction, type AlertInput } from '@/app/alerts/actions';
import { Button } from '@/src/components/ui/Button';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { Input } from '@/src/components/ui/Input';
import { Modal } from '@/src/components/ui/Modal';
import { useToast } from '@/src/components/ui/Toast';
import { describeCondition } from '@/src/lib/alerts/logic';
import { requestAlertEvaluation } from '@/src/lib/alerts/client';
import type { AlertCondition, PriceAlert } from '@/src/lib/alerts/types';

interface AlertFormValues {
  symbol: string;
  condition: AlertCondition;
  targetValue: string;
  cooldownMinutes: string;
  enabled: boolean;
}

const blank: AlertFormValues = {
  symbol: '',
  condition: 'above',
  targetValue: '',
  cooldownMinutes: '60',
  enabled: true,
};
const targetValueError = 'กรุณาใส่ราคาเป้าหมายที่มากกว่า 0';
const decimalPattern = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

export function parsePositiveDecimal(raw: string): number | null {
  const normalized = raw.trim();
  if (!decimalPattern.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const conditionOptions: Array<{ value: AlertCondition; label: string }> = [
  { value: 'above', label: 'ราคาสูงกว่า/เท่ากับ' }, { value: 'below', label: 'ราคาต่ำกว่า/เท่ากับ' },
  { value: 'percent_change_up', label: 'เปอร์เซ็นต์เพิ่มขึ้น' }, { value: 'percent_change_down', label: 'เปอร์เซ็นต์ลดลง' },
];
const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }).format(new Date(value)) : 'ยังไม่เคย';

export function AlertsClient({ initialAlerts }: { initialAlerts: PriceAlert[] }) {
  const router = useRouter();
  const [alerts, setAlerts] = useState(initialAlerts); const [editing, setEditing] = useState<PriceAlert | null>(null);
  const [form, setForm] = useState<AlertFormValues>(blank); const [open, setOpen] = useState(false); const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false); const [formError, setFormError] = useState('');
  const [evaluating, setEvaluating] = useState(false); const { addToast } = useToast();
  const submittingRef = useRef(false);
  const symbolInputRef = useRef<HTMLInputElement>(null);
  const formId = `price-alert-form-${useId().replaceAll(':', '')}`;

  function showForm(alert?: PriceAlert) {
    setEditing(alert ?? null);
    setForm(alert ? {
      symbol: alert.symbol,
      condition: alert.condition,
      targetValue: String(alert.targetValue),
      cooldownMinutes: String(alert.cooldownMinutes),
      enabled: alert.enabled,
    } : blank);
    setFormError('');
    setOpen(true);
  }

  function closeForm() {
    if (!submittingRef.current) setOpen(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;

    const targetValue = parsePositiveDecimal(form.targetValue);
    if (targetValue === null) {
      setFormError(targetValueError);
      return;
    }
    const cooldownMinutes = Number(form.cooldownMinutes);
    if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 10080) {
      setFormError('กรุณาใส่ Cooldown เป็นจำนวนเต็มระหว่าง 1 ถึง 10080 นาที');
      return;
    }

    const input: AlertInput = {
      symbol: form.symbol.trim().toUpperCase(),
      condition: form.condition,
      targetValue,
      cooldownMinutes,
      enabled: form.enabled,
    };
    submittingRef.current = true;
    setSubmitting(true);
    setFormError('');
    try {
      const result = editing ? await updateAlertAction(editing.id, input) : await createAlertAction(input);
      if (!result.ok || !result.alert) {
        addToast({ title: 'บันทึกไม่สำเร็จ', message: result.ok ? undefined : result.message, type: 'error' });
        return;
      }
      setAlerts((current) => editing ? current.map((item) => item.id === result.alert!.id ? result.alert! : item) : [result.alert!, ...current]);
      setOpen(false);
      router.refresh();
      addToast({ title: editing ? 'แก้ไขการแจ้งเตือนแล้ว' : 'สร้างการแจ้งเตือนแล้ว', type: 'success' });
    } catch (error) {
      addToast({
        title: 'บันทึกไม่สำเร็จ',
        message: error instanceof Error ? error.message : 'กรุณาลองอีกครั้ง',
        type: 'error',
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  function toggle(alert: PriceAlert) { startTransition(async () => {
    const result = await setAlertEnabledAction(alert.id, !alert.enabled);
    if (!result.ok) { addToast({ title: 'เปลี่ยนสถานะไม่สำเร็จ', message: result.message, type: 'error' }); return; }
    setAlerts((current) => current.map((item) => item.id === alert.id ? { ...item, enabled: !item.enabled } : item));
  }); }
  function remove(alert: PriceAlert) { if (!window.confirm(`ลบ Price Alert ของ ${alert.symbol}?`)) return; startTransition(async () => {
    const result = await deleteAlertAction(alert.id); if (!result.ok) { addToast({ title: 'ลบไม่สำเร็จ', message: result.message, type: 'error' }); return; }
    setAlerts((current) => current.filter((item) => item.id !== alert.id)); addToast({ title: 'ลบ Alert แล้ว', type: 'success' });
  }); }
  async function evaluate() {
    setEvaluating(true); try { const response = await requestAlertEvaluation(); const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Evaluation failed');
      window.dispatchEvent(new Event('notifications-updated'));
      addToast({ title: 'ตรวจสอบ Alerts แล้ว', message: `ตรวจ ${payload.data.evaluated} รายการ · แจ้งเตือนใหม่ ${payload.data.triggered} รายการ`, type: 'success' });
    } catch (error) { addToast({ title: 'ตรวจสอบไม่สำเร็จ', message: error instanceof Error ? error.message : undefined, type: 'error' }); }
    finally { setEvaluating(false); }
  }

  const formComplete = form.symbol.trim() !== ''
    && form.targetValue.trim() !== ''
    && form.cooldownMinutes.trim() !== '';

  return <div className="space-y-5">
    <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
      <strong className="block text-amber-300">ไม่ใช่ Background Real-time Alert</strong>
      ระบบตรวจเงื่อนไขเมื่อคุณเปิด/รีเฟรชแอป หรือกด “ตรวจสอบตอนนี้” เท่านั้น ไม่มีการตรวจสอบต่อเนื่องเมื่อปิดแอป
    </section>
    <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-semibold text-white">Price Alerts</h2><p className="text-xs text-slate-500">{alerts.length} รายการ</p></div>
      <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto"><Button className="min-w-0 px-2 sm:px-4" variant="outline" onClick={evaluate} isLoading={evaluating}><RefreshCw size={16} className="mr-2 flex-none" /><span className="truncate">ตรวจสอบตอนนี้</span></Button><Button className="min-w-0 px-2 sm:px-4" onClick={() => showForm()}><Plus size={16} className="mr-2 flex-none" /><span className="truncate">สร้าง Alert</span></Button></div></div>
    {alerts.length === 0 ? <EmptyState className="panel" icon={BellRing} title="ยังไม่มี Price Alert" description="สร้างเงื่อนไขจากราคาหรือเปอร์เซ็นต์การเปลี่ยนแปลงได้จากปุ่มด้านบน" /> :
      <div className="space-y-3">{alerts.map((alert) => <article key={alert.id} className={`rounded-2xl border p-4 sm:p-5 ${alert.enabled ? 'border-slate-700 bg-[#151B28]' : 'border-slate-800 bg-slate-900/50 opacity-70'}`}>
        <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="text-lg font-bold text-white">{alert.symbol}</h3><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${alert.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}>{alert.enabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}</span></div>
          <p className="text-sm text-slate-300">{describeCondition(alert.condition, alert.targetValue)}</p><p className="mt-2 text-xs text-slate-500">Cooldown {alert.cooldownMinutes} นาที · ตรวจล่าสุด {dateTime(alert.lastEvaluatedAt)} · Trigger ล่าสุด {dateTime(alert.lastTriggeredAt)}</p></div>
          <div className="flex items-center gap-1"><label className="flex min-h-11 cursor-pointer items-center gap-2 px-2 text-xs text-slate-400"><input type="checkbox" checked={alert.enabled} disabled={pending} onChange={() => toggle(alert)} className="h-4 w-4 accent-[#D4FF00]" />เปิด</label>
            <button aria-label={`แก้ไข ${alert.symbol}`} onClick={() => showForm(alert)} className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"><Edit3 size={17} /></button>
            <button aria-label={`ลบ ${alert.symbol}`} onClick={() => remove(alert)} className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-400"><Trash2 size={17} /></button></div></div>
      </article>)}</div>}
    <Modal
      isOpen={open}
      onClose={closeForm}
      closeDisabled={submitting}
      initialFocusRef={editing ? undefined : symbolInputRef}
      title={editing ? `แก้ไข Alert: ${editing.symbol}` : 'สร้าง Price Alert'}
      footer={<div className="grid gap-2 min-[360px]:grid-cols-2">
        <Button type="button" variant="ghost" onClick={closeForm} disabled={submitting} className="w-full px-3">ยกเลิก</Button>
        <Button type="submit" form={formId} isLoading={submitting} disabled={!formComplete || submitting} className="w-full px-3">
          {submitting ? 'กำลังบันทึก...' : 'บันทึกการแจ้งเตือน'}
        </Button>
      </div>}
    ><form id={formId} onSubmit={submit} className="min-w-0 space-y-4" noValidate>
      <label className="block text-sm text-slate-300">Symbol<Input ref={symbolInputRef} value={form.symbol} disabled={Boolean(editing) || submitting} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} placeholder="เช่น AAPL" required autoComplete="off" className="mt-1" /></label>
      <label className="block text-sm text-slate-300">เงื่อนไข<select value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value as AlertCondition })} className="mt-1 h-10 w-full rounded-md border border-slate-700 bg-[#151B28] px-3 text-sm text-white">{conditionOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label className="block text-sm text-slate-300">{form.condition.startsWith('percent') ? 'เปอร์เซ็นต์ (ใส่ค่าบวก)' : 'ราคาเป้าหมาย'}<Input
        type="text"
        inputMode="decimal"
        value={form.targetValue}
        disabled={submitting}
        onChange={(e) => { setForm({ ...form, targetValue: e.target.value }); setFormError(''); }}
        placeholder="เช่น 150.50"
        required
        autoComplete="off"
        aria-invalid={formError === targetValueError}
        aria-describedby={formError ? `${formId}-error` : undefined}
        className="mt-1"
      /></label>
      <label className="block text-sm text-slate-300">Cooldown (นาที)<Input type="number" min="1" max="10080" step="1" value={form.cooldownMinutes} disabled={submitting} onChange={(e) => { setForm({ ...form, cooldownMinutes: e.target.value }); setFormError(''); }} required className="mt-1" /></label>
      <label className="flex min-w-0 items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={form.enabled} disabled={submitting} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="h-4 w-4 flex-none accent-[#D4FF00]" /><span className="min-w-0 break-words">เปิดใช้งาน</span></label>
      {formError && <p id={`${formId}-error`} role="alert" className="text-sm text-red-400">{formError}</p>}
    </form></Modal>
  </div>;
}

