# Market Signal calibration runs

Output of `npm run signal:calibrate` (`scripts/calibrate.ts`), one directory per
run, named for the UTC instant it started.

```
<runId>/report.md      the tables, meant to be read
<runId>/manifest.json  every parameter and the instrument list, so a run can be
                       compared against another one and reproduced exactly
```

Committed, unlike `__golden__/corpus/`. The runs are small, and the point of
versioning them is that a later run can be diffed against an earlier one — a
calibration you cannot compare against last month's is a screenshot.

## What these are and are not

They are **measurement**. P4a fits nothing and feeds nothing back into the
engine; `report.md` is evidence, not a gate, and no test reads it. P4b is where a
number here is allowed to move a threshold in `src/config/signal.ts`.

A run is reproducible from the repo plus the corpus: the control draws come from
a seeded generator, `calculatedAt` is pinned, and every observation replays the
engine over frozen bars. The corpus is gitignored and refetchable, so a run made
after `signal:sensitivity --refresh` is measuring different input — the manifest
records the instrument list so that is at least visible.

## Reading them

Two numbers are load-bearing and easy to skip past.

`clust` is the largest subset of the observations in a row that share no outcome
bars. At a 20-bar horizon with a 5-bar stride, four consecutive observations
overlap almost entirely, so a raw `n` of 400 is closer to 100 independent facts.
Judge every comparison on `clust`.

**No rate is ever printed without its baseline.** A hit rate on its own says
nothing: in a market that rose, every long signal looks skilful. The `edge`
column is the only column that carries information, and it is frequently zero.
