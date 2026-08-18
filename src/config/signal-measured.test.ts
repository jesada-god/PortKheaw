import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARKET_SIGNAL_MEASURED } from '@/src/config/signal';

/**
 * The card makes claims about what a measurement found. This is the wire
 * between the claim and the measurement.
 *
 * Everything in `MARKET_SIGNAL_MEASURED` is quoted somewhere a reader can see:
 * the period, the corpus size, the confirmation rates, and — since P4.5 — the
 * sentence saying no directional edge was found. Those are only worth anything
 * if re-running the harness cannot silently leave them behind, so this file
 * reads the run named in the config and fails when the two disagree.
 *
 * It is deliberately a TEST rather than a script. A stale figure on a card that
 * sells for money is a defect, and defects belong where the suite runs.
 */

const CALIBRATION_ROOT = join(process.cwd(), '__calibration__');

type HeadlineSide = { n: number; clustered: number; rate: number };
type Manifest = {
  runId: string;
  period: [string, string];
  instruments: string[];
  headline: Record<string, { signal: HeadlineSide; base: HeadlineSide }>;
};

const runDirectories = () => readdirSync(CALIBRATION_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const manifest = (): Manifest => JSON.parse(
  readFileSync(join(CALIBRATION_ROOT, MARKET_SIGNAL_MEASURED.runId, 'manifest.json'), 'utf8'),
) as Manifest;

/** Gap between the signal's hit rate and the base rate, in percentage points. */
const edgePp = (side: { signal: HeadlineSide; base: HeadlineSide }) =>
  (side.signal.rate - side.base.rate) * 100;

/**
 * Half-width of the 95% interval around the signal's hit rate, in pp, on the
 * CLUSTERED count — the number of observations that share no outcome bars, which
 * is the honest count of independent facts at that horizon. Using raw `n` here
 * would make the interval look three times tighter than it is at 20 bars.
 */
const noiseBandPp = (signal: HeadlineSide) =>
  1.96 * Math.sqrt((signal.rate * (1 - signal.rate)) / signal.clustered) * 100;

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const thaiMonth = (isoMonth: string) => {
  const [year, month] = isoMonth.split('-');
  return `${THAI_MONTHS[Number(month) - 1]} ${year}`;
};

describe('the figures the card quotes belong to a run that exists', () => {
  it('names a calibration run that is present in the repo', () => {
    expect(runDirectories()).toContain(MARKET_SIGNAL_MEASURED.runId);
  });

  /*
   * The mechanism the whole file exists for.
   *
   * A newer run in `__calibration__/` while the config still points at an older
   * one means somebody measured again and did not look at what the card says.
   * Run ids are UTC instants, so "newest" is "last when sorted".
   */
  it('names the NEWEST run, so a fresh harness pass cannot be quietly ignored', () => {
    expect(MARKET_SIGNAL_MEASURED.runId).toBe(runDirectories().at(-1));
  });

  it('agrees with the manifest about which run it is', () => {
    expect(manifest().runId).toBe(MARKET_SIGNAL_MEASURED.runId);
  });
});

describe('the period the card shows is the period that was measured', () => {
  it('matches the manifest on both ends', () => {
    const [from, to] = manifest().period;
    expect(from.startsWith(MARKET_SIGNAL_MEASURED.period.from)).toBe(true);
    expect(to.startsWith(MARKET_SIGNAL_MEASURED.period.to)).toBe(true);
  });

  it('says the same thing in Thai as it does in ISO', () => {
    expect(MARKET_SIGNAL_MEASURED.period.thai).toBe(
      `${thaiMonth(MARKET_SIGNAL_MEASURED.period.from)} – ${thaiMonth(MARKET_SIGNAL_MEASURED.period.to)}`,
    );
  });

  it('counts the corpus the way the card counts it', () => {
    expect(manifest().instruments).toHaveLength(MARKET_SIGNAL_MEASURED.corpusInstruments);
  });
});

describe('the "no edge was found" sentence survives its own evidence', () => {
  /*
   * If a later run produces a real edge, the card is understating what it has
   * and the sentence is wrong in the other direction. Either way the wording
   * has to be revisited, which is what failing here forces.
   */
  it('finds no horizon where the signal beats the base rate by more than the editorial line', () => {
    const gaps = Object.entries(manifest().headline)
      .map(([horizon, side]) => ({ horizon, edge: edgePp(side) }));

    for (const { horizon, edge } of gaps) {
      expect(
        Math.abs(edge),
        `horizon ${horizon} moved to ${edge.toFixed(2)}pp — the card's wording has to be rewritten`,
      ).toBeLessThan(MARKET_SIGNAL_MEASURED.directionalEdge.claimHoldsBelowPp);
    }
  });

  it('finds no horizon where the gap is larger than its own sampling error', () => {
    for (const [horizon, side] of Object.entries(manifest().headline)) {
      expect(
        Math.abs(edgePp(side)),
        `horizon ${horizon} is outside its own noise band — the gap is now a finding, not a rounding`,
      ).toBeLessThan(noiseBandPp(side.signal));
    }
  });

  it('quotes the largest gap it actually measured', () => {
    const largest = Math.max(...Object.values(manifest().headline).map((side) => Math.abs(edgePp(side))));
    expect(Number(largest.toFixed(1))).toBe(MARKET_SIGNAL_MEASURED.directionalEdge.largestAbsolutePp);
  });
});
