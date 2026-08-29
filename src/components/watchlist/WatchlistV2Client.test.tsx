// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_MUST_NOT_SAY, NEVER_SAY } from '@/src/lib/presentation/banned-copy';
import type { WatchlistRow } from '@/src/lib/watchlist/rows';

/**
 * The screen, RENDERED AND HYDRATED — not read as source text.
 *
 * The same discipline `MarketStatusCard.test.tsx` states: a contract test that
 * greps a component proves a string exists in a file. It cannot tell whether
 * the string reaches a reader, whether the branch that prints it is reachable,
 * or whether a `null` slipped through as the text "null". And it certainly
 * cannot tell whether the expand row actually expands.
 *
 * So everything here mounts the real component into a real DOM, CLICKS things,
 * and asserts on `textContent` afterwards. The detail assertions in particular
 * are only meaningful post-interaction: a static render has no detail row at
 * all, so a source-reading test would happily pass on a component whose
 * disclosure never opened.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const actions = {
  createWatchlistAction: vi.fn(async () => ({ ok: true as const })),
  deleteWatchlistAction: vi.fn(async () => ({ ok: true as const })),
  renameWatchlistAction: vi.fn(async () => ({ ok: true as const })),
  setWatchlistPinAction: vi.fn(async () => ({ ok: true as const })),
};
vi.mock('@/app/watchlist/actions', () => actions);

const toasts: { title: string; message?: string }[] = [];
vi.mock('@/src/components/ui/Toast', () => ({
  useToast: () => ({ addToast: (toast: { title: string; message?: string }) => { toasts.push(toast); } }),
}));

vi.mock('@/src/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));

vi.mock('@/src/components/instruments/InstrumentLogo', () => ({
  InstrumentLogo: ({ symbol }: { symbol: string }) => <span>{symbol}</span>,
}));

const { WatchlistV2Client } = await import('./WatchlistV2Client');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  toasts.length = 0;
  Object.values(actions).forEach((action) => action.mockClear());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function row(overrides: Partial<WatchlistRow> = {}): WatchlistRow {
  return {
    id: `id-${overrides.symbol ?? 'AAPL'}`,
    symbol: 'AAPL',
    createdAt: '2026-01-01T00:00:00.000Z',
    watchlistId: 'list-1',
    pinned: false,
    companyName: 'Apple',
    logoUrl: null,
    price: 210.5,
    currency: 'USD',
    day: {
      change: 2.1,
      changePercent: 1.01,
      sessionDate: null,
      source: 'live',
      copy: { label: 'วันนี้', caption: 'ตลาดกำลังซื้อขายอยู่ ตัวเลขนี้ขยับตามราคาล่าสุด' },
    },
    trend: { level: 'good', word: 'ขาขึ้น', demoted: false },
    expanded: { support: 200, resistance: 220, volume: 1_200_000, earningsDays: 3 },
    ...overrides,
  };
}

const LISTS = [
  { id: 'list-1', name: 'รายการโปรด', createdAt: '2026-01-01T00:00:00.000Z', itemCount: 2 },
  { id: 'list-2', name: 'ระยะยาว', createdAt: '2026-02-01T00:00:00.000Z', itemCount: 1 },
];

function render(rows: WatchlistRow[], lists = LISTS) {
  act(() => {
    root.render(
      <WatchlistV2Client watchlist={{ id: 'list-1', name: 'รายการโปรด' }} lists={lists} rows={rows} />,
    );
  });
}

const text = () => container.textContent ?? '';

/**
 * Type into a CONTROLLED input the way a person does.
 *
 * Assigning `input.value` directly does not work on a React-controlled field:
 * React tracks the last value it wrote on the node, sees no change, and drops
 * the event — so the component's state never updates and the assertion that
 * follows is testing the initial render. Going through the prototype's own
 * setter is what makes React's tracker observe a real change.
 */
