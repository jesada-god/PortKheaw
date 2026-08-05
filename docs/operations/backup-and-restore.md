# Backup and restore

Scope: the PortKheaw Production Supabase project. This is the operational
runbook for proving the backups are restorable — not for restoring Production.

> **Production is never a restore target.** Every procedure below restores into a
> separate, disposable project. A restore that overwrites Production during a
> drill would destroy exactly the data the drill exists to protect.

---

## 1. What exists today

| Capability | Where it comes from | Notes |
| --- | --- | --- |
| Daily automated backup | Supabase platform, per project | Retention depends on the project's plan tier. Free-tier projects get daily backups with short retention and **no** point-in-time recovery. |
| Point-in-time recovery (PITR) | Supabase paid add-on | Not assumed to be enabled. Verify in the dashboard before relying on it. |
| Schema history | `supabase/migrations/*.sql` in this repository | The schema is fully reproducible from the repository alone; it is the data that needs the backup. |
| Storage objects | Supabase Storage (`support-attachments` bucket) | Backed up separately from the database. Attachments are support evidence, not billing records. |

**Verify the current state before every drill** — the plan tier and the
retention window are the two facts most likely to have changed since this file
was written:

1. Supabase Dashboard → the Production project → **Database → Backups**.
2. Record: newest backup timestamp, oldest retained backup, whether PITR is on.
3. If the newest backup is older than 24 hours, stop and fix that first. A drill
   against a stale backup proves nothing useful.

### Tables a restore must be judged on

Losing any of these costs money or trust, so they are what the verification in
step 4 checks:

- `user_subscriptions` — who has paid access, and until when.
- `billing_invoices` — what was billed and collected. The revenue ledger.
- `billing_refund_events`, `refund_requests` — money going back.
- `billing_webhook_events`, `billing_webhook_retries` — delivery evidence.
- `billing_reconciliation_runs`, `billing_reconciliation_issues`.
- `support_tickets`, `support_thread_messages`, `support_audit_events`.
- `admin_audit_events`, `beta_program_state`, `beta_invites`.
- `profiles`, `user_roles`, `portfolios` and the ledger tables beneath them.

---

## 2. Restore drill — isolated target

Run quarterly, and after any migration that changes a billing table.

**Before you start**, confirm out loud which project reference you are pointing
at. The single most dangerous step in this runbook is pasting the Production
reference into step 2.3.

### 2.1 Create the target

1. Supabase Dashboard → **New project**.
2. Name it `portkheaw-restore-drill-YYYYMMDD`. The date in the name is what stops
   a stale drill project being mistaken for something live later.
3. Region: same as Production, so timing observations are comparable.
4. Record the new project reference. **This is the only reference used below.**

### 2.2 Take the backup

- **Platform backup:** Dashboard → Production project → Database → Backups →
  **Download** the most recent backup.
- **Or a logical dump** (works on any tier):

  ```bash
  # Read-only against Production. Produces a file; changes nothing.
  supabase db dump --db-url "$PRODUCTION_DB_URL" -f drill.sql
  ```

  `PRODUCTION_DB_URL` is read from your own shell for this command only. Do not
  add it to `.env.local`, and do not leave it in shell history — prefix the
  command with a space, or export it in a subshell.

  > This repository's `.env.local` contains prose alongside values and breaks the
  > Supabase CLI parser. Run CLI commands from an isolated copy of `supabase/`,
  > or pass `--db-url` explicitly as above.

### 2.3 Restore into the drill project

```bash
# TARGET_DB_URL is the DRILL project. Read it back before pressing enter.
psql "$TARGET_DB_URL" -f drill.sql
```

If restoring a platform backup instead, use Dashboard → the **drill** project →
Database → Backups → Restore, and upload the downloaded file.

### 2.4 Verify

Run against the **drill** database, and compare with the same queries run
read-only against Production.

