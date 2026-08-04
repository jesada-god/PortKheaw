import type { Metadata } from 'next';
import { LegalDocumentView } from '@/src/components/legal/LegalDocumentView';
import { legalDocuments } from '@/src/lib/legal/documents';

const document = legalDocuments.privacy;

export const metadata: Metadata = {
  title: document.title,
  description: document.subtitle,
};

export default function PrivacyPage() {
  return <LegalDocumentView document={document} />;
}
