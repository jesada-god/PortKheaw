/**
 * The specimen sheet the status-mark QA script photographs.
 *
 * Split out of `status-direction-marks-qa.mts` for the same reason
 * `options-signal-card-client.tsx` is split out of its driver: esbuild reads a
 * `.mts` file as TypeScript and not as TSX, so the JSX has to live in a `.tsx`
 * of its own. The driver owns the browser, the stylesheet and the measuring;
 * this file owns nothing but what is drawn.
 *
 * Every entry in {@link SPECIMENS} is one real call site, at the className and
 * the level that call site passes. Nothing here invents a shape: if a row looks
 * wrong on the sheet, the surface it names looks wrong too.
 */
import React from 'react';
import { StatusLabel, StatusRow, type StatusMarkKind } from '@/src/components/ui/StatusLabel';
import { STATUS_PRESENTATION, type StatusLevel } from '@/src/lib/presentation/status';

/** Every call site, with the props and the class the real one passes. */
export interface Specimen {
  /** `file:line`, so a row on the sheet can be found in the source. */
  where: string;
  /** What the reader is looking at, in the product's own words. */
  what: string;
  level: StatusLevel;
  label: string;
  className?: string;
  /** A `StatusRow` rather than a bare label: the name printed before the dot. */
  rowName?: string;
  /** The mark this site ships with. `dot` marks the four with no direction. */
  mark: StatusMarkKind;
  /** Text drawn above the status, where the real surface prints a figure. */
  figure?: string;
  figureClass?: string;
}

/*
 * The nineteen directional sites, then the four that keep the dot.
 *
 * Ordered as a reader meets them — the overview, then the stock page, then the
 * tools — rather than by file, so the sheet reads the way the product does.
 */
export const SPECIMENS: readonly Specimen[] = [
  {
    where: 'MarketStatusCard.tsx:59',
    what: 'ภาพรวมตลาด · headline',
    level: 'good', label: 'ตลาดกลับมาเป็นขาขึ้น', className: 'text-lg', mark: 'direction',
  },
  {
    where: 'MarketStatusCard.tsx:111',
    what: 'ภาพรวมตลาด · หนึ่งอินพุต',
    level: 'bad', label: '-1.82%', className: 'text-xs', mark: 'direction',
    figure: '5,412.20', figureClass: 'figure font-mono text-sm font-semibold text-[var(--text)]',
  },
  {
    where: 'MarketTodaySection.tsx:164',
    what: 'ตลาดวันนี้ · หนึ่งค่าที่อ่านได้',
    level: 'bad', label: '-0.94%', className: 'text-xs', mark: 'direction',
    figure: '17,908.21', figureClass: 'figure text-base font-bold text-[var(--text)]',
  },
  {
    where: 'MarketTodaySection.tsx:222',
    what: 'ตลาดวันนี้ · ทิศทาง',
    level: 'good', label: 'ตลาดเป็นขาขึ้น', rowName: 'ทิศทาง', mark: 'direction',
  },
  {
    where: 'MarketTodaySection.tsx:239',
    what: 'ตลาดวันนี้ · เงินรอบตลาด (อ่านไม่ได้)',
    level: 'unknown', label: STATUS_PRESENTATION.unknown.fallbackLabel,
    rowName: 'เงินรอบตลาด', mark: 'direction',
  },
  {
    where: 'MarketTodaySection.tsx:419',
    what: 'แถบสินทรัพย์ · หนึ่งช่อง',
    level: 'good', label: '+1.24%', className: 'text-xs', mark: 'direction',
    figure: '2,388.40', figureClass: 'figure text-sm font-bold text-[var(--text)]',
  },
  {
    where: 'DashboardClient.tsx:610',
    what: 'พอร์ต · กำไร/ขาดทุนรวม',
    level: 'bad', label: '-$746.28 (-3.10%)', className: 'text-sm', mark: 'direction',
  },
  {
    where: 'DashboardClient.tsx:621',
    what: 'พอร์ต · วันนี้',
    level: 'good', label: '+$128.40 (+0.62%)', className: 'text-sm', mark: 'direction',
  },
  {
    where: 'DashboardClient.tsx:719',
    what: 'สิ่งที่เปลี่ยนไป (แบบย่อ)',
    level: 'bad', label: 'NVDA ขยับ -9.00% เกินช่วงปกติ 60 วัน', className: 'text-sm', mark: 'direction',
  },
  {
    where: 'DashboardClient.tsx:1537',
    what: 'สรุปตลาดหนึ่งบรรทัด',
    level: 'neutral', label: 'ตลาดผสม ดัชนีขึ้น 2 จาก 4', className: 'text-sm', mark: 'direction',
  },
  {
    where: 'ChangesList.tsx:59',
    what: 'สิ่งที่เปลี่ยนไป · สัญลักษณ์',
    level: 'bad', label: 'RKLB', className: 'text-sm', mark: 'direction',
  },
  {
    where: 'WatchlistTable.tsx:122',
    what: 'วอตช์ลิสต์ · %วันนี้',
    level: 'good', label: '+2.14%', className: 'text-xs', mark: 'direction',
    figure: '$212.40', figureClass: 'figure text-sm font-bold text-[var(--text)]',
  },
  {
    where: 'WatchlistTable.tsx:135',
    what: 'วอตช์ลิสต์ · คำแนวโน้ม',
    level: 'weak', label: 'อ่อนแรง', className: 'text-xs', mark: 'direction',
  },
  {
    where: 'WatchlistV2Client.tsx:64',
    what: 'วอตช์ลิสต์เต็ม · TrendMark',
    level: 'good', label: 'ขาขึ้น', className: 'text-xs', mark: 'direction',
  },
  {
    where: 'WhatChangedCard.tsx:95',
    what: 'สิ่งที่เปลี่ยนไป (การ์ด)',
    level: 'good', label: 'AAPL ราคาขึ้นเหนือแนวต้าน 210 แล้ว', className: 'text-sm', mark: 'direction',
  },
  {
    where: 'StockSummaryCard.tsx:49',
    what: 'หน้าหุ้น · แถวสถานะ',
    level: 'neutral', label: 'ใกล้แนวต้าน', rowName: 'แนวต้าน', mark: 'direction',
  },
  {
    where: 'MarketSignalSection.tsx:696',
    what: 'สัญญาณตลาด · สถานะ',
    level: 'good', label: 'ขาขึ้นชัดเจน', className: 'font-sans text-sm', mark: 'direction',
  },
  {
    where: 'OptionsSignalSection.tsx:243',
    what: 'สัญญาณออปชัน · สถานะ',
    level: 'weak', label: 'สัญญาณขัดแย้งกัน', className: 'font-sans text-sm', mark: 'direction',
  },
  {
    where: 'SearchClient.tsx:206',
    what: 'ค้นหา · %วันนี้',
    level: 'good', label: '+0.48%', className: 'text-xs', mark: 'direction',
  },
  /* --- The four with no direction to point. They keep the coloured circle. --- */
  {
    where: 'DashboardClient.tsx:429',
    what: 'สถานะระบบ — KEEPS ITS DOT',
    level: 'neutral', label: 'กำลังเชื่อมต่อบางแหล่งข้อมูล', className: 'font-medium', mark: 'dot',
  },
  {
    where: 'DataState.tsx:145',
    what: 'ข้อมูลล่าสุด — KEEPS ITS DOT',
    level: 'neutral', label: 'ข้อมูลล่าสุด 27 ส.ค. 2569 11:30',
    className: 'text-xs font-normal', mark: 'dot',
  },
  {
    where: 'EventsList.tsx:98',
    what: 'ความสำคัญของ event — KEEPS ITS DOT',
    level: 'bad', label: 'สำคัญมาก', className: 'text-[11px]', mark: 'dot',
  },
  {
    where: 'StockPlannerWorkspace.tsx:948',
    what: 'สถานะแผน — KEEPS ITS DOT',
    level: 'good', label: 'สมเหตุสมผล', rowName: 'สถานะแผน', mark: 'dot',
  },
];

