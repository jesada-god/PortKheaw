import { fixed, fixedMultiply, fixedToNumber } from '../../money/fixed';
import { US_EQUITY_TIMEZONE, exchangeSessionDate } from '../../market-data/session';
import { calculateDte } from './calculations';
import { optionPositionMoneyness } from './presentation';
import type { OptionKind, OptionPositionSummary, OptionSide } from './types';

/**
 * What "ใช้สิทธิ์" and "หมดอายุ" actually do to a portfolio — written once.
 *
 * Both the confirmation preview in the browser and the server action that writes
 * the ledger row read this module, so the sentence a reader is shown before
 * confirming and the rule the server enforces afterwards cannot drift apart.
 * Nothing here writes, fetches or prices anything: it takes the state
 * `calculatePortfolio` already produced — cash, the underlying holding, the open
 * contracts — and answers whether the settlement is possible and what it moves.
 *
 * The refusals exist because the ledger's own constraint would otherwise be the
 * only thing standing in the way, and it speaks in "รายการนี้ทำให้จำนวนหุ้นหรือ
 * สัญญาติดลบ" for every cause at once. A reader exercising a Put they hold no
 * shares for needs to be told exactly that, before they press anything.
 */

export type OptionSettlementAction = 'exercise' | 'expired';

export type OptionSettlementRefusalCode =
  | 'position-closed'
  | 'contracts-invalid'
  | 'contracts-exceed-open'
  | 'short-side-exercise'
  | 'insufficient-cash'
  | 'insufficient-shares'
  | 'not-expired';

/** The contract identity and the portfolio state a settlement is decided against. */
export interface OptionSettlementSubject {
  underlyingSymbol: string;
  optionKind: OptionKind;
  side: OptionSide;
  strikePrice: number;
  multiplier: number;
  expirationDate: string;
  /** Contracts still open on this position, straight off the ledger summary. */
  openContracts: number;
  /** Where the underlying is trading, when the quote pipeline knows. */
  underlyingPrice?: number | null;
}

export interface OptionSettlementRequest {
  action: OptionSettlementAction;
  subject: OptionSettlementSubject;
  contracts: number;
  /** Cash the ledger reports for the portfolio holding the contract, in USD. */
  cashBalance: number;
  /** Shares of the underlying held in that SAME portfolio, from the ledger. */
  underlyingShares: number;
}

/**
 * The write path's input: the same request plus the clock it is judged by.
 * Separate because the preview has no business asking whether the market day
 * has arrived — a disabled button already says that, and only the server's own
 * clock is allowed to decide it.
 */
export interface OptionSettlementAuthorization extends OptionSettlementRequest {
  /** Today on the US exchange calendar — the only clock an expiry may be judged by. */
  marketDate: string;
}

export interface OptionSettlementPlan {
  action: OptionSettlementAction;
  contracts: number;
  contractsRemaining: number;
  /** Shares the settlement moves — always 0 for an expiry. */
  shares: number;
  /** Whether the underlying arrives, leaves, or does not move at all. */
  underlyingDirection: 'receive' | 'deliver' | 'none';
  /** Strike × shares, before any fee. 0 for an expiry. */
  strikeValue: number;
  /** Signed cash movement in USD: negative pays, positive receives. */
  cashDelta: number;
  cashAfter: number;
  underlyingSharesAfter: number;
  /**
   * True when the contract still looks in the money and the reader chose to let
   * it expire anyway. A warning only — nothing is auto-exercised, and no broker
   * behaviour is assumed on their behalf.
   */
  inTheMoneyWarning: boolean;
}

export type OptionSettlementOutcome =
  | { ok: true; plan: OptionSettlementPlan }
  | { ok: false; code: OptionSettlementRefusalCode; message: string };

/** The label a beginner reads, with the English term kept in parentheses once. */
export const OPTION_SETTLEMENT_TITLE: Readonly<Record<OptionSettlementAction, string>> = {
  exercise: 'ใช้สิทธิ์ออปชัน',
  expired: 'บันทึกสัญญาหมดอายุ',
};

export const OPTION_EXPIRY_LOCKED_HELPER = 'ใช้ได้เมื่อถึงวันหมดอายุ';

export const OPTION_EXPIRY_ITM_WARNING =
  'สัญญานี้อาจยังมีมูลค่าจากราคาใช้สิทธิ์ โปรดตรวจสอบก่อนบันทึกหมดอายุ';

/**
 * Today on the US exchange calendar.
 *
 * An option expires at the close of its expiration day in New York, so New York
 * is the only calendar that can answer "has it expired yet". Reading the
 * reader's own day would open the button on the morning of the 28th in Bangkok —
 * still the 27th on the exchange — and record an expiry for a contract that has
 * most of a trading session left to run.
 */
export function optionMarketDate(now: Date | number = Date.now()): string {
  const instant = new Date(now);
  return exchangeSessionDate(instant.toISOString(), US_EQUITY_TIMEZONE)
    ?? instant.toISOString().slice(0, 10);
}

/** Whether "หมดอายุ" may be pressed at all, by the exchange calendar alone. */
export function isOptionExpiryReached(expirationDate: string, marketDate = optionMarketDate()): boolean {
  return calculateDte(expirationDate, marketDate) <= 0;
}

