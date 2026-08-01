import Header from '@/src/components/layout/Header';
import { KheawLoader } from '@/src/components/ui/KheawLoader';

/**
 * Watchlist resolves one quote per tracked symbol, four at a time, so its first
 * paint scales with the size of the list. Previously it had no route fallback.
 */
export default function WatchlistLoading() {
  return (
    <div>
      <Header title="รายการติดตาม" subtitle="ติดตามหุ้นที่คุณสนใจ พร้อมราคาและสถานะข้อมูลล่าสุด" />
      <KheawLoader variant="page" deferred />
    </div>
  );
}