/**
 * One row of the sheet: where it lives, then the thing itself.
 *
 * `force` is the before/after switch. `dot` on every row is not an
 * approximation of the old rendering, it IS the old rendering — the same span,
 * the same emoji, the same 0.8em.
 */
function Row({ spec, force }: { spec: Specimen; force: StatusMarkKind | null }) {
  const mark = force ?? spec.mark;
  return (
    <li className="min-w-0 border-t border-[var(--hairline)] px-3 py-2.5" data-spec={spec.where}>
      <p className="text-[10px] leading-4 text-[var(--text-muted)]">
        {spec.what}
        {'  ·  '}
        <span className="font-mono">{spec.where}</span>
      </p>
      <div className="mt-1 min-w-0" data-spec-body="">
        {spec.figure && (
          <span className={`${spec.figureClass} mb-0.5 block truncate`}>{spec.figure}</span>
        )}
        {spec.rowName
          ? <StatusRow name={spec.rowName} level={spec.level} label={spec.label} mark={mark} />
          : <StatusLabel level={spec.level} label={spec.label} mark={mark} className={spec.className} />}
      </div>
    </li>
  );
}

/** The five levels in a column, so the shapes can be compared without hunting. */
function Vocabulary({ force }: { force: StatusMarkKind | null }) {
  const levels: StatusLevel[] = ['good', 'neutral', 'weak', 'bad', 'unknown'];
  return (
    <ul className="grid gap-1 px-3 py-2">
      {levels.map((level) => (
        <li key={level} className="flex items-baseline gap-2 text-sm" data-vocab={level}>
          <span className="w-16 shrink-0 font-mono text-[10px] text-[var(--text-muted)]">{level}</span>
          <StatusLabel level={level} mark={force ?? 'direction'} />
          <span className="ms-auto shrink-0 font-mono text-[10px] text-[var(--text-muted)]">
            {force === 'dot' ? 'dot' : STATUS_PRESENTATION[level].icon}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function Sheet({ force }: { force: StatusMarkKind | null }) {
  return (
    <div data-testid="status-mark-sheet" className="min-w-0">
      <div className="panel-quiet min-w-0 p-0">
        <p className="px-3 pt-3 text-sm font-semibold text-[var(--text)]">ห้าระดับ</p>
        <Vocabulary force={force} />
      </div>
      <div className="panel-quiet mt-3 min-w-0 p-0">
        <p className="px-3 pt-3 pb-1 text-sm font-semibold text-[var(--text)]">ทุกจุดที่ใช้</p>
        <ul className="min-w-0">
          {SPECIMENS.map((spec) => <Row key={spec.where} spec={spec} force={force} />)}
        </ul>
      </div>
    </div>
  );
}
