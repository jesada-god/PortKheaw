import 'server-only';

import { getCompanyProfileService } from '@/src/lib/market-data';
import type { CompanyProfile } from '@/src/lib/market-data/types';
import type { InstrumentMetadata } from '@/src/lib/overview/types';
import { getInstrumentMetadata } from './master';

const PROFILE_CONCURRENCY = 4;

export function resolveInstrumentPresentationMetadata(
  instrument: InstrumentMetadata,
  profile: CompanyProfile | null,
): InstrumentMetadata {
  return {
    ...instrument,
    companyName: profile?.name?.trim() || instrument.companyName,
    logoUrl: profile?.logoUrl ?? instrument.logoUrl,
  };
}

/**
 * Resolves the same provider-backed company identity used by Stock Detail while
 * preserving instrument-master metadata as a per-symbol fallback.
 */
export async function getInstrumentPresentationMetadata(
  symbols: readonly string[],
): Promise<Map<string, InstrumentMetadata>> {
  const instruments = await getInstrumentMetadata(symbols);
  const entries = [...instruments.entries()];
  if (entries.length === 0) return instruments;

  const profiles = getCompanyProfileService();
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const entry = entries[cursor++];
      if (!entry) continue;
      const [symbol, instrument] = entry;
      try {
        const profile = await profiles.getCompanyProfile(symbol);
        instruments.set(
          symbol,
          resolveInstrumentPresentationMetadata(instrument, profile.data),
        );
      } catch {
        // A provider failure is isolated to this symbol. The instrument-master
        // identity remains available and InstrumentLogo renders its monogram.
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(PROFILE_CONCURRENCY, entries.length) },
      () => worker(),
    ),
  );
  return instruments;
}
