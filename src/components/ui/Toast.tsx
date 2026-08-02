'use client';
import { create } from 'zustand'
import { X } from 'lucide-react'

interface Toast {
  id: string
  title: string
  message?: string
  type?: 'success' | 'error' | 'info'
}

interface ToastStore {
  toasts: Toast[]
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
}

export const useToast = create<ToastStore>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = Date.now().toString()
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, 3000)
  },
  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}))

export function Toaster() {
  const { toasts, removeToast } = useToast()

  /*
   * Above the dock at every width. The old `sm:bottom-4` assumed the bottom
   * strip was a mobile-only navigation; the capsule is there on desktop too, and
   * a toast pinned to the viewport edge would sit behind it.
   */
  return (
    <div aria-live="polite" className="fixed left-4 right-4 bottom-[calc(var(--dock-clearance)+0.25rem)] sm:left-auto sm:right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto w-full sm:w-auto sm:min-w-[300px] sm:max-w-md flex items-start justify-between p-4 rounded-xl border shadow-xl transition-all ${
            toast.type === 'error' ? 'bg-red-500/10 border-red-500/50 text-red-500' :
            toast.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-500' :
            'bg-[#151B28] border-slate-800 text-white'
          }`}
        >
          <div>
            <h4 className="font-semibold text-sm">{toast.title}</h4>
            {toast.message && <p className="text-xs mt-1 opacity-80">{toast.message}</p>}
          </div>
          <button onClick={() => removeToast(toast.id)} aria-label="ปิดข้อความแจ้งเตือน" className="p-1 opacity-50 hover:opacity-100">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  )
}
