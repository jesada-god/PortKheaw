import 'server-only';

import { getCompanyProfileService } from '@/src/lib/market-data';
import type { CompanyProfile } from '@/src/lib/market-data/types';
import type { InstrumentMetadata } from '@/src/lib/overview/types';
import { marketAssetLogoUrl } from '@/src/lib/overview/market-assets';
import { getInstrumentMetadata } from './master';
import {
  ExpiringFailureMemory,
  LOGO_DEFERRED_TTL_MS,
  LOGO_NEGATIVE_TTL_MS,
  LOGO_RESOLVED_TTL_MS,
  chooseInstrumentLogoUrl,
  normalizeLogoUrl,
  tidyInstrumentName,
} from './logo-policy';
import { isBrokenLogoUrl, persistInstrumentLogos } from './logo-store';

const PROFILE_CONCURRENCY = 4;

/**
 * Symbols a provider answered about and had no logo for. Re-asked once per TTL
 * rather than once per render, so a logo-less instrument costs one request a
 * session instead of one a page.
 *
 * Only a *successful* "there is no logo" lands here. A rate limit, a timeout or
 * any other failure never does — a spent quota is not evidence about a company,
 * and remembering it as one is how a symbol goes permanently blank.
 */
const logolessSymbols = new ExpiringFailureMemory(LOGO_NEGATIVE_TTL_MS);

/**
 * Symbols whose logo source could not answer — a spent quota, an outage.
 *
 * Only background resolution honours this. The profile service's own provider
 * cooldown is a minute, which on a daily quota means a busy site would spend the
 * whole allowance re-asking about symbols nobody can answer for; a reader who
 * adds a symbol still gets a fresh attempt every time.
 */
const deferredSymbols = new ExpiringFailureMemory(LOGO_DEFERRED_TTL_MS);

/**
 * Logos resolved in this process, for the case the database cannot cover: a
 * symbol with no row on the instrument master has nowhere to be persisted, and
 * without this every render would re-ask the provider for it.
 */
const resolvedLogos = new Map<string, { logoUrl: string; expiresAt: number }>();

/**
 * Resolutions currently in flight, by symbol.
 *
 * This is what makes the whole pipeline dedupe: a page that renders twenty rows
 * of the same symbol, two concurrent requests for the same new ticker, and a
 * mutation racing the page render it triggers all await ONE provider call.
 */
const inFlight = new Map<string, Promise<EnsuredInstrumentLogo>>();

export interface EnsuredInstrumentLogo {
  symbol: string;
  logoUrl: string | null;
  /** The provider's own company name, when it answered with one. */
  companyName: string | null;
  status:
    /** Already on the instrument master (or a bundled mark); nothing was asked. */
    | 'persisted'
    /** Newly resolved from the profile provider and written back. */
    | 'resolved'
    /** A provider answered and has no logo for this symbol. */
    | 'unavailable'
    /** Nobody could answer right now — quota, outage, timeout. Try again later. */
    | 'deferred';
}

/** Test seam: forgets every remembered resolution, positive and negative. */
export function resetInstrumentLogoMemory(): void {
  logolessSymbols.clear();
  deferredSymbols.clear();
  resolvedLogos.clear();
  inFlight.clear();
}

function recallResolved(symbol: string, now = Date.now()): string | null {
  const entry = resolvedLogos.get(symbol);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    resolvedLogos.delete(symbol);
    return null;
  }
  return isBrokenLogoUrl(entry.logoUrl) ? null : entry.logoUrl;
}

/** What is already known about a symbol's logo, without asking anyone. */
function knownLogoUrl(symbol: string, persisted: string | null | undefined): string | null {
  const stored = isBrokenLogoUrl(persisted) ? null : normalizeLogoUrl(persisted);
  return marketAssetLogoUrl(symbol) ?? stored ?? recallResolved(symbol);
}

