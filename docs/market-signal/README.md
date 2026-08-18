# Market Signal — drafts for the owner to approve

Three pieces of writing, none of them shipped and none of them wired to
anything. They exist because turning the rollout flags on changes what the
Technical Outlook card says about itself, and a change of that size should reach
existing subscribers as a sentence somebody wrote on purpose rather than as a
card that looks different one morning.

| File | What it is | Who reads it |
| --- | --- | --- |
| `changelog.md` | What changed and why | Anyone who asks; a public changelog entry if you want one |
| `in-app-notice.md` | The one-time notice on first sight of the new card | Every existing subscriber with the capability |
| `pricing-copy.md` | Which pricing strings now describe something that no longer exists | You, before the flags go on |

And two measurement write-ups, which are findings rather than drafts — they
record what was measured and what the product is therefore allowed to say:

| File | What it answers |
| --- | --- |
| `p5-context-findings.md` | Whether any of the four context features beats the base rate. None does; none was built. |
| `p6-history-findings.md` | Whether a label that has stood longer is a more accurate one. It is not, which is what makes the history strip a disclosure and forbids it from ranking. |
| `p4b-findings.md` | Whether there is anything to calibrate. There is not, and the reliability table is not even monotone, so a remap would restore the misreading P4.5 removed. |
| `prediction-language-audit.md` | Every place in the app that described this feature with a word implying prediction. All four items **approved and applied**; the file remains as the record of what changed and why. |

And one operational note:

| File | What it is |
| --- | --- |
| `rollout-order.md` | The order to turn the five flags on, what to watch at each step, and the one step that touches the database. |
| `open-work.md` | What is known, decided and not done — including the second signal engine nobody has measured. |

**The wording is yours.** These are drafts written to a brief — "a seller who
measured their own product and is telling the truth, not a system that gave up".
Nothing here is in the product and nothing here has a test holding it in place,
with one exception: the figures quoted in `changelog.md` come from
`MARKET_SIGNAL_MEASURED` in `src/config/signal.ts`, and if you re-run
`npm run signal:calibrate` those figures change and this file goes stale
silently. There is no test on a markdown file.
