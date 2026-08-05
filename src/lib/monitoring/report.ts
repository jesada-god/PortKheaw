import 'server-only';

import { serverEnv } from '@/src/config/env/server';
import {
  sanitizeContext,
  sanitizeError,
  type MonitoringContext,
} from './sanitize';

/**
 * Where server-side failures go.
 *
 * This product has no monitoring provider connected today. That is a reason to
 * build the capture points now rather than later, not a reason to skip them: the
 * places worth reporting from — a checkout that failed at the provider, a webhook
 * that dead-lettered, a reconciliation pass that threw, a scheduler tick that
 * died — are the ones nobody is watching a log for at 03:00, and wiring them
 * afterwards means finding all of them again under pressure.
 *
 * So the reporter always runs. With no DSN it writes one structured, sanitized
 * line to the platform's log, which is a real destination — Vercel keeps and
 * searches it. With a DSN it additionally ships a Sentry-compatible event. The
 * redaction, the context allowlist and their tests are identical either way, so
 * connecting a provider later is a configuration change and not a code change.
 *
 * Nothing in here can throw. A monitoring failure that breaks the request it was
 * reporting on is worse than no monitoring.
 */

export type MonitoringLevel = 'error' | 'warning';

export interface CaptureInput {
  /** What failed, as a stable slug: `billing.checkout`, `webhook.dead-letter`. */
  scope: string;
  cause?: unknown;
  /** A short, secret-free description when there is no exception to report. */
  message?: string;
  level?: MonitoringLevel;
  context?: Record<string, unknown>;
}

interface SentryDsn {
  endpoint: string;
  publicKey: string;
}

/**
 * `https://<key>@<host>/<project>` → the ingest endpoint for that project.
 *
 * Parsed rather than pattern-matched so a malformed value yields `null` and the
 * reporter silently falls back to logging, instead of throwing inside a catch
 * block somewhere in a payment path.
 */
export function parseSentryDsn(dsn: string | undefined): SentryDsn | null {
  if (!dsn) return null;
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\/+/, '');
    if (!url.username || !projectId || !/^\d+$/.test(projectId)) return null;
    return {
      // The public key travels as the documented query parameter rather than an
      // `X-Sentry-Auth` header, so the request carries no custom header and no
      // preflight concern if it is ever issued from anywhere but a server.
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/`
        + `?sentry_key=${encodeURIComponent(url.username)}&sentry_version=7`,
      publicKey: url.username,
    };
  } catch {
    return null;
  }
}

let cachedDsn: SentryDsn | null | undefined;

function dsn(): SentryDsn | null {
  cachedDsn ??= parseSentryDsn(serverEnv.SENTRY_DSN);
  return cachedDsn;
}

/** Test seam, so the reporter's own behaviour is observable without a network. */
export type MonitoringSink = (line: string) => void;
let sink: MonitoringSink = (line) => console.error(line);
export function setMonitoringSink(next: MonitoringSink | null): void {
  sink = next ?? ((line) => console.error(line));
  cachedDsn = undefined;
}

export interface MonitoringEvent {
  event: 'server_error';
  level: MonitoringLevel;
  scope: string;
  message: string;
  errorName: string | null;
  stack: string | null;
  context: MonitoringContext;
  observedAt: string;
}

/** The sanitized record, exposed so the capture points can be tested directly. */
export function buildMonitoringEvent(input: CaptureInput): MonitoringEvent {
  const level = input.level ?? 'error';
  const error = input.cause === undefined ? null : sanitizeError(input.cause);
  return {
    event: 'server_error',
    level,
    scope: input.scope.slice(0, 80),
    message: error?.message ?? sanitizeContextMessage(input.message),
    errorName: error?.name ?? null,
    stack: error?.stack ?? null,
    context: sanitizeContext(input.context),
    observedAt: new Date().toISOString(),
  };
}

function sanitizeContextMessage(message: string | undefined): string {
  if (!message) return 'unspecified failure';
  return sanitizeError(message).message;
}

/**
 * Report a server-side failure.
 *
 * Deliberately returns `void` and is never awaited by its callers: a capture is
 * best-effort, and a payment path must not wait on a monitoring host.
 */
export function captureServerError(input: CaptureInput): void {
  let event: MonitoringEvent;
  try {
    event = buildMonitoringEvent(input);
  } catch {
    return;
  }

  try {
    sink(JSON.stringify(event));
  } catch {
    // A logging sink that throws is not worth a second attempt.
  }

  const target = dsn();
  if (!target) return;

  try {
    const envelope = sentryEnvelope(event);
    void fetch(target.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope' },
      body: envelope,
      // The report must not outlive the request it describes by much, and must
      // never keep a serverless function alive waiting for an ingest host.
      signal: AbortSignal.timeout(2_000),
      cache: 'no-store',
    }).catch(() => {});
  } catch {
    // No DSN reachable, malformed envelope, or `fetch` unavailable. The
    // structured line above is already written, which is the guarantee.
  }
}

/**
 * A Sentry envelope, built by hand.
 *
 * The SDK is not a dependency on purpose: it is large, it instruments globals,
 * and everything this product needs from it is one POST of a well-specified
 * document. If a full SDK is wanted later, these capture points are already in
 * the right places and only this function changes.
 */
export function sentryEnvelope(event: MonitoringEvent): string {
  const eventId = crypto.randomUUID().replace(/-/g, '');
  const header = JSON.stringify({
    event_id: eventId,
    sent_at: event.observedAt,
    sdk: { name: 'portkheaw.minimal', version: '1' },
  });
  const itemHeader = JSON.stringify({ type: 'event' });
  const payload = JSON.stringify({
    event_id: eventId,
    timestamp: event.observedAt,
    platform: 'node',
    level: event.level,
    logger: event.scope,
    environment: serverEnv.SENTRY_ENVIRONMENT ?? 'production',
    release: process.env.VERCEL_GIT_COMMIT_SHA ?? undefined,
    message: { formatted: event.message },
    exception: event.errorName
      ? { values: [{ type: event.errorName, value: event.message }] }
      : undefined,
    extra: { stack: event.stack, ...event.context },
    tags: { scope: event.scope },
  });
  return `${header}\n${itemHeader}\n${payload}\n`;
}
