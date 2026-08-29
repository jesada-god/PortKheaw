import { defineConfig } from "eslint/config";
import next from "eslint-config-next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import noUnsourcedFrameWord from "./eslint-rules/no-unsourced-frame-word.mjs";
import noBannedCopy from "./eslint-rules/no-banned-copy.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig([
    {
        extends: [...next],
    },
    {
        /*
         * =====================================================================
         * EVERY FILE THAT CAN HAND A READER A STRING. Not a list of folders.
         * =====================================================================
         *
         * The phrases and the reasoning are in
         * `src/lib/presentation/banned-copy.ts`. What matters here is the SCOPE,
         * and the scope is now an inversion of what it was, because the shape of
         * the old one was itself the recurring bug.
         *
         * It began as an allow-list of "the five pages a reader spends time on
         * plus the components those pages are assembled from", and every few
         * weeks something turned out to be outside it. Portfolio was, so every
         * day-figure caption on `/portfolio` went unscanned. `src/lib/portfolio`
         * was, because the sentences are composed there and passed down as
         * props. `src/config` was, because a rule table is not usually copy —
         * except the one that carries `labelTh` for every figure on the Market
         * Status card. Each was found the same way, patched the same way, and
         * the next gap was already open.
         *
         * An audit settled it. A banned phrase was planted as a live string
         * literal in 29 files spread across `app/`, `src/components/` and
         * `src/lib/` — settings, pricing, support, sign-in, admin, alerts,
         * notifications, watchlist, upcoming, not-found, the error boundary,
         * subscription, auth, news, layout, the billing reminders, the
         * notification copy, the alert engine, the market-signal engine, the
         * security lockdown — and eslint reported nothing on ALL 29. The rule
         * was not clearing the product's copy. It was reading a corner of it.
         *
         * So the question the scope answers is no longer "which folders have we
         * remembered" but "what can reach a reader", and the answer is: the app
         * routes, everything under `src`, the middleware (which composes the
         * lockdown and maintenance responses a reader actually sees), and the
         * gateway service. A new folder is covered the day it is created, which
         * is the only version of this that stops needing an audit.
         *
         * WHAT IS DELIBERATELY OUT:
         *   * tests — a test asserting a phrase is absent has to name it, and
         *     holding the assertion to the rule would ban checking it;
         *   * `banned-copy.ts` — the list itself, for the same reason;
         *   * `scripts/` — developer tooling whose output goes to a terminal,
         *     never to a reader. If a script ever grows reader-facing copy it
         *     is in the wrong place, and that is the bug to fix rather than the
         *     scope.
         */
        files: [
            "app/**/*.{ts,tsx}",
            "src/**/*.{ts,tsx}",
            "middleware.ts",
            "services/**/*.ts",
        ],
        ignores: ["**/*.test.ts", "**/*.test.tsx", "**/banned-copy.ts"],
        plugins: {
            portkheaw: { rules: { "no-banned-copy": noBannedCopy } },
        },
        rules: {
            "portkheaw/no-banned-copy": "error",
        },
    },
    {
        /*
         * The card's copy layer, held to the card's vocabulary.
         *
         * Every file in the market-signal folder that a reader's eyes end up
         * in, not just the reason table — the second collision of this kind
         * (`pre_earnings_breakout: 'ออกนอกกรอบก่อนงบ'`) was a flag chip in the
         * component, in a plain-string table the reason-scoped rule could not
         * see. Tests are excluded: they assert the copy, they are not copy, and
         * holding them to the rule would mean maintaining the allow list twice.
         *
         * `src/lib/analytics/market-signal` JOINS THE SCOPE. The audit planted
         * "กรอบ" in `calculations.ts` and eslint reported nothing — and that file
         * is not incidental to this rule, it is where the engine composes the
         * reason and note copy the bar prints. Two of its strings already say
         * "กรอบ" (the ATR-band notes at ~1675 and ~1683). They pass, because the
         * code around them reads `zones`, which is exactly the proof the rule
         * asks for; the point is that until now nothing had checked.
         *
         * WHY THIS ONE IS NOT WIDENED PRODUCT-WIDE, unlike the banned-copy rule
         * above. `FRAME_WORD` is matched as a SUBSTRING, and "กรอบ" is a
         * substring of ordinary Thai words that have nothing to do with a price
         * frame — "ทุกรอบ" (every cycle), "อีกรอบ" (again), "หลายรอบ". Those
         * appear across the subscription copy, the support FAQ and the options
         * simulator, and scoping the rule to them would produce false positives
         * that could only be silenced by allow-listing unrelated sentences —
         * which would turn the allow list from a record of frame provenance into
         * noise, and destroy the one thing that makes it worth reading.
         */
        files: [
            "src/components/analytics/market-signal/**/*.{ts,tsx}",
            "src/lib/analytics/market-signal/**/*.ts",
        ],
        ignores: ["**/*.test.ts", "**/*.test.tsx"],
        plugins: {
            "market-signal": { rules: { "no-unsourced-frame-word": noUnsourcedFrameWord } },
        },
        rules: {
            "market-signal/no-unsourced-frame-word": ["error", {
                /*
                 * THE FRAME'S OWN VOCABULARY, one entry at a time.
                 *
                 * Everything here is a module-level copy table: it has no
                 * `zones` to read because it is a lookup the CALLER indexes
                 * with a zone field. So each is pinned by naming what raises
                 * it, and a reviewer can check every line of this list against
                 * `calculations.ts` without leaving the file it names.
                 *
                 * The four flag chips are the sharpest case. All four are
                 * raised inside `if (zones) { … }` at calculations.ts:1419-1426
                 * — `zones.pendingBreakout`, `zones.pendingBreakdown`,
                 * `zones.mode === 'atr_band'`, `zones.lastTestedBarsAgo`. The
                 * fifth chip in that table, `pre_earnings_breakout`, is raised
                 * OUTSIDE it from `breakout || breakdown` (the confirmed-pivot
                 * pair), which is exactly why it is not on this list and no
                 * longer says "กรอบ".
                 */
                allow: [
                    // Raised from `zones.*` inside `if (zones)`. calculations.ts:1419-1426
                    "FLAG_COPY.pending_breakout",
                    "FLAG_COPY.pending_breakdown",
                    "FLAG_COPY.narrow_range",
                    "FLAG_COPY.stale_zone",

                    // The bar describing itself: every one of these is indexed
                    // by a zone field at the point of use — `ZONE_COPY[zones.zone]`,
                    // `ZONE_MODE_COPY[zones.mode]`, and so on. They are the
                    // frame's own words, which is the case the ONE WORD FOR ONE
                    // THING block in `MarketSignalSection.tsx` sets out.
                    "ZONE_COPY.uptrend",
                    "ZONE_COPY.sideways",
                    "ZONE_COPY.downtrend",
                    "PENDING_ZONE_COPY.up",
                    "PENDING_ZONE_COPY.down",
                    "FRESH_ZONE_COPY.uptrend",
                    "FRESH_ZONE_COPY.sideways",
                    "FRESH_ZONE_COPY.downtrend",
                    "ZONE_FRAME_NOTE_COPY.atrBand",
                    "ZONE_FRAME_NOTE_COPY.noFrame",
                    "ZONE_SEGMENT_COPY.uptrend",
                    "ZONE_SEGMENT_COPY.sideways",
                    "ZONE_SEGMENT_COPY.downtrend",
                    "ZONE_MODE_COPY.structural",
                    "ZONE_MODE_COPY.atr_band",

                    // Which side of the frame's own triggers the live price and
                    // the close are on. Both take `ZoneSide`, which has no
                    // meaning except against the frame.
                    "LIVE_SAME_SIDE_COPY.above",
                    "LIVE_SAME_SIDE_COPY.inside",
                    "LIVE_SAME_SIDE_COPY.below",
                    "liveMoveCopy",

                    /*
                     * The three reason entries, which are the frame described
                     * without the frame in hand. Checked in round 3: NONE of
                     * them reads a `frame.*` field, because no such field
                     * reaches this layer — the frame arrives as `zones`. Two
                     * read nothing at all, one reads `actionable`. Each is
                     * pinned by the condition the engine raises it on:
                     *
                     *   narrow-range-band      `zones && zones.mode === 'atr_band'`   :1495
                     *   invalidation-from-band `actionable.notes` has 'atr_band_fallback' :1503
                     *   no-defensible-target   `actionable.invalidation && !actionable.target` :1511
                     *
                     * The last two run through `actionable`, which P3 computes
                     * from the zone and nothing else, so they are still the
                     * frame — one object further along. Rewording them to read
                     * `zones` directly was deliberately left out of round 3.
                     */
                    "REASON_COPY.narrow-range-band",
                    "REASON_COPY.invalidation-from-band",
                    "REASON_COPY.no-defensible-target",
                ],
            }],
        },
    },
]);
