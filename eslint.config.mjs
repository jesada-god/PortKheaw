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
         * THE PRODUCT'S COPY, over the five pages a reader actually spends time
         * on plus the components those pages are assembled from.
         *
         * The phrases and the reasoning are in
         * `src/lib/presentation/banned-copy.ts`. What matters here is the
         * SCOPE, because the previous scope is the whole reason the rule
         * exists: the list lived inside `MarketSignalSection.test.tsx`, so one
         * component in the product was held to it while a Tools card shipped
         * "เครื่องมือนี้จะช่วยให้คุณ" and the stock page grew a banner reading
         * "การวิเคราะห์ด้วย AI — กำลังจะมา".
         *
         * Tests are excluded for the same reason the frame-word rule excludes
         * them: a test asserting that a phrase is absent has to name the phrase,
         * and holding the assertion to the rule would ban checking it.
         *
         * PORTFOLIO WAS OUTSIDE THIS LIST, and the gap was not theoretical: with
         * "ระบบประเมินว่า" planted as a live string literal in
         * `src/lib/portfolio/day-change-label.ts` and
         * `tracker/OptionPositionCard.tsx`, eslint reported nothing. Every day
         * figure caption a reader sees on `/portfolio` is written in those two
         * folders, so the rule was passing over the copy rather than clearing
         * it — the same shape of hole that let a Tools card ship the phrase
         * above while one card two folders away was held to a vocabulary.
         *
         * `src/lib/portfolio` is included as well as the components, because
         * the sentences do not live in the components: they are composed in
         * `day-change-label.ts` and passed down as props, so a scope covering
         * only `src/components/portfolio` would still see none of them.
         */
        files: [
            "app/page.tsx",
            "app/portfolio/**/*.{ts,tsx}",
            "app/search/**/*.{ts,tsx}",
            "app/stock/**/*.{ts,tsx}",
            "app/tools/**/*.{ts,tsx}",
            "src/components/{dashboard,portfolio,search,stock,tools,analytics,upcoming,watchlist,ui}/**/*.{ts,tsx}",
            "src/lib/{overview,portfolio,stock-detail,tools,presentation}/**/*.ts",
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
         */
        files: ["src/components/analytics/market-signal/**/*.{ts,tsx}"],
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
