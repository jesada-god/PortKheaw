'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, Pencil, Pin, Plus, Star, Trash2 } from 'lucide-react';
import {
  createWatchlistAction,
  deleteWatchlistAction,
  renameWatchlistAction,
  setWatchlistPinAction,
} from '@/app/watchlist/actions';
import { Button } from '@/src/components/ui/Button';
import { EmptyState } from '@/src/components/ui/EmptyState';
import { useToast } from '@/src/components/ui/Toast';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { STATUS_PRESENTATION } from '@/src/lib/presentation/status';
import { checkWatchlistName } from '@/src/lib/watchlist/naming';
import { sortRowsByTrend, type WatchlistRow } from '@/src/lib/watchlist/rows';
import type { WatchlistSummary } from '@/src/lib/watchlist/types';

/**
 * The watchlist, rebuilt.
 *
 * ===========================================================================
 * FOUR COLUMNS, AND THE REST BEHIND A DISCLOSURE
 * ===========================================================================
 * Symbol, price, today, trend. That is what somebody scanning twelve holdings
 * is scanning for, and every extra column is paid for by all twelve rows at
 * once. The support level, the resistance, the volume and the report date are
 * real and are kept — one symbol at a time, in the expanded row, where a reader
 * has stopped scanning and started looking.
 *
 * The trend cell is a mark and a Thai word and nothing else. No score, no
 * percentage, no confidence: `trend.ts` has the measurement that settles why.
 *
 * ===========================================================================
 * THE SAME ROWS, TWO SHAPES
 * ===========================================================================
 * A table on a wide screen, cards on a phone — one rendering, `sortRowsByTrend`
 * for the cards because on a phone the order IS the interface. Both read the
 * same `rows` array, so a symbol cannot be present in one and missing from the
 * other.
 */

function formatPrice(value: number | null, currency: string) {
  if (value === null) return 'ยังไม่มีราคา';
  return `${value.toLocaleString('th-TH', { maximumFractionDigits: 4 })} ${currency}`;
}

