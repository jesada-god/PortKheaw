import { z } from 'zod';
import { resolveCurrentMarketSession, sessionPresentation } from '@/src/lib/market-data/current-session';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import { fixed, fixedDivide, fixedMultiply, fixedToNumber } from '@/src/lib/money/fixed';
import {
  DEFAULT_TRANSACTION_TIME_ZONE,
  resolveTransactionTimeZone,
  validateTransactionDateTime,
} from '../transaction-datetime';

export const OPTION_CONTRACT_MULTIPLIER = 100 as const;
export const OPTION_PURCHASE_MAX_QUOTE_AGE_MS = 15 * 60_000;

const positivePrice = z.string().trim()
  .regex(/^\d+(?:\.\d{1,8})?$/, 'ราคาซื้อต้องเป็นทศนิยมไม่เกิน 8 ตำแหน่ง')
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, 'ราคาซื้อต้องมากกว่า 0');

/**
 * Commission and exchange fees, as one non-negative decimal. The pattern admits
 * neither a sign nor an exponent, so a negative fee — a rebate the ledger has no
 * verb for — and `NaN` are both rejected by shape rather than by a later check.
 */
const feeAmount = z.string().trim()
  .regex(/^\d+(?:\.\d{1,8})?$/, 'ค่าธรรมเนียมต้องเป็นตัวเลขไม่ติดลบ ทศนิยมไม่เกิน 8 ตำแหน่ง')
  .refine((value) => Number.isFinite(Number(value)), 'ค่าธรรมเนียมไม่ถูกต้อง');

/**
 * How the number in the fee box is meant, and the *only* thing this distinction
 * decides: `per_contract` multiplies it by the contract count to reach the one
 * total the ledger stores. Every figure downstream — cost, max loss, cash after,
 * breakeven, P&L — is computed from that total, so an order entered either way
 * is the same position afterwards.
 */
export const OPTION_FEE_MODES = ['total', 'per_contract'] as const;
export type OptionFeeMode = typeof OPTION_FEE_MODES[number];

export const optionPurchaseRequestSchema = z.object({
  portfolioId: z.string().uuid('กรุณาเลือกพอร์ตออปชัน'),
  underlyingSymbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9.-]{0,19}$/),
  expiration: z.iso.date(),
  contractSymbol: z.string().trim().toUpperCase().min(3).max(80),
  contracts: z.number().int().positive().max(1_000_000),
  purchasePrice: positivePrice,
  /*
   * Defaulted rather than required: a client that predates the fee box sends no
   * fee, and the request it sends is still a correct zero-fee purchase. The
   * server never trusts the client's arithmetic either way — it is handed the
   * number as typed plus the mode, and computes the total itself.
   */
  fee: feeAmount.default('0'),
  feeMode: z.enum(OPTION_FEE_MODES).default('total'),
  occurredAt: z.string().trim().min(1),
  timezone: z.string().trim().min(1).max(64).default(DEFAULT_TRANSACTION_TIME_ZONE)
    .transform(resolveTransactionTimeZone),
  quoteFingerprint: z.string().min(16).max(1_000),
  idempotencyKey: z.string().uuid(),
}).superRefine((value, context) => {
  const result = validateTransactionDateTime(value.occurredAt, value.timezone);
  if (!result.ok) context.addIssue({ code: 'custom', path: ['occurredAt'], message: result.message });
  if (value.expiration < value.occurredAt.slice(0, 10)) {
    context.addIssue({ code: 'custom', path: ['expiration'], message: 'สัญญาหมดอายุแล้ว' });
  }
});

export type OptionPurchaseRequest = z.infer<typeof optionPurchaseRequestSchema>;

