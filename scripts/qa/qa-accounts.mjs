/**
 * THROWAWAY QA ACCOUNTS: WHERE THEY MAY BE MADE, AND HOW THEY GO AWAY.
 *
 * ===========================================================================
 * WHY THIS IS ONE MODULE AND NOT A PATTERN NINE SCRIPTS COPY
 * ===========================================================================
 * Nine scripts in `scripts/` sign in as a real reader, which means each one
 * creates a real `auth.users` row. Two of them never deleted it, four deleted
 * it in a way that could not work, and none of them checked. The result was
 * twelve QA accounts sitting in PRODUCTION, because `.env.local` is this
 * repo's production configuration by convention and every one of those scripts
 * read it.
 *
 * A pattern copied nine times is nine chances to copy it slightly wrong, and
 * the evidence that this happens is the twelve accounts. So the guard, the
 * registry, the dependency-ordered purge and the proof are here, once, and the
 * scripts call them.
 *
 * ===========================================================================
 * WHY DELETING THE USER IS NOT ENOUGH
 * ===========================================================================
 * Measured against the schema rather than assumed:
 *
 *     auth.users --CASCADE--> public.portfolios --RESTRICT--> portfolio_transactions
 *                                               --RESTRICT--> portfolio_option_positions
 *                                               --RESTRICT--> portfolio_option_targets
 *
 * Deleting the auth user cascades into `portfolios`, and the three RESTRICT
 * children then refuse it with 23503. The RESTRICT is deliberate — a ledger is
 * the account's financial record and `202608280001` argues at length for
 * keeping it — so the answer is order, not cascade, which is the same answer
 * that migration gave `purge_account_data`.
 *
 * `purgeOwnedRows` below is that order, for the tables a QA script actually
 * seeds. It is deliberately NOT a copy of the product's full purge list: this
 * removes what QA made, and anything it misses shows up as a failed teardown
 * rather than as a silent partial delete.
 */
import { assertNotProduction } from '../../src/lib/dev/db-target.ts';

/**
 * ===========================================================================
 * THE OWNER REGISTRY — ONE LIST, READ FROM BOTH ENDS
 * ===========================================================================
 * Every throwaway account is stamped at creation with `user_metadata.qa_owner`,
 * and `trial:qa-cleanup` sweeps production by that stamp. Those were two lists:
 * the tags nine scripts wrote, and the tags one sweep looked for. They drifted
 * to the worst possible place — the sweep knew ONE of the nine — so it reported
 * "0 deletable" against a production database holding twelve QA accounts, and
 * the report was true about the list and false about the database.
 *
 * A sweep that names its own owners is a sweep that silently narrows every time
 * somebody adds a QA script, and nothing goes red when it does: the new script
 * passes, the sweep passes, and the accounts pile up. So the list lives HERE,
 * once, beside the teardown — the writers get their tag out of it through
 * `qaOwner()`, the sweep imports `QA_OWNER_TAGS`, and neither can name a tag
 * the other has not seen.
 *
 * The value of each entry is the script that writes the tag. It is what makes
 * the registry checkable rather than merely central: `qa-accounts.test.ts`
 * reads every file under `scripts/` and fails if a `qa_owner` is written that
 * is not registered, or if a registered tag names a file that does not write
 * it. An entry cannot be added to widen the sweep without a script behind it,
 * and a script cannot stamp an account the sweep will not come back for.
 *
 * ADDING A QA SCRIPT THAT CREATES ACCOUNTS: add its tag here, and write it with
 * `qaOwner('<tag>')`. That is the whole procedure, and skipping it fails a test
 * rather than leaking an account.
 */
export const QA_OWNERS = Object.freeze({
  'admin-overview-qa': 'scripts/qa/admin-overview-qa.mjs',
  'codex-options-canonical-e2e': 'scripts/qa/options-simulator-canonical-e2e.mjs',
  'commodity-futures-qa': 'scripts/qa/commodity-futures-qa.mjs',
  'option-chain-purchase-e2e': 'scripts/qa/option-chain-purchase-e2e.mjs',
  'phase1-ux-qa': 'scripts/qa/phase1-ux-qa.mjs',
  'phase2-ops-qa': 'scripts/qa/phase2-ops-qa.mjs',
  'stock-planner-mobile-qa': 'scripts/qa/stock-planner-mobile-qa.mjs',
  'tools-simulator-mobile-qa': 'scripts/qa/tools-simulator-mobile-qa.mjs',
  'ui-redesign-qa': 'scripts/qa/ui-redesign-authenticated-qa.mjs',
});

/** The same list as a plain array, which is the shape the sweep filters with. */
export const QA_OWNER_TAGS = Object.freeze(Object.keys(QA_OWNERS).sort());

/**
 * Reserved domain, so a swept candidate cannot be an address anybody receives
 * mail at. Exported for the same reason the tags are: the sweep requires the
 * tag AND this domain, so a script that stamped a registered tag onto an
 * address outside it would create an account the sweep can never collect.
 */
export const QA_EMAIL_DOMAIN = '@example.com';

/**
 * The tag to stamp on an account, checked against the registry as it is read.
 *
 * It returns its argument, so the call site still reads as the literal it
 * replaced — the point is not indirection, it is that a tag typed here and
 * nowhere else THROWS at the moment the account would have been created,
 * before there is anything in production to go and find.
 */
export function qaOwner(tag) {
  if (!Object.hasOwn(QA_OWNERS, tag)) {
    throw new Error(
      `qa_owner ${JSON.stringify(tag)} is not registered in scripts/qa/qa-accounts.mjs. `
      + `An unregistered tag is an account trial:qa-cleanup will never sweep. `
      + `Registered: ${QA_OWNER_TAGS.join(', ')}.`,
    );
  }
  return tag;
}

