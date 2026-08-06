import Link from 'next/link';
import {
  ChevronRight,
  FileText,
  LifeBuoy,
  Receipt,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import { legalLinkOrder, legalDocuments, type LegalDocumentSlug } from '@/src/lib/legal/documents';

/**
 * The policy and help pages, as a section of Settings rather than a footnote.
 *
 * The links themselves come from `legalDocuments` — the same catalogue the
 * policy pages, the sign-in screen and the plan cards read — so a document that
 * is renamed, rerouted or added is renamed, rerouted or added here too, and no
 * second list can drift out of step with it. The order is `legalLinkOrder`, for
 * the same reason: one order, everywhere the links appear.
 *
 * Only two things live here that are not in that catalogue: an icon per row, and
 * the support centre, which is a product surface rather than a legal document
 * and so has no entry in it.
 *
 * The rows deliberately reuse the plan link's treatment at the top of Settings —
 * bordered card, soft accent tile, chevron — because that is what a tappable row
 * already looks like on this page. `min-w-0` and `break-words` throughout: the
 * longest label here is wider than a 320px screen, and the page must never
 * scroll sideways to accommodate it.
 */

const ICON: Readonly<Record<LegalDocumentSlug, LucideIcon>> = {
  terms: FileText,
  privacy: ShieldCheck,
  'subscription-policy': RefreshCw,
  'refund-policy': Receipt,
  'investment-disclaimer': TriangleAlert,
};

export function LegalSupportLinks() {
  const rows = [
    ...legalLinkOrder.map((slug) => ({
      href: legalDocuments[slug].href,
      label: legalDocuments[slug].title,
      description: legalDocuments[slug].subtitle,
      Icon: ICON[slug],
    })),
    {
      href: '/support',
      label: 'ศูนย์ช่วยเหลือและรายงานปัญหา',
      description: 'แจ้งปัญหา ติดตามเรื่องที่แจ้ง และช่องทางติดต่อทีมงาน',
      Icon: LifeBuoy,
    },
  ];

  return (
    <section aria-labelledby="legal-support-heading" className="min-w-0 space-y-4">
      <div className="min-w-0 space-y-1">
        <h2 id="legal-support-heading" className="text-lg font-semibold text-[var(--text)]">
          ข้อมูล กฎหมาย และความช่วยเหลือ
        </h2>
        <p className="text-sm text-[var(--text-muted)]">
          เงื่อนไขการใช้งาน นโยบายที่เกี่ยวกับบัญชีและการชำระเงิน และช่องทางขอความช่วยเหลือ
        </p>
      </div>
      <ul className="min-w-0 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)]">
        {rows.map(({ href, label, description, Icon }) => (
          <li key={href} className="min-w-0 border-b border-[var(--border)] last:border-b-0">
            <Link
              href={href}
              className="flex min-h-14 min-w-0 items-center gap-3 p-4 transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)] sm:px-5"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <Icon aria-hidden="true" size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium break-words text-[var(--text)]">{label}</span>
                <span className="block text-xs leading-5 break-words text-[var(--text-muted)]">
                  {description}
                </span>
              </span>
              <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-[var(--text-muted)]" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
