import { describe, expect, it } from 'vitest';
import { canonicalizeEmail } from './canonical-email';

describe('canonicalizeEmail', () => {
  it('trims and lower-cases every address', () => {
    expect(canonicalizeEmail('  Reader@Example.COM ')).toBe('reader@example.com');
  });

  it('folds googlemail onto gmail', () => {
    expect(canonicalizeEmail('reader@googlemail.com')).toBe('reader@gmail.com');
  });

  /*
   * The whole point of the ledger: these are one mailbox, so they are one claim,
   * and the second sign-up cannot take a second trial.
   */
  it('gives every Gmail spelling of one mailbox the same canonical form', () => {
    const forms = [
      'jesada.twt@gmail.com',
      'JesadaTwt@gmail.com',
      'jesada.t.w.t@gmail.com',
      'jesadatwt+portkheaw@gmail.com',
      'Jesada.Twt+one.two@googlemail.com',
      '  jesadatwt@GOOGLEMAIL.com  ',
    ];
    const canonical = forms.map(canonicalizeEmail);
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe('jesadatwt@gmail.com');
  });

  /*
   * The mirror-image failure, and the more expensive one: folding a domain that
   * does not ignore dots or tags would refuse a trial to somebody who has never
   * had one, on the strength of a stranger's address.
   */
  it('normalizes nothing beyond case and whitespace on other domains', () => {
    expect(canonicalizeEmail('a.b@outlook.com')).toBe('a.b@outlook.com');
    expect(canonicalizeEmail('ab@outlook.com')).toBe('ab@outlook.com');
    expect(canonicalizeEmail('a.b@outlook.com')).not.toBe(canonicalizeEmail('ab@outlook.com'));
    expect(canonicalizeEmail('reader+tag@company.co.th')).toBe('reader+tag@company.co.th');
    expect(canonicalizeEmail('reader+tag@company.co.th')).not.toBe(canonicalizeEmail('reader@company.co.th'));
  });

  it('cuts a Gmail tag before removing dots, so a dot inside the tag cannot survive', () => {
    expect(canonicalizeEmail('read.er+a.b.c@gmail.com')).toBe('reader@gmail.com');
  });

  it('refuses anything that is not a single well-formed address', () => {
    for (const input of [
      '', '   ', 'reader', 'reader@', '@gmail.com', 'reader@@gmail.com',
      'reader@localhost', 'reader@.com', 'reader@gmail.com.', 'a b@gmail.com',
      '+tag@gmail.com', '.@gmail.com', null, undefined, 42 as unknown as string,
    ]) {
      expect(canonicalizeEmail(input)).toBeNull();
    }
  });
});
