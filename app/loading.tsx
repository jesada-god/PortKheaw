import Header from '@/src/components/layout/Header';
import { KheawLoader } from '@/src/components/ui/KheawLoader';
import { appConfig } from '@/src/config/app';

/**
 * Route fallback for the overview page, which waits on several market data
 * providers at once and is the slowest first paint in the product.
 *
 * `deferred` is what makes the mascot safe to put on a route. The fallback is
 * streamed the instant navigation starts, but the CSS grace holds it invisible
 * for 300ms, so a warm cache swaps straight to the dashboard with the mascot
 * never painted. The header stays: it is the page's own furniture, not part of
 * the loading area.
 */
export default function Loading() {
  return (
    <div>
      <Header title={`กำลังโหลด ${appConfig.name}`} />
      <KheawLoader variant="page" deferred />
    </div>
  );
}
