import Header from '@/src/components/layout/Header';
import { KheawLoader } from '@/src/components/ui/KheawLoader';

/**
 * Industry detail loads a whole sector's constituents before it knows its own
 * title, so the fallback header carries the generic one the page itself falls
 * back to. Previously this route had no fallback at all.
 */
export default function IndustryDetailLoading() {
  return (
    <div>
      <Header title="รายละเอียดอุตสาหกรรม" />
      <KheawLoader variant="page" deferred priority />
    </div>
  );
}
