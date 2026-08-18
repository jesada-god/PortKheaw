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

**The wording is yours.** These are drafts written to a brief — "a seller who
measured their own product and is telling the truth, not a system that gave up".
Nothing here is in the product and nothing here has a test holding it in place,
with one exception: the figures quoted in `changelog.md` come from
`MARKET_SIGNAL_MEASURED` in `src/config/signal.ts`, and if you re-run
`npm run signal:calibrate` those figures change and this file goes stale
silently. There is no test on a markdown file.
