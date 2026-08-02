'use client';

import { useCallback, useEffect, useState } from 'react';
import { BellOff, BellRing, RotateCcw, Send } from 'lucide-react';
import { clientEnv } from '@/src/config/env/client';
import {
  decodeVapidPublicKey,
  resolvePushDeviceState,
  type PushDeviceState,
} from '@/src/lib/push/client';
import { Button } from '@/src/components/ui/Button';

type State = 'checking' | 'error' | PushDeviceState;
type Action = 'checking' | 'enabling' | 'testing' | 'disabling' | null;

const messages: Record<Exclude<State, 'checking' | 'error'>, string> = {
  unsupported: 'อุปกรณ์นี้ไม่รองรับ คุณยังใช้กล่องการแจ้งเตือนได้ตามปกติ',
  blocked: 'การแจ้งเตือนถูกปิดกั้น กรุณาเปิดสิทธิ์จากการตั้งค่าเบราว์เซอร์',
  unavailable: 'ยังเปิดการแจ้งเตือนบนอุปกรณ์นี้ไม่ได้ในขณะนี้ กรุณาลองใหม่ภายหลัง',
  off: 'ยังไม่ได้เปิดการแจ้งเตือนบนอุปกรณ์นี้',
  on: 'พร้อมรับการแจ้งเตือน',
};

function supportsPush(): boolean {
  return (
    'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
  );
}

export function PushPreferences() {
  const [state, setState] = useState<State>('checking');
  const [action, setAction] = useState<Action>('checking');
  const [message, setMessage] = useState('กำลังตรวจสอบอุปกรณ์นี้…');

  const refresh = useCallback(async () => {
    setAction('checking');
    setMessage('กำลังตรวจสอบอุปกรณ์นี้…');
    if (!supportsPush()) {
      setState('unsupported');
      setMessage(messages.unsupported);
      setAction(null);
      return;
    }
    if (Notification.permission === 'denied') {
      setState('blocked');
      setMessage(messages.blocked);
      setAction(null);
      return;
    }
    try {
      const [registration, response] = await Promise.all([
        navigator.serviceWorker.ready,
        fetch('/api/push/subscriptions', {
          cache: 'no-store',
          credentials: 'same-origin',
        }),
      ]);
      const result = await response.json();
      if (!response.ok) throw new Error('push-status-unavailable');
      const subscription = await registration.pushManager.getSubscription();
      const nextState = resolvePushDeviceState({
        supported: true,
        permission: Notification.permission,
        subscribed: Boolean(subscription),
        configured: Boolean(
          result.data?.configured
          && clientEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        ),
      });
      setState(nextState);
      setMessage(messages[nextState]);
    } catch {
      setState('error');
      setMessage('ตรวจสอบสถานะไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setAction(null);
    }
  }, []);

  useEffect(() => {
    const initialCheck = window.setTimeout(() => {
      void refresh();
    }, 0);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearTimeout(initialCheck);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);

  async function enable() {
    if (action || !supportsPush()) return;
    setAction('enabling');
    setMessage('กำลังเปิดการแจ้งเตือน…');
    let createdSubscription: PushSubscription | null = null;
    try {
      // Permission is requested only from this explicit user action.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        const nextState = permission === 'denied' ? 'blocked' : 'off';
        setState(nextState);
        setMessage(messages[nextState]);
        return;
      }
      const publicKey = clientEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!publicKey) throw new Error('push-not-configured');
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidPublicKey(publicKey),
      });
      if (!existing) createdSubscription = subscription;
      const response = await fetch('/api/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) throw new Error('subscription-not-saved');
      setState('on');
      setMessage('พร้อมรับการแจ้งเตือน');
    } catch {
      if (createdSubscription) {
        await createdSubscription.unsubscribe().catch(() => false);
      }
      setState('error');
      setMessage('เปิดการแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setAction(null);
    }
  }

  async function disable() {
    if (action || !supportsPush()) return;
    setAction('disabling');
    setMessage('กำลังปิดการแจ้งเตือน…');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch('/api/push/subscriptions', {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) throw new Error('subscription-not-removed');
        const removed = await subscription.unsubscribe();
        if (!removed) throw new Error('browser-subscription-not-removed');
      }
      setState('off');
      setMessage('ปิดการแจ้งเตือนบนอุปกรณ์นี้แล้ว');
    } catch {
      setState('error');
      setMessage('ปิดการแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setAction(null);
    }
  }

  async function testPush() {
    if (action || !supportsPush()) return;
    setAction('testing');
    setMessage('กำลังส่งการแจ้งเตือนทดสอบ…');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription || Notification.permission !== 'granted') {
        setState('off');
        setMessage(messages.off);
        return;
      }
      const response = await fetch('/api/push/test', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      const result = await response.json().catch(() => null);
      if (response.status === 429) {
        const seconds = Number(result?.retryAfterSeconds) || 30;
        setMessage(`กรุณารอ ${seconds} วินาที แล้วลองอีกครั้ง`);
        return;
      }
      if (response.status === 404) {
        setState('off');
        setMessage('ไม่พบการเชื่อมต่อของอุปกรณ์นี้ กรุณาเปิดการแจ้งเตือนใหม่');
        return;
      }
      if (!response.ok) throw new Error('test-push-failed');
      setState('on');
      setMessage('ส่งการแจ้งเตือนทดสอบแล้ว');
    } catch {
      setState('error');
      setMessage('ส่งการแจ้งเตือนทดสอบไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setAction(null);
    }
  }

  const busy = action !== null;
  return <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
    <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {state === 'on'
          ? <BellRing className="mt-0.5 shrink-0 text-[var(--accent)]" size={20} />
          : <BellOff className="mt-0.5 shrink-0 text-[var(--text-muted)]" size={20} />}
        <div className="min-w-0 flex-1">
          <p className="font-medium text-[var(--text)]">การแจ้งเตือนบนอุปกรณ์นี้</p>
          <p
            className="mt-1 break-words text-xs leading-5 text-[var(--text-muted)]"
            role={state === 'error' ? 'alert' : 'status'}
            aria-live="polite"
          >
            {message}
          </p>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        {state === 'off' && <Button
          type="button"
          onClick={() => void enable()}
          isLoading={action === 'enabling'}
          disabled={busy}
          className="min-h-11 w-full sm:w-auto"
        >
          เปิดการแจ้งเตือน
        </Button>}
        {state === 'on' && <>
          <Button
            type="button"
            onClick={() => void testPush()}
            isLoading={action === 'testing'}
            disabled={busy}
            className="min-h-11 w-full sm:w-auto"
          >
            <Send size={16} className="mr-2" />
            ส่งการแจ้งเตือนทดสอบ
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void disable()}
            isLoading={action === 'disabling'}
            disabled={busy}
            className="min-h-11 w-full sm:w-auto"
          >
            ปิด
          </Button>
        </>}
        {(state === 'error' || state === 'unavailable') && <Button
          type="button"
          variant="outline"
          onClick={() => void refresh()}
          isLoading={action === 'checking'}
          disabled={busy}
          className="min-h-11 w-full sm:w-auto"
        >
          <RotateCcw size={16} className="mr-2" />
          ลองใหม่
        </Button>}
      </div>
    </div>
  </div>;
}
