import { fixed, fixedMultiply, fixedToNumber, type Fixed } from '../money/fixed';
import type { PortfolioTransaction } from './types';
import type { TransactionInput } from './validation';

function normalized(value: string | undefined, currency: 'USD' | 'THB', rate: string | undefined): Fixed | null {
  if (value == null || value.trim() === '' || !Number.isFinite(Number(value))) return null;
  if (currency === 'USD') return fixed(value);
  if (!rate || !Number.isFinite(Number(rate)) || Number(rate) <= 0) return null;
  return fixed(value) * 100_000_000n / fixed(rate);
}

function effect(
  type: TransactionInput['type'],
  amount: Fixed,
  quantity: Fixed,
  price: Fixed,
  fee: Fixed,
  strike: Fixed,
  multiplier: Fixed,
  optionKind?: 'call' | 'put' | null,
): Fixed {
  if (type === 'deposit' || type === 'dividend' || type === 'adjustment' || type === 'transfer_in') return amount;
  if (type === 'withdrawal' || type === 'fee' || type === 'transfer_out') return -amount;
  if (type === 'initial_position') return amount;
  const units = fixedMultiply(quantity, multiplier);
  if (type === 'acquisition') {
    return -fixedMultiply(quantity, price) - fee;
  }
  if (type === 'buy_to_open' || type === 'buy_to_close') return -fixedMultiply(units, price) - fee;
  if (type === 'disposal') return fixedMultiply(quantity, price) - fee;
  if (type === 'sell_to_open' || type === 'sell_to_close') return fixedMultiply(units, price) - fee;
  if (type === 'exercise' || type === 'assignment') {
    const buyUnderlying = (type === 'exercise' && optionKind === 'call')
      || (type === 'assignment' && optionKind === 'put');
    const settlement = fixedMultiply(units, strike);
    return buyUnderlying ? -settlement - fee : settlement - fee;
  }
  return 0n;
}

export function cashEffectForInput(input: TransactionInput): number | null {
  const amount = normalized(input.amount || '0', input.originalCurrency, input.fxRateAtTransaction);
  const price = normalized(input.price || '0', input.originalCurrency, input.fxRateAtTransaction);
  const fee = normalized(input.fee || '0', input.originalCurrency, input.fxRateAtTransaction);
  if (amount === null || price === null || fee === null) return null;
  return fixedToNumber(effect(
    input.type,
    amount,
    fixed(input.quantity || '0'),
    price,
    fee,
    fixed(input.strikePrice || '0'),
    fixed(input.multiplier || '100'),
    input.optionKind,
  ));
}

export function cashEffectForTransaction(transaction: PortfolioTransaction): number {
  return fixedToNumber(effect(
    transaction.type,
    fixed(transaction.normalizedAmountUsd ?? transaction.amount),
    fixed(transaction.quantity),
    fixed(transaction.normalizedPriceUsd ?? transaction.price),
    fixed(transaction.normalizedFeeUsd ?? transaction.fee),
    fixed(transaction.strikePrice),
    fixed(transaction.multiplier ?? '100'),
    transaction.optionKind,
  ));
}

export function estimateCashAfterTransaction(
  currentCashUsd: number,
  input: TransactionInput,
  replaced?: PortfolioTransaction | null,
): number | null {
  const nextEffect = cashEffectForInput(input);
  if (nextEffect === null) return null;
  return fixedToNumber(
    fixed(currentCashUsd)
    - fixed(replaced ? cashEffectForTransaction(replaced) : 0)
    + fixed(nextEffect),
  );
}
