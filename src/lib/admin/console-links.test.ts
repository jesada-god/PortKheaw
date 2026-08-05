import { describe, expect, it } from 'vitest';
import {
  stripeCustomerUrl, stripeEventUrl, stripeInvoiceUrl, supabaseAccountUrl, supabaseProjectRef,
} from './console-links';

describe('provider deep links', () => {
  it('separates test from live, so an operator never lands in the wrong ledger', () => {
    expect(stripeInvoiceUrl('live', 'in_1QxAbCdEfGhIjKlMn'))
      .toBe('https://dashboard.stripe.com/invoices/in_1QxAbCdEfGhIjKlMn');
    expect(stripeInvoiceUrl('test', 'in_1QxAbCdEfGhIjKlMn'))
      .toBe('https://dashboard.stripe.com/test/invoices/in_1QxAbCdEfGhIjKlMn');
  });

  it('builds nothing at all from a value that is not an identifier', () => {
    // No link is strictly better than a link somewhere unintended.
    for (const bad of [null, undefined, '', '   ', 'javascript:alert(1)', '../../admin', 'in_', 'in_short']) {
      expect(stripeInvoiceUrl('live', bad)).toBeNull();
    }
  });

  it('trims the incidental whitespace a copy-paste carries', () => {
    // Trimming is safe — the pattern still has to match afterwards — and it is
    // the difference between a working link and a dead one for a value an
    // operator pasted from somewhere else.
    expect(stripeInvoiceUrl('live', '  in_1QxAbCdEfGhIjKlMn  '))
      .toBe('https://dashboard.stripe.com/invoices/in_1QxAbCdEfGhIjKlMn');
  });

  it('refuses anything carrying a path or a query', () => {
    expect(stripeInvoiceUrl('live', 'in_1Qx/../events')).toBeNull();
    expect(stripeInvoiceUrl('live', 'in_1Qx?foo=bar')).toBeNull();
    expect(stripeInvoiceUrl('live', 'in_1Qx#frag')).toBeNull();
  });

  it('links customers and events by the same rule', () => {
    expect(stripeCustomerUrl('live', 'cus_ABCDEFGHIJKL')).toContain('/customers/cus_ABCDEFGHIJKL');
    expect(stripeEventUrl('test', 'evt_ABCDEFGHIJKL')).toContain('/test/events/evt_ABCDEFGHIJKL');
    expect(stripeCustomerUrl('live', 'not-a-customer')).toBeNull();
  });
});

describe('the Supabase project reference', () => {
  it('comes from the public API URL, never from a key', () => {
    expect(supabaseProjectRef('https://abcdefghijklmnopqrst.supabase.co'))
      .toBe('abcdefghijklmnopqrst');
  });

  it('answers null for anything it cannot parse', () => {
    expect(supabaseProjectRef(undefined)).toBeNull();
    expect(supabaseProjectRef('')).toBeNull();
    expect(supabaseProjectRef('not a url')).toBeNull();
    expect(supabaseProjectRef('https://localhost:54321')).toBeNull();
  });
});

describe('account links', () => {
  const ref = 'abcdefghijklmnopqrst';

  it('links an account by our own uuid', () => {
    const url = supabaseAccountUrl(ref, '52e7b434-1dca-4636-88ab-ea9bdf063761');
    expect(url).toContain(`/project/${ref}/auth/users`);
    expect(url).toContain('52e7b434-1dca-4636-88ab-ea9bdf063761');
  });

  it('builds nothing without a project or without a uuid', () => {
    expect(supabaseAccountUrl(null, '52e7b434-1dca-4636-88ab-ea9bdf063761')).toBeNull();
    expect(supabaseAccountUrl(ref, 'not-a-uuid')).toBeNull();
    expect(supabaseAccountUrl(ref, null)).toBeNull();
  });

  it('encodes what it interpolates', () => {
    // Belt and braces: the uuid pattern already refuses this input.
    expect(supabaseAccountUrl(ref, '52e7b434-1dca-4636-88ab-ea9bdf06376 ')).toBeNull();
  });
});
