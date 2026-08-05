import Header from '@/src/components/layout/Header';
import { KheawLoader } from '@/src/components/ui/KheawLoader';

export default function PortfolioTransactionsLoading() {
  return (
    <div>
      <Header
        title="ประวัติเงินเข้า–ออก"
        subtitle="ทุกรายการอ่านจาก Transaction Ledger เดิม ไม่มีตารางประวัติแยกต่างหาก"
      />
      <KheawLoader variant="page" deferred />
    </div>
  );
}
