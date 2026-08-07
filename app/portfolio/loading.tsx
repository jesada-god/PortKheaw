import Header from '@/src/components/layout/Header';
import { KheawLoader } from '@/src/components/ui/KheawLoader';

/**
 * Portfolio waits on the ledger, every holding's quote, the option chain for
 * each open contract and the USD/THB rate before it can total anything — and
 * had no route fallback at all, so a slow load left the previous page frozen
 * on screen with nothing to say it was working.
 */
export default function PortfolioLoading() {
  return (
    <div>
      <Header
        title="พอร์ตโฟลิโอจำลอง"
        subtitle="คำนวณใหม่จาก Transaction Ledger ทุกครั้ง โดยไม่ส่งคำสั่งซื้อขายจริง"
      />
      <KheawLoader variant="page" deferred priority />
    </div>
  );
}
