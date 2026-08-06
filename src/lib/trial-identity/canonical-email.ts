/**
 * The one address behind many spellings.
 *
 * The free trial is granted once per *person*, and a person who deletes their
 * account and signs up again is the same person. The account row cannot prove
 * that — it is deleted with them — so the proof has to be a value derived from
 * the address itself, and that value has to be stable across the spellings one
 * mailbox answers to.
 *
 * Two rules, and no more than two:
 *
 *   1. **Every address** is trimmed and lower-cased, and `googlemail.com` is
 *      folded onto `gmail.com`. Both are the same Google mailbox; the domain is
 *      a historical alias Google itself treats as identical.
 *   2. **Only Gmail** additionally loses dots and a `+tag` suffix, because only
 *      Gmail is documented to ignore them. `a.b@gmail.com` and `ab@gmail.com`
 *      are one mailbox; `a.b@outlook.com` and `ab@outlook.com` are two, and
 *      folding them would refuse a trial to somebody who has never had one.
 *
 * Nothing here is a claim about *who* an address belongs to, and nothing here is
 * ever stored: the output is immediately hashed. It exists in its own module,
 * away from `src/lib/auth`, precisely because the auth surfaces are forbidden to
 * reason about an address's domain at all — deciding a trial is not deciding an
 * account type, and the two must not learn each other's habits.
 */

/** The domains Google serves from one mailbox. */
const GOOGLE_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const GOOGLE_CANONICAL_DOMAIN = 'gmail.com';

/**
 * The canonical form of an address, or `null` when the input is not one.
 *
 * Deliberately strict about shape — exactly one `@`, a non-empty local part and
 * a domain carrying a dot — because a value that is not an address cannot be
 * folded correctly and must never become a claim that blocks somebody.
 */
export function canonicalizeEmail(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const separator = trimmed.lastIndexOf('@');
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  if (trimmed.indexOf('@') !== separator) return null;

  const rawLocal = trimmed.slice(0, separator);
  const domain = trimmed.slice(separator + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null;

  const canonicalDomain = GOOGLE_MAIL_DOMAINS.has(domain) ? GOOGLE_CANONICAL_DOMAIN : domain;

  /*
   * The plus tag and the dots are removed for Google and for nobody else. The
   * order matters: the tag is cut first, so that a dot inside a tag cannot
   * survive as part of the local part.
   */
  let local = rawLocal;
  if (canonicalDomain === GOOGLE_CANONICAL_DOMAIN) {
    const tag = local.indexOf('+');
    if (tag >= 0) local = local.slice(0, tag);
    local = local.replaceAll('.', '');
  }

  if (!local) return null;
  return `${local}@${canonicalDomain}`;
}