function type(selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(selector);
  if (!input) throw new Error(`no input for ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const click = (selector: string) => {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`no element for ${selector}`);
  act(() => { element.click(); });
};

describe('watchlist v2 — the main row', () => {
  it('shows the symbol, the price, today and the trend word', () => {
    render([row()]);
    expect(text()).toContain('AAPL');
    expect(text()).toContain('210.5');
    expect(text()).toContain('1.01%');
    expect(text()).toContain('ขาขึ้น');
  });

  /*
   * The split this whole screen is built around. Before anybody clicks, the
   * four extras must not be anywhere in the document — not hidden by CSS, not
   * rendered and collapsed. Absent.
   */
  it('keeps support, resistance, volume and earnings out of the collapsed row', () => {
    render([row()]);
    expect(text()).not.toContain('แนวรับ');
    expect(text()).not.toContain('แนวต้าน');
    expect(text()).not.toContain('ปริมาณซื้อขาย');
    expect(container.querySelector('[data-testid="watchlist-detail-AAPL"]')).toBeNull();
  });

  it('shows them once the row is expanded, and hides them again', () => {
    render([row()]);
    click('[data-testid="watchlist-row-AAPL"]');
    expect(text()).toContain('แนวรับ');
    expect(text()).toContain('แนวต้าน');
    expect(text()).toContain('220');
    expect(text()).toContain('1,200,000');
    expect(text()).toContain('อีก 3 วัน');

    click('[data-testid="watchlist-row-AAPL"]');
    expect(container.querySelector('[data-testid="watchlist-detail-AAPL"]')).toBeNull();
  });

  it('publishes no score or confidence percentage anywhere on the screen', () => {
    render([row()]);
    click('[data-testid="watchlist-row-AAPL"]');
    for (const banned of ['คะแนน', 'ความมั่นใจ', 'confidence', 'score']) {
      expect(text().toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
  });

  it('says nothing from either banned list, expanded or collapsed', () => {
    render([row({ trend: { level: 'neutral', word: 'ทรงตัว', demoted: true } })]);
    const collapsed = text();
    click('[data-testid="watchlist-row-AAPL"]');
    const opened = `${collapsed} ${text()}`;
    for (const phrase of [...CARD_MUST_NOT_SAY, ...NEVER_SAY]) {
      expect(opened, phrase).not.toContain(phrase);
    }
  });
});

describe('watchlist v2 — missing data', () => {
  it('never renders a null as text, and never as a calm zero', () => {
    render([row({
      price: null,
      day: {
        change: null, changePercent: null, sessionDate: null, source: null,
        copy: { label: 'วันนี้', caption: 'ยังไม่ได้ราคาปิดของหุ้นตัวนี้ จึงยังคำนวณตัวเลขวันนี้ไม่ได้ ระบบจะอัปเดตให้เมื่อได้ราคามา' },
      },
      trend: { level: 'unknown', word: 'ยังไม่มีข้อมูล', demoted: false },
      expanded: { support: null, resistance: null, volume: null, earningsDays: null },
    })]);
    click('[data-testid="watchlist-row-AAPL"]');
    expect(text()).not.toContain('null');
    expect(text()).not.toContain('NaN');
    expect(text()).not.toContain('0.00%');
    expect(text()).toContain('ยังไม่มีข้อมูล');
    expect(text()).toContain('ยังไม่มีราคา');
  });

  it('explains a withheld trend rather than letting it read as a quiet tape', () => {
    render([row({ trend: { level: 'neutral', word: 'ทรงตัว', demoted: true } })]);
    click('[data-testid="watchlist-row-AAPL"]');
    expect(text()).toContain('ข้อมูลบางส่วน');
  });
});

describe('watchlist v2 — the session label', () => {
  it('labels the column วันนี้ while the market is trading', () => {
    render([row()]);
    expect(text()).toContain('วันนี้');
    click('[data-testid="watchlist-row-AAPL"]');
    expect(text()).toContain('ตลาดกำลังซื้อขายอยู่');
  });

  /*
   * Closed. The column header takes the label the shared copy module produced,
   * so a figure from Friday's close is headed วันศุกร์ rather than วันนี้ — the
   * failure this replaces is a weekend page captioned "today" over Friday's
   * numbers.
   */
  it('names the day the figure came from once the market is shut', () => {
    render([row({
      day: {
        change: 2.1, changePercent: 1.01, sessionDate: '2026-08-28', source: 'snapshot',
        copy: { label: 'วันศุกร์', caption: 'ตลาดยังไม่เปิด ตัวเลขนี้คือราคาปิดของวันศุกร์ที่ 28 ส.ค. 2026' },
      },
    })]);
    expect(container.querySelector('[data-testid="watchlist-table"]')?.textContent).toContain('วันศุกร์');
    click('[data-testid="watchlist-row-AAPL"]');
    expect(text()).toContain('ราคาปิดของวันศุกร์');
  });
});

describe('watchlist v2 — mobile order', () => {
  it('puts the most pronounced trends first and a missing reading last', () => {
    render([
      row({ id: 'a', symbol: 'FLAT', trend: { level: 'neutral', word: 'ทรงตัว', demoted: false } }),
      row({ id: 'b', symbol: 'GONE', trend: { level: 'unknown', word: 'ยังไม่มีข้อมูล', demoted: false } }),
      row({ id: 'c', symbol: 'DOWN', trend: { level: 'bad', word: 'ขาลง', demoted: false } }),
      row({ id: 'd', symbol: 'UPUP', trend: { level: 'good', word: 'ขาขึ้น', demoted: false } }),
    ]);
    const cards = [...container.querySelectorAll('[data-testid="watchlist-cards"] [data-testid^="watchlist-card-"]')];
    const order = cards.map((card) => card.getAttribute('data-testid')!.replace('watchlist-card-', ''));
    // A fall is as prominent as a rise; the tie between them breaks by symbol.
    expect(order).toEqual(['DOWN', 'UPUP', 'FLAT', 'GONE']);
  });

  it('renders the same symbols in the table as in the cards', () => {
    const rows = [row({ id: 'a', symbol: 'AAA' }), row({ id: 'b', symbol: 'BBB' })];
    render(rows);
    const inTable = [...container.querySelectorAll('[data-testid^="watchlist-row-"]')]
      .map((node) => node.getAttribute('data-testid')!.replace('watchlist-row-', '')).sort();
    const inCards = [...container.querySelectorAll('[data-testid^="watchlist-card-"]')]
      .map((node) => node.getAttribute('data-testid')!.replace('watchlist-card-', '')).sort();
    expect(inTable).toEqual(inCards);
  });
});

describe('watchlist v2 — several lists', () => {
  it('shows every list the reader owns with its count', () => {
    render([row()]);
    expect(text()).toContain('รายการโปรด');
    expect(text()).toContain('ระยะยาว');
  });

  it('refuses an empty name without calling the server', () => {
    render([row()]);
    click('[data-testid="watchlist-create-open"]');
    type('#watchlist-create-name', '   ');
    click('[data-testid="watchlist-create-submit"]');
    expect(actions.createWatchlistAction).not.toHaveBeenCalled();
    expect(toasts.at(-1)?.title).toBe('สร้างไม่ได้');
  });

  it('sends a trimmed name for a valid create', () => {
    render([row()]);
    click('[data-testid="watchlist-create-open"]');
    type('#watchlist-create-name', '  หุ้นเทค  ');
    click('[data-testid="watchlist-create-submit"]');
    expect(actions.createWatchlistAction).toHaveBeenCalledWith('หุ้นเทค');
  });

  it('renames the list that is open, named explicitly', () => {
    render([row()]);
    click('[aria-label="เปลี่ยนชื่อรายการติดตาม"]');
    type('#watchlist-rename', 'ชื่อใหม่');
    click('[data-testid="watchlist-rename-submit"]');
    expect(actions.renameWatchlistAction).toHaveBeenCalledWith('list-1', 'ชื่อใหม่');
  });

  /*
   * Deleting takes a list of symbols with it, so one click must not do it. The
   * first click only opens a confirmation that NAMES the list and says what
   * goes.
   */
  it('does not delete on the first click', () => {
    render([row()]);
    click('[data-testid="watchlist-delete-open"]');
    expect(actions.deleteWatchlistAction).not.toHaveBeenCalled();
    const confirm = container.querySelector('[data-testid="watchlist-delete-confirm"]')!;
    expect(confirm.textContent).toContain('รายการโปรด');
    expect(confirm.textContent).toContain('ย้อนกลับไม่ได้');

    click('[data-testid="watchlist-delete-submit"]');
    expect(actions.deleteWatchlistAction).toHaveBeenCalledWith('list-1');
  });

  it('offers no delete control at all on the only list, and says why', () => {
    render([row()], [LISTS[0]!]);
    expect(container.querySelector('[data-testid="watchlist-delete-open"]')).toBeNull();
    expect(text()).toContain('ลบรายการสุดท้ายไม่ได้');
  });

  it('pins a row into the list the row belongs to', () => {
    render([row({ watchlistId: 'list-2', pinned: false })]);
    click('[data-testid="watchlist-pin-AAPL"]');
    expect(actions.setWatchlistPinAction).toHaveBeenCalledWith('list-2', 'AAPL', true);
  });
});
