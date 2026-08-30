/**
 * portkheaw/no-host-local-time
 *
 * The host-local `Date` readers are a build error inside the market-events
 * feature.
 *
 * WHY A LINT RULE AND NOT A CODE REVIEW NOTE. `getDate()` is correct on every
 * developer's laptop, correct in most tests, and wrong in production — the
 * Vercel server runs UTC and the reader's phone runs Asia/Bangkok, so an event
 * at 2:00 p.m. New York time (01:00 the next day in Bangkok) is filed on the
 * 16th by the server and the 17th by the browser. Nothing about that failure is
 * visible from the outside: both dates are plausible, both render cleanly, and
 * the hydration mismatch is the only symptom. A reviewer who knows all of this
 * still cannot reliably spot the one call that reintroduces it.
 *
 * So the calendar converts through `Intl.DateTimeFormat` with an explicit
 * `Asia/Bangkok`, in exactly one module, and this rule is what stops a second
 * path being opened later.
 *
 * WHAT IT DOES NOT FLAG: the `getUTC*` family. Those answer in UTC on every
 * machine, which is the property the local ones lack, and `time.ts` uses
 * `getUTCDay` deliberately on a value it built with `Date.UTC`.
 */

const BANNED = new Map([
  ['getDate', 'the day of the month in the HOST zone'],
  ['getMonth', 'the month in the HOST zone'],
  ['getDay', 'the weekday in the HOST zone'],
  ['getHours', 'the hour in the HOST zone'],
  ['getMinutes', 'the minute in the HOST zone'],
  ['getFullYear', 'the year in the HOST zone'],
]);

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Keep host-local Date readers out of the market-events calendar, where every '
        + 'instant must be resolved through the Asia/Bangkok Intl util instead.',
    },
    schema: [{
      type: 'object',
      properties: {
        allow: {
          type: 'array',
          items: { type: 'string' },
          description: 'Method names to permit despite the ban.',
        },
      },
      additionalProperties: false,
    }],
    messages: {
      hostLocal:
        '`{{name}}()` reads {{meaning}}. The Vercel server is UTC and the reader is in '
        + 'Bangkok, so this places an event on two different days depending on which '
        + 'machine renders it. Resolve the instant with bangkokParts / bangkokDayKey '
        + 'from src/lib/market-events/time.ts instead.',
    },
  },
  create(context) {
    const allow = new Set(context.options?.[0]?.allow ?? []);
    return {
      MemberExpression(node) {
        // `date.getDate()` and `date['getDate']()` are the same mistake.
        const name = node.computed
          ? (node.property.type === 'Literal' ? node.property.value : null)
          : node.property.name;
        if (typeof name !== 'string') return;
        if (!BANNED.has(name) || allow.has(name)) return;
        context.report({
          node: node.property,
          messageId: 'hostLocal',
          data: { name, meaning: BANNED.get(name) },
        });
      },
    };
  },
};

export default rule;