export function resolveInstrumentPresentationMetadata(
  instrument: InstrumentMetadata,
  profile: CompanyProfile | null,
): InstrumentMetadata {
  return {
    ...instrument,
    companyName: profile?.name?.trim() || tidyInstrumentName(instrument.companyName),
    /*
     * Persisted first, provider second, monogram last — and a provider that
     * answers with nothing cannot take a stored logo away.
     */
    logoUrl: chooseInstrumentLogoUrl({
      persisted: instrument.logoUrl,
      provider: profile?.logoUrl,
    }),
  };
}

/**
 * Whether the *logo* source failed, even though a profile came back.
 *
 * `CompanyProfileService` asks the secondary provider only for the logo, and
 * absorbs its failure into a reason code rather than an exception — so a spent
 * FMP quota arrives as a perfectly successful profile that happens to have no
 * logo. Told apart here, because the two mean opposite things: one is "this
 * company has no logo" and the other is "nobody could tell us right now".
 * `SECONDARY_LOGO_MISSING` is the former; every other `SECONDARY_*` the latter.
 */
function logoSourceUnavailable(reasonCode: string | null | undefined): boolean {
  return /SECONDARY_(?!LOGO_MISSING)/.test(reasonCode ?? '');
}

async function resolveFromProvider(
  symbol: string,
  persisted: string | null,
): Promise<EnsuredInstrumentLogo> {
  try {
    const profile = await getCompanyProfileService().getCompanyProfile(symbol);
    const providerLogo = isBrokenLogoUrl(profile.data.logoUrl) ? null : profile.data.logoUrl;
    const logoUrl = chooseInstrumentLogoUrl({ persisted, provider: providerLogo });
    const companyName = profile.data.name?.trim() || null;
    if (!logoUrl) {
      if (logoSourceUnavailable(profile.reasonCode)) {
        deferredSymbols.remember(symbol);
        return { symbol, logoUrl: null, companyName, status: 'deferred' };
      }
      logolessSymbols.remember(symbol);
      return { symbol, logoUrl: null, companyName, status: 'unavailable' };
    }
    resolvedLogos.set(symbol, { logoUrl, expiresAt: Date.now() + LOGO_RESOLVED_TTL_MS });
    deferredSymbols.forget(symbol);
    /*
     * Awaited so the write finishes before a serverless instance may freeze, and
     * swallowed so no caller fails for a cache write it does not need: the URL is
     * already in the value being returned.
     */
    await persistInstrumentLogos([{ symbol, logoUrl, persisted }]).catch(() => []);
    return { symbol, logoUrl, companyName, status: 'resolved' };
  } catch {
    /*
     * Deliberately not remembered. A spent FMP quota, a timeout or an outage
     * says nothing about whether this company has a logo, so the next request
     * gets to try again and the reader sees a stable symbol badge until then.
     */
    deferredSymbols.remember(symbol);
    return { symbol, logoUrl: persisted, companyName: null, status: 'deferred' };
  }
}

/**
 * Resolve, persist and return the logo for ONE symbol — the entry point every
 * first-seen flow shares: search, opening Stock Detail, adding a holding and
 * adding a watchlist row.
 *
 * Concurrent callers for the same symbol join the same promise, so a symbol is
 * only ever asked about once at a time no matter how many surfaces want it.
 */
