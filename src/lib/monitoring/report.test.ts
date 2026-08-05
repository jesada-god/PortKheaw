import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMonitoringEvent, captureServerError, parseSentryDsn, sentryEnvelope, setMonitoringSink,
} from './report';

afterEach(() => {
  setMonitoringSink(null);
  vi.unstubAllGlobals();
});

describe('the DSN', () => {
  it('parses a well-formed public DSN into an ingest endpoint', () => {
    const parsed = parseSentryDsn('https://abc123@o1.ingest.sentry.io/456');
    expect(parsed?.endpoint).toBe(
      'https://o1.ingest.sentry.io/api/456/envelope/?sentry_key=abc123&sentry_version=7',
    );
    expect(parsed?.publicKey).toBe('abc123');
  });

  it('answers null for anything malformed, rather than throwing in a catch block', () => {
    // This is called from inside error handlers on payment paths.
    for (const bad of [undefined, '', 'not a url', 'https://o1.ingest.sentry.io/456', 'https://abc@host/notanumber']) {
      expect(parseSentryDsn(bad)).toBeNull();
    }
  });
});

describe('the event', () => {
  it('reports a sanitized exception', () => {
    const event = buildMonitoringEvent({
      scope: 'billing.checkout',
      cause: new Error('failed with sk_live_ABCDEFGHIJKLMNOP'),
      context: { planKey: 'pro_monthly', email: 'reader@example.com' },
    });
    expect(event.message).toBe('failed with [redacted:provider-key]');
    expect(event.errorName).toBe('Error');
    expect(event.context).toEqual({ planKey: 'pro_monthly' });
    expect(event.level).toBe('error');
  });

  it('reports a message with no exception', () => {
    const event = buildMonitoringEvent({
      scope: 'billing.webhook.dead-letter',
      message: 'billing webhook dead-lettered',
      level: 'warning',
      context: { eventType: 'invoice.paid', attempt: 10 },
    });
    expect(event.errorName).toBeNull();
    expect(event.stack).toBeNull();
    expect(event.level).toBe('warning');
    expect(event.context).toEqual({ eventType: 'invoice.paid', attempt: 10 });
  });

  it('sanitizes a message supplied without an exception', () => {
    expect(buildMonitoringEvent({ scope: 'x', message: 'for reader@example.com' }).message)
      .toContain('[redacted:email]');
  });

  it('bounds the scope', () => {
    expect(buildMonitoringEvent({ scope: 'z'.repeat(200) }).scope.length).toBe(80);
  });
});

describe('capturing', () => {
  it('always writes a structured line, with or without a provider', () => {
    const lines: string[] = [];
    setMonitoringSink((line) => lines.push(line));

    captureServerError({ scope: 'scheduler.background-run', cause: new Error('boom') });

    expect(lines).toHaveLength(1);
    const written = JSON.parse(lines[0]);
    expect(written.event).toBe('server_error');
    expect(written.scope).toBe('scheduler.background-run');
    expect(written.message).toBe('boom');
  });

  it('never throws, whatever it is handed', () => {
    setMonitoringSink(() => { throw new Error('sink is broken'); });
    // A monitoring failure that breaks the request it was reporting on is worse
    // than no monitoring at all.
    expect(() => captureServerError({ scope: 'x', cause: new Error('y') })).not.toThrow();

    setMonitoringSink(null);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => captureServerError({ scope: 'x', cause: circular })).not.toThrow();
  });

  it('does not call out when no DSN is configured', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    setMonitoringSink(() => {});

    captureServerError({ scope: 'x', cause: new Error('y') });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the Sentry envelope', () => {
  const event = buildMonitoringEvent({
    scope: 'billing.checkout',
    cause: new Error('failed for reader@example.com'),
    context: { planKey: 'pro_monthly' },
  });

  it('is three newline-delimited JSON documents', () => {
    const lines = sentryEnvelope(event).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toEqual({ type: 'event' });
    const payload = JSON.parse(lines[2]);
    expect(payload.level).toBe('error');
    expect(payload.logger).toBe('billing.checkout');
    expect(payload.exception.values[0].type).toBe('Error');
  });

  it('ships only what the sanitizer already approved', () => {
    const envelope = sentryEnvelope(event);
    expect(envelope).not.toContain('reader@example.com');
    expect(envelope).toContain('[redacted:email]');
    expect(envelope).toContain('pro_monthly');
  });

  it('gives each event its own id, shared by header and payload', () => {
    const first = JSON.parse(sentryEnvelope(event).split('\n')[0]).event_id;
    const second = JSON.parse(sentryEnvelope(event).split('\n')[0]).event_id;
    expect(first).not.toBe(second);
    const lines = sentryEnvelope(event).split('\n');
    expect(JSON.parse(lines[0]).event_id).toBe(JSON.parse(lines[2]).event_id);
  });
});
