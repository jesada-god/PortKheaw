# Trial-ledger retention: legal sign-off and enabling enforcement

Scope: `public.trial_identity_claims` and the nightly sweep that will one day
delete from it. This is a runbook for a human to follow deliberately.

> **Enforcement ships disabled, and turning it on is not a technical task.** The
> mechanism is built, scheduled, tested and running. What it is waiting for is a
> decision by counsel that three years is the right window under PDPA, and a
> record of who made it. Nothing in this repository will enable it, and nobody
> should enable it on the strength of the tests alone.

---

## 0. What exists today

| Piece | State |
| --- | --- |
| `trial_identity_claims.retain_until` | Stamped on every row at claim time, never recomputed. |
| `trial_identity_claims.legal_hold_until` | Null unless an operator sets it. Outranks the deadline. |
| `public.purge_expired_trial_identity_claims(run_id, apply, batch)` | Service-role only. Batched, idempotent per run id. |
| `public.trial_retention_config` | Singleton. `enforcement_enabled = false`. |
| `public.trial_retention_runs` | One audit row per run: counts, mode, run id, sanitized error. **No identity column exists.** |
| pg_cron job `portkheaw-trial-retention` | Runs nightly at 19:23 UTC (02:23 Asia/Bangkok) with `apply => true`. |

Because the flag is off, that nightly job resolves to mode `reporting_only`: it
writes an audit row saying how many rows are **due**, and deletes nothing. That is
deliberate — a purge whose first live run is also its first real run is a purge
nobody has ever seen work.

The published promise is in the privacy policy (`src/lib/legal/documents.ts`,
section 4) and the numbers come from `src/lib/trial-identity/retention.ts`, so the
page and the behaviour cannot drift.

## 1. What the sweep will never delete

Assert these to counsel; they are enforced in SQL and covered by
`src/lib/trial-identity/retention-migration.test.ts`:

1. A row whose `retain_until` has not passed.
2. A row under a live legal hold.
3. A row a **live account** still holds. Such a row is part of an existing
   account's own data; it is removed when that account is deleted. Deleting it
   early would hand a long-standing member a second free week.

And what it can never record: an identity digest. The audit table has no column
for one, and no writer could add a value to a column that does not exist.

---

## 2. Read-only review before sign-off

```bash
npm run probe:trial-retention
```

Then, for the numbers counsel will ask about:

```sql
-- Service role, read-only. How much is actually at stake.
select
  claim_origin,
  count(*)                                                as claims,
  count(*) filter (where retain_until < now())            as past_deadline,
  count(*) filter (where claimed_by_user_id is not null)  as held_by_live_account,
  count(*) filter (where legal_hold_until > now())        as on_legal_hold,
  min(first_claimed_at)                                   as oldest_claim
from public.trial_identity_claims
group by claim_origin;

-- What the scheduled job has been reporting.
select started_at, mode, scanned, deleted, error
from public.trial_retention_runs
order by started_at desc
limit 14;
```

## 3. A dry run, whenever you like

Safe with the flag off *or* on: `apply => false` never deletes.

```sql
select * from public.purge_expired_trial_identity_claims(gen_random_uuid(), false, null);
```

`scanned` is what a real run would remove; `deleted` will be `0` and `mode` will
be `dry_run`.

## 4. Legal sign-off checklist

- [ ] Counsel has confirmed **three years** from the claim date is proportionate
      under PDPA for the stated purpose (one free trial per person).
- [ ] Counsel has confirmed the pseudonymous-digest framing: no mailbox, no
      subject, no card, no IP, no name — a keyed digest that cannot be reversed
      without a key held only in the server environment.
- [ ] Counsel has confirmed the legal-hold carve-out for an unresolved dispute,
      refund request or audit.
- [ ] The privacy policy wording has been read **as published** at `/privacy`,
      not as a diff.
- [ ] A named person accepts the decision, and the date is recorded.

## 5. Enabling enforcement

No code change and no redeploy. One row.

```sql
-- Service role. Record the sign-off in the same statement that permits deletion,
-- so the flag and its authority can never be separated.
update public.trial_retention_config
set enforcement_enabled = true,
    legal_signed_off_at = now(),
    legal_signed_off_by = '<the approving admin account uuid>',
    updated_at = now(),
    updated_by = '<your admin account uuid>'
where singleton;
```

Then, on the **first** enabled night, deliberately and with somebody watching:

- [ ] `npm run probe:trial-retention` reports `retention enforcement ENABLED` with
      a `signed off` date, not `NOT RECORDED`.
- [ ] Read the next audit row: `mode = 'apply'`, and `deleted` matches the
      `scanned` count the reporting-only runs had been printing (bounded by the
      batch limit of 500).
- [ ] Re-run the probe: `due` has dropped by exactly that number.

If `scanned` is far larger than you expect, **turn the flag back off** before the
next night and find out why. A batch is 500 rows, so a surprise is bounded to 500
rows per night rather than to the table.

## 6. Placing a legal hold

Keyed on the claim's id, service-role only. There is deliberately no way to place
a hold by identity digest, and no free-text reason column on the row — the case
reference belongs in the support ticket that raised it, not in the one table built
to hold nothing about anybody.

```sql
select public.set_trial_identity_legal_hold(
  '<claim uuid>', now() + interval '1 year', '<your admin account uuid>'
);

-- Lifting it:
select public.set_trial_identity_legal_hold('<claim uuid>', null, null);
```

## 7. Turning enforcement off again

```sql
update public.trial_retention_config
set enforcement_enabled = false, updated_at = now(), updated_by = '<your uuid>'
where singleton;
```

The job keeps running and reverts to reporting only. Deletions already made are
not recoverable except from a backup — see
[backup-and-restore.md](backup-and-restore.md).

## Decision log

| Date | Decision | By | Notes |
| --- | --- | --- | --- |
| 2026-08-06 | Mechanism shipped **disabled** | Engineering | Awaiting counsel. Not a technical outstanding item. |
