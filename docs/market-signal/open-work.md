# Open work

What is known, decided, and not done. Each item says who it belongs to, because
the two categories here are genuinely different: some of this is the owner's
judgement and some of it is engineering waiting for a decision or for time to
pass.

---

## 1. The Options Signal Engine has never been measured · ENGINEERING, not now

**Owner of the decision: the owner. Owner of the work: engineering, when told.**

The app now contains **two signal engines that speak to different standards.**

| | Market Signal | Options Signal |
| --- | --- | --- |
| Measured against a base rate | Yes — P4a, 108 instruments, 14,154 observations | **Never** |
| Says "Confidence" as a percentage | No, removed in P4.5 | **Yes** |
| Card carries a not-a-forecast line | Yes | No |

Three surfaces still sell `คะแนนความมั่นใจ` for the options engine:

* `src/lib/subscription/upgrade-copy.ts:85` — the Pro upgrade modal
* `src/lib/subscription/plan-catalog.ts:121` — the plan comparison
* `src/components/analytics/options-signal/OptionsSignalSection.tsx:101` — the card

**These are deliberately NOT being changed.** Rewording them now would imply a
finding that does not exist: nobody has measured this engine, so "we removed the
confidence claim" would be a statement about evidence we do not have. The honest
options are to measure it or to leave it, and leaving it is the current position.

### What to do when it is measured

Run the same harness — `scripts/calibrate.ts`, adapted to the options engine's
own claim — against the same corpus and the same base-rate construction. Nothing
new needs inventing; the methodology exists and its known limits are documented.

**And the binding rule for afterwards:** if the result reads like Market
Signal's — no edge outside its own sampling error — then **both products' copy
changes at the same time, in one commit.** Not one at a time.

The reason is not tidiness. A product that fixes one card's wording and leaves
the other has told its customers that the honest card is the exception. Two
engines making the same kind of claim to two different standards is worse than
either standard applied consistently, and the gap is most visible to exactly the
readers who pay for both.

**Timing: not now.** Market Signal's flags are not on yet. Measuring a second
engine before the first rollout is finished splits attention across two
disclosures and two sets of copy decisions.

## 2. Release notes in the database · OWNER

Release notes are stored in the database and written through
`ReleaseNoteEditor.tsx`, not in this repository, so they cannot be swept from
here. Any existing note describing the Technical Outlook in predictive terms
needs the same treatment as the four copy fixes.

**The owner has this.** Check the admin console before the first flag goes on.

## 3. Expected Move — collecting, not building · SEPARATE BRANCH

Decided: nothing is built, and collection starts. **None of it is on this
branch.** The migration, the collector, the derivation and its tests live on
`wip/expected-move-collection`, held back from the deploy that ships the copy
fixes.

The reason is the one thing in that work nobody can check later: `derive.ts`
picks the expiry — nearest at least 7 days out — and writes the result into rows
that are meant to be read in about three years. Every other risk in this project
announces itself; a wrong rule here is silent until 2027, at which point the
whole collected series is the thing that is wrong. It does not belong in the same
commit as work that was measured before it shipped.

Status on that branch: migration written, **not applied**. Collector registered
as `npm run collect:expected-move`. Nothing reads it, no flag, no UI. `derive.ts`
and the migration each have a test file; what is unresolved is not coverage but
whether to store the derived expiry choice at all, or only the raw chain and
derive at read time.

**Nothing to do here for about twelve months.** The open decision — raw versus
derived — is worth settling before the first row is written, not after.

## 4. The train/test sign flip · OPEN QUESTION, deliberately not pursued

Four unrelated features and the engine all change sign at the same date, which
means an edge near zero may be two opposing states cancelling rather than an
absence of signal. Recorded in full in `p5-context-findings.md`, marked internal,
and barred from any reader-facing surface.

**Deliberately not being chased.** The split date is already known from having
looked at it, and "find the conditioning variable that makes the edge appear"
always succeeds on a corpus this size. Five preconditions are listed there; none
is met, and the first one — an effect outside its interval at more than one
horizon — fails outright.

What would move it: a corpus extension backwards through 2020-2022, which would
supply a real drawdown and let the question be asked with the split defined
before the data is seen. That is data collection, not modelling.

## 5. The card has never been looked at on a real phone · UNVERIFIED

`MarketSignalSection.test.tsx` asserts that nothing in the footer carries
`truncate`, `line-clamp-*`, `hidden`, a nowrap or a `max-h` + `overflow-hidden`,
and that the not-a-forecast sentence renders as one unbroken string rather than
fragments a clamp could split. That is the honest limit of jsdom: there is no
layout engine, so it checks the classes that would cause a collapse, not the
collapse.

Real pixels at 390x844 are `npm run qa:ui-redesign-auth`, which needs a running
server and a signed-in Elite account and therefore has never been run against
this card.

**What this means:** the disclosure is protected against the ways it could be
hidden on purpose, and unverified against the ways a long Thai sentence could
overflow a narrow column on its own. Worth one real run before `SIGNAL_GATE`
goes on, since the gate is the step that changes what the card says.

