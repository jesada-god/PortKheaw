import type { Metadata } from 'next';
import { AuthCard, AuthHeader, AuthShell, AuthTitle } from '@/src/components/auth/AuthShell';
import { ConfigurationRequired } from '@/src/components/auth/ConfigurationRequired';

export const metadata: Metadata = { title: 'ยังตั้งค่าไม่ครบ' };

export default function ConfigurationRequiredPage() {
  return (
    <AuthShell>
      <AuthHeader compact />
      <AuthCard>
        <AuthTitle
          title="ระบบเข้าสู่ระบบยังไม่พร้อม"
          description="ส่วนอื่นของแอปยังเปิดดูข้อมูลตลาดสาธารณะได้ตามปกติ"
        />
        <ConfigurationRequired />
      </AuthCard>
    </AuthShell>
  );
}
