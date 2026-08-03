import { FlaskConical } from 'lucide-react';
import { adminPreviewLabel, type ActiveAdminPreviewMode } from '@/src/lib/subscription/admin-access';
import type { PageEntitlement } from '@/src/lib/subscription/page-entitlement';
import { formatBangkokDateTime } from '@/src/lib/subscription/trial';
import { AdminPreviewExitButton } from './AdminPreviewExitButton';

/**
 * The site-wide reminder that what you are looking at is a simulation.
 *
 * It renders on every page, from the root layout, because a preview changes what
 * every page shows — an operator who forgets they are inside one would read a
 * locked feature as a bug. It renders for nobody else: the condition is the
 * stored administrator role *and* a running preview, both resolved on the
 * server, so an ordinary reader never receives this markup at all.
 *
 * It states the mode, when it lapses, and that the real plan is untouched.
 */
export function AdminPreviewBanner({ entitlement }: { entitlement: PageEntitlement }) {
  if (!entitlement.isAdmin || entitlement.adminPreviewMode === 'actual') return null;
  const mode = entitlement.adminPreviewMode as ActiveAdminPreviewMode;

  return (
    <div
      role="status"
      data-testid="admin-preview-banner"
      data-preview-mode={mode}
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-[color-mix(in_srgb,var(--role-admin)_45%,transparent)] bg-[color-mix(in_srgb,var(--role-admin)_14%,transparent)] px-4 py-2 text-center text-xs font-medium text-[var(--text)]"
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        <FlaskConical aria-hidden="true" size={15} className="shrink-0 text-[var(--role-admin)]" />
        <span className="min-w-0">
          โหมดทดสอบสิทธิ์ Admin: <strong className="font-semibold">{adminPreviewLabel(mode)}</strong>
          {entitlement.previewExpiresAt && (
            <>
              {' · '}
              <span className="text-[var(--text-secondary)]">
                หมดอายุ {formatBangkokDateTime(entitlement.previewExpiresAt)}
              </span>
            </>
          )}
        </span>
      </span>
      <AdminPreviewExitButton />
    </div>
  );
}
