// @vitest-environment jsdom

/**
 * Session icon contract: which Material Symbols glyph each session gets, which
 * theme token colors it, and that every icon carries a Thai accessible name.
 *
 * The glyph/tone mapping is asserted against the SESSION RESOLVER's own output
 * rather than a hand-written table, so the icon a reader sees is provably the one
 * the resolved phase + close reason dictate.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveCurrentMarketSession,
  sessionPresentation,
  type MarketCloseReason,
  type MarketSessionPhase,
  type SessionIconName,
  type SessionTone,
} from '@/src/lib/market-data/current-session';
import { SessionIcon } from './SessionIcon';

vi.stubGlobal('React', React);

function render(phase: MarketSessionPhase, closeReason: MarketCloseReason | null): string {
  const view = sessionPresentation(phase, closeReason);
  return renderToStaticMarkup(
    <SessionIcon name={view.icon} tone={view.tone} title={view.description} />,
  );
}

describe('12. session icon mapping', () => {
  it.each([
    ['PRE', null, 'wb_twilight'],
    ['REGULAR', null, 'sunny'],
    ['POST', null, 'bedtime'],
    // A closure the calendar can explain gets the calendar glyph…
    ['CLOSED', 'HOLIDAY', 'event'],
    ['CLOSED', 'EVENT', 'event'],
    // …and an ordinary evening, a weekend or an early close all read as "the day
    // is over", which is one fact and therefore one glyph.
    ['CLOSED', 'NORMAL', 'bedtime'],
    ['CLOSED', 'WEEKEND', 'bedtime'],
    ['CLOSED', 'EARLY_CLOSE', 'bedtime'],
  ] as const)('maps %s / %s to the %s glyph', (phase, closeReason, icon: SessionIconName) => {
    expect(sessionPresentation(phase, closeReason).icon).toBe(icon);
    expect(render(phase, closeReason)).toContain(`data-session-icon="${icon}"`);
  });

  it('uses no emoji anywhere in the session status text or icon', () => {
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
    for (const [phase, reason] of [
      ['PRE', null], ['REGULAR', null], ['POST', null],
      ['CLOSED', 'NORMAL'], ['CLOSED', 'WEEKEND'], ['CLOSED', 'HOLIDAY'],
      ['CLOSED', 'EVENT'], ['CLOSED', 'EARLY_CLOSE'],
    ] as const) {
      const view = sessionPresentation(phase, reason);
      expect(view.label).not.toMatch(emoji);
      expect(view.description).not.toMatch(emoji);
      expect(render(phase, reason)).not.toMatch(emoji);
    }
  });

  it('renders a real inlined SVG path rather than a web-font ligature', () => {
    // A `font-src 'self' data:` CSP blocks the Google Fonts icon file, so a
    // ligature would render as the literal text "wb_twilight" in production.
    const markup = render('PRE', null);
    expect(markup).toContain('<svg');
    expect(markup).toMatch(/<path d="M[\d.]/);
    expect(markup).not.toContain('material-symbols');
  });

  it('drives the icon from the calendar-resolved session, not a caller-chosen label', () => {
    // Sunday 2026-07-26, 13:00 ET.
    const weekend = resolveCurrentMarketSession({ now: '2026-07-26T17:00:00.000Z' });
    expect(sessionPresentation(weekend.phase, weekend.closeReason).icon).toBe('bedtime');

    // Independence Day observed, Friday 2026-07-03.
    const holiday = resolveCurrentMarketSession({ now: '2026-07-03T17:00:00.000Z' });
    expect(sessionPresentation(holiday.phase, holiday.closeReason).icon).toBe('event');

    // Wednesday 2026-07-29, 11:00 ET.
    const regular = resolveCurrentMarketSession({ now: '2026-07-29T15:00:00.000Z' });
    expect(sessionPresentation(regular.phase, regular.closeReason).icon).toBe('sunny');

    // Wednesday 2026-07-29, 16:30 ET.
    const post = resolveCurrentMarketSession({ now: '2026-07-29T20:30:00.000Z' });
    expect(sessionPresentation(post.phase, post.closeReason).icon).toBe('bedtime');

    // Wednesday 2026-07-29, 08:30 ET.
    const pre = resolveCurrentMarketSession({ now: '2026-07-29T12:30:00.000Z' });
    expect(sessionPresentation(pre.phase, pre.closeReason).icon).toBe('wb_twilight');
  });
});

describe('13. session icon colors', () => {
  it.each([
    ['PRE', null, 'pre'],
    ['REGULAR', null, 'regular'],
    ['POST', null, 'post'],
    ['CLOSED', 'NORMAL', 'closed'],
    ['CLOSED', 'WEEKEND', 'closed'],
    ['CLOSED', 'EARLY_CLOSE', 'closed'],
    ['CLOSED', 'HOLIDAY', 'event'],
    ['CLOSED', 'EVENT', 'event'],
  ] as const)('colors %s / %s with the %s tone', (phase, closeReason, tone: SessionTone) => {
    expect(sessionPresentation(phase, closeReason).tone).toBe(tone);
    expect(render(phase, closeReason)).toContain(`data-session-tone="${tone}"`);
  });

  it('resolves every tone through a theme token, never a hardcoded hex', () => {
    for (const [phase, reason] of [
      ['PRE', null], ['REGULAR', null], ['POST', null],
      ['CLOSED', 'NORMAL'], ['CLOSED', 'HOLIDAY'],
    ] as const) {
      const markup = render(phase, reason);
      expect(markup).toMatch(/class="[^"]*text-session-(pre|regular|post|closed|event)/);
      // Any literal colour in the markup would bypass light/dark theming entirely.
      expect(markup).not.toMatch(/#[0-9A-Fa-f]{3,6}/);
      expect(markup).toContain('fill="currentColor"');
    }
  });

  it('never reuses the gain/loss classes for a session icon', () => {
    for (const [phase, reason] of [
      ['PRE', null], ['REGULAR', null], ['POST', null], ['CLOSED', 'NORMAL'], ['CLOSED', 'EVENT'],
    ] as const) {
      const markup = render(phase, reason);
      expect(markup).not.toContain('text-positive');
      expect(markup).not.toContain('text-negative');
    }
  });
});

describe('14. session icon accessibility', () => {
  it('gives every icon a Thai accessible name and a matching tooltip', () => {
    for (const [phase, reason] of [
      ['PRE', null], ['REGULAR', null], ['POST', null],
      ['CLOSED', 'NORMAL'], ['CLOSED', 'WEEKEND'], ['CLOSED', 'HOLIDAY'],
      ['CLOSED', 'EVENT'], ['CLOSED', 'EARLY_CLOSE'],
    ] as const) {
      const view = sessionPresentation(phase, reason);
      const markup = render(phase, reason);
      expect(markup).toContain('role="img"');
      expect(markup).toContain(`aria-label="${view.description}"`);
      expect(markup).toContain(`<title>${view.description}</title>`);
      // Thai script, so the name is readable to the audience it is written for.
      expect(view.description).toMatch(/[฀-๿]/);
    }
  });

  it('states the Thai status text the spec requires for each session', () => {
    expect(sessionPresentation('PRE', null).label).toBe('ก่อนเปิดตลาด');
    expect(sessionPresentation('REGULAR', null).label).toBe('ตลาดเปิด');
    expect(sessionPresentation('POST', null).label).toBe('หลังปิดตลาด');
    expect(sessionPresentation('CLOSED', 'NORMAL').label).toBe('ปิดตลาด');
    expect(sessionPresentation('CLOSED', 'HOLIDAY').label).toContain('วันหยุด');
    expect(sessionPresentation('CLOSED', 'EVENT').label).toContain('เหตุการณ์พิเศษ');
  });

  it('does not claim the market is closed when the session is merely unresolved', () => {
    // CLOSED price rules are applied for safety, but asserting "ปิดตลาด" would state
    // a fact that could not be established.
    const view = sessionPresentation('CLOSED', null, 'UNKNOWN');
    expect(view.label).toBe('ไม่ทราบสถานะตลาด');
    expect(view.label).not.toContain('ปิดตลาด');
    expect(view.description).toContain('ราคาปิดจริงของวันซื้อขายล่าสุด');
    expect(view.tone).toBe('closed');
  });

  it('keeps a halted symbol truthful about both facts at once', () => {
    // The market is open; this one symbol is paused. Collapsing either fact loses
    // information a reader needs.
    const view = sessionPresentation('REGULAR', null, 'HALTED');
    expect(view.label).toContain('ตลาดเปิด');
    expect(view.label).toContain('หยุดซื้อขายชั่วคราว');
    expect(view.tone).toBe('closed');
  });
});
