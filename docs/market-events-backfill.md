# Backfilling the macro calendar

`src/data/market-events.json` holds only releases that had not happened yet when
it was written. Everything that reads past releases — the market-history block
under a day in `/market-events` — therefore has nothing to read, and renders
nothing at all.

Closing that gap is **data entry, not code**. Every surface has already been
proved against a file that holds past rows (`src/lib/market-events/past-rows.test.ts`,
eighteen assertions across seven consumers, all of which passed the first time
they were run). Nothing needs changing to accept history. It needs history.

---

## The one rule

**Never write a date you did not read off a published page.**

A wrong release date is worse than a missing one, because a reader plans around
it and because the number joined to it then describes the wrong session. This is
the same rule that keeps `FED SPEECH` out of the file entirely: the Federal
Reserve publishes no forward schedule of speeches, so every date would have been
invented, and it is absent rather than guessed.

Corollaries:

- Do not derive a date from a pattern. "CPI is mid-month" is true until it is
  not, and the exceptions are exactly the months worth having.
- Do not copy the examples below into the file. The first is a row that is
  already in it; the second is a template with the fields blanked.
- If you cannot find a date, leave the row out. A short history is honest; a
  plausible one is not.

### The gap you will hit first

Both 2025 and 2026 had lapses in appropriations, and BLS moved release dates
because of them. The revised dates are published:

<https://www.bls.gov/bls/2025-lapse-revised-release-dates.htm>

A schedule page printed before a lapse can disagree with what was actually
published. Where they disagree, the date the release **actually came out** is
the one this file wants, because that is the day the market had the number.

---

## Where to read the dates

All four verified reachable on 2026-09-03. If one has moved, fix it here — this
is the only copy, deliberately: `market-events.json`'s `_provenance` block names
the FORWARD schedules, and a second list of URLs in a second place is a second
thing to keep true.

| Source | Kinds | Where the past dates are |
| --- | --- | --- |
| **BLS** | `CPI`, `PPI`, `NFP` | <https://www.bls.gov/bls/archived_sched.htm> — "Schedules for Selected BLS Economic News Releases for Prior Years", one page per year back to 2000 (and a PDF for 1957–2000). This is the best source in the list: a whole year of exact dates on one page. Per-release archives are at <https://www.bls.gov/bls/news-release/cpi.htm> (swap `cpi` for `ppi`, `empsit`). |
| **BEA** | `PCE`, `GDP` | <https://www.bea.gov/news/archive> — filter by Product and Year. `PCE` is published as *Personal Income and Outlays*; `GDP` as *Gross Domestic Product*, and note the estimate stage (advance / second / third) for `referencePeriod`. |
| **Federal Reserve** | `FOMC` | <https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm> — past years back to 2021 on the same page as the upcoming ones; older years via the historical links there. The statement lands on the **second day** of a two-day meeting at 2:00 p.m. ET. |
| **DOL** | `JOBLESS_CLAIMS` | <https://oui.doleta.gov/unemploy/claims_arch.asp> — the archive tool holds prior news releases. The rule is Thursday 8:30 a.m. ET, moved only for a federal holiday, and the page publishes the exceptions. |

---

## What a row looks like

### Example 1 — a real row, already in the file

Copied verbatim from `src/data/market-events.json`. It is here to show the
shape, not to be pasted.

```json
{
  "id": "cpi-2026-09-11",
  "kind": "CPI",
  "titleTh": "เงินเฟ้อผู้บริโภค (CPI)",
  "shortTh": "CPI",
  "importance": "high",
  "source": "BLS",
  "referencePeriod": "August 2026",
  "at": "2026-09-11T12:30:00.000Z",
  "etDisplay": "8:30 a.m. ET"
}
```

### Example 2 — the template to fill

Every `<...>` is a value you read off an archive page. Nothing here is a date.

```json
{
  "id": "cpi-<YYYY-MM-DD>",
  "kind": "CPI",
  "titleTh": "เงินเฟ้อผู้บริโภค (CPI)",
  "shortTh": "CPI",
  "importance": "high",
  "source": "BLS",
  "referencePeriod": "<the month or quarter the figure is ABOUT>",
  "at": "<YYYY-MM-DD>T<HH:MM>:00.000Z",
  "etDisplay": "8:30 a.m. ET"
}
```

### The fields, and the two that are easy to get wrong

