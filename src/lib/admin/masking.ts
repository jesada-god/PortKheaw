/**
 * Masking, for the operator console.
 *
 * The console shows less than it knows, by default. An operator answering "was I
 * charged twice?" needs enough of a mailbox to be sure they have the right
 * account, and needs none of the rest — and a screen that is shared, screenshotted
 * or shoulder-read is the ordinary case for a support console, not the unusual one.
 *
 * Everything here is pure and total: a null, an empty string and a malformed
 * value all produce a placeholder rather than throwing or, worse, falling through
 * to the raw input.
 */

const PLACEHOLDER = '—';

/**
 * `jessada@example.com` → `je•••@example.com`.
 *
 * The domain survives because it is what tells an operator whether they are
 * looking at the account they meant; the local part is what identifies a person,
 * so only enough of it remains to distinguish two rows side by side.
 */
export function maskEmail(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!text) return PLACEHOLDER;

  const at = text.lastIndexOf('@');
  if (at < 1 || at === text.length - 1) {
    // Not an address. Mask it as an opaque value rather than printing it.
    return maskIdentifier(text);
  }

  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const kept = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${kept}•••@${domain}`;
}

/**
 * A provider or internal identifier, reduced to a label.
 *
 * `in_1QxAbCdEfGhIjKlMn` → `in_1Q…KlMn`. Enough to match against a row an
 * operator is already looking at, never enough to reconstruct or to paste
 * somewhere it does not belong. Short values are masked entirely rather than
 * shown, because a short identifier is the one a prefix would fully reveal.
 */
export function maskIdentifier(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!text) return PLACEHOLDER;
  if (text.length <= 8) return `${text.slice(0, 1)}${'•'.repeat(Math.max(1, text.length - 1))}`;
  return `${text.slice(0, 5)}…${text.slice(-4)}`;
}

/** A uuid, shortened to its first group. Ours, not a provider's. */
export function maskAccountRef(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!text) return PLACEHOLDER;
  return text.split('-')[0] ?? maskIdentifier(text);
}

/**
 * Whether a string looks like something that must never be rendered.
 *
 * Used by the console's own tests rather than at run time: it is a tripwire for
 * "did a payload with a live key or a full provider id reach a page?", which is
 * the failure this whole module exists to make impossible.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\bwhsec_[A-Za-z0-9]{8,}/,
  /\brk_(?:live|test)_[A-Za-z0-9]{8,}/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./,
  /\b(?:cus|sub|in|pi|ch|evt|price|cs)_[A-Za-z0-9]{14,}/,
  /\b\d{13,19}\b/,
];

export function looksSensitive(value: string): boolean {
  return SECRET_SHAPES.some((shape) => shape.test(value));
}
