# Admin MFA (AAL2)

## What this protects against

One thing, specifically: **a stolen ordinary session.**

Every other gate in this product treats the session cookie as proof of who is
asking. For a reader that is fine — the blast radius is their own portfolio. For
an operator it is not: one borrowed laptop, one leaked cookie, one XSS on an
unrelated page, and the console that changes roles, overrides plans, issues
refunds and takes the product offline opens with no further questions.

So operator surfaces require that a second factor was used **in this session** —
Supabase's `aal2` — not merely that one is enrolled. That distinction is the
whole mechanism. A stolen cookie carries `aal1`, and it cannot be upgraded
without the factor, which is not in the cookie.

## Who it applies to

Platform administrators, on operator surfaces, and nobody else. An ordinary
reader never encounters it — a non-operator asking for `/admin` still gets the
bare 404 they got before, and never learns that a second factor is something this
product asks for.

## Where it is enforced

Four independent layers. None is trusted to be the only one.

| Layer | File | Refusal |
|---|---|---|
| Edge filter | `middleware.ts` | GET → redirect to `/admin/security`; non-GET → `403 mfa-required` |
| Page render | `src/lib/admin/admin-guard.ts` (`requireAdminPage`) | redirect to `/admin/security` |
| Mutations | `src/lib/security/admin-assurance-server.ts` (`requireAdminMutation`) | typed `MFA_REQUIRED` refusal |
| Database | `is_platform_admin` inside every operator routine | routine-level refusal |

The mutation layer is the boundary, not the middleware. Three operator actions
live under `/settings` and `/support` rather than `/admin` — the admin refund
decisions, the ticket controls, and the access preview — and the middleware
assurance gate never sees those URLs. `requireAdminMutation()` is the only gate
between a caller and those functions.

A mutation is refused with a `403`, never a redirect. A server action posts to
its own page URL, and a `302` would let the browser follow it into a page render
instead of failing the write.

## The one exemption

`/admin/security` renders at `aal1`. It has to: it is where the factor is
enrolled and presented, and a gate that refuses entry to the room containing its
own key is a lockout rather than a gate.

It is still behind the operator check — a non-operator gets the same 404 there as
anywhere else under `/admin`. The exemption is asserted to be exactly one page by
`src/lib/admin/admin-console.contract.test.ts`, which fails the build if a second
page opts out. That test exists because the cheapest way to "fix" a console page
that redirects is to copy the exemption, and doing so would quietly undo the
whole requirement.

There is no environment variable, header, build flag or code constant that
satisfies the requirement. `src/lib/security/admin-assurance.test.ts` scans the
executable text of all three assurance modules for one.

## Enrolling

1. Sign in as an administrator and open any console URL. You are redirected to
   `/admin/security`.
2. **เริ่มตั้งค่า** → scan the QR with an authenticator app (Google
   Authenticator, 1Password, Authy, …), or type the shown secret in manually.
3. Enter the six-digit code. On success the session is upgraded to `aal2`, the
   console opens, and you are returned to where you were heading.

The TOTP secret and its QR exist only between `enroll` and `verify`, only in the
browser, and are never sent to our server, logged, or persisted. Supabase holds
the authoritative copy.

Enrolment runs in the browser because only the browser Supabase client writes the
upgraded `aal2` session back to the cookie the server reads. Verifying through a
server action would upgrade a session the browser never receives, and the console
would stay shut behind a factor the operator had just used.

## Recovery: enrol a second factor

**The recovery mechanism is a second enrolled factor, and you should add one the
day you enrol the first.** `/admin/security` prompts for it as soon as the first
is verified.

Put it on a different device — a second phone, a desktop password manager, a
printed secret in a safe. Two factors on two devices makes losing one an
inconvenience instead of an incident.

This is deliberately not recovery codes. A recovery code is a bearer credential
that is weaker than the factor it replaces, redeemable from exactly the stolen
session this whole mechanism exists to stop, and it needs its own storage,
hashing and single-use accounting — three more things to get wrong. A second TOTP
factor is the same mechanism with none of that surface.

A factor can only be removed while another verified one remains, so the console
can never be left with a requirement nobody can satisfy.

## Break-glass: every factor lost

This cannot be done from the application, by design. It requires Supabase
project credentials and it leaves a trail.

1. Supabase dashboard → **Authentication → Users** → find the account.
2. Delete its MFA factors. (Equivalently, from the SQL editor:
   `delete from auth.mfa_factors where user_id = '<uuid>';`)
3. The operator signs in and is sent to `/admin/security` to enrol again, because
   they now have no verified factor.
4. **Enrol two factors this time.**

Anyone with the project credentials to do this can already read and change every
row in the database, so this adds no privilege that did not exist — which is
exactly why it is the acceptable break-glass and why there is no in-product
equivalent.

Record who performed it and why. If it happens more than once, the problem is
that nobody enrolled a backup factor, and the fix is step 4 rather than an easier
recovery path.

## Supabase settings to confirm

- **Authentication → Providers → Multi-Factor Authentication**: TOTP enabled.
- **Maximum enrolled factors**: at least 2, or the backup-factor recovery path
  does not exist. This is the one setting whose default may need changing.
