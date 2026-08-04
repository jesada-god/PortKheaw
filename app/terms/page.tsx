import type { Metadata } from 'next';
import { LegalDocumentView } from '@/src/components/legal/LegalDocumentView';
import { legalDocuments } from '@/src/lib/legal/documents';

/*
 * Static. A policy page carries no per-reader state, so it is prerendered into
 * shared HTML — which is also what makes it readable by somebody who cannot sign
 * in, the reason these routes are outside the protected paths.
 */
const document = legalDocuments.terms;

export const metadata: Metadata = {
  title: document.title,
  description: document.subtitle,
};

export default function TermsPage() {
  return <LegalDocumentView document={document} />;
}
