// @vitest-environment jsdom

/**
 * What the refund surfaces do with the seven-day window.
 *
 * The rule being pinned is that both of these render the window from the *row's
 * own* timestamps — the provider-confirmed `paidAt`, the server-derived deadline
 * and the database clock that came with them — and never from `Date.now()`. The
 * clock-skew test proves it the only way that matters: it moves the machine's
 * clock by a year in each direction and asserts the rendered text does not
 * change.
 *
 * Nothing here can file a request: the action module is a mock, asserted
 * uncalled.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refundDeadlineLabel } from '@/src/lib/billing/refund-window';
import type { BillingInvoiceView } from '@/src/lib/support/refund-repository';
import { BillingHistoryCard } from './BillingHistoryCard';
import { RefundRequestForm } from './RefundRequestForm';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal('React', React);

const mocks = vi.hoisted(() => ({ createRefundRequestAction: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/settings/refunds/actions', () => ({
  createRefundRequestAction: mocks.createRefundRequestAction,
}));

/** The database's clock for every fixture below. Never the machine's. */
const NOW = '2026-08-06T00:00:00.000Z';

function invoice(overrides: Partial<BillingInvoiceView> = {}): BillingInvoiceView {
  const paidAt = overrides.paidAt ?? '2026-08-05T00:00:00.000Z';
  return {
    invoiceRef: 'invoice-1',
    planKey: 'elite_monthly',
    status: 'paid',
    amountPaidMinor: 79_900,
    amountRefundedMinor: 0,
    currency: 'thb',
    periodStart: '2026-08-05T00:00:00.000Z',
    periodEnd: '2026-09-05T00:00:00.000Z',
    issuedAt: paidAt,
    paidAt,
    refundRequestStatus: null,
    refundDeadlineAt: new Date(Date.parse(paidAt) + 7 * 86_400_000).toISOString(),
    databaseNow: NOW,
    ...overrides,
  };
}

/** A day inside the window, and one well outside it. */
const INSIDE = invoice({ invoiceRef: 'inside', paidAt: '2026-08-05T00:00:00.000Z' });
const EXPIRED = invoice({ invoiceRef: 'expired', paidAt: '2026-07-01T00:00:00.000Z' });

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => { root.render(node); });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  vi.useRealTimers();
});

describe('the purchase list', () => {
  it('states the deadline and the time left on a charge still in its window', () => {
    render(<BillingHistoryCard invoices={[INSIDE]} />);
    const note = container.querySelector('[data-testid="refund-window-note"]');
    expect(note?.getAttribute('data-state')).toBe('open');
    expect(note?.textContent).toContain(refundDeadlineLabel(INSIDE.refundDeadlineAt));
    expect(note?.textContent).toContain('เหลืออีก 6 วัน');
  });

  /*
   * A reader whose window has closed is owed the date it closed on. A row that
   * quietly stops mentioning the deadline is a row that cannot answer "why not?".
   */
  it('still names the deadline once it has passed', () => {
    render(<BillingHistoryCard invoices={[EXPIRED]} />);
    const note = container.querySelector('[data-testid="refund-window-note"]');
    expect(note?.getAttribute('data-state')).toBe('closed');
    expect(note?.textContent).toContain('พ้นกำหนดขอคืนเงินแล้ว');
    expect(note?.textContent).toContain(refundDeadlineLabel(EXPIRED.refundDeadlineAt));
  });

  it('shows no window for a charge that was never collected', () => {
    render(<BillingHistoryCard invoices={[invoice({ status: 'open', paidAt: null, refundDeadlineAt: null })]} />);
    expect(container.querySelector('[data-testid="refund-window-note"]')).toBeNull();
  });
});

describe('the request form', () => {
  it('offers only the charges still inside their window', () => {
    render(<RefundRequestForm invoices={[INSIDE, EXPIRED]} />);
    const options = [...container.querySelectorAll('#refund-invoice option')];
    expect(options).toHaveLength(1);
    expect(options[0].getAttribute('value')).toBe('inside');
  });

  it('states the deadline for the charge currently selected', () => {
    render(<RefundRequestForm invoices={[INSIDE]} />);
    const deadline = container.querySelector('[data-testid="refund-window-deadline"]');
    expect(deadline?.textContent).toContain('ขอคืนเงินได้ถึง');
    expect(deadline?.textContent).toContain(refundDeadlineLabel(INSIDE.refundDeadlineAt));
  });

  /*
   * With nothing left to ask for, the form is replaced by an explanation that
   * names the rule and lists what expired — not by an empty select.
   */
  it('explains itself, and files nothing, when every window has closed', () => {
    render(<RefundRequestForm invoices={[EXPIRED]} />);
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('พ้นกำหนด 7 วัน');
    const expired = container.querySelector('[data-testid="refund-expired-list"]');
    expect(expired?.textContent).toContain(refundDeadlineLabel(EXPIRED.refundDeadlineAt));
    expect(mocks.createRefundRequestAction).not.toHaveBeenCalled();
  });

  it('drops a charge that already has an undecided request', () => {
    render(<RefundRequestForm invoices={[invoice({ refundRequestStatus: 'pending' })]} />);
    expect(container.querySelector('form')).toBeNull();
  });
});

/**
 * The property the whole window design rests on.
 */
describe('the device’s clock', () => {
  it('cannot extend or shorten what is rendered', () => {
    render(<BillingHistoryCard invoices={[INSIDE, EXPIRED]} />);
    const truth = [...container.querySelectorAll('[data-testid="refund-window-note"]')]
      .map((node) => `${node.getAttribute('data-state')}:${node.textContent}`);

    for (const pretend of ['2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(pretend));
      render(<BillingHistoryCard invoices={[]} />);
      render(<BillingHistoryCard invoices={[INSIDE, EXPIRED]} />);
      const under = [...container.querySelectorAll('[data-testid="refund-window-note"]')]
        .map((node) => `${node.getAttribute('data-state')}:${node.textContent}`);
      expect(under, pretend).toEqual(truth);
      vi.useRealTimers();
    }
  });

  it('cannot put an expired charge back in the form either', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    render(<RefundRequestForm invoices={[EXPIRED]} />);
    expect(container.querySelector('form')).toBeNull();
  });
});

/**
 * 320×720 and 390×844. jsdom measures nothing, so what is asserted is the
 * structure that lets a long Thai deadline sentence wrap instead of widening
 * the row.
 */
describe('at 320px and 390px', () => {
  it('wraps the deadline onto its own line inside the row', () => {
    render(<BillingHistoryCard invoices={[INSIDE]} />);
    const note = container.querySelector('[data-testid="refund-window-note"]');
    expect(note?.className).toContain('w-full');
    expect(note?.className).toContain('min-w-0');
    expect(note?.className).toContain('break-words');
    expect(container.querySelector('li')?.className).toContain('flex-wrap');
  });

  it('lets the form’s deadline line wrap too', () => {
    render(<RefundRequestForm invoices={[INSIDE]} />);
    const deadline = container.querySelector('[data-testid="refund-window-deadline"]');
    expect(deadline?.className).toContain('break-words');
    expect(container.querySelector('form')?.className).toContain('min-w-0');
  });
});
