import { fixed, fixedPercent, fixedToNumber, type Fixed } from '../money/fixed';

/**
 * The one place a portfolio's total return becomes a percentage.
 *
 * `totalGain` is defined by the ledger as `totalValue - netDeposited -
 * netTransferred`: what the portfolio is worth today, less every unit of
 * capital that was put into it. A percentage of that gain therefore only means
 * anything when it is measured against the *same* capital the gain was measured
 * from. Splitting the two apart is what this module exists to prevent.
 *
 * It used to be split. The percentage divided by `netDeposited` alone while the
 * gain subtracted deposits and transfers both, so a portfolio funded by moving
 * positions in rather than by depositing cash had a real gain over a zero
 * denominator — and `fixedPercent` answers a zero basis with a hard 0. A
 * portfolio holding one transferred-in option contract up +31.91% reported
 * "ผลตอบแทนรวม 0.00%", and Kheaw, who reads that same number, sat neutral.
 *
 * Stocks, options and cash need no branches of their own here. Each is already
 * inside `totalValue` (shares at market, open contracts at mark, cash at face)
 * and inside the capital base (cash deposits, imported opening positions, and
 * the cost basis carried by any transferred position, share or contract alike),
 * so one division covers every mix of them.
 */

/**
 * Capital the holder actually put into the portfolio.
 *
 * Transferred capital counts exactly as deposited capital does: a position that
 * arrives brings the basis it was bought at, and the ledger already adds that
 * basis to `netTransferredCapital` at the destination and removes it at the
 * source. Excluding it here would ask what a gain is worth as a share of money
 * that was never claimed to be the whole investment.
 */
export function portfolioInvestedCapital(
  netDepositedCapital: Fixed,
  netTransferredCapital: Fixed,
): Fixed {
  return netDepositedCapital + netTransferredCapital;
}

/**
 * Total return as a percentage, or `null` when no percentage exists.
 *
 * `null` is returned for a missing gain (some holding has no price yet) and for
 * a capital base that is not positive — a portfolio nothing was ever put into,
 * or one that has had more withdrawn than was put in. Neither of those is a
 * zero return, and neither may be reported as one: 0.00% is reserved for a
 * portfolio that genuinely stands where its capital left it. Callers render the
 * null as "no total-return figure yet" rather than as a number, and Kheaw reads
 * it as no reading rather than as flat.
 */
export function portfolioTotalReturnPercent(
  totalGain: Fixed | null,
  netDepositedCapital: Fixed,
  netTransferredCapital: Fixed,
): number | null {
  if (totalGain === null) return null;
  const basis = portfolioInvestedCapital(netDepositedCapital, netTransferredCapital);
  if (basis <= 0n) return null;
  return fixedToNumber(fixedPercent(totalGain, basis));
}

/** The same calculation for callers that already hold plain numbers. */
export function portfolioTotalReturnPercentOf(summary: {
  totalGain: number | null;
  netDepositedCapital: number;
  netTransferredCapital: number;
}): number | null {
  return portfolioTotalReturnPercent(
    summary.totalGain === null ? null : fixed(summary.totalGain),
    fixed(summary.netDepositedCapital),
    fixed(summary.netTransferredCapital),
  );
}
