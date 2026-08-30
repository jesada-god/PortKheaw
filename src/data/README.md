# `src/data`

Static data that ships inside the bundle. No provider call reads any of it, and
nothing here is generated — every row was transcribed by hand from a published
source and is expected to be edited by hand.

---

## `market-events.json` — the macro economic calendar

**Adding an event is editing this file and nothing else.** There is no horizon
constant, no window to widen and no code change: a row dated January 2027 shows
up the moment it is in the file, and so does one dated 2030. Two modules read
this file and both grow with it:

- [`src/lib/market-overview/events.ts`](../lib/market-overview/events.ts) — the
  Overview list, which shows every row from today forward
- [`src/lib/market-events/calendar.ts`](../lib/market-events/calendar.ts) — the
  month grid and the `/market-events` feed

### Schema

```jsonc
{
  "schemaVersion": 1,
  "events": [
    {
      "id": "cpi-2027-01-13",
      "kind": "CPI",
      "titleTh": "เงินเฟ้อผู้บริโภค",
      "shortTh": "เงินเฟ้อ",
      "importance": "high",
      "source": "BLS",
      "referencePeriod": "ธ.ค. 2026",
      "at": "2027-01-13T13:30:00.000Z",
      "etDisplay": "8:30 a.m. ET"
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | Unique, and stable forever. It keys the rendered row and the relevance join, so changing it on an existing event is the same as deleting and re-adding it. Convention: `<kind-lowercase>-<YYYY-MM-DD>`. |
| `kind` | One of `CPI` `PPI` `PCE` `NFP` `GDP` `FOMC` `JOBLESS_CLAIMS`. A value outside this list drops the row — see *A bad row is dropped* below. |
| `titleTh` | The full Thai name, for the detail row. |
| `shortTh` | The name that fits in a calendar cell. Keep it under about 8 Thai characters. |
| `importance` | `high` \| `medium` \| `low`. An **editorial** ranking of how widely the release is watched. It is not measured and says nothing about how any symbol responds. |
| `source` | `BLS` \| `BEA` \| `FED` \| `DOL` — the agency that publishes it. |
| `referencePeriod` | What the number is ABOUT, not when it lands. A CPI print on 13 January reports December. |
| `at` | **The value.** A UTC instant, and it must end in `Z`. |
| `etDisplay` | **A label only.** Never parsed, never computed with. |

### Two rules worth stating before you add a row

**`at` must be UTC, ending in `Z`.** An offset form like
`2027-01-13T08:30:00-05:00` parses correctly today and is the shape that invites
somebody to store a local time with a zone name beside it later — which
re-derives a DST offset on every machine that draws it and gets it wrong on the
two Sundays a year when it matters. The schema regex rejects anything else.

Converting from the agency's announcement: US releases are quoted in ET, and ET
is **UTC−5 in winter and UTC−4 in summer**. An 8:30 a.m. ET release is
`13:30:00.000Z` from November to March and `12:30:00.000Z` from March to
November. Getting this wrong puts the row on the right day with the wrong hour,
which is invisible on the calendar and wrong in the countdown.

**No symbol lists.** There is no field for "which stocks this affects", and one
must not be added. The moment a symbol is written next to a release it becomes a
claim that ages silently — the reader sells the stock and the file still says the
release affects them. That join is computed at read time against the reader's own
holdings, in
[`event-relevance.ts`](../lib/market-overview/event-relevance.ts).

### A bad row is dropped, and a bad FILE is empty

A row that fails validation is skipped and the rest still load. A file that does
not parse at all yields **no** events rather than a partial list: half a calendar
looks exactly like a complete one and tells a reader that nothing is scheduled
the week the schema changed underneath it.

After editing, `npx vitest run src/lib/market-overview/events.test.ts` checks the
shipped file parses, is sorted, and carries a `Z` instant on every row.
