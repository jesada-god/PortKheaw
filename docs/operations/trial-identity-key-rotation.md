# Rotating the trial-identity HMAC key

Scope: the keys the persistent trial ledger (`public.trial_identity_claims`) is
written and read with. This is a runbook for a human to follow deliberately.

> **The old key is not replaced. It is retained.** The ledger holds a keyed digest
> of a mailbox, and the digest is only findable again by the key that made it. A
> rotation that removes the old key does not "expire" old claims — it makes them
> invisible, which hands a second free week to every person who has already had
> one, silently, with no error in any log. The old key stays configured until every
> claim written under it has passed its retention date.

See also: [secret-rotation.md](secret-rotation.md) for the rules that apply to
every credential, and [trial-retention-enforcement.md](trial-retention-enforcement.md)
for when a key version's claims are finally gone.

---

## 0. How the keyring works

| Variable | Meaning |
| --- | --- |
| `TRIAL_IDENTITY_HMAC_SECRET` | The variable this feature shipped with. Read as **version 1**. Never delete it while V1 claims exist unless you have copied its value to `TRIAL_IDENTITY_HMAC_SECRET_V1` first. |
| `TRIAL_IDENTITY_HMAC_SECRET_V1` … `_V4` | The versioned keys. |
| `TRIAL_IDENTITY_HMAC_ACTIVE_VERSION` | Which version **new** claims are written under. Unset means `1`. |

Two rules follow from the design and are enforced in
`src/lib/trial-identity/keyring.ts`:

- **One version writes.** New claims are stamped with the active version only.
- **Every configured version reads.** A claim check derives the identity once per
  configured version and asks about all of them in one query, so a V1 claim keeps
  refusing a trial after the active version has moved to V2.

The deployment **fails closed** — every trial is refused, nobody gets a wrong
answer — on any of: no key at all; a key with surrounding whitespace or shorter
than 16 characters; the same key under two versions; `…_ACTIVE_VERSION` naming a
version whose key is not set; `TRIAL_IDENTITY_HMAC_SECRET` and `…_V1` set to
different values; V1 retired without naming an active version.

Beyond that, the *database* can fail closed too: if the ledger holds a claim
stamped with a version this deployment has no key for, eligibility refuses rather
than admitting, because a miss under a key we cannot compute proves nothing. That
is the condition `npm run probe:trial-retention` reports as `UNSUPPORTED`.

---

## 1. Before you start

- [ ] `npm run probe:trial-retention` is clean. Record the current active version
      and the list of stored versions.
- [ ] You know **why** you are rotating. A suspected leak of the key is a real
      reason; "it has been a while" is not, because the cost of a rotation is
      carrying two keys for three years.
- [ ] Not a Friday evening, and not during a Thai market session.

## 2. Generate the new key

```bash
# 32 bytes, base64. Never paste the output into this repository, a commit
# message, a ticket, a chat, or an error report.
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

## 3. Add the key — do not activate it

Set **only** the new key in Vercel (Production, Preview, Development):

```
TRIAL_IDENTITY_HMAC_SECRET_V2 = <the new value>
```

If this is the first rotation, also make version 1 explicit **in the same change**,
copying the value from `TRIAL_IDENTITY_HMAC_SECRET` exactly:

```
TRIAL_IDENTITY_HMAC_SECRET_V1 = <the existing value, unchanged>
```

Setting `…_V1` to anything other than the existing value fails closed
(`legacy-conflict`) rather than guessing which one is meant. Leaving
`TRIAL_IDENTITY_HMAC_SECRET` in place beside an identical `…_V1` is accepted and
is the safer order.

## 4. Deploy, and prove the read path first

Redeploy so the running build resolves the new keyring. Nothing has changed about
what gets written — the active version is still 1.

- [ ] `npm run probe:trial-retention` reports `active V1, reads V1, V2`.
- [ ] `stored key versions` is **not** `UNSUPPORTED`.

This is the step that makes the rotation safe: the build that will later write V2
can already read V1, and the build that reads V2 is live *before* anything writes
it.

## 5. Activate

```
TRIAL_IDENTITY_HMAC_ACTIVE_VERSION = 2
```

Redeploy.

- [ ] `npm run probe:trial-retention` reports `active V2, reads V1, V2`.
- [ ] A **new** account can start a trial (its claim is written under V2).
- [ ] An account whose trial was already spent under V1 is still refused with the
      "you have used this before" wording, and its checkout still works. This is
      the assertion the whole runbook exists for; do not skip it.

## 6. Keep the old key

Version 1's key stays configured until every V1 claim has passed its
`retain_until`. In practice that is **three years after the last V1 claim was
written** — which is *not* the day you rotated, because a claim written the hour
before the switch carries its own full window.

To check whether a version still has claims:

```sql
-- Service role, read-only.
select hash_version, count(*), max(retain_until) as last_expiry
from public.trial_identity_claims
group by hash_version
order by hash_version;
```

Remove `TRIAL_IDENTITY_HMAC_SECRET_V1` only when that query returns no row for
version 1. `npm run probe:trial-retention` will report `UNSUPPORTED V1` if you
remove it early — and every trial will be refused until it is restored.

---

## What must never happen

- **Rehashing old claims under the new key.** It is impossible: the ledger holds
  digests and no raw identities, which is the point of it. There is nothing to
  re-derive from.
- **Storing the raw mailbox to make rehashing possible.** That would turn a
  pseudonymous ledger into a list of addresses that outlives every account, which
  is precisely what the design refuses. The keyring exists so that rotation does
  not need it.
- **Reusing a version number.** A version is part of the unique key. Reusing one
  would collide two different derivations of the same identity.
- **Rotating and enabling retention enforcement in the same change.** One of them
  changes what is findable and the other changes what exists; do not debug them
  together.

## Rotation log

Date and operator only — never a value, never a prefix, never a fingerprint.

| Date | Operator | From → to | Notes |
| --- | --- | --- | --- |
| 2026-08-06 | — | (keyring installed; V1 = existing key, unchanged) | No rotation performed. |
