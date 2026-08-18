import { describe, expect, it } from 'vitest';
import { GLOSSARY } from '@/src/lib/analytics/glossary/terms';
import { upgradeCopy } from './upgrade-copy';

/**
 * What the app is allowed to promise about the Technical Outlook.
 *
 * P4a measured what "Confidence" was worth as a forecast — the 90-99 band hits
 * what the 20-29 band hits — so P4.5 took the word off the card. Everything that
 * SELLS the card had to follow, and this is the part that is easy to lose: a
 * benefit line lives in a different file from the thing it describes, nobody
 * reads it after it ships, and a future edit restoring a confident-sounding word
 * would be invisible until a customer quoted it back.
 *
 * These are promises made to people who paid. The wording below was approved by
 * the owner; this file is what stops it drifting.
 *
 * SCOPE. Market Signal only. The Options Signal Engine still sells
 * `คะแนนความมั่นใจ` and that is DELIBERATE and correct — it is a different
 * engine and it has never been measured, so changing its wording would imply a
 * finding that does not exist. See `docs/market-signal/open-work.md`: if it is
 * ever measured and reads like Market Signal, both products' copy changes
 * together, not one at a time.
 */

/** Words that read as a claim about what price will do, or about how sure we are. */
const FORECAST_WORDS = ['ความมั่นใจ', 'Confidence', 'แม่นยำ', 'ทำนาย', 'พยากรณ์', 'คาดการณ์'];

const MARKET_SIGNAL_CAPABILITIES = ['technical.outlook', 'technical.outlook.commodity'] as const;

describe('nothing sells the Technical Outlook as a forecast', () => {
  it.each(MARKET_SIGNAL_CAPABILITIES)('%s promises nothing the card will not show', (capability) => {
    const copy = upgradeCopy(capability);
    const text = `${copy.title} ${copy.benefit} ${copy.lockedLabel}`;
    for (const word of FORECAST_WORDS) {
      expect(text, `"${word}" is back in the ${capability} upgrade copy`).not.toContain(word);
    }
  });

  /*
   * The positive half. Removing a word is easy to do by deleting the sentence,
   * which would leave the upgrade modal describing less than the card does —
   * the breakdown is real, is the most useful thing on the card, and was never
   * sold before P4.5.
   */
  it('sells the per-reason breakdown, which is real and was never sold before', () => {
    expect(upgradeCopy('technical.outlook').benefit).toContain('เหตุผลรายข้อ');
  });

  it('still says a contract is priced off the contract, not off the fund tracking it', () => {
    expect(upgradeCopy('technical.outlook.commodity').benefit).toContain('ไม่ใช่จากกองทุนที่อ้างอิงมัน');
  });
});

describe('the glossary points at words that exist', () => {
  /*
   * A cross-reference is a promise too, in miniature: it sends a reader looking
   * for something on the card. `Confidence` is not there any more.
   */
  it('does not send a reader looking for a Confidence the card no longer has', () => {
    const entry = GLOSSARY.directionalScore;
    const text = `${entry.what} ${entry.why} ${entry.when}`;
    expect(text).not.toContain('Confidence');
    expect(entry.when).toContain('ความสอดคล้องของหลักฐาน');
  });

  it('keeps saying the score is not an accuracy percentage', () => {
    expect(GLOSSARY.directionalScore.what).toContain('ไม่ใช่เปอร์เซ็นต์ความแม่นยำ');
  });
});
