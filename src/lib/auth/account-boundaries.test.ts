import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The guarantees that live in the database and in the shape of the app rather
 * than in a function: one account per address, one owner per row, and no
 * endpoint that will tell a stranger who is registered.
 *
 * These read the real migrations and the real routes. They are structural on
 * purpose — a mocked Supabase cannot prove that `profiles` has a primary key or
 * that a policy compares against `auth.uid()`.
 */
const authMigration = readFileSync(resolve('supabase/migrations/202607180001_phase_1_auth.sql'), 'utf8');

/** Source with comments removed, so a cautionary note is not read as an implementation. */
function code(path: string): string {
  return readFileSync(resolve(path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const isImplementation = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);

function migrationFiles(): string[] {
  return readdirSync(resolve('supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .map((name) => readFileSync(resolve('supabase/migrations', name), 'utf8'));
}

describe('one address, one account', () => {
  it('keys the profile on the auth user id, so a second profile row for one account is impossible', () => {
    expect(authMigration).toContain('id uuid primary key references auth.users(id) on delete cascade');
    expect(authMigration).toContain('user_id uuid primary key references auth.users(id) on delete cascade');
  });

  /*
   * Two sign-ups landing at the same moment is the case a `select` then `insert`
   * check loses: both read "no profile", both insert, one crashes or duplicates.
   * The trigger relies on the primary key and `on conflict do nothing` instead,
   * which is decided by the database, not by timing.
   */
  it('creates the profile idempotently, without a read-then-write race', () => {
    const trigger = authMigration.slice(authMigration.indexOf('function public.handle_new_user'));
    expect(trigger).toContain('on conflict (id) do nothing');
    expect(trigger).toContain('on conflict (user_id) do nothing');
    expect(trigger).toContain('after insert on auth.users');
    // No "does it already exist?" lookup that a concurrent signup could outrun.
    expect(/select\s+.*from\s+public\.profiles/i.test(trigger)).toBe(false);
  });

  it('runs the profile trigger as a definer function that is not callable by users', () => {
    expect(authMigration).toContain('security definer set search_path');
    expect(authMigration).toContain('revoke all on function public.handle_new_user() from public, anon, authenticated');
  });
});

describe('row level security', () => {
  it('enables RLS on the profile and settings tables', () => {
    expect(authMigration).toContain('alter table public.profiles enable row level security');
    expect(authMigration).toContain('alter table public.user_settings enable row level security');
  });

  it('scopes every profile and settings policy to the requesting user', () => {
    const policies = [...authMigration.matchAll(/create policy "([^"]+)" on public\.(profiles|user_settings)[\s\S]*?;/g)];
    expect(policies.length).toBeGreaterThanOrEqual(5);
    for (const [statement, name] of policies) {
      expect(`${name}: ${statement}`).toContain('auth.uid()');
      // `to authenticated` is what keeps an anonymous key out entirely.
      expect(`${name}: ${statement}`).toContain('to authenticated');
    }
  });

  it('never grants an anonymous reader access to a profile', () => {
    expect(/create policy[\s\S]*?on public\.profiles[\s\S]*?to anon/.test(authMigration)).toBe(false);
  });

  /*
   * The rebuild must not have moved any portfolio data off the account it
   * belongs to. Every user-owned table still carries a user_id/owner column and
   * still compares it to auth.uid() in its policies.
   */
  it('keeps portfolio, watchlist and transaction data owned by the same user id', () => {
    const owned = migrationFiles().filter((sql) => /create table if not exists public\.(portfolios|watchlists|transactions)/.test(sql));
    expect(owned.length).toBeGreaterThan(0);
    for (const sql of owned) {
      expect(sql).toContain('references auth.users(id)');
      expect(sql).toContain('auth.uid()');
      expect(sql).toContain('enable row level security');
    }
  });
});

describe('account privacy', () => {
  it('ships no endpoint that reveals whether an address has an account', () => {
    // A `check-email` style route is the classic enumeration oracle.
    expect(existsSync(resolve('app/api/auth'))).toBe(false);
    for (const name of readdirSync(resolve('app/api'))) {
      expect(name).not.toMatch(/check-email|account-exists|provider|identity/i);
    }
  });

  it('offers no "set a password" control anywhere in the signed-in account UI', () => {
    // A Google-only account must not be handed a way to grow a password, and the
    // simplest guarantee is that no such control exists to begin with.
    for (const file of ['app/profile/page.tsx', 'app/settings/page.tsx', 'src/components/auth/AccountActions.tsx']) {
      const source = readFileSync(resolve(file), 'utf8');
      expect(source).not.toContain('ตั้งรหัสผ่าน');
      expect(source).not.toContain('เปลี่ยนรหัสผ่าน');
      expect(source).not.toContain('updateUser');
    }
  });

  it('keeps the recovery request wording free of any account or provider detail', () => {
    const form = readFileSync(resolve('src/components/auth/ForgotPasswordForm.tsx'), 'utf8');
    expect(form).toContain('หากบัญชีนี้รองรับการตั้งรหัสผ่านใหม่');
    for (const leak of ['ไม่พบบัญชี', 'ไม่มีบัญชีนี้', 'ใช้ Google', 'สมัครด้วย Google']) {
      expect(form).not.toContain(leak);
    }
  });

  it('never decides an account type from the shape of the address', () => {
    // Comments are stripped first: `identity.ts` names gmail explicitly as the
    // thing it must not do, and that warning must not read as a violation.
    const surfaces = [
      ...readdirSync(resolve('src/lib/auth')).filter(isImplementation).map((name) => `src/lib/auth/${name}`),
      'app/auth/actions.ts',
      'app/auth/callback/route.ts',
    ];
    for (const path of surfaces) {
      const source = code(path);
      expect(`${path}: gmail`).not.toContain('@gmail.com');
      expect(source).not.toContain('@gmail.com');
      expect(source).not.toContain('endsWith(\'@');
      expect(source).not.toMatch(/email[^\n]*\.split\('@'\)[^\n]*provider/i);
    }
  });
});

describe('secret handling', () => {
  it('never reaches for the service role key from anything the browser can load', () => {
    const clientSurfaces = [
      ...readdirSync(resolve('src/components/auth')).filter(isImplementation).map((name) => `src/components/auth/${name}`),
      ...readdirSync(resolve('src/lib/auth')).filter(isImplementation).map((name) => `src/lib/auth/${name}`),
      'app/auth/actions.ts',
      'app/auth/callback/route.ts',
    ];

    for (const path of clientSurfaces) {
      const source = readFileSync(resolve(path), 'utf8');
      expect(`${path}: service role`).not.toContain('SERVICE_ROLE');
      expect(source).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
      expect(source).not.toContain('createAdminClient');
    }
  });

  it('logs nothing at all from the code paths that handle codes, tokens and passwords', () => {
    for (const path of ['app/auth/actions.ts', 'app/auth/callback/route.ts', 'src/components/auth/AuthControls.tsx']) {
      const source = readFileSync(resolve(path), 'utf8');
      expect(`${path}: console`).not.toContain('console.');
      expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });

  it('renders provider errors as text, never as markup', () => {
    for (const name of readdirSync(resolve('src/components/auth')).filter(isImplementation)) {
      const source = readFileSync(resolve('src/components/auth', name), 'utf8');
      expect(source).not.toContain('dangerouslySetInnerHTML');
    }
  });
});
