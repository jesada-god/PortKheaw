import 'server-only';

import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import { calculatePortfolio } from '../calculations';
import type { PortfolioRecord } from '../types';
import {
  buildOptionPurchaseQuote,
  calculateOptionPurchasePreview,
  optionPurchaseQuoteFingerprint,
  optionPurchaseRequestSchema,
  validateOptionPurchaseQuote,
  type OptionPurchaseQuoteSnapshot,
  type OptionPurchaseRequest,
} from './purchase';

export type OptionPurchaseServiceResult =
  | {
    ok: true;
    transactionId: string;
    quote: OptionPurchaseQuoteSnapshot;
    cost: number;
    cashAfter: number;
  }
  | {
    ok: false;
    code: 'invalid' | 'contract-not-found' | 'invalid-quote' | 'stale-quote' | 'market-closed'
      | 'quote-changed' | 'portfolio-not-found' | 'insufficient-cash';
    message: string;
    fields?: Record<string, string>;
    quote?: OptionPurchaseQuoteSnapshot;
  };

export interface OptionPurchaseServiceDependencies {
  now(): number;
  loadChain(symbol: string, expiration: string): Promise<OptionsChain>;
  loadPortfolio(id: string): Promise<PortfolioRecord | null>;
  create(input: OptionPurchaseRequest, quote: OptionPurchaseQuoteSnapshot): Promise<string>;
}

export async function purchaseOptionFromChain(
  raw: unknown,
  dependencies: OptionPurchaseServiceDependencies,
): Promise<OptionPurchaseServiceResult> {
  const parsed = optionPurchaseRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? 'form')] ??= issue.message;
    return { ok: false, code: 'invalid', message: 'กรุณาตรวจสอบข้อมูลที่กรอก', fields };
  }
  const input = parsed.data;
  const chain = await dependencies.loadChain(input.underlyingSymbol, input.expiration);
  const quote = buildOptionPurchaseQuote(chain, input.contractSymbol);
  if (!quote) {
    return { ok: false, code: 'contract-not-found', message: 'ไม่พบสัญญานี้ใน Options Chain ล่าสุด' };
  }
  const quoteValidation = validateOptionPurchaseQuote(quote, dependencies.now());
  if (!quoteValidation.ok) return { ...quoteValidation, quote };
  /*
   * The terms, not the price — see `optionPurchaseQuoteFingerprint`. This fires
   * when the contract the server resolved does not carry the kind, strike,
   * expiry or multiplier the reader was shown under that symbol, which would
   * post a different instrument than the one clicked.
   */
  if (optionPurchaseQuoteFingerprint(quote) !== input.quoteFingerprint) {
    return {
      ok: false,
      code: 'quote-changed',
      message: 'เงื่อนไขสัญญาไม่ตรงกับที่แสดงไว้ กรุณาปิดแล้วเลือกสัญญาใหม่อีกครั้ง',
      quote,
    };
  }

  const portfolio = await dependencies.loadPortfolio(input.portfolioId);
  if (!portfolio || portfolio.type !== 'OPTION' || portfolio.archivedAt !== null) {
    return { ok: false, code: 'portfolio-not-found', message: 'กรุณาเลือกพอร์ตออปชันที่ยังใช้งานอยู่' };
  }
  const cashBalance = calculatePortfolio(portfolio.transactions).cashBalance;
  const preview = calculateOptionPurchasePreview(input.contracts, input.purchasePrice, cashBalance);
  if (!preview) return { ok: false, code: 'invalid', message: 'จำนวนสัญญาหรือราคาซื้อไม่ถูกต้อง' };
  if (preview.cashAfter < 0) {
    return {
      ok: false,
      code: 'insufficient-cash',
      message: `เงินสดไม่พอ ต้องใช้ $${preview.cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    };
  }

  const transactionId = await dependencies.create(input, quote);
  return { ok: true, transactionId, quote, cost: preview.cost, cashAfter: preview.cashAfter };
}
