import type { Metadata } from 'next';
import Header from '@/src/components/layout/Header';
import { LegalFooterLinks } from '@/src/components/legal/LegalFooterLinks';
import { OPEN_SOURCE_PAGE, openSourceNotices } from '@/src/lib/legal/open-source';

/*
 * Static, and outside the protected paths for the same reason the policy pages
 * are: an attribution notice that only signed-in readers can reach is not a
 * notice. This is the page the licence condition points at, so it has to be
 * readable by anyone who follows the credit under a chart.
 */

export const metadata: Metadata = {
  title: OPEN_SOURCE_PAGE.title,
  description: OPEN_SOURCE_PAGE.subtitle,
};

const LINK = 'font-medium text-[var(--accent)] underline underline-offset-4 hover:text-[var(--accent-hover)]';

export default function OpenSourcePage() {
  return (
    <div className="min-w-0">
      <Header title={OPEN_SOURCE_PAGE.title} subtitle={OPEN_SOURCE_PAGE.subtitle} backFallbackHref="/" />
      <main className="mx-auto w-full max-w-3xl min-w-0 p-4 md:p-8">
        <article className="min-w-0 space-y-8">
          <header className="min-w-0">
            <p className="max-w-[65ch] text-sm leading-7 text-[var(--text-muted)]">{OPEN_SOURCE_PAGE.intro}</p>
          </header>

          {openSourceNotices.map((item) => (
            <section
              key={item.name}
              data-testid={`open-source-${item.name}`}
              className="min-w-0 space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
            >
              <div className="min-w-0 space-y-1">
                <h2 className="text-base font-semibold break-words text-[var(--text)]">{item.name}</h2>
                <p className="text-xs text-[var(--text-muted)]">เวอร์ชัน {item.version}</p>
              </div>

              <p className="max-w-[65ch] text-sm leading-7 text-[var(--text-muted)]">{item.usedFor}</p>

              <dl className="min-w-0 space-y-3">
                <div className="min-w-0">
                  <dt className="text-sm font-medium text-[var(--text)]">สัญญาอนุญาต</dt>
                  <dd className="mt-1 text-sm leading-7 break-words text-[var(--text-muted)]">
                    <a href={item.licenseUrl} target="_blank" rel="noreferrer" className={LINK}>
                      {item.license}
                    </a>
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-sm font-medium text-[var(--text)]">เว็บไซต์ผู้พัฒนา</dt>
                  <dd className="mt-1 text-sm leading-7 break-words text-[var(--text-muted)]">
                    <a href={item.homepage} target="_blank" rel="noreferrer" className={LINK}>
                      {item.homepage}
                    </a>
                  </dd>
                </div>
              </dl>

              {/*
                The NOTICE file itself. Reproduced exactly, in a monospace block,
                because this is the text the licence asks us to carry — not a
                paraphrase of it. `overflow-x-auto` keeps the long second line
                inside its own scroller instead of widening the page at 320px.
              */}
              <div className="min-w-0 space-y-2">
                <h3 className="text-sm font-medium text-[var(--text)]">ประกาศแสดงที่มา (NOTICE)</h3>
                <div className="min-w-0 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3">
                  <pre
                    data-testid="open-source-notice"
                    className="font-mono text-xs leading-6 whitespace-pre text-[var(--text-muted)]"
                  >{item.notice.join('\n')}</pre>
                </div>
              </div>
            </section>
          ))}

          <LegalFooterLinks />
        </article>
      </main>
    </div>
  );
}
