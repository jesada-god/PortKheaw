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

/*
 * The SIDEWAYS base rate, wired the same way and to the same run.
 *
 * The manifest carries the DIRECTIONAL headline and nothing else — sideways is
 * excluded from every hit rate in it, because no direction was claimed — so the
 * figures the card quotes for it live only in the run's `report.md`. That is
 * what this reads. Parsing a report rather than a JSON field is the honest cost
 * of the harness not emitting one; the table is fixed-width and machine-written
 * by `scripts/calibrate.ts`, and a shape change breaks the parse loudly rather
 * than silently returning a stale number.
 */
const sidewaysRow = (horizon: number) => {
  const report = readFileSync(
    join(CALIBRATION_ROOT, MARKET_SIGNAL_MEASURED.runId, 'report.md'),
    'utf8',
  );
  const section = report.split('### Sideways')[1] ?? '';
  const table = section.split('```')[1] ?? '';
  const row = table.split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .find((cells) => cells.length === 4 && cells[0] === String(horizon));
  if (!row) throw new Error(`the run's report has no sideways row at ${horizon} bars`);
  return {
    stillSidewaysPct: Number(row[1].replace('%', '')),
    insideFramePct: Number(row[2].replace('%', '')),
    n: Number(row[3]),
  };
};

describe('the SIDEWAYS base rate the card discloses is the one that was measured', () => {
  const measured = MARKET_SIGNAL_MEASURED.sidewaysPersistence;

  it('quotes the run at the horizon it says it is quoting', () => {
    const row = sidewaysRow(measured.horizonBars);
    expect(row.stillSidewaysPct).toBe(measured.labelStillSidewaysPct);
    expect(row.insideFramePct).toBe(measured.priceInsideFramePct);
    expect(row.n).toBe(measured.sampleSize);
  });

  /*
   * The other direction, and the reason the copy exists at all. The card says
   * the label usually holds while price usually does not — that sentence is
   * only true while the two rates are far apart, so the distance is asserted
   * rather than assumed. A run that closes the gap fails here, which is the
   * signal to rewrite the wording rather than to move the number.
   */
  it('keeps the gap the wording is built on', () => {
    const row = sidewaysRow(measured.horizonBars);
    const gap = row.stillSidewaysPct - row.insideFramePct;
    expect(
      gap,
      `the label/price gap is now ${gap.toFixed(1)}pp — "ป้ายมักอยู่ต่อ ส่วนราคามักออกจากกรอบไปก่อน" has to be rewritten`,
    ).toBeGreaterThan(measured.claimHoldsAboveGapPp);
  });

  /*
   * And that the population is the one §6.6 describes: every horizon is
   * followed over the same rows, so the sample size cannot differ between them.
   * A parse that drifted onto another table would show up here first.
   */
  it('reads the same population at every horizon the run prints', () => {
    for (const horizon of [5, 10, 20]) {
      expect(sidewaysRow(horizon).n, `horizon ${horizon} is a different population`)
        .toBe(measured.sampleSize);
    }
  });
});
