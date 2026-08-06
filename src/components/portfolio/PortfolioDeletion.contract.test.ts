import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Wiring contracts for the delete-and-move surface.
 *
 * These assert connections rather than behaviour — that the card offers deletion
 * instead of archiving, that the page passes the recovery list down, that the
 * client never computes an amount for itself. Each is a wire that a rendering
 * test would need most of the application mounted to observe, and each is one
 * that has a wrong version somebody could plausibly write.
 */

const manager = readFileSync(resolve(process.cwd(), 'src/components/portfolio/PortfolioManager.tsx'), 'utf8');
const page = readFileSync(resolve(process.cwd(), 'app/portfolio/page.tsx'), 'utf8');
const client = readFileSync(resolve(process.cwd(), 'src/components/portfolio/PortfolioClient.tsx'), 'utf8');
const repository = readFileSync(resolve(process.cwd(), 'src/lib/portfolio/repository.ts'), 'utf8');
const actions = readFileSync(resolve(process.cwd(), 'app/portfolio/transfer-actions.ts'), 'utf8');
const transferDialog = readFileSync(resolve(process.cwd(), 'src/components/portfolio/TransferAssetsDialog.tsx'), 'utf8');

describe('the portfolio card', () => {
  it('offers deletion where it used to offer only archiving', () => {
    expect(manager).toContain('ลบพอร์ต');
    expect(manager).toContain('openDelete(portfolio)');
    // Archive survives for exactly one case: the Default / Legacy portfolio,
    // which cannot be deleted because the account is anchored to it.
    expect(manager).toMatch(/portfolio\.isLegacy[\s\S]{0,200}Archive/);
  });

  it('styles deletion as the destructive action it is', () => {
    expect(manager).toContain('border-[var(--negative)]/50 text-[var(--negative)]');
    expect(manager).toContain('<Trash2 size={14} /> ลบพอร์ต');
  });

  it('never deletes on the click — it opens a dialog', () => {
    expect(manager).toContain('<DeletePortfolioDialog');
    // No path from the card straight to the mutation.
    expect(manager).not.toMatch(/onClick=\{\(\) => softDeletePortfolioAction/);
  });

  it('reads the dialog’s facts from the server rather than the page it is on', () => {
    expect(manager).toContain('loadPortfolioDeletionSummaryAction');
    expect(manager).toMatch(/setDeleteLoading\(true\)/);
  });
});

describe('the recovery window', () => {
  it('is loaded by the page and handed all the way down', () => {
    expect(page).toContain('getRecentlyDeleted()');
    expect(page).toContain('recentlyDeleted={recentlyDeleted}');
    expect(client).toContain('recentlyDeleted={recentlyDeleted}');
    expect(manager).toContain('data-testid="recently-deleted-portfolios"');
    expect(manager).toContain('พอร์ตที่ลบล่าสุด');
  });

  it('offers an undo that outlives a toast', () => {
    expect(manager).toContain('data-testid="portfolio-undo-delete"');
    expect(manager).toContain('ลบพอร์ตแล้ว กู้คืนได้ภายใน 7 วัน');
    expect(manager).toContain('restoreDeletedPortfolioAction');
  });
});

describe('soft-deleted portfolios are invisible to every ordinary read', () => {
  it('filters them out of the one method the application reads portfolios through', () => {
    expect(repository).toMatch(/getAll\(\)[\s\S]{0,900}\.is\('deleted_at', null\)/);
  });

  it('filters them out of the scheduled service-role read too', () => {
    expect(repository).toMatch(/loadPortfoliosForUser[\s\S]{0,900}\.is\('deleted_at', null\)/);
  });

  it('returns them only from the method whose whole purpose is to list them', () => {
    expect(repository).toMatch(/getRecentlyDeleted[\s\S]{0,400}\.not\('deleted_at', 'is', null\)/);
  });
});

describe('the server owns every amount', () => {
  it('accepts only quantities and identifiers from the browser', () => {
    // The confirmation schema is the boundary. A cost basis, a unit price or a
    // market value appearing here would be a number the client could choose.
    expect(actions).toMatch(/equities: z\.array\(z\.object\(\{\s*symbol:[\s\S]{0,120}quantity: z\.number\(\)/);
    expect(actions).not.toMatch(/costBasis\w*: z\./);
    expect(actions).not.toMatch(/unitCost\w*: z\./);
  });

  it('rebuilds the plan on confirm rather than trusting the previewed one', () => {
    expect(actions).toMatch(/confirmAssetTransferAction[\s\S]{0,2000}buildTransferPreview/);
  });

  it('replays one group id so a double submit lands on the first write', () => {
    expect(actions).toContain('groupId: uuid');
    expect(manager).toContain('setAssetGroupId(result.groupId)');
    expect(manager).toMatch(/groupId: assetGroupId/);
  });

  it('sends the reader back to a fresh list when the positions moved underneath them', () => {
    expect(manager).toMatch(/result\.code === 'stale'[\s\S]{0,400}loadTransferableAssetsAction/);
  });
});

describe('the transfer dialog', () => {
  it('walks the three questions in order', () => {
    expect(transferDialog).toContain('1. เลือกพอร์ตปลายทาง');
    expect(transferDialog).toContain('2. เลือกรายการที่จะย้าย');
    expect(transferDialog).toContain('3. ตรวจสอบก่อนยืนยัน');
  });

  it('says a move is not a trade, on the screen where it is confirmed', () => {
    expect(transferDialog).toContain('การย้ายไม่ใช่การขายและไม่ส่งคำสั่งซื้อขายจริง');
    expect(transferDialog).toContain('ยืนยันการย้ายสินทรัพย์');
  });

  it('offers the destination and the deletion once the move is done', () => {
    expect(transferDialog).toContain('เปิดพอร์ตปลายทาง');
    expect(transferDialog).toContain('ลบพอร์ตเดิม');
  });

  it('lets long labels wrap so nothing widens the dialog on a narrow screen', () => {
    expect(transferDialog).toContain('break-words');
    expect(transferDialog).toContain('min-w-0');
    expect(transferDialog).not.toMatch(/min-w-\[\d{3,}px\]/);
  });
});
