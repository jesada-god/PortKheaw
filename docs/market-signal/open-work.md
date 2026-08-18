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
