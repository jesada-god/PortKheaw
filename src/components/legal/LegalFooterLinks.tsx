import Link from 'next/link';
import { legalLinks, type LegalDocumentSlug } from '@/src/lib/legal/documents';

/**
 * The policy links, in one component so every surface shows the same set in the
 * same order.
 *
 * Deliberately a quiet row of small text rather than a bordered card or an
 * expandable section: these links have to be findable on the sign-in screen, at
 * the bottom of Settings, under the plan cards and at the foot of each policy
 * page, and four different treatments of the same five links is exactly the
 * clutter the brief asked to avoid.
 *
 * `current` drops the link to the page you are already on — a link to here is
 * noise, and on a policy page it is also confusing.
 */
export function LegalFooterLinks({
  current,
  className,
  includeSupport = true,
}: {
  current?: LegalDocumentSlug;
  className?: string;
  /** The sign-in screen shows Help too; a policy page already links to it. */
  includeSupport?: boolean;
}) {
  const links = legalLinks().filter((link) => !current || !link.href.endsWith(`/${current}`));

  return (
    <nav
      aria-label="เอกสารและนโยบาย"
      className={className ?? 'border-t border-[var(--border)] pt-4'}
    >
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="text-xs text-[var(--text-muted)] underline-offset-4 transition-colors hover:text-[var(--text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
            >
              {link.label}
            </Link>
          </li>
        ))}
        {includeSupport && (
          <li>
            <Link
              href="/support"
              className="text-xs text-[var(--text-muted)] underline-offset-4 transition-colors hover:text-[var(--text)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]"
            >
              ช่วยเหลือ
            </Link>
          </li>
        )}
      </ul>
    </nav>
  );
}