function formatPercent(value: number | null) {
  if (value === null) return 'ยังไม่มีตัวเลข';
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${Math.abs(value).toFixed(2)}%`;
}

function percentTone(value: number | null) {
  if (value === null) return 'text-[var(--text-muted)]';
  if (value > 0) return 'text-[var(--positive)]';
  if (value < 0) return 'text-[var(--negative)]';
  return 'text-[var(--text-secondary)]';
}

/** The mark and the word, together. The mark is decorative; the word carries it. */
function TrendMark({ row }: { row: WatchlistRow }) {
  const presentation = STATUS_PRESENTATION[row.trend.level];
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden="true">{presentation.emoji}</span>
      <span className={`text-xs font-semibold text-[var(${presentation.token})]`}>{row.trend.word}</span>
    </span>
  );
}

function DetailRow({ row }: { row: WatchlistRow }) {
  const { expanded } = row;
  const entries: [string, string][] = [
    ['แนวรับ', expanded.support === null ? 'ยังไม่มีข้อมูล' : expanded.support.toLocaleString('th-TH', { maximumFractionDigits: 4 })],
    ['แนวต้าน', expanded.resistance === null ? 'ยังไม่มีข้อมูล' : expanded.resistance.toLocaleString('th-TH', { maximumFractionDigits: 4 })],
    ['ปริมาณซื้อขาย', expanded.volume === null ? 'ยังไม่มีข้อมูล' : expanded.volume.toLocaleString('th-TH')],
    ['ประกาศผลประกอบการ', expanded.earningsDays === null
      ? 'ยังไม่มีกำหนด'
      : expanded.earningsDays === 0 ? 'วันนี้' : `อีก ${expanded.earningsDays} วัน`],
  ];
  return (
    <div className="bg-[var(--surface-elevated)] px-4 py-3" data-testid={`watchlist-detail-${row.symbol}`}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {entries.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] text-[var(--text-muted)]">{label}</dt>
            <dd className="figure-data truncate text-sm text-[var(--text)]">{value}</dd>
          </div>
        ))}
      </dl>
      {/*
        Why this row may read ทรงตัว while the stock page says more. A cell that
        withheld a label and said nothing about it would look like a quiet tape,
        which is a different fact entirely.
      */}
      {row.trend.demoted && (
        <p className="mt-2 text-[11px] text-[var(--text-secondary)]">
          ข้อมูลบางส่วนของหุ้นตัวนี้ยังไม่ครบ จึงยังไม่สรุปแนวโน้มให้ชัดกว่านี้
        </p>
      )}
      <p className="mt-2 text-[11px] text-[var(--text-muted)]">{row.day.copy.caption}</p>
    </div>
  );
}

export function WatchlistV2Client({
  watchlist,
  lists,
  rows,
}: {
  watchlist: { id: string; name: string };
  lists: WatchlistSummary[];
  rows: WatchlistRow[];
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const isOnline = useOnlineStatus();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(watchlist.name);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [, startTransition] = useTransition();

  const cardRows = useMemo(() => sortRowsByTrend(rows), [rows]);
  /*
    The last list cannot be deleted. The rule is enforced in
    `public.delete_watchlist` under a lock — this only decides whether to OFFER
    the button, because a control that is always there and always fails is worse
    than one that is not there.
  */
  const isOnlyList = lists.length <= 1;

  function run(action: () => Promise<{ ok: boolean; message?: string }>, success: string) {
    if (!isOnline) {
      addToast({ title: 'แก้ไขรายการติดตามไม่ได้ขณะออฟไลน์', type: 'error' });
      return;
    }
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        addToast({ title: 'ไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      addToast({ title: success, type: 'success' });
      router.refresh();
    });
  }

  function submitRename() {
    const checked = checkWatchlistName(nameDraft);
    if (!checked.ok) {
      addToast({ title: 'เปลี่ยนชื่อไม่ได้', message: checked.message ?? undefined, type: 'error' });
      return;
    }
    setRenaming(false);
    run(() => renameWatchlistAction(watchlist.id, checked.normalized), 'เปลี่ยนชื่อแล้ว');
  }

  function submitCreate() {
    const checked = checkWatchlistName(createDraft);
    if (!checked.ok) {
      addToast({ title: 'สร้างไม่ได้', message: checked.message ?? undefined, type: 'error' });
      return;
    }
    setCreating(false);
    setCreateDraft('');
    run(() => createWatchlistAction(checked.normalized), 'สร้างรายการใหม่แล้ว');
  }

  return (
    <div className="space-y-4">
      {!isOnline && (
        <p className="rounded-[var(--radius-control)] border border-[var(--warning-line)] bg-[var(--warning-soft)] p-3 text-sm leading-6 text-[var(--warning)]">
          โหมดอ่านอย่างเดียวขณะออฟไลน์ — ราคาอาจเก่า และการแก้ไขรายการติดตามถูกปิดไว้
        </p>
      )}

      {/* The switcher. Every list the reader owns, oldest first. */}
      <div className="flex flex-wrap items-center gap-2">
        {lists.map((list) => (
          <button
            key={list.id}
            type="button"
            data-testid={`watchlist-tab-${list.id}`}
            onClick={() => router.push(`/watchlist?list=${encodeURIComponent(list.id)}`)}
            className={`min-h-11 rounded-full px-4 text-xs font-semibold ${
              list.id === watchlist.id
                ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text)]'
            }`}
            aria-current={list.id === watchlist.id ? 'true' : undefined}
          >
            {list.name} · {list.itemCount}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setCreating((open) => !open)}
          className="flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-semibold text-[var(--accent)]"
          data-testid="watchlist-create-open"
        >
          <Plus size={14} aria-hidden="true" /> สร้างรายการใหม่
        </button>
      </div>

      {creating && (
        <div className="panel flex flex-wrap items-center gap-2 p-3">
          <label htmlFor="watchlist-create-name" className="sr-only">ชื่อรายการใหม่</label>
          <input
            id="watchlist-create-name"
            value={createDraft}
            onChange={(event) => setCreateDraft(event.target.value)}
            maxLength={80}
            placeholder="เช่น หุ้นเทคโนโลยี"
            className="min-h-11 flex-1 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-sm text-[var(--text)]"
          />
          <Button size="sm" onClick={submitCreate} data-testid="watchlist-create-submit">สร้าง</Button>
          <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>ยกเลิก</Button>
        </div>
      )}

      <section className="panel min-w-0 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--hairline)] px-3.5 py-3 sm:px-4">
          {renaming ? (
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <label htmlFor="watchlist-rename" className="sr-only">เปลี่ยนชื่อรายการติดตาม</label>
              <input
                id="watchlist-rename"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                maxLength={80}
                className="min-h-11 flex-1 rounded-[var(--radius-control)] border border-[var(--border-strong)] bg-[var(--input-bg)] px-3 text-sm text-[var(--text)]"
              />
              <Button size="sm" onClick={submitRename} data-testid="watchlist-rename-submit">บันทึก</Button>
              <Button size="sm" variant="ghost" onClick={() => { setRenaming(false); setNameDraft(watchlist.name); }}>ยกเลิก</Button>
            </div>
          ) : (
            <div className="min-w-0">
              <h2 className="truncate text-sm font-bold text-[var(--text)]">{watchlist.name}</h2>
              <p className="text-xs text-[var(--text-muted)]">{rows.length} รายการ · ซิงก์กับบัญชีของคุณ</p>
            </div>
          )}
          {!renaming && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="เปลี่ยนชื่อรายการติดตาม"
                onClick={() => setRenaming(true)}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                <Pencil size={16} />
              </button>
              {/*
                No delete control at all on the last list — see `isOnlyList`.
                The reader is told why, rather than being given a button that
                exists only to refuse them.
              */}
              {isOnlyList ? (
                <span className="text-[11px] text-[var(--text-muted)]" data-testid="watchlist-delete-blocked">
                  ลบรายการสุดท้ายไม่ได้
                </span>
              ) : (
                <button
                  type="button"
                  aria-label="ลบรายการติดตามนี้"
                  onClick={() => setConfirmingDelete(true)}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] text-[var(--text-muted)] hover:bg-[var(--negative-soft)] hover:text-[var(--negative)]"
                  data-testid="watchlist-delete-open"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          )}
        </div>

        {/*
          Deleting takes a symbol list with it, so it takes a second, deliberate
          step. The confirmation names the list and says what goes — a dialog
          that only says "are you sure" asks the reader to remember which one
          they clicked.
        */}
        {confirmingDelete && (
          <div className="border-b border-[var(--hairline)] bg-[var(--negative-soft)] px-4 py-3" data-testid="watchlist-delete-confirm">
            <p className="text-sm text-[var(--text)]">
              ลบ “{watchlist.name}” พร้อมหุ้น {rows.length} ตัวในรายการนี้ใช่ไหม การลบย้อนกลับไม่ได้
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={() => { setConfirmingDelete(false); run(() => deleteWatchlistAction(watchlist.id), 'ลบรายการแล้ว'); }}
                data-testid="watchlist-delete-submit"
              >
                ลบรายการนี้
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>ยกเลิก</Button>
            </div>
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyState mascot icon={Star} title="รายการติดตามยังว่าง" description="ค้นหาและเพิ่มหุ้นที่คุณสนใจ" />
        ) : (
          <>
            {/* Wide screens: one row per symbol, four columns, expandable. */}
            <table className="hidden w-full table-fixed md:table" data-testid="watchlist-table">
              <thead>
                <tr className="border-b border-[var(--hairline)] text-left text-[11px] text-[var(--text-muted)]">
                  <th scope="col" className="w-[34%] px-4 py-2 font-medium">หุ้น</th>
                  <th scope="col" className="w-[22%] px-4 py-2 text-right font-medium">ราคา</th>
                  <th scope="col" className="w-[22%] px-4 py-2 text-right font-medium">{rows[0]!.day.copy.label}</th>
                  <th scope="col" className="w-[22%] px-4 py-2 font-medium">แนวโน้ม</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <Row key={row.id} row={row} expanded={expanded} onToggle={setExpanded} columns={4} />
                ))}
              </tbody>
            </table>

            {/*
              Phones: the same rows, ordered by how strongly the trend commits.
              A holding that is falling hard sorts alongside one that is rising —
              see `sortRowsByTrend` for why an order by "best first" would be the
              wrong optimism here.
            */}
            <ul className="divide-y divide-[var(--hairline)] md:hidden" data-testid="watchlist-cards">
              {cardRows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded((current) => (current === row.symbol ? null : row.symbol))}
                    aria-expanded={expanded === row.symbol}
                    className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left"
                    data-testid={`watchlist-card-${row.symbol}`}
                  >
                    <InstrumentLogo symbol={row.symbol} companyName={row.companyName} logoUrl={row.logoUrl} size={36} appearance="plain" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-[var(--text)]">{row.symbol}</span>
                      <TrendMark row={row} />
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="figure-data block text-sm text-[var(--text)]">{formatPrice(row.price, row.currency)}</span>
                      <span className={`figure block text-xs font-bold ${percentTone(row.day.changePercent)}`}>
                        {formatPercent(row.day.changePercent)}
                      </span>
                    </span>
                    <ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-[var(--text-muted)] ${expanded === row.symbol ? 'rotate-180' : ''}`} />
                  </button>
                  {expanded === row.symbol && <DetailRow row={row} />}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function Row({
  row,
  expanded,
  onToggle,
  columns,
}: {
  row: WatchlistRow;
  expanded: string | null;
  onToggle: (symbol: string | null) => void;
  columns: number;
}) {
  const isOpen = expanded === row.symbol;
  const { addToast } = useToast();
  const [, startTransition] = useTransition();
  return (
    <>
      <tr className="border-b border-[var(--hairline)] hover:bg-[var(--surface-hover)]">
        <td className="px-4 py-2.5">
          <button
            type="button"
            onClick={() => onToggle(isOpen ? null : row.symbol)}
            aria-expanded={isOpen}
            className="flex min-w-0 items-center gap-2 text-left"
            data-testid={`watchlist-row-${row.symbol}`}
          >
            <InstrumentLogo symbol={row.symbol} companyName={row.companyName} logoUrl={row.logoUrl} size={28} appearance="plain" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold text-[var(--text)]">{row.symbol}</span>
              <span className="block truncate text-[11px] text-[var(--text-muted)]">{row.companyName}</span>
            </span>
            <ChevronDown size={14} aria-hidden="true" className={`shrink-0 text-[var(--text-muted)] ${isOpen ? 'rotate-180' : ''}`} />
          </button>
        </td>
        <td className="figure-data px-4 py-2.5 text-right text-sm text-[var(--text)]">{formatPrice(row.price, row.currency)}</td>
        <td className={`figure px-4 py-2.5 text-right text-sm font-bold ${percentTone(row.day.changePercent)}`}>
          {formatPercent(row.day.changePercent)}
        </td>
        <td className="px-4 py-2.5">
          <span className="flex items-center justify-between gap-2">
            <TrendMark row={row} />
            <button
              type="button"
              aria-label={row.pinned ? `เลิกปักหมุด ${row.symbol}` : `ปักหมุด ${row.symbol} ไว้บนหน้าภาพรวม`}
              aria-pressed={row.pinned}
              onClick={() => startTransition(async () => {
                const result = await setWatchlistPinAction(row.watchlistId, row.symbol, !row.pinned);
                if (!result.ok) addToast({ title: 'ปักหมุดไม่สำเร็จ', message: result.message, type: 'error' });
              })}
              className={`flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-control)] ${row.pinned ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
              data-testid={`watchlist-pin-${row.symbol}`}
            >
              <Pin size={14} />
            </button>
          </span>
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={columns} className="p-0">
            <DetailRow row={row} />
          </td>
        </tr>
      )}
    </>
  );
}
