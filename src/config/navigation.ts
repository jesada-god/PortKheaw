import { Home, PieChart, Search, Star, Wrench, type LucideIcon } from 'lucide-react';

export interface PrimaryNavItem {
  /** Thai label. Doubles as the link's accessible name and its dock tooltip. */
  readonly name: string;
  readonly href: string;
  readonly icon: LucideIcon;
}

/**
 * The five primary destinations, declared once.
 *
 * They used to be typed out twice — once in the desktop sidebar and once in the
 * mobile bottom navigation — which is how the two could drift apart without
 * anything failing. The floating dock is now the only consumer, and it reads
 * this list rather than restating it.
 */
export const primaryNavItems: readonly PrimaryNavItem[] = [
  { name: 'ภาพรวม', href: '/', icon: Home },
  { name: 'รายการติดตาม', href: '/watchlist', icon: Star },
  { name: 'ค้นหา', href: '/search', icon: Search },
  { name: 'พอร์ต', href: '/portfolio', icon: PieChart },
  { name: 'เครื่องมือ', href: '/tools', icon: Wrench },
];

/**
 * Whether `href` is the destination the reader is currently inside.
 *
 * Overview is an exact match — every other route lives under `/`, so a prefix
 * test would light it up everywhere. The rest match themselves and anything
 * nested beneath them, so `/tools/what-if` keeps เครื่องมือ selected. The
 * trailing slash matters: a bare `startsWith` would also claim a sibling route
 * that merely begins with the same letters.
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}
