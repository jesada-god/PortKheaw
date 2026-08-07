import { KheawLoader } from '@/src/components/ui/KheawLoader';

/**
 * Route fallback for stock detail. The page fans out to quotes, fundamentals,
 * chart history and options before it can render anything, so this is where a
 * slow provider is felt most.
 *
 * The skeleton header this replaced drew a price row that was pure guesswork —
 * bars the exact shape of numbers the page had not fetched yet. One honest
 * "still working" beats a mock-up of the answer.
 */
export default function StockDetailLoading() {
  return <KheawLoader variant="page" deferred priority />;
}
