# Recovering a stuck account deletion

Scope: `public.account_lifecycle` and the pipeline in
`src/lib/account/account-deletion.ts`. This is a runbook for a human to follow
deliberately.

> **A deletion that stopped is invisible without this.** An account whose data has
> been purged but whose auth user survived a failed final step looks, to every
> ordinary query, exactly like an account. The person believes they are deleted;
> the mailbox is still taken; nothing alerts.

---

## 0. The states, and what each one means

The pipeline runs in a fixed order: mark closing → write the trial ledger → settle
the payment provider → empty the storage bucket → purge the data → **delete the
auth user, last**.

| Reported state | Stage | What has happened | Safe action |
| --- | --- | --- | --- |
| `closing` | `requested` | Nothing destroyed. The provider is **not** settled. | Re-run the in-app deletion. It is safe from the top. |
| `purge_pending` | `provider_settled` | The provider is settled; the data is still there. | Resume the purge, then finish. |
| `awaiting_auth_delete` | `data_purged` | The data is gone; the account still exists. | Delete the auth user — **only** once the purge is measured empty. |

A finished deletion leaves **no row at all** — `account_lifecycle` cascades from
`auth.users` — so "closed" is observable only as an absence. A row whose account
no longer exists is a state the database should not be able to hold, and the tools
report it rather than inventing a repair for it.

`stuck` is orthogonal: any of the three, untouched for longer than the threshold
you pass (default one hour).

## 1. Look

```bash
npm run probe:trial-retention                       # includes deletions in flight
npm run account:reconcile                           # preview only, the default
npm run account:reconcile -- --stuck-after=15min
```

The preview prints one `decision` line per account: its state, whether it is
stuck, the action that *would* be taken, and why. Nothing is written.

Direct, read-only, if you prefer SQL:

```sql
select * from public.account_deletion_report(interval '1 hour');
select public.account_residual_data_count('<user uuid>');
```

## 2. Act

```bash
npm run account:reconcile -- --apply
npm run account:reconcile -- --user=<uuid> --apply     # one account only
```

What `--apply` does, per state:

- `purge_pending` → empties the support-attachment objects, calls
  `purge_account_data`, advances the stage, then finishes the deletion.
- `awaiting_auth_delete` → **re-measures** `account_residual_data_count`,
  re-confirms the lifecycle row still says `data_purged`, then deletes the auth
  user.
- `closing` → refuses, and tells you to re-run the in-app deletion.

## 3. What it will not do, and why

- **It never returns an account to service.** Reverting is
  `cancel_account_deletion`'s decision and only at the stage where nothing has
  been destroyed. The reconciler does not call it, and there is no flag that makes
  it.
- **It never settles a payment provider.** That needs the application's billing
  client, and doing it twice is a second outward-facing action against somebody's
  subscription. A deletion still at `requested` is reported, not resumed.
- **It never writes the trial ledger.** The ledger is written *before* the provider
  is settled, so anything the reconciler can reach already has its claim. Writing
  it again from a script would be recording a claim nothing derived.
- **It never deletes an auth user on a stage name alone.** `data_purged` is a
  statement about the past. If `account_residual_data_count` is not exactly zero —
  or cannot be read at all — it refuses and reports. An unreadable count is not
  zero.

Its log is a stage, an action and an account id. Never an address, never a digest.

## 4. If a deletion is stuck at `requested`

The provider step failed, which is the one case where the account may go back into
service — and only the in-app pipeline can decide that, because only it can reach
Stripe.

1. Check the provider's own dashboard for the subscription's real state.
2. Ask the account holder to press Delete again, or run the pipeline for them from
   an authenticated context. Every step is idempotent; a re-run does not
   double-cancel.
3. If the provider is unreachable for an extended period, leave it. The account is
   closed to writes and nothing has been lost — that is the state the design
   chose.

## 5. If the same account keeps failing at the last step

Almost always an auth-side problem rather than a data one:

- [ ] `account_residual_data_count` reads `0` (if not, a table was added to the
      schema after `purge_account_data`'s list was written — fix the list first).
- [ ] The service-role key is valid and `auth.admin.deleteUser` is not being
      refused. Check the reconciler's `auth_delete_failed` detail.
- [ ] The account is not the seeded owner account, which nothing should ever
      delete.

## 6. What to check after any recovery

- [ ] `npm run account:reconcile` reports nothing in flight (or only rows you
      deliberately left).
- [ ] `npm run probe:trial-retention` is clean.
- [ ] If the account had spent a trial, a claim for it still exists: the ledger is
      what makes re-registering on the same mailbox a dead end, and a recovery must
      not have removed it.

```sql
-- Counts only; there is no way to look up a claim by mailbox, by design.
select hash_version, claim_origin, count(*)
from public.trial_identity_claims group by 1, 2 order by 1, 2;
```
