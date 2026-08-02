# Google sign-in branding — operator checklist

## What this fixes

Google's account chooser currently reads:

> เลือกบัญชีเพื่อดำเนินการต่อไปยัง **`<project-ref>.supabase.co`**

That string is rendered by Google, on Google's own domain. **No application code
can change it** — not CSS, not a proxy, not injected DOM. Attempting to overlay
or imitate that screen would be building a credential-collection page that looks
like Google's, which this repo does not do.

Google decides what to print there from two things, both of which live in
consoles rather than in this repository:

1. the **OAuth consent screen** configuration of the Google Cloud project, and
2. the **host of the authorized redirect URI** the OAuth client was registered
   with — which today is the Supabase project host.

Until item 2 is an owned domain, the account chooser keeps showing a Supabase
host. Every step below is a manual action for the project owner.

---

## Current state

| Thing | Value |
| --- | --- |
| Production origin | `https://portkheaw.vercel.app` |
| Supabase auth host | `https://<project-ref>.supabase.co` (from `NEXT_PUBLIC_SUPABASE_URL`) |
| OAuth redirect URI registered with Google | `https://<project-ref>.supabase.co/auth/v1/callback` |
| App callback (unchanged by any of this) | `https://portkheaw.vercel.app/auth/callback` |

The app never sends the browser to Google itself. It calls
`supabase.auth.signInWithOAuth`, Supabase redirects to Google, Google returns to
**Supabase's** `/auth/v1/callback`, and Supabase then returns to the app's
`/auth/callback`. That middle hop is the host Google names, which is why
changing the app's own domain does not affect the consent screen.

---

## Step 1 — Brand the consent screen (do this first; no new domain required)

Google Cloud Console → **APIs & Services → OAuth consent screen → Branding**.

| Field | Value to enter |
| --- | --- |
| App name | `PortKheaw` |
| User support email | the owner's support address |
| App logo | the PortKheaw mark — upload `public/icons/icon-512.png` (512×512 PNG, under 1 MB) |
| Application home page | `https://portkheaw.vercel.app` |
| Application privacy policy link | `https://portkheaw.vercel.app/legal/privacy` |
| Application terms of service link | `https://portkheaw.vercel.app/legal/terms` |
| Authorized domains | `vercel.app` — and `<owned-domain>` once step 3 is done |
| Developer contact information | the owner's email |

Then **Save**.

> Uploading a logo puts the app into Google's verification queue. Until
> verification completes, an unverified app can still show the redirect host
> rather than the app name, and external users may see the "Google hasn't
> verified this app" interstitial. Verification requires a domain you can prove
> ownership of in Google Search Console — which is the same prerequisite as
> step 3.

**Privacy policy and terms pages do not exist in this app yet.** Google requires
both links to resolve. Either publish those two routes or point the fields at
pages hosted elsewhere before submitting.

## Step 2 — Confirm the OAuth client's URIs

Google Cloud Console → **APIs & Services → Credentials → OAuth 2.0 Client IDs →
your Web client**.

**Authorized JavaScript origins** — the origins that host the app:

```
https://portkheaw.vercel.app
http://localhost:3000
```

**Authorized redirect URIs** — the Supabase auth callback, *not* the app's:

```
https://<project-ref>.supabase.co/auth/v1/callback
```

Then in Supabase Dashboard → **Authentication → URL Configuration**:

- Site URL: `https://portkheaw.vercel.app`
- Redirect URLs (allow-list): `https://portkheaw.vercel.app/**` and
  `http://localhost:3000/**`

The app requests `redirectTo = <this origin>/auth/callback` and sanitises the
`next` parameter on both the request and the return leg
(`src/lib/auth/paths.ts`, `app/auth/callback/route.ts`), so the allow-list is a
second lock rather than the only one.

## Step 3 — Replace the Supabase host with an owned domain

**This is the only step that removes the project ref from Google's screen.**

Prerequisites, neither of which this repository can satisfy:

- a domain the owner controls, and
- the Supabase **Custom Domain** add-on, which is a paid add-on and is not
  available on the Free plan.

1. Supabase Dashboard → **Settings → General → Custom Domains** → enable the
   add-on and enter `auth.<owned-domain>`.
2. Add the TXT/CNAME records Supabase prints, at the DNS provider.
3. Wait for verification, then **Activate**.
4. Google Cloud Console → Credentials → the Web client → **Authorized redirect
   URIs**: add

   ```
   https://auth.<owned-domain>/auth/v1/callback
   ```

   Keep the old `<project-ref>.supabase.co` URI in place until step 6 is
   verified — removing it first breaks sign-in for anyone mid-flow.
5. OAuth consent screen → **Authorized domains**: add `<owned-domain>`.
6. Vercel → Project → **Settings → Environment Variables → Production**: set

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://auth.<owned-domain>
   ```

   Leave `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` untouched — the key is bound to
   the project, not the hostname. Redeploy: `NEXT_PUBLIC_*` values are inlined
   at build time, so an existing deployment keeps the old host until rebuilt.
7. Verify the account chooser now reads `auth.<owned-domain>`, then remove the
   old redirect URI from Google.

No code change accompanies step 6. Every Supabase client in the app — browser,
server, admin, the middleware CSP, and the `scripts/` CLIs — is constructed from
that one variable, and `src/config/env/supabase-host.test.ts` fails the build if
a second source of the host is ever introduced.

---

## What is definitely *not* the fix

- Changing `NEXT_PUBLIC_SUPABASE_URL` to a domain that only CNAMEs to Supabase
  without the add-on. Supabase Auth issues its own redirect and cookie domain
  from the configured host; a bare DNS alias breaks the token exchange.
- Proxying `/auth/v1/*` through the Next app to disguise the host. It would put
  a session-minting endpoint behind an app route, and Google would still be
  registered against whichever host it redirects to.
- Any change to the app's own `/auth/callback`, the anon/publishable key, the
  session cookie, or the PKCE flow. None of those appear on Google's screen.