export interface OptionPurchaseQuoteSnapshot {
  underlyingSymbol: string;
  optionKind: 'call' | 'put';
  strike: number;
  expiration: string;
  contractSymbol: string;
  multiplier: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  spot: number;
  quoteTimestamp: string;
  chainTimestamp: string;
  status: OptionContract['status'];
  delayedMinutes: number | null;
  provider: string;
  marketDataProvider: string | null;
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

export function buildOptionPurchaseQuote(
  chain: OptionsChain,
  contractSymbol: string,
): OptionPurchaseQuoteSnapshot | null {
  const normalized = contractSymbol.trim().toUpperCase();
  const contract = [...chain.calls, ...chain.puts]
    .find((item) => item.contractSymbol.toUpperCase() === normalized);
  if (!contract) return null;
  const bid = finiteOrNull(contract.bid);
  const ask = finiteOrNull(contract.ask);
  return {
    underlyingSymbol: chain.underlyingSymbol.toUpperCase(),
    optionKind: contract.type,
    strike: contract.strike,
    expiration: contract.expiration,
    contractSymbol: contract.contractSymbol.toUpperCase(),
    multiplier: contract.multiplier,
    bid,
    ask,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : finiteOrNull(contract.mark),
    last: finiteOrNull(contract.last),
    impliedVolatility: finiteOrNull(contract.impliedVolatility),
    delta: finiteOrNull(contract.delta),
    gamma: finiteOrNull(contract.gamma),
    theta: finiteOrNull(contract.theta),
    vega: finiteOrNull(contract.vega),
    rho: finiteOrNull(contract.rho),
    spot: chain.spot,
    quoteTimestamp: contract.asOf,
    chainTimestamp: chain.asOf,
    status: contract.status,
    delayedMinutes: contract.delayedMinutes,
    provider: chain.provider,
    marketDataProvider: contract.marketDataProvider,
  };
}

export type OptionQuoteValidation =
  | { ok: true }
  | { ok: false; code: 'invalid-quote' | 'stale-quote' | 'market-closed'; message: string };

/**
 * Why the quote in front of the reader is old, when it is old.
 *
 * US listed options quote in the REGULAR session only — 09:30–16:00 ET. Neither
 * the pre-market nor the after-hours equity window quotes them, so for this
 * purchase path both are shut exactly as a weekend is, and the equity phase is
 * the right thing to read: `REGULAR` is the only phase in which a fresh option
 * quote can exist at all.
 *
 * This exists because the two cases are not the same finding and must not share
 * a message. An old quote during trading hours is a defect somewhere in the
 * provider/cache path, and "reload" is a real instruction. An old quote at
 * 03:00 ET is the market being closed, and "กรุณาโหลดราคาใหม่" then asks a
 * reader to keep pressing a button that cannot produce a newer price until the
 * bell — the useless refresh prompt this function replaces.
 *
 * Returns null while the options market is open, which is what makes the
 * staleness refusal keep its own words in the case where they mean something.
 */
export function optionsMarketClosedMessage(nowMs = Date.now()): string | null {
  const session = resolveCurrentMarketSession({ now: new Date(nowMs) });
  if (session.phase === 'REGULAR') return null;
  const { label } = sessionPresentation(session.phase, session.closeReason, session.session);
  return `${label} — ออปชันสหรัฐฯ ซื้อขาย 09:30–16:00 น. ตามเวลาตลาดสหรัฐฯ ราคาที่แสดงคือราคาล่าสุดของรอบซื้อขายก่อนหน้า จะเพิ่มเข้าพอร์ตได้อีกครั้งเมื่อตลาดเปิด`;
}

/**
 * The refusal for a quote that is too old to buy on, worded for the reason it is
 * old. The 15-minute allowance itself is unchanged either way — only what the
 * reader is told about it.
 */
function staleQuoteRefusal(nowMs: number): OptionQuoteValidation {
  const closed = optionsMarketClosedMessage(nowMs);
  return closed
    ? { ok: false, code: 'market-closed', message: closed }
    : { ok: false, code: 'stale-quote', message: 'ราคาออปชันชุดนี้เก่าเกินไป กรุณาโหลดราคาใหม่' };
}

export function validateOptionPurchaseQuote(
  quote: OptionPurchaseQuoteSnapshot,
  nowMs = Date.now(),
): OptionQuoteValidation {
  if (
    quote.multiplier !== OPTION_CONTRACT_MULTIPLIER
    || quote.ask === null
    || !Number.isFinite(quote.ask)
    || quote.ask <= 0
    || !Number.isFinite(quote.spot)
    || quote.spot <= 0
  ) {
    return { ok: false, code: 'invalid-quote', message: 'สัญญานี้ยังไม่มี Ask หรือ multiplier มาตรฐาน 100 ที่ใช้ซื้อได้' };
  }
  if (quote.status === 'stale') return staleQuoteRefusal(nowMs);
  const observedAt = Date.parse(quote.quoteTimestamp);
  const allowedAge = OPTION_PURCHASE_MAX_QUOTE_AGE_MS + (quote.delayedMinutes ?? 0) * 60_000;
  if (!Number.isFinite(observedAt) || nowMs - observedAt > allowedAge || observedAt - nowMs > 60_000) {
    return staleQuoteRefusal(nowMs);
  }
  return { ok: true };
}

/**
 * What a purchase pins, and what it deliberately does not.
 *
 * The fingerprint travels with the request so the server can refuse to write a
 * row whose TERMS are not the ones the reader was shown. It pins the contract's
 * identity — symbol, kind, strike, expiry, multiplier — because those are what
 * the server supplies to the ledger from its own copy of the chain, and a
 * disagreement there would post a different instrument than the one clicked.
 *
 * Bid, ask, mid, last, spot and the quote instant are deliberately NOT pinned,
 * and must not be added back. Two facts decide it:
 *
 *   1. **The money does not come from them.** The row is priced from
 *      `purchasePrice` — the value in the reader's own input, which the cost,
 *      max loss and cash-after preview are all derived from — so a market that
 *      moves between opening the sheet and confirming cannot change what the
 *      reader was shown or what they are charged. There is nothing here for an
 *      equality check to protect.
 *   2. **They move continuously.** A live option re-quotes every few seconds, so
 *      pinning them refuses any reader who takes longer than one quote to press
 *      confirm — and refuses the retry for the same reason. Production QA hit
 *      exactly that: a Call shown at ask 62.13 was 60.76 at the server seconds
 *      later, and no purchase could complete at all *while the market was open*,
 *      which is the only time one can be made.
 *
 * Freshness is still gated, and gated separately: `validateOptionPurchaseQuote`
 * runs against the server's own quote and refuses anything past the 15-minute
 * allowance, so a purchase is only ever offered against a real, recent market.
 */
export function optionPurchaseQuoteFingerprint(quote: OptionPurchaseQuoteSnapshot): string {
  return JSON.stringify([
    quote.contractSymbol,
    quote.optionKind,
    quote.strike,
    quote.expiration,
    quote.multiplier,
  ]);
}

export interface OptionPurchasePreview {
  /** Price x 100 x contracts — the contract premium alone, before any fee. */
  premium: number;
  /** The order's whole fee in USD, after the per-contract mode is resolved. */
  feeTotal: number;
  /** Premium + fee: the cash this order takes, and the position's cost. */
  cost: number;
  /** A long option cannot lose more than it cost, and the fee is part of it. */
  maxLoss: number;
  cashAfter: number;
  /**
   * What the underlying has to travel past the strike, per share, for the whole
   * order to come out even — the premium per share plus the fee spread over the
   * shares it controls. Added to the strike for a call, subtracted for a put.
   */
  breakevenOffset: number;
}

/**
 * The one place a fee entered per contract becomes the order's total. Kept apart
 * from the preview so the server can resolve the same number for the row it
 * writes without recomputing a preview it does not need.
 */
export function resolveOptionFeeTotal(fee: string, feeMode: OptionFeeMode, contracts: number): number | null {
  if (!Number.isInteger(contracts) || contracts <= 0 || !feeAmount.safeParse(fee).success) return null;
  const parsed = fixed(fee.trim());
  return fixedToNumber(feeMode === 'per_contract' ? fixedMultiply(parsed, fixed(String(contracts))) : parsed);
}

/** Strike plus the breakeven offset for a call, minus it for a put. */
export function optionPurchaseBreakeven(
  optionKind: 'call' | 'put',
  strike: number,
  breakevenOffset: number,
): number {
  return fixedToNumber(optionKind === 'call'
    ? fixed(strike) + fixed(breakevenOffset)
    : fixed(strike) - fixed(breakevenOffset));
}

export function calculateOptionPurchasePreview(
  contracts: number,
  purchasePrice: string,
  cashBalance: number,
  fee: string = '0',
  feeMode: OptionFeeMode = 'total',
): OptionPurchasePreview | null {
  if (!Number.isInteger(contracts) || contracts <= 0 || !positivePrice.safeParse(purchasePrice).success) return null;
  const feeTotalNumber = resolveOptionFeeTotal(fee, feeMode, contracts);
  if (feeTotalNumber === null) return null;
  const units = fixedMultiply(fixed(String(contracts)), fixed(String(OPTION_CONTRACT_MULTIPLIER)));
  const premium = fixedMultiply(units, fixed(purchasePrice));
  const feeTotal = fixed(feeTotalNumber);
  const cost = premium + feeTotal;
  const numericCost = fixedToNumber(cost);
  return {
    premium: fixedToNumber(premium),
    feeTotal: fixedToNumber(feeTotal),
    cost: numericCost,
    maxLoss: numericCost,
    cashAfter: fixedToNumber(fixed(cashBalance) - cost),
    breakevenOffset: fixedToNumber(fixed(purchasePrice) + fixedDivide(feeTotal, units)),
  };
}
