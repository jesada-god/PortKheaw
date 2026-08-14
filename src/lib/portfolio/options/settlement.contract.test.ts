import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const action = read('app/portfolio/option-settlement-actions.ts');
const dialog = read('src/components/portfolio/OptionSettlementDialog.tsx');
const section = read('src/components/portfolio/OptionsSection.tsx');
const holdingCard = read('src/components/portfolio/tracker/HoldingCard.tsx');
const toolAction = read('src/components/portfolio/PositionToolAction.tsx');
const plannerPage = read('app/tools/stock-planner/page.tsx');

/*
 * Where the settlement rules actually live.
 *
 * A disabled button is not a refusal and a preview is not a rule. These read the
 * source because the properties they hold are structural: that the browser sends
 * no money, that the server re-derives every figure from the ledger, and that
 * the write still goes through the one transaction path everything else uses. A
 * behavioural test can prove the current code is right; only these stop the next
 * change from quietly moving the decision back into the browser.
 */

describe('the settlement decision is the server’s', () => {
  it('re-derives cash, shares and open contracts from the ledger rather than trusting the request', () => {
    // The request carries which position and how many — never a balance.
    expect(action).toContain('positionKey');
    expect(action).toContain('calculatePortfolio(portfolio.transactions)');
    expect(action).toContain('summary.cashBalance');
    expect(action).toContain('summary.holdings.find');
    expect(action).toContain('summary.optionPositions.find');
    for (const clientSupplied of ['input.cashBalance', 'input.underlyingShares', 'input.strikePrice', 'input.price']) {
      expect(action).not.toContain(clientSupplied);
    }
  });

  it('asks the shared rule — including the expiry gate — before writing anything', () => {
    expect(action).toContain('authorizeOptionSettlement');
    expect(action).toContain('marketDate: optionMarketDate()');
    // The authorization is read before the row is built, and a refusal returns.
    expect(action.indexOf('authorizeOptionSettlement')).toBeLessThan(action.indexOf('repository.create'));
    expect(action).toContain('if (!authorization.ok) return');
  });

  it('resolves ownership through the reader’s own scoped read', () => {
    expect(action).toContain('repository.getById(input.portfolioId)');
    expect(action).toContain('if (!portfolio) return');
    expect(action).toContain("auth.getUser()");
  });

  /*
   * No second ledger, no second money path: the row goes through the same
   * schema, the same preparation and the same RPC every other transaction uses,
   * so entitlement, archived and deleted portfolios, idempotency and the
   * negative-balance constraints all still apply underneath.
   */
  it('writes through the one existing transaction path', () => {
    expect(action).toContain('portfolioTransactionSchema.safeParse');
    expect(action).toContain('preparePortfolioTransactionForCreate');
    expect(action).toContain('repository.create(');
    expect(action).toContain('idempotencyKey: input.idempotencyKey');
    expect(action).not.toMatch(/\.from\('portfolio_transactions'\)\s*\.insert/);
  });

  /* An exercise settles at the strike and an expiry at nothing. */
  it('writes no premium and no fee for either settlement', () => {
    expect(action).toContain("price: '0'");
    expect(action).toContain("fee: '0'");
  });
});

describe('what the browser is allowed to send', () => {
  it('sends the position and the amount, and none of the money', () => {
    expect(section).toContain('positionKey: settlement.position.key');
    expect(section).toContain('contracts: submission.contracts');
    const submitBlock = section.slice(section.indexOf('settleOptionPositionAction({'), section.indexOf('if (!result.ok)'));
    for (const financial of ['strikePrice', 'multiplier', 'price:', 'fee:', 'optionKind', 'expirationDate']) {
      expect(submitBlock).not.toContain(financial);
    }
  });

  it('shares one rule with the server instead of computing its own preview', () => {
    expect(dialog).toContain('planOptionSettlement');
    expect(dialog).toContain('optionSettlementSubject');
    // No arithmetic of its own: no strike × shares written a second time here.
    expect(dialog).not.toMatch(/strikePrice\s*\*/);
    expect(dialog).toContain('ระบบจะตรวจสอบอีกครั้งตอนบันทึก');
  });

  it('keeps the expiry button shut before the day, and says the server decides', () => {
    expect(section).toContain('isOptionExpiryReached(position.expirationDate, marketDate)');
    expect(section).toContain('disabled={locked}');
    expect(section).toContain('OPTION_EXPIRY_LOCKED_HELPER');
  });
});

describe('the tool action is not a transaction action', () => {
  it('sits in its own row, on both the contract card and the holding card', () => {
    for (const source of [section, holdingCard]) {
      expect(source).toContain('PositionToolAction');
      expect(source).toContain('border-t border-[var(--border)] pt-3');
      expect(source).toContain('คำนวณอย่างเดียว ไม่บันทึกรายการ');
    }
    expect(section).toContain('data-testid="option-transaction-actions"');
  });

  it('never writes to the ledger from the tool path', () => {
    // It imports no server action at all, so there is nothing here that could
    // post a row: navigating is the whole of what this control does.
    expect(toolAction).not.toMatch(/from '@\/app\//);
    expect(toolAction).toContain('router.push');
  });

  /* The gate that counts stays where it was: on the server. */
  it('leaves the planner’s own server gate untouched', () => {
    expect(plannerPage).toContain('resolvePageEntitlement');
    expect(plannerPage).toContain("hasCapability(entitlement.effectiveAccessTier, CAPABILITY)");
  });
});

describe('the action rows fit a phone', () => {
  /*
   * 320px is the narrowest screen this product supports. Four short Thai labels
   * wrap onto two rows there; what must never happen is a row that scrolls
   * sideways or one that pushes the card past the viewport.
   */
  it('wraps rather than overflowing, at every width', () => {
    for (const source of [section, holdingCard, dialog]) {
      expect(source).toContain('min-w-0');
      expect(source).not.toMatch(/overflow-x-auto/);
      expect(source).not.toMatch(/min-w-\[\d{3,}px\]/);
    }
    expect(section).toContain('flex min-w-0 flex-wrap gap-2');
    expect(holdingCard).toContain('flex min-w-0 flex-wrap gap-2');
  });

  it('keeps the settlement dialog inside the viewport with its confirm row reachable', () => {
    expect(dialog).toContain('sticky bottom-0');
    expect(dialog).toContain('break-words');
  });

  it('draws every surface from theme tokens, so light and dark both hold', () => {
    for (const source of [dialog, toolAction]) {
      expect(source).toContain('var(--');
      expect(source).not.toMatch(/(?:bg|text|border)-\[#[0-9a-fA-F]{3,8}\]/);
    }
  });
});
