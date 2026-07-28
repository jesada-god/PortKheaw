import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { appConfig } from '@/src/config/app';
import { BrandMark } from '@/src/components/brand/BrandMark';

interface AuthCardProps {
  title: string;
  description: string;
  children: React.ReactNode;
}

export function AuthCard({ title, description, children }: AuthCardProps) {
  return (
    <div className="mx-auto flex min-h-[calc(100dvh-7rem)] w-full max-w-md items-center px-4 py-8 sm:px-6">
      <section className="w-full rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-7">
        <Link href="/" className="mb-6 inline-flex items-center gap-2 text-sm font-bold text-[var(--text)]">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand-mark-bg)]">
            <BrandMark className="h-8 w-8" />
          </span>
          {appConfig.name}
        </Link>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-[var(--text)]">{title}</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{description}</p>
        </div>
        {children}
        <p className="mt-6 flex items-start gap-2 text-xs leading-5 text-slate-500">
          <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
          Session จัดเก็บใน secure cookie โดย Supabase และไม่มี Service Role key ในเบราว์เซอร์
        </p>
      </section>
    </div>
  );
}
