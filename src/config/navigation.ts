import { Home, LogIn, PieChart, Search, Star, Wrench, type LucideIcon } from 'lucide-react';

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
 * What the dock offers somebody who is not signed in.
 *
 * ===========================================================================
 * WHY THIS LIST EXISTS
 * ===========================================================================
 * `/stock/{symbol}` is public on purpose: it is the page a search engine
 * indexes and the page people paste into a chat. Somebody arriving there from
 * Google is the reader the whole public surface exists for.
 *
 * Of the five primary destinations, four now need a session. Showing that
 * reader five buttons where four bounce to a sign-in form is a worse welcome
 * than showing two that work, and it spends the arrival this product just went
 * out of its way to keep. So the dock offers what they can actually do —
 * search — and the one thing we want them to do next.
 *
 * Not hiding the dock entirely: a reader with no navigation and no call to
 * action has nowhere to go but back. Not keeping the dead buttons either: a
 * button that answers with a login wall is worse than an absent one, because
 * it costs a tap to find that out.
 *
 * `next` carries the page they were reading, so signing in returns them to it
 * rather than dropping them on the dashboard having lost their place.
 * `getSafeReturnPath` re-validates it on the way back, so an odd pathname
 * cannot become an open redirect.
 */
export function anonymousNavItems(currentPath: string): readonly PrimaryNavItem[] {
  return [
    { name: 'ค้นหา', href: '/search', icon: Search },
    {
      name: 'เข้าสู่ระบบ',
      href: `/auth/sign-in?next=${encodeURIComponent(currentPath)}`,
      icon: LogIn,
    },
  ];
}

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