/** Leave the accounts behind for inspection. Debugging only. */
export const KEEP = process.argv.includes('--keep');

/**
 * Refuse to run anywhere a throwaway account must not be created.
 *
 * A thin wrapper on the shared guard so every QA script names itself the same
 * way, and so there is one import to grep for when asking "which scripts are
 * safe to point at a real database".
 */
export function assertQaTarget(url, label) {
  assertNotProduction(url, label);
}

/**
 * A registry of the accounts one run created, with a teardown that proves
 * itself.
 *
 * `register` is called from wherever the account is actually made rather than
 * from the top of the script, because these scripts create users in more than
 * one place and the second one is always the easy one to miss — `phase1-ux`
 * makes its Elite reader four hundred lines away from its Pro one, inside a
 * helper called from one branch of a nested loop.
 */
export function createQaAccounts({ url, serviceKey, label }) {
  const created = [];
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const request = async (method, path, extra) => {
    const response = await fetch(`${url}${path}`, { method, headers: { ...headers, ...(extra ?? {}) } });
    return { ok: response.ok, status: response.status, body: await response.text() };
  };

  const ids = async (path) => {
    const result = await request('GET', path);
    if (!result.ok) return [];
    try {
      const rows = JSON.parse(result.body);
      return Array.isArray(rows) ? rows.map((row) => row.id).filter(Boolean) : [];
    } catch {
      return [];
    }
  };

  /**
   * Delete the rows this account owns, children before parents.
   *
   * Every filter is the account's own id, so a run can only remove what it
   * made. One request per table, so a failure names the table it happened on —
   * the discipline `verify-overview-alert-sweep.ts` states for its teardown.
   */
  async function purgeOwnedRows(userId) {
    const owner = `user_id=eq.${encodeURIComponent(userId)}`;
    const steps = [];
    const del = async (labelForStep, path) => {
      const result = await request('DELETE', `/rest/v1/${path}`, { Prefer: 'return=minimal' });
      steps.push(result.ok ? labelForStep : `${labelForStep} FAILED ${result.status}`);
    };

    for (const table of ['price_alerts', 'stock_plans', 'option_simulations', 'purchase_consents']) {
      await del(table, `${table}?${owner}`);
    }

    /*
      `watchlist_items` cascades from `watchlists`, but it is deleted explicitly
      anyway: a teardown that relies on a cascade is a teardown that changes
      behaviour the next time somebody edits a constraint, and it costs one
      request to not depend on that.
    */
    const lists = await ids(`/rest/v1/watchlists?${owner}&select=id`);
    if (lists.length > 0) {
      await del('watchlist_items', `watchlist_items?watchlist_id=in.(${lists.join(',')})`);
      await del('watchlists', `watchlists?${owner}`);
    }

    /* The three RESTRICT children, then the portfolios they were blocking. */
    const portfolios = await ids(`/rest/v1/portfolios?${owner}&select=id`);
    if (portfolios.length > 0) {
      const scope = `portfolio_id=in.(${portfolios.join(',')})`;
      await del('portfolio_option_targets', `portfolio_option_targets?${scope}`);
      await del('portfolio_option_positions', `portfolio_option_positions?${scope}`);
      await del('portfolio_transactions', `portfolio_transactions?${scope}`);
      await del('portfolios', `portfolios?${owner}`);
    }
    return steps;
  }

  return {
    /** Record an account the moment it exists. Returns it, so it can wrap a call. */
    register(account) {
      if (account?.userId) created.push({ userId: account.userId, email: account.email ?? '(unknown)', tier: account.tier ?? '-' });
      return account;
    },

    get accounts() {
      return [...created];
    },

    /**
     * Delete every account this run made, and PROVE it.
     *
     * Newest first, so a partial failure leaves the older ledger intact. Then a
     * `GET` on each id must answer 404 — a teardown that reports success from
     * the delete call alone tells you the mess is gone on exactly the runs
     * where it is not, which is how twelve accounts accumulated unnoticed.
     */
    async teardown() {
      if (created.length === 0) return { deleted: 0, failed: [], remaining: [] };
      if (KEEP) {
        console.log(`\n--keep: leaving ${created.length} account(s) in place:`);
        for (const account of created) console.log(`  ${account.email} (${account.userId})`);
        return { kept: true, deleted: 0, failed: [], remaining: [] };
      }

      console.log(`\nteardown (${label})`);
      const failed = [];
      for (const account of [...created].reverse()) {
        const rows = await purgeOwnedRows(account.userId);
        const result = await request('DELETE', `/auth/v1/admin/users/${encodeURIComponent(account.userId)}`);
        if (result.ok) {
          console.log(`  deleted ${account.email}${rows.length ? `  [${rows.join(', ')}]` : ''}`);
        } else {
          failed.push({ ...account, error: `${result.status} ${result.body.slice(0, 200)}` });
          console.log(`  FAILED  ${account.email}: ${result.status} ${result.body.slice(0, 160)}`);
        }
      }

      const remaining = [];
      for (const account of created) {
        const check = await request('GET', `/auth/v1/admin/users/${encodeURIComponent(account.userId)}`);
        if (check.ok) remaining.push({ userId: account.userId, email: account.email });
      }
      console.log(remaining.length === 0
        ? `  verified: ${created.length} account(s) created, 0 left behind`
        : `  VERIFY FAILED: ${remaining.length} account(s) still present`);
      return { deleted: created.length - failed.length, failed, remaining };
    },
  };
}