```sql
-- Schema: every table the product depends on is present.
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;

-- Row counts for the tables that carry money and access.
select 'user_subscriptions' as table_name, count(*) from public.user_subscriptions
union all select 'billing_invoices', count(*) from public.billing_invoices
union all select 'billing_refund_events', count(*) from public.billing_refund_events
union all select 'billing_webhook_events', count(*) from public.billing_webhook_events
union all select 'support_tickets', count(*) from public.support_tickets
union all select 'refund_requests', count(*) from public.refund_requests
union all select 'admin_audit_events', count(*) from public.admin_audit_events
union all select 'beta_invites', count(*) from public.beta_invites
union all select 'profiles', count(*) from public.profiles
order by table_name;

-- Row-level security is still ON for every table that has it in Production.
-- A restore that silently drops RLS is the failure mode that matters most:
-- the data is all there, and every account can read every other account's rows.
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r'
order by relname;

-- The revenue ledger agrees with itself.
select
  count(*) filter (where status = 'paid') as paid_invoices,
  sum(amount_paid_minor) filter (where paid_at is not null) as collected_minor,
  sum(amount_refunded_minor) as refunded_minor
from public.billing_invoices;

-- The audit trail is still append-only. This must FAIL.
update public.admin_audit_events set action = 'tampered' where true;
-- expected: ERROR: AUDIT_APPEND_ONLY
```

A drill passes only when **all** of the following hold:

- [ ] every table present in Production is present in the drill project;
- [ ] row counts match Production, or differ only by rows written after the
      backup was taken (note the delta and the backup timestamp);
- [ ] `relrowsecurity` is `true` for every table where it is `true` in
      Production;
- [ ] the billing ledger totals match;
- [ ] the append-only `update` above is refused;
- [ ] `select public.platform_readiness()` returns a row.

### 2.5 Clean up

1. Delete the drill project in the Supabase dashboard. Leaving it running is a
   second copy of every customer record, with nobody watching it.
2. Delete `drill.sql` and any downloaded backup from local disk.
3. Record the outcome in the log below.

---

## 3. Real recovery (Production is broken)

Not a drill. Read all of it before running any of it.

1. **Stop the writers.** In Vercel, set `BILLING_ENABLED=false` and redeploy.
   Signed webhooks then return a refusal instead of applying events, and no new
   entitlement is written while the database is inconsistent. Stripe retries for
   up to ~3 days, so events are not lost — they queue.
2. **Do not restore over Production first.** Restore the backup into a fresh
   project and verify it there with section 2.4. Restoring straight over a
   damaged Production destroys the evidence of what went wrong, and any data
   written after the backup.
3. **Decide the window.** Everything written between the backup timestamp and
   now will be lost by the restore. Quantify it before deciding:

   ```sql
   select count(*) from public.billing_invoices where created_at > '<backup ts>';
   select count(*) from public.user_subscriptions where updated_at > '<backup ts>';
   ```

4. **Reconcile against Stripe, not against the backup.** Stripe is the source of
   truth for money. After any restore, the daily reconciliation pass
   (`runBillingReconciliation`) reports every disagreement between the provider
   and the restored rows at `/admin` and `/admin/billing`. Work that list before
   re-enabling billing.
5. **Re-enable billing** (`BILLING_ENABLED=true`) only once the reconciliation
   list is empty or every remaining item is understood.
6. **Replay nothing by hand.** There is no manual path that grants a tier, and
   adding one under pressure is how an unsigned second path to paid access gets
   created. Ask Stripe to redeliver the events instead: Stripe Dashboard →
   Developers → Webhooks → the endpoint → **Resend** the failed events.

---

## 4. Drill log

| Date | Operator | Backup timestamp | Target project | Result | Notes |
| --- | --- | --- | --- | --- | --- |
| _(not yet executed)_ | | | | | The drill needs an isolated Supabase project, which is a deliberate act with a cost. It has not been run. |