| Field | Notes |
| --- | --- |
| `id` | `<kind-slug>-<publication date>`, lower case. The slugs in use are `cpi`, `ppi`, `nfp`, `pce`, `gdp`, `fomc`, `jobless-claims`. Must be unique; a test asserts it. |
| `kind` | One of `CPI`, `PPI`, `PCE`, `NFP`, `GDP`, `FOMC`, `JOBLESS_CLAIMS`. |
| `titleTh` / `shortTh` | Copy them from an existing row of the same kind. They are per-kind constants, not per-row prose, and `shortTh` is what a calendar cell prints. |
| `importance` | Copy from an existing row of the same kind. It is an editorial note about how widely a release is watched, and it does not vary by month. |
| `source` | `BLS`, `BEA`, `FED` or `DOL`. |
| `referencePeriod` | The period the figure is ABOUT, not when it came out — `"August 2026"`, `"Q3 2026 second"`, `"weekly"`. |
| **`at`** | **The publication instant in UTC, ending in `Z`.** This is the only field ever computed with. See below. |
| `etDisplay` | A LABEL. Nothing parses it; a contract test enforces that. `"8:30 a.m. ET"` for the BLS/BEA/DOL releases, `"2:00 p.m. ET"` for an FOMC statement. |

#### Converting a published ET time to `at`

The archives publish an Eastern wall clock. `at` is the instant, so the offset
depends on whether US daylight saving was in force that day — **not on the time
of year in the abstract**, and not on a rule you remember.

- EDT (roughly mid-March to early November): ET + 4 hours → `8:30 a.m.` is `12:30:00.000Z`
- EST (the rest of the year): ET + 5 hours → `8:30 a.m.` is `13:30:00.000Z`

The two 8:30 a.m. CPI releases either side of the 2026 change are `12:30Z` in
October and `13:30Z` in November — the same wall clock, two different instants.
Getting this wrong shifts the row by an hour, which is usually invisible and
occasionally moves it to the wrong day in Bangkok.

Store the instant and nothing else. Do **not** add a field naming a time zone
beside a wall clock: that shape re-derives the offset on every machine that
draws it, and `market-events.contract.test.ts` fails the build if it appears.

---

## What to do first

Work down this list. It is ordered by how much a reader gains per row entered,
not by how easy the source is.

1. **`CPI`** — the most watched release in the file, and the one a reader is
   most likely to open a day for. Twelve rows a year.
2. **`NFP`** — the other release that moves the whole tape on its own. Twelve
   rows a year, always a Friday.
3. **`PPI`** — twelve a year, and the BLS year schedule already open for CPI
   and NFP has it on the same page. Cheap once you are there.
4. **`PCE`** — twelve a year, BEA. The Fed's preferred inflation measure, so
   worth more than its watch-count suggests.
5. **`FOMC`** — only eight a year, and its history is the least comparable of
   the six: a 2:00 p.m. statement is measured differently from an 8:30 print
   (see `release-timing.ts`). Still worth having, but it will never fill a
   three-sample block as fast as the others.
6. **`JOBLESS_CLAIMS`** — fifty-two a year, the lowest importance in the file,
   and by far the most typing. Do it last, or not at all. A block for a weekly
   release is three of the last three weeks, which is the least interesting
   history any of these kinds produces.

One year of the first four is about 48 rows and gives every block its full three
samples. That is the target worth aiming at first.

---

## After you have added rows

```bash
npm run backfill:event-reactions
```

One request to Yahoo for five years of `^GSPC` daily bars, joined to the rows
you just added on the **New York** day. Writes `src/data/market-event-reactions.json`.

With no past rows in the calendar it makes no request at all and writes an empty
file — that is a successful run, and it is what it does today.

Then check, in this order:

1. **The console output.** It prints how many rows landed in `beforeOpen`,
   `intraday` and `afterClose`, and every row it could not measure with the
   reason. `no-session` means the release fell on a day the US market was shut;
   that is recorded, never slid to the next session, and it is worth confirming
   the date really was a holiday rather than a typo.
2. **`npm test`.** `past-rows.test.ts` proves the new rows stay out of the feed
   and out of the overview list, and `release-timing.test.ts` proves every row
   classifies and that only FOMC rows land intraday. If a new row breaks the
   second one, its `at` is probably an hour out.
3. **`npm run qa:events-calendar`.** Captures `/market-events` at 375px. The
   history block wraps to two lines under a busy row; confirm it still does with
   real numbers.
4. **The page itself.** Walk back to a month you just filled. The back arrow
   should now reach it — the range is read off the file, so months appear as
   soon as rows do, with no code change and no constant to bump.

---

## Related

- `src/data/market-events.json` — `_provenance` (forward schedules) and
  `_knownGaps` (what is deliberately absent, and why)
- `src/lib/market-events/time.ts` — the one place an instant becomes a Thai wall
  clock, and the reasoning for why there is exactly one
- `src/lib/market-events/release-timing.ts` — why an 8:30 print and a 2:00 p.m.
  statement are not the same measurement
- `src/lib/market-events/reactions.ts` — what the history block may say, and the
  vocabulary it may not use
