import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('transaction date integration contract', () => {
  it('shares the wall-time utility across add, edit, options, and transfer UI', () => {
    const surfaces = [
      read('src/components/portfolio/PortfolioClient.tsx'),
      read('src/components/portfolio/OptionsSection.tsx'),
      read('src/components/portfolio/PortfolioManager.tsx'),
      read('src/components/portfolio/TransactionFormModal.tsx'),
    ];
    for (const source of surfaces) {
      expect(source).toMatch(/currentDateTimeLocal|maximumTransactionDateTimeLocal|formatDateTimeLocal|validateTransactionDateTime/);
    }
  });

  it('converts to UTC once in the repository for transaction and transfer writes', () => {
    const repository = read('src/lib/portfolio/repository.ts');
    expect(repository).toContain('transactionDateTimeToUtcIso(input.occurredAt, input.timezone)');
    expect(repository.match(/transactionDateTimeToUtcIso/g)).toHaveLength(3);
  });

  it('uses the same two-minute validation on client and server without fixed-offset parsing', () => {
    const validation = read('src/lib/portfolio/validation.ts');
    const actions = read('app/portfolio/portfolio-actions.ts');
    const utility = read('src/lib/portfolio/transaction-datetime.ts');
    expect(validation).toContain('validateTransactionDateTime');
    expect(actions).toContain('validateTransactionDateTime');
    expect(utility).toContain('TRANSACTION_FUTURE_TOLERANCE_MS = 2 * 60 * 1_000');
    expect(`${validation}\n${actions}`).not.toContain("+07:00");
  });
});