## 6. `คะแนนทิศทาง` names two different numbers on one page · OWNER

**Owner of the decision: the owner** — the Market Signal half of this wording was
approved in `prediction-language-audit.md` and is held in place by
`technical-outlook-copy.test.ts`. **Owner of the work: engineering, once told
which name moves.**

### The symptom

A reader scrolling one stock detail page meets the same Thai label twice, over
two numbers on incompatible scales, with the same denominator printed after both.

| | Market Signal | Options Signal |
| --- | --- | --- |
| Field | `result.score` | `diagnostics.directionScore0to100` |
| Range | **-100 … +100**, signed | **0 … 100**, unsigned |
| What the sign means | the direction the evidence leans | there is no sign |
| Printed as | `+7` above a stated axis | `68 / 100` |
| Thai name | `คะแนนทิศทาง` | `คะแนนทิศทาง` |

`-45` and `45` are different readings of the same label. On the options card a
low number is a weak setup; on the Market Signal side a low number may be a
strong DOWNWARD reading. Nothing on either card tells a reader the two scales
differ, and both are on screen within one scroll.

### Where it is written

Market Signal, calling `result.score` `คะแนนทิศทาง`:

* `src/lib/subscription/upgrade-copy.ts:102` — the Elite upgrade modal
* `src/lib/subscription/upgrade-copy.ts:109` — the Pro (commodity) upgrade modal
* `src/components/analytics/market-signal/MarketSignalSection.tsx:379` — the locked
  preview summary, i.e. the line a Basic reader sees before paying

Options Signal, calling `directionScore0to100` `คะแนนทิศทาง`:

* `src/components/analytics/options-signal/OptionsSignalSection.tsx:240` — the card
  headline label, rendered directly above `{value} / 100`
* `:511`, `:557`, `:649`, `:750` — the same name through its explainer dialog

Both cards render from `src/components/stock/StockDetailClient.tsx` — the Market
Signal section at **line 734** and the Options Signal section at **line 761**, 27
lines apart in one column.

### Why it is not fixed in this round

The three Market Signal spellings are **approved copy**. `prediction-language-audit.md`
states the rule plainly: these are promises made to people who paid, so the
wording is not a developer's call, and `technical-outlook-copy.test.ts` exists to
stop them drifting. Changing them to resolve a collision would be doing exactly
what that test was written to prevent, however good the reason.

The Options Signal spellings are worse to touch, for the reason already recorded
in item 1: that engine has never been measured, so any change to how it names its
own number reads as a finding that does not exist.

### The options, with what each costs

1. **Rename the Market Signal side to the card's own label.** The card now prints
   `คะแนนรวมเอนไปทางไหน` over this field, with its axis stated under it, so the
   sales copy is already the odd one out — three lines to change, all in files a
   test guards. Cheapest, and it leaves `คะแนนทิศทาง` meaning exactly one thing.
   Needs the owner's approval on the two upgrade modals.
2. **Rename the Options Signal side.** Honest but larger: six sites, a dialog
   whose whole first heading is the name, and it is the engine whose wording is
   frozen until it has been measured. Best deferred until item 1 is done.
3. **Qualify both in place** — "คะแนนทิศทาง (หุ้น)" against "คะแนนทิศทาง (ออปชัน)".
   Cheapest to agree on and the weakest fix: it distinguishes the ENGINES and
   still says nothing about the two scales, which is the part that misreads.
4. **Do nothing, knowingly.** Defensible only while the two cards are never
   compared, which `StockDetailClient.tsx:734,761` is direct evidence against.

**Recommended: option 1**, and it needs one decision from the owner, not a
project. Option 2 follows whenever item 1 above is settled, so that the two
engines are named to one standard rather than one at a time — the same binding
rule this file already sets out for the confidence wording.

## 7. Two in-memory test doubles read the wall clock · ENGINEERING, small

Five tests in three files went red on 2026-08-22 with nothing changed, because
their fixtures had aged past a real date. Fixed by pinning `Date` in the tests
(`useOptionsSupportResistance.test.tsx`, `options-source/client.test.ts`,
`options-signal/signal-history.test.ts`), which is where the fix belonged — but
two of the three had the same underlying shape and it is worth naming.

`fetchOptionsExpirations` filters `value >= new Date()` at
`src/lib/stock-detail/options-source/client.ts:61`, and
`createSignalHistoryLog().read()` computes its lookback cutoff from `Date.now()`
at `src/lib/analytics/options-signal/signal-history.ts:182`. Both are correct for
the process they run in. Neither can be told what day it is, so a test can only
control them by controlling the global clock.

`checkHistoryAccess` already takes `{ now }` and shows the pattern. Giving those
two the same option would let the tests state their own day instead of faking a
global — a small change, worth making the next time either file is open, and not
worth a commit of its own.

**What must NOT be done instead:** retries, `skip`, or fixtures computed from
`now`. The first two hide it; the third makes the filter untestable, since the
case under test is precisely that one date is dropped and two are kept.