/**
 * A settlement subject read straight off a position summary, so no caller
 * re-derives an identity the ledger already produced.
 */
export function optionSettlementSubject(position: OptionPositionSummary): OptionSettlementSubject {
  return {
    underlyingSymbol: position.underlyingSymbol,
    optionKind: position.optionKind,
    side: position.side,
    strikePrice: position.strikePrice,
    multiplier: position.multiplier,
    expirationDate: position.expirationDate,
    openContracts: position.contracts,
    underlyingPrice: position.underlyingPrice,
  };
}

function refuse(code: OptionSettlementRefusalCode, message: string): OptionSettlementOutcome {
  return { ok: false, code, message };
}

/**
 * The one settlement rule, for both actions.
 *
 * Long Call exercise buys the underlying at the strike, so cash leaves and
 * shares arrive. Long Put exercise sells it at the strike, so shares leave and
 * cash arrives — which is exactly why the shares must already be there. An
 * expiry moves neither: it closes contracts at a premium of zero, and inventing
 * a cash flow for it would be inventing money.
 */
export function planOptionSettlement(request: OptionSettlementRequest): OptionSettlementOutcome {
  const { action, subject, contracts } = request;
  const { openContracts, multiplier, strikePrice, underlyingSymbol } = subject;

  if (!Number.isFinite(openContracts) || openContracts <= 0) {
    return refuse('position-closed', 'สัญญานี้ไม่มีจำนวนคงเหลือให้ทำรายการ');
  }
  if (!Number.isInteger(contracts) || contracts <= 0) {
    return refuse('contracts-invalid', 'จำนวนสัญญาต้องเป็นจำนวนเต็มและมากกว่า 0');
  }
  if (contracts > openContracts) {
    return refuse('contracts-exceed-open', 'จำนวนสัญญาต้องไม่เกินจำนวนที่ถืออยู่');
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0 || !Number.isFinite(strikePrice) || strikePrice <= 0) {
    return refuse('contracts-invalid', 'ข้อมูลสัญญาไม่ครบ จึงคำนวณรายการนี้ไม่ได้');
  }

  const cash = fixed(request.cashBalance);
  const heldShares = fixed(request.underlyingShares);
  const contractsRemaining = openContracts - contracts;
  const moneyness = optionPositionMoneyness({
    optionKind: subject.optionKind,
    strikePrice,
    underlyingPrice: subject.underlyingPrice ?? null,
  });

  if (action === 'expired') {
    return {
      ok: true,
      plan: {
        action,
        contracts,
        contractsRemaining,
        shares: 0,
        underlyingDirection: 'none',
        strikeValue: 0,
        cashDelta: 0,
        cashAfter: fixedToNumber(cash),
        underlyingSharesAfter: fixedToNumber(heldShares),
        // Only the holder of a long contract loses value by letting it lapse; a
        // short position expiring in the money is the counterparty's decision,
        // not a warning this reader can act on.
        inTheMoneyWarning: subject.side === 'long' && moneyness === 'ITM',
      },
    };
  }

  // `exercise` is the long side's verb. The ledger's own check constraint holds
  // the same line — a short position that gets called away is `assignment`.
  if (subject.side !== 'long') {
    return refuse('short-side-exercise', 'ฝั่ง Short ใช้สิทธิ์เองไม่ได้ ให้บันทึกเป็นการถูกใช้สิทธิ์ (Assignment)');
  }

  const shares = fixedMultiply(fixed(contracts), fixed(multiplier));
  const strikeValue = fixedMultiply(shares, fixed(strikePrice));
  const receiving = subject.optionKind === 'call';
  const cashDelta = receiving ? -strikeValue : strikeValue;
  const cashAfter = cash + cashDelta;
  const sharesAfter = receiving ? heldShares + shares : heldShares - shares;

  if (receiving && cashAfter < 0n) {
    return refuse('insufficient-cash', 'เงินสดในพอร์ตไม่เพียงพอสำหรับใช้สิทธิ์ Call นี้');
  }
  if (!receiving && sharesAfter < 0n) {
    return refuse('insufficient-shares', `มีหุ้น ${underlyingSymbol} ไม่เพียงพอสำหรับใช้สิทธิ์ Put นี้`);
  }

  return {
    ok: true,
    plan: {
      action,
      contracts,
      contractsRemaining,
      shares: fixedToNumber(shares),
      underlyingDirection: receiving ? 'receive' : 'deliver',
      strikeValue: fixedToNumber(strikeValue),
      cashDelta: fixedToNumber(cashDelta),
      cashAfter: fixedToNumber(cashAfter),
      underlyingSharesAfter: fixedToNumber(sharesAfter),
      inTheMoneyWarning: false,
    },
  };
}

/**
 * The same rule with the expiry gate attached, for the write path.
 *
 * The gate lives here rather than in the preview because a disabled button is
 * not a refusal: the browser can send anything, so the server asks this question
 * against its own clock before any row is written.
 */
export function authorizeOptionSettlement(request: OptionSettlementAuthorization): OptionSettlementOutcome {
  if (request.action === 'expired' && !isOptionExpiryReached(request.subject.expirationDate, request.marketDate)) {
    return refuse('not-expired', 'สัญญานี้ยังไม่ถึงวันหมดอายุ');
  }
  return planOptionSettlement(request);
}