export function ensureInstrumentLogo(
  symbol: string,
  options: {
    persisted?: string | null;
    /**
     * Skip symbols whose provider could not answer recently. Background work
     * sets this; a reader-initiated add never does, so an explicit action always
     * gets its own attempt.
     */
    background?: boolean;
  } = {},
): Promise<EnsuredInstrumentLogo> {
  const canonical = symbol.trim().toUpperCase();
  if (!canonical) {
    return Promise.resolve({
      symbol, logoUrl: null, companyName: null, status: 'unavailable',
    });
  }

  const pending = inFlight.get(canonical);
  if (pending) return pending;

  const known = knownLogoUrl(canonical, options.persisted);
  if (known) {
    return Promise.resolve({
      symbol: canonical, logoUrl: known, companyName: null, status: 'persisted',
    });
  }
  if (logolessSymbols.has(canonical)) {
    return Promise.resolve({
      symbol: canonical, logoUrl: null, companyName: null, status: 'unavailable',
    });
  }
  if (options.background && deferredSymbols.has(canonical)) {
    return Promise.resolve({
      symbol: canonical, logoUrl: null, companyName: null, status: 'deferred',
    });
  }

  const work = (async () => {
    /*
     * `persisted` is only trusted when the caller had it in hand. Otherwise the
     * instrument master is read first, so a logo another request stored a moment
     * ago is reused instead of asking the provider for it again.
     */
    const stored = options.persisted === undefined
      ? (await getInstrumentMetadata([canonical]).catch(() => null))?.get(canonical)?.logoUrl ?? null
      : options.persisted ?? null;
    const fromStore = knownLogoUrl(canonical, stored);
    if (fromStore) {
      return {
        symbol: canonical, logoUrl: fromStore, companyName: null, status: 'persisted' as const,
      };
    }
    return resolveFromProvider(canonical, normalizeLogoUrl(stored));
  })().finally(() => inFlight.delete(canonical));

  inFlight.set(canonical, work);
  return work;
}

/**
 * The same resolution for a list, bounded on both axes: at most `limit` symbols
 * are considered and at most `concurrency` providers are in flight, so a page
 * with a long watchlist cannot turn into a burst of provider requests — and no
 * single symbol can hold the rest up, because each settles on its own.
 */
export async function ensureInstrumentLogos(
  entries: ReadonlyArray<{ symbol: string; persisted?: string | null }>,
  options: { limit?: number; concurrency?: number; background?: boolean } = {},
): Promise<Map<string, EnsuredInstrumentLogo>> {
  const limit = Math.max(0, options.limit ?? entries.length);
  const pending = entries.slice(0, limit);
  const results = new Map<string, EnsuredInstrumentLogo>();
  if (pending.length === 0) return results;

  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const entry = pending[cursor++];
      if (!entry) continue;
      const resolved = await ensureInstrumentLogo(entry.symbol, {
        persisted: entry.persisted,
        background: options.background,
      });
      results.set(resolved.symbol, resolved);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(options.concurrency ?? PROFILE_CONCURRENCY, pending.length) },
    () => worker(),
  ));
  return results;
}

/**
 * The single instrument identity resolver every surface reads — Portfolio, the
 * watchlist, search, Stock Detail and the overview alike.
 *
 * A symbol whose logo is already on the instrument master is answered from the
 * database alone: no profile request is made for it at all, which is what keeps
 * a portfolio of twenty holdings from opening forty provider calls on every
 * render. Only the gaps go to the providers, and whatever they fill in is
 * written back so the gap is closed for everyone from then on.
 */
export async function getInstrumentPresentationMetadata(
  symbols: readonly string[],
): Promise<Map<string, InstrumentMetadata>> {
  const instruments = await getInstrumentMetadata(symbols);
  const entries = [...instruments.entries()];
  if (entries.length === 0) return instruments;

  /*
   * A URL reported broken is dropped here rather than trusted until the row is
   * cleared, so the reader stops seeing the missing picture immediately.
   */
  for (const [symbol, instrument] of entries) {
    instruments.set(symbol, {
      ...instrument,
      companyName: tidyInstrumentName(instrument.companyName),
      logoUrl: knownLogoUrl(symbol, instrument.logoUrl),
    });
  }

  const gaps = [...instruments.entries()].filter(
    ([symbol, instrument]) => !instrument.logoUrl && !logolessSymbols.has(symbol),
  );
  if (gaps.length === 0) return instruments;

  const ensured = await ensureInstrumentLogos(
    gaps.map(([symbol]) => ({ symbol, persisted: null })),
    { background: true },
  );
  for (const [symbol, instrument] of gaps) {
    const resolution = ensured.get(symbol);
    if (!resolution) continue;
    instruments.set(symbol, {
      ...instrument,
      companyName: resolution.companyName || instrument.companyName,
      logoUrl: chooseInstrumentLogoUrl({
        persisted: instrument.logoUrl,
        provider: resolution.logoUrl,
      }),
    });
  }
  return instruments;
}
