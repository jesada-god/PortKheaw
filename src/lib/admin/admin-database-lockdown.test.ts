import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The database as the last barrier, checked across the whole migration history
 * rather than one file at a time.
 *
 * The individual migration tests exercise the routines they introduce. What none
 * of them can see is the shape of the *set*: that the twenty-sixth operator
 * routine somebody adds next quarter checks the role like the first twenty-five
 * do, is revoked from `anon`, and pins its `search_path`. Those are the three
 * properties that make a `security definer` routine safe, and a routine that
 * quietly ships without one of them is the failure this file is here to catch.
 *
 * Every fact below is read out of the migrations themselves — the routine list
 * is discovered, never hand-kept — so a new routine joins the assertions by
 * existing.
 */

const root = process.cwd();
const MIGRATIONS = globSync('supabase/migrations/*.sql', { cwd: root }).sort();

interface Routine {
  name: string;
  file: string;
  /** `create … function public.<name>(…) … $$;` — the definition, in full. */
  body: string;
}

/** The last definition of each routine wins, the way the migrations replay. */
function latestDefinitions(): Map<string, Routine> {
  const found = new Map<string, Routine>();
  for (const file of MIGRATIONS) {
    const sql = readFileSync(resolve(root, file), 'utf8');
    const pattern = /create (?:or replace )?function public\.(\w+)\s*\(/g;
    for (let match = pattern.exec(sql); match; match = pattern.exec(sql)) {
      const end = sql.indexOf('$$;', match.index);
      found.set(match[1], {
        name: match[1],
        file,
        body: end === -1 ? sql.slice(match.index) : sql.slice(match.index, end + 3),
      });
    }
  }
  return found;
}

const ROUTINES = latestDefinitions();
const ALL_SQL = MIGRATIONS.map((file) => readFileSync(resolve(root, file), 'utf8')).join('\n');

/**
 * Operator routines: everything named `admin_*` that a client could call.
 *
 * `admin_access_preview_duration` is excluded by name because it is not one — it
 * returns an interval constant, takes no caller, and is revoked from every client
 * role, which the grant assertions below prove rather than assume.
 */
const OPERATOR_ROUTINES = [...ROUTINES.values()]
  .filter((routine) => routine.name.startsWith('admin_'))
  .filter((routine) => routine.name !== 'admin_access_preview_duration')
  .sort((left, right) => left.name.localeCompare(right.name));

describe('every operator routine', () => {
  it('is discovered rather than listed, and there are as many as the console uses', () => {
    expect(OPERATOR_ROUTINES.length).toBeGreaterThanOrEqual(24);
  });

  /*
   * The identity is read from `auth.uid()` inside the routine. A routine that
   * accepted a caller id as an argument would be asking the client who it is,
   * which is the whole class of bug this rule exists to make impossible.
   */
  it('derives the caller from auth.uid(), never from an argument', () => {
    for (const routine of OPERATOR_ROUTINES) {
      expect(`${routine.name}: ${routine.body.includes('auth.uid()')}`)
        .toBe(`${routine.name}: true`);
      expect(`${routine.name}: ${/input_(actor|caller|admin|requesting)_user/.test(routine.body)}`)
        .toBe(`${routine.name}: false`);
    }
  });

  it('checks is_platform_admin inside the database and refuses on its own terms', () => {
    for (const routine of OPERATOR_ROUTINES) {
      expect(`${routine.name}: ${routine.body.includes('is_platform_admin')}`)
        .toBe(`${routine.name}: true`);
      expect(`${routine.name}: ${routine.body.includes("'ADMIN_REQUIRED'")}`)
        .toBe(`${routine.name}: true`);
    }
  });

  it('runs security definer with a fixed, empty search_path', () => {
    for (const routine of OPERATOR_ROUTINES) {
      expect(`${routine.name}: ${routine.body.includes("security definer set search_path = ''")}`)
        .toBe(`${routine.name}: true`);
    }
  });

  it('is revoked from anon, so an unauthenticated caller cannot reach it at all', () => {
    for (const routine of OPERATOR_ROUTINES) {
      const revoked = new RegExp(
        `revoke all on function public\\.${routine.name}\\([^)]*\\)\\s*from public, anon`,
      ).test(ALL_SQL);
      expect(`${routine.name}: ${revoked}`).toBe(`${routine.name}: true`);
    }
  });
});

describe('the role predicate itself', () => {
  const predicate = ROUTINES.get('is_platform_admin');

  it('exists, and reads the stored role from user_roles', () => {
    expect(predicate?.body).toContain('public.user_roles');
    expect(predicate?.body).toContain("role = 'admin'");
  });

  it('is security definer with a fixed search_path, or it cannot answer from a policy', () => {
    expect(predicate?.body).toContain("security definer set search_path = ''");
  });

  /*
   * `exists(...)` is what makes this fail closed: a missing row, a null argument
   * and an unrecognised role all answer false. The failure mode is losing
   * operator access, never granting it.
   */
  it('answers from an existence test, so an unknown account is not an operator', () => {
    expect(predicate?.body).toContain('select exists (');
  });

  it('is out of reach of an unauthenticated caller', () => {
    expect(ALL_SQL).toContain('revoke all on function public.is_platform_admin(uuid) from public, anon');
  });
});

describe('nobody can promote themselves', () => {
  it('grants a client role nothing but a read of user_roles', () => {
    expect(ALL_SQL).toContain('revoke all on table public.user_roles from anon, authenticated');
    expect(ALL_SQL).toContain('grant select on table public.user_roles to authenticated');
    for (const privilege of ['insert', 'update', 'delete']) {
      expect(ALL_SQL).not.toContain(`grant ${privilege} on table public.user_roles`);
    }
  });

  it('keeps row-level security on the role table', () => {
    expect(ALL_SQL).toContain('alter table public.user_roles enable row level security');
  });

  /*
   * The read policy is scoped to the reader's own row. Even the select they do
   * have cannot be turned into a roster of who the operators are.
   */
  it('lets an account read its own role row and no other', () => {
    const policy = ALL_SQL.slice(ALL_SQL.indexOf('create policy "Users can read own role"'));
    expect(policy.slice(0, policy.indexOf(';'))).toContain('(select auth.uid()) = user_id');
  });

  it('has no routine that writes a role from a caller-supplied value', () => {
    for (const routine of ROUTINES.values()) {
      const writesRole = /(insert into|update)\s+public\.user_roles/.test(routine.body);
      if (!writesRole) continue;
      // The signup trigger is the one writer, and it writes the default only.
      expect(`${routine.name}`).toBe('handle_new_user');
      expect(routine.body).toContain('insert into public.user_roles (user_id) values (new.id)');
    }
  });
});

describe('the preview never becomes a promotion', () => {
  it('takes no user id, and verifies the stored role before it writes', () => {
    for (const name of ['set_my_admin_access_preview', 'clear_my_admin_access_preview']) {
      const routine = ROUTINES.get(name);
      expect(`${name}: ${routine?.body.includes('(select auth.uid())')}`).toBe(`${name}: true`);
      expect(`${name}: ${routine?.body.includes("viewer.role = 'admin'")}`).toBe(`${name}: true`);
      expect(`${name}: ${routine?.body.includes("raise exception 'ADMIN_REQUIRED'")}`)
        .toBe(`${name}: true`);
    }
  });

  /*
   * A preview changes what the holder can *open*, never what they *are*. If it
   * ever touched the role, an operator simulating Basic would lock themselves
   * out of the control that ends the simulation — and, far worse, the role would
   * become something a request could move.
   */
  it('never writes to user_roles', () => {
    for (const name of ['set_my_admin_access_preview', 'clear_my_admin_access_preview']) {
      expect(`${name}: ${/public\.user_roles\s+set|into public\.user_roles/.test(ROUTINES.get(name)!.body)}`)
        .toBe(`${name}: false`);
    }
  });
});

describe('the service key stays on the server', () => {
  it('is never read under a NEXT_PUBLIC name', () => {
    expect(ALL_SQL).not.toContain('NEXT_PUBLIC_SUPABASE_SERVICE');
    const admin = readFileSync(resolve(root, 'src/lib/supabase/admin.ts'), 'utf8');
    expect(admin).toContain("import 'server-only'");
    expect(admin).toContain('serverEnv.SUPABASE_SERVICE_ROLE_KEY');
  });

  /*
   * The console renders through the operator's own session, so the projections'
   * own role checks apply to it. A page that reached for the service key would
   * be reading past every policy in this file.
   */
  it('is never used to render the operator console', () => {
    for (const page of globSync('app/admin/**/*.tsx', { cwd: root })) {
      const code = readFileSync(resolve(root, page), 'utf8');
      expect(`${page}: ${code.includes('createAdminClient')}`).toBe(`${page}: false`);
      expect(`${page}: ${code.includes('SERVICE_ROLE')}`).toBe(`${page}: false`);
    }
    const repository = readFileSync(resolve(root, 'src/lib/admin/admin-repository.ts'), 'utf8');
    expect(repository).not.toContain('createAdminClient');
  });
});
