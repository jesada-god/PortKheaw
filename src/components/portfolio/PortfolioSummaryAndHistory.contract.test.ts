import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const client = read('src/components/portfolio/PortfolioClient.tsx');
const manager = read('src/components/portfolio/PortfolioManager.tsx');
const sheet = read('src/components/portfolio/PortfolioValueSheet.tsx');
const history = read('src/components/portfolio/TransactionHistoryClient.tsx');
const historyPage = read('app/portfolio/transactions/page.tsx');
const presentation = read('src/lib/portfolio/presentation.ts');
const mascot = read('src/components/portfolio/PortfolioGoalMascot.tsx');
const shell = read('src/components/layout/MainLayout.tsx');
const hero = read('src/components/portfolio/tracker/TrackerHero.tsx');
const panels = read('src/components/portfolio/tracker/SecondaryPanels.tsx');
const options = read('src/components/portfolio/OptionsSection.tsx');

describe('portfolio summary card', () => {
  it('labels profit and loss in Thai, with no mixed Thai/English wording', () => {
    // The headline figures live on the shared hero card now, which is the one
    // place either of them is named.
    expect(hero).toContain('label="กำไร/ขาดทุนวันนี้"');
    expect(hero).toContain("totalGainLabel = 'กำไร/ขาดทุนรวม'");
    expect(hero).not.toContain('label="P/L วันนี้"');
    expect(hero).not.toContain('label="P/L รวม"');
    /*
     * Scoped to the hero on purpose. The accounting panel keeps the ledger's own
     * English terms, which are a different surface with their own contract; what
     * had to stop was a portfolio *summary* naming its headline figures in
     * English while everything around them is Thai.
     */
    expect(hero).not.toContain('Total P&L');
    expect(hero).not.toContain('Today P&L');
    expect(manager).not.toContain('label="Total P&L"');
    expect(manager).not.toContain('label="Today P&L"');
  });

  it('explains a missing today figure in Thai, as helper text rather than a warning', () => {
    expect(client).toContain('ยังคำนวณกำไร/ขาดทุนวันนี้ไม่ได้ เพราะไม่มีราคาปิดวันก่อน');
    expect(client).not.toContain('Today P&amp;L ยังไม่พร้อม');
    expect(client).toMatch(/data-testid="portfolio-today-unavailable">[\s\S]{0,20}ยังคำนวณกำไร/);
    expect(client).toMatch(/text-xs text-\[var\(--text-muted\)\]"[^>]*data-testid="portfolio-today-unavailable"/);
  });

  it('keeps one profit/loss colour mapping and hands masked values a neutral tone', () => {
    expect(presentation).toContain('export function portfolioReturnTone');
    expect(presentation).toContain('export function portfolioReturnToneClass');
    // The goal card's names are aliases of the same function, not a second copy.
    expect(mascot).toContain('export const portfolioGoalReturnTone = portfolioReturnTone;');
    expect(mascot).toContain('export const portfolioGoalReturnToneClass = portfolioReturnToneClass;');
    for (const field of ['todayChange', 'totalGain']) {
      expect(hero).toContain(`portfolioReturnToneClass(showBalances ? ${field} : null, 'text-[var(--text-secondary)]')`);
    }
    // The hero never repeats its own null-and-sign colour test.
    expect(hero).not.toContain("=== null ? 'text-slate-400' : gainColor");
    expect(client).not.toContain("aggregateSummary.todayChange === null ? 'text-slate-400' : gainColor");
    expect(client).not.toContain("aggregateSummary.totalGain === null ? 'text-slate-400' : gainColor");
    // Total value stays the ordinary text colour, and cash reads as a balance in
    // the accounting panel rather than as a return.
    expect(panels).toContain('<Figure label="เงินสด" value={money(summary.cashBalance)} />');
  });

  it('offers the balance-adjustment sheet from the total itself', () => {
    expect(hero).toContain('aria-label="ปรับยอดพอร์ต"');
    expect(hero).toContain('data-testid="portfolio-value-edit"');
    expect(client).toContain('openValueSheet()');
    expect(client).toContain('requestPortfolioWrite()');
    expect(sheet).toContain('title="ปรับยอดพอร์ต"');
  });
});

describe('portfolio page carries no transaction history', () => {
  it('has no timeline, no preview rows and no ledger list of any kind', () => {
    expect(client).not.toContain('data-testid="portfolio-transaction-timeline"');
    expect(client).not.toContain('timeline.slice');
    expect(client).not.toContain('stockHistory');
    expect(client).not.toContain('cashEffectForTransaction');
    expect(client).not.toContain('Transaction Ledger</Modal>');
    expect(client).not.toContain('holding.transactions.map');
    expect(client).not.toContain('transactionLabels[transaction.type]');
  });

  it('replaces them with one compact entry point that describes what is inside', () => {
    expect(client).toContain('testId="portfolio-history-entry"');
    expect(panels).toContain('data-testid={testId}');
    expect(client).toContain('ดูรายการซื้อ ขาย ฝาก ถอน โอน และปรับยอดทั้งหมด');
    expect(client).toContain('href={`/portfolio/transactions?portfolio=${detailPortfolio.id}`}');
    expect(client).toContain('testId="portfolio-history-link"');
    expect(client).toContain('ประวัติเงินเข้า–ออก');
  });

  it('moves the accounting one tap down without losing any of it', () => {
    for (const label of [
      'เงินฝากสุทธิ (Net deposits)', 'มูลค่าหุ้น', 'มูลค่าออปชันสุทธิ',
      'ต้นทุนคงเหลือ', 'Realized P&L', 'Unrealized P&L',
    ]) {
      expect(panels).toContain(label);
    }
    expect(panels).toContain('data-testid="portfolio-accounting-details"');
    expect(client).toContain('<AccountingDetails');
    // Every figure is still read off the summary the ledger produced.
    expect(panels).toContain('summary.netDepositedCapital');
    expect(panels).toContain('summary.costBasis + summary.optionRemainingCost');
  });

  /*
   * One sheet, asset kind first.
   *
   * "ซื้อ" and "ขาย" used to be two of its choices, which forced the sheet to
   * guess an option or a share from the portfolio's own type before the reader
   * had said which they meant. Both are now the transaction form's own
   * ประเภทรายการ selector, reached through หุ้น / ETF — so the two rows that
   * disappeared are a relocation, not a removal, and the cash rows below them
   * are untouched.
   */
  it('keeps the add flow and its asset-kind, deposit, withdraw and transfer choices', () => {
    expect(client).toContain('data-testid="portfolio-add-asset-sheet"');
    for (const label of ['หุ้น / ETF', 'ออปชัน', 'เติมเงินจำลอง', 'ถอนเงินจำลอง', 'โอนระหว่างพอร์ต']) {
      expect(client).toContain(`title="${label}"`);
    }
    expect(client).toContain('createPortfolioTransactionAction');
    // Buy and sell live on as ledger types the one stock flow can still select.
    expect(read('src/components/portfolio/TransactionFormModal.tsx'))
      .toContain("'acquisition', 'disposal', 'initial_position'");
  });

  /*
   * Exactly one call to action on the page, and no section allowed to grow a
   * second one. The empty state carries no button at all now, which is why
   * `EmptyAssets` no longer accepts one.
   */
  it('offers a single add entry point, written once and reused by every screen', () => {
    expect(client).toContain('data-testid="portfolio-add-asset"');
    expect(client.match(/data-testid="portfolio-add-asset"/g)).toHaveLength(1);
    expect(client).toContain('เพิ่มสินทรัพย์');
    expect(client).not.toContain('เพิ่มรายการออปชัน');
    expect(options).not.toContain('เพิ่มรายการออปชัน</Button>');
    expect(panels).not.toContain('actionLabel');
    expect(panels).not.toContain('onAction');
  });

  it('leaves the dock clearance to the shell instead of stacking its own padding', () => {
    expect(shell).toContain('pb-[var(--dock-clearance)]');
    expect(history).not.toMatch(/\bpb-\[var\(--dock-clearance\)\]/);
  });
});

describe('transaction history route', () => {
  it('reads the same ledger, with no second source of truth', () => {
    expect(historyPage).toContain('new PortfolioRepository(client)');
    expect(historyPage).toContain('repository.getAll()');
    expect(historyPage).not.toContain('transaction_history');
    expect(history).toContain('buildTransactionHistory');
    expect(history).toContain('updatePortfolioTransactionAction');
    expect(history).toContain('deletePortfolioTransactionAction');
  });

  it('gives the reader a way back, a portfolio scope and privacy masking', () => {
    expect(history).toContain('href="/portfolio"');
    expect(history).toContain('กลับไปหน้าพอร์ต');
    expect(history).toContain('id="transaction-history-scope"');
    expect(history).toContain('รวมทุกพอร์ต');
    expect(history).toContain('usePortfolioPrivacy');
    expect(history).toContain('SENSITIVE_VALUE_MASK');
  });

  it('colours money in, money out and directionless rows from the shared mapping', () => {
    expect(history).toContain('transactionDirectionToneClass(entry.direction');
    expect(history).not.toContain("direction === 'in' ? 'text-positive'");
  });

  it('supports empty, error, loading and paging states', () => {
    expect(history).toContain('data-testid="transaction-history-empty"');
    expect(history).toContain('โหลดรายการเพิ่ม');
    expect(history).toContain('page.shown < page.total');
    expect(read('app/portfolio/transactions/loading.tsx')).toContain('KheawLoader');
    expect(read('app/portfolio/transactions/error.tsx')).toContain('role="alert"');
  });

  it('opens a row into the existing transaction detail, edit and reversal flow', () => {
    expect(history).toContain('onClick={() => setSelected(entry)}');
    expect(history).toContain('TransactionFormModal');
    expect(history).toContain('แก้ไขรายการ');
    expect(history).toContain('ย้อนรายการ');
    // Paired transfers stay untouchable from one side, as in the ledger itself.
    expect(history).toContain('selected.transaction.transferId');
    expect(history).toContain('READ_ONLY_PORTFOLIO_MESSAGE');
  });
});
