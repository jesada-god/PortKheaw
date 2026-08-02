import { Check, Minus } from 'lucide-react';
import {
  formatBaht,
  planDescriptors,
  planFeatureGroups,
  type PlanFeatureRow,
  type PlanFeatureValue,
} from '@/src/lib/subscription/plan-catalog';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';

/**
 * The full comparison, rendered twice from one source: a table from `md` up,
 * and a stack of per-category cards below it. Neither layout re-states a
 * feature — both walk `planFeatureGroups`, whose enforced rows are read
 * straight out of the entitlement matrix.
 *
 * The table sits in its own horizontally scrollable box so a narrow window
 * scrolls the table, never the page.
 */
export function PlanComparison() {
  return (
    <section aria-labelledby="comparison-heading" className="space-y-4">
      <div className="space-y-1">
        <h2 id="comparison-heading" className="text-xl font-bold text-[var(--text)]">เปรียบเทียบทุกแพ็กเกจ</h2>
        <p className="text-sm text-[var(--text-muted)]">รายการเดียวกันทั้งหมด แยกตามหมวดการใช้งาน</p>
      </div>

      <div className="hidden overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <caption className="sr-only">ตารางเปรียบเทียบความสามารถของแพ็กเกจ Basic, Pro และ Elite</caption>
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-elevated)]">
                <th scope="col" className="px-4 py-3 font-semibold text-[var(--text)]">ความสามารถ</th>
                {planDescriptors.map((plan) => (
                  <th
                    key={plan.tier}
                    scope="col"
                    className="w-[7.5rem] px-4 py-3 text-center font-semibold text-[var(--text)]"
                  >
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            {planFeatureGroups.map((group) => (
              <tbody key={group.id}>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-hover)]">
                  <th
                    scope="colgroup"
                    colSpan={1 + planDescriptors.length}
                    className="px-4 py-2 text-xs font-semibold tracking-wide text-[var(--text-muted)]"
                  >
                    {group.label}
                  </th>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--border)] last:border-b-0">
                    <th scope="row" className="px-4 py-3 font-normal text-[var(--text-secondary)]">
                      {row.label}
                    </th>
                    {planDescriptors.map((plan) => (
                      <td key={plan.tier} className="px-4 py-3 text-center">
                        <ValueCell row={row} tier={plan.tier} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </div>

      <div className="space-y-4 md:hidden">
        {planFeatureGroups.map((group) => (
          <article
            key={group.id}
            className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <h3 className="text-sm font-semibold text-[var(--text)]">{group.label}</h3>
            <ul className="mt-3 flex flex-col gap-3">
              {group.rows.map((row) => (
                <li key={row.id} className="min-w-0 border-t border-[var(--border)] pt-3 first:border-t-0 first:pt-0">
                  <p className="text-sm text-[var(--text-secondary)]">{row.label}</p>
                  <dl className="mt-2 grid grid-cols-3 gap-2">
                    {planDescriptors.map((plan) => (
                      <div
                        key={plan.tier}
                        className="min-w-0 rounded-lg bg-[var(--surface-elevated)] px-1.5 py-1.5 text-center"
                      >
                        <dt className="text-[11px] font-medium text-[var(--text-muted)]">{plan.name}</dt>
                        <dd className="mt-0.5 flex justify-center">
                          <ValueCell row={row} tier={plan.tier} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * One cell. Availability is never colour alone: an included feature carries a
 * tick with a text alternative, and an excluded one carries a dash, so the
 * table reads the same to a screen reader and in greyscale.
 */
function ValueCell({ row, tier }: { row: PlanFeatureRow; tier: SubscriptionTier }) {
  const value: PlanFeatureValue = row.values[tier];

  if (value.kind === 'included') {
    return (
      <>
        <Check aria-hidden="true" size={17} className="inline-block text-[var(--brand-green)]" />
        <span className="sr-only">{`${row.label}: มีให้ใช้`}</span>
      </>
    );
  }
  if (value.kind === 'excluded') {
    return (
      <>
        <Minus aria-hidden="true" size={17} className="inline-block text-[var(--text-muted)]" />
        <span className="sr-only">{`${row.label}: ไม่มีให้ใช้`}</span>
      </>
    );
  }
  if (value.kind === 'count') {
    return value.value === 0 ? (
      <>
        <Minus aria-hidden="true" size={17} className="inline-block text-[var(--text-muted)]" />
        <span className="sr-only">{`${row.label}: ไม่มีให้ใช้`}</span>
      </>
    ) : (
      <span className="text-sm font-semibold tabular-nums text-[var(--text)]">
        {formatBaht(value.value)}
        <span className="sr-only"> พอร์ต</span>
      </span>
    );
  }
  return <span className="text-sm font-medium text-[var(--text)]">{value.value}</span>;
}
