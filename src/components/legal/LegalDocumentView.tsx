import Link from 'next/link';
import { AlertTriangle, Info } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { LegalFooterLinks } from './LegalFooterLinks';
import type { LegalBlock, LegalDocument } from '@/src/lib/legal/documents';

/**
 * One renderer for all five policy documents.
 *
 * Written once so the heading structure, the reading measure and the small-screen
 * behaviour cannot diverge between pages. Two layout decisions are load-bearing:
 *
 *   * the prose column is capped at `65ch`, because a policy that runs the full
 *     width of a desktop monitor is a policy nobody finishes;
 *   * the price table scrolls inside its own container rather than widening the
 *     page. Four columns of Thai text do not fit in 320px, and a horizontally
 *     scrolling *document* is the failure this avoids.
 */

function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case 'paragraph':
      return <p className="text-sm leading-7 text-[var(--text-muted)]">{block.text}</p>;

    case 'list':
      return (
        <ul className="space-y-2">
          {block.items.map((item) => (
            <li key={item} className="flex gap-2.5 text-sm leading-7 text-[var(--text-muted)]">
              <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
              <span className="min-w-0">{item}</span>
            </li>
          ))}
        </ul>
      );

    case 'definitions':
      return (
        <dl className="space-y-4">
          {block.items.map((item) => (
            <div key={item.term} className="min-w-0">
              <dt className="text-sm font-medium text-[var(--text)]">{item.term}</dt>
              <dd className="mt-1 text-sm leading-7 text-[var(--text-muted)]">{item.description}</dd>
            </div>
          ))}
        </dl>
      );

    case 'table':
      return (
        // The scroll container is the table's, never the page's.
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)]">
                {block.columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="whitespace-nowrap px-3 py-2.5 text-left font-medium text-[var(--text)]"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row.join('|')} className="border-b border-[var(--border)] last:border-0">
                  {row.map((cell, index) => (
                    <td
                      key={`${row[0]}-${index}`}
                      className={index === 0
                        ? 'px-3 py-2.5 font-medium text-[var(--text)]'
                        : 'px-3 py-2.5 whitespace-nowrap text-[var(--text-muted)]'}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'callout': {
      const warning = block.tone === 'warning';
      const Icon = warning ? AlertTriangle : Info;
      return (
        <div
          className={`flex gap-3 rounded-xl border p-4 ${warning
            ? 'border-[var(--warning-border,var(--border-strong))] bg-[color-mix(in_srgb,var(--negative)_8%,transparent)]'
            : 'border-[var(--border)] bg-[var(--accent-soft)]'}`}
        >
          <Icon
            aria-hidden="true"
            size={18}
            className={`mt-0.5 shrink-0 ${warning ? 'text-[var(--negative)]' : 'text-[var(--accent)]'}`}
          />
          <p className="min-w-0 text-sm leading-7 text-[var(--text)]">{block.text}</p>
        </div>
      );
    }

    default:
      return null;
  }
}

export function LegalDocumentView({ document }: { document: LegalDocument }) {
  return (
    <div className="min-w-0">
      <Header title={document.title} subtitle={document.subtitle} backFallbackHref="/" />
      <main className="mx-auto w-full max-w-3xl min-w-0 p-4 md:p-8">
        <article className="min-w-0 space-y-8">
          <header className="min-w-0 space-y-3">
            <p className="text-xs text-[var(--text-muted)]">มีผลตั้งแต่ {document.effectiveDate}</p>
            <p className="max-w-[65ch] text-sm leading-7 text-[var(--text-muted)]">{document.intro}</p>
          </header>

          {document.sections.map((section) => (
            <section key={section.heading} className="min-w-0 space-y-4">
              <h2 className="text-base font-semibold text-[var(--text)]">{section.heading}</h2>
              <div className="max-w-[65ch] min-w-0 space-y-4">
                {section.blocks.map((block, index) => (
                  <Block key={`${section.heading}-${index}`} block={block} />
                ))}
              </div>
            </section>
          ))}

          <section className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]">
            <h2 className="text-base font-semibold text-[var(--text)]">ติดต่อเรา</h2>
            <p className="text-sm leading-7 text-[var(--text-muted)]">
              หากมีคำถามเกี่ยวกับเอกสารนี้ เปิดเรื่องกับทีมงานได้ที่{' '}
              <Link
                href="/support"
                className="font-medium text-[var(--accent)] underline underline-offset-4 hover:text-[var(--accent-hover)]"
              >
                หน้าช่วยเหลือ
              </Link>
            </p>
          </section>

          <LegalFooterLinks current={document.slug} />
        </article>
      </main>
    </div>
  );
}
