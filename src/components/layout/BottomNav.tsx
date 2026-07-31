'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, Star, Search, PieChart, Wrench } from 'lucide-react';
import { cn } from '@/src/utils/cn';

const navItems = [
  { name: 'ภาพรวม', href: '/', icon: Home },
  { name: 'Watchlist', href: '/watchlist', icon: Star },
  { name: 'ค้นหา', href: '/search', icon: Search },
  { name: 'พอร์ต', href: '/portfolio', icon: PieChart },
  { name: 'เครื่องมือ', href: '/tools', icon: Wrench },
];

export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="เมนูหลัก"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_94%,transparent)] pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden"
    >
      <div className="flex h-16 items-center justify-around">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href
            || (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-1 px-0.5',
                active
                  ? 'text-[var(--accent)]'
                  : 'text-[var(--text-muted)] transition-colors hover:text-[var(--text)]',
              )}
            >
              <Icon size={20} strokeWidth={active ? 2.5 : 2} />
              <span className="max-w-full truncate text-[10px] font-medium">{item.name}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
