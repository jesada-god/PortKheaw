import type { Metadata } from 'next';
import { LegalDocumentView } from '@/src/components/legal/LegalDocumentView';
import { legalDocuments } from '@/src/lib/legal/documents';

const document = legalDocuments['subscription-policy'];

export const metadata: Metadata = {
  title: document.title,
  description: document.subtitle,
};

export default function SubscriptionPolicyPage() {
  return <LegalDocumentView document={document} />;
}
