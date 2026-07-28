'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Star, Search, PieChart, Wrench } from 'lucide-react';
import { cn } from '@/src/utils/cn';
import { appConfig } from '@/src/config/app';
import { BrandMark } from '@/src/components/brand/BrandMark';

const navItems = [
  { name: 'Home', href: '/', icon: Home },
  { name: 'Watchlist', href: '/watchlist', icon: Star },
  { name: 'Search', href: '/search', icon: Search },
  { name: 'Portfolio', href: '/portfolio', icon: PieChart },
  { name: 'Tools', href: '/tools', icon: Wrench },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] transition-colors duration-200 lg:flex">
      <div className="border-b border-[var(--border)] p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-mark-bg)]">
            <BrandMark priority className="h-9 w-9" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--text)]">{appConfig.name}</h1>
        </div>
      </div>
      
      <nav className="flex-1 py-4 space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));

          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                'flex items-center gap-3 px-6 py-3 transition-colors',
                isActive 
                  ? 'border-r-4 border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
              )}
            >
              <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
              <span>{item.name}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto p-6">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-[var(--accent)]">Pro Analysis</p>
          <p className="text-sm text-[var(--text-secondary)]">What-If & Monte Carlo Ready</p>
        </div>
      </div>
    </aside>
  );
}
