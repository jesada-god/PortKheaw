import { z } from 'zod';
import { TOOL_CATALOG, type ToolCatalogEntry } from './catalog';

/**
 * The one road from a position in the portfolio to a tool that can read it.
 *
 * Two things had to be true at once, and a single loose bag of query parameters
 * could give neither. A reader holding shares must never be dropped into a form
 * asking for a strike, and a reader holding a contract must never be dropped
 * into a stock planner that would silently treat their $73 strike as a share
 * price. So the context is a discriminated union: the `type` field decides which
 * fields exist, which tools are offered, and which parser will accept it.
 *
 * Everything here travels as URL parameters, which means it is reader-supplied
 * input and is treated as such — `parseToolHandoff` re-validates every field and
 * returns `null` rather than a half-filled context. What it cannot do is matter:
 * the context prefills form inputs and nothing else. Entitlement is decided by
 * the compute routes and by the Stock Planner's own server page, so no
 * parameter here can unlock a tool, and a malformed one can only produce an
 * empty workspace.
 */

export const TOOL_HANDOFF_SOURCE = 'portfolio' as const;
export const TOOL_HANDOFF_SOURCE_PARAM = 'from';

const symbol = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9.-]{0,19}$/);
const positive = z.number().positive();
const optionalPositive = positive.nullable().catch(null);

const optionContextSchema = z.object({
  type: z.literal('option'),
  symbol,
  optionKind: z.enum(['call', 'put']),
  side: z.enum(['long', 'short']),
  strike: positive,
  expiration: z.iso.date(),
  contracts: z.number().int().positive().max(1_000_000),
  multiplier: positive,
  /** The reader's own average premium per share — their cost basis, not a quote. */
  premium: z.number().nonnegative(),
  mark: optionalPositive,
  underlyingPrice: optionalPositive,
  impliedVolatility: z.number().positive().max(10).nullable().catch(null),
  contractSymbol: z.string().trim().toUpperCase().min(3).max(80).nullable().catch(null),
  portfolioId: z.string().uuid().nullable().catch(null),
});

const equityContextSchema = z.object({
  type: z.enum(['stock', 'etf']),
  symbol,
  quantity: positive,
  averageCost: z.number().nonnegative(),
  price: optionalPositive,
  marketValue: z.number().nullable().catch(null),
  unrealizedGain: z.number().nullable().catch(null),
  portfolioId: z.string().uuid().nullable().catch(null),
});

export const portfolioToolContextSchema = z.discriminatedUnion('type', [
  optionContextSchema,
  equityContextSchema,
]);

export type OptionToolContext = z.infer<typeof optionContextSchema>;
export type EquityToolContext = z.infer<typeof equityContextSchema>;
export type PortfolioToolContext = z.infer<typeof portfolioToolContextSchema>;

/** The canonical asset type a position carries, never a guess from its symbol. */
export type PortfolioAssetType = PortfolioToolContext['type'];

/**
 * Which tools may open this asset — the routing rule, stated once.
 *
 * Derived from the catalog's own `assetScope` rather than a second list here, so
 * a tool that changes what instrument it is for changes where it is offered.
 */
export function toolsForAssetType(type: PortfolioAssetType): ToolCatalogEntry[] {
  const scope = type === 'option' ? 'options' : 'stock';
  return TOOL_CATALOG.filter((tool) => tool.assetScope === scope);
}

export function toolAcceptsAssetType(tool: ToolCatalogEntry, type: PortfolioAssetType): boolean {
  return tool.assetScope === (type === 'option' ? 'options' : 'stock');
}

function put(params: URLSearchParams, key: string, value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  params.set(key, String(value));
}

/** The context as URL parameters. Keys are flat because a URL has no nesting. */
export function toolHandoffParams(context: PortfolioToolContext): URLSearchParams {
  const params = new URLSearchParams();
  params.set(TOOL_HANDOFF_SOURCE_PARAM, TOOL_HANDOFF_SOURCE);
  params.set('type', context.type);
  params.set('symbol', context.symbol);
  put(params, 'portfolioId', context.portfolioId);
  if (context.type === 'option') {
    put(params, 'optionKind', context.optionKind);
    put(params, 'side', context.side);
    put(params, 'strike', context.strike);
    put(params, 'expiration', context.expiration);
    put(params, 'contracts', context.contracts);
    put(params, 'multiplier', context.multiplier);
    put(params, 'premium', context.premium);
    put(params, 'mark', context.mark);
    put(params, 'underlyingPrice', context.underlyingPrice);
    put(params, 'impliedVolatility', context.impliedVolatility);
    put(params, 'contractSymbol', context.contractSymbol);
    return params;
  }
  put(params, 'quantity', context.quantity);
  put(params, 'averageCost', context.averageCost);
  put(params, 'price', context.price);
  put(params, 'marketValue', context.marketValue);
  put(params, 'unrealizedGain', context.unrealizedGain);
  return params;
}

/** The full link for one tool, or `null` when that tool cannot read this asset. */
export function toolHandoffHref(tool: ToolCatalogEntry, context: PortfolioToolContext): string | null {
  if (!toolAcceptsAssetType(tool, context.type)) return null;
  return `${tool.route}?${toolHandoffParams(context).toString()}`;
}

function readNumber(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * A context rebuilt from URL parameters, or `null`.
 *
 * `null` is the whole failure mode: a missing field, a strike that is not a
 * number, a `type` nobody issues. The caller opens an empty workspace, which is
 * the same thing a reader who navigated to the tool directly gets — never a
 * partially filled one carrying somebody's half-parsed position.
 */
export function parseToolHandoff(params: URLSearchParams): PortfolioToolContext | null {
  if (params.get(TOOL_HANDOFF_SOURCE_PARAM) !== TOOL_HANDOFF_SOURCE) return null;
  const type = params.get('type');
  const candidate = type === 'option'
    ? {
      type,
      symbol: params.get('symbol') ?? '',
      optionKind: params.get('optionKind') ?? '',
      side: params.get('side') ?? '',
      strike: readNumber(params, 'strike'),
      expiration: params.get('expiration') ?? '',
      contracts: readNumber(params, 'contracts'),
      multiplier: readNumber(params, 'multiplier') ?? 100,
      premium: readNumber(params, 'premium') ?? 0,
      mark: readNumber(params, 'mark'),
      underlyingPrice: readNumber(params, 'underlyingPrice'),
      impliedVolatility: readNumber(params, 'impliedVolatility'),
      contractSymbol: params.get('contractSymbol'),
      portfolioId: params.get('portfolioId'),
    }
    : {
      type,
      symbol: params.get('symbol') ?? '',
      quantity: readNumber(params, 'quantity'),
      averageCost: readNumber(params, 'averageCost') ?? 0,
      price: readNumber(params, 'price'),
      marketValue: readNumber(params, 'marketValue'),
      unrealizedGain: readNumber(params, 'unrealizedGain'),
      portfolioId: params.get('portfolioId'),
    };
  const parsed = portfolioToolContextSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The option half, refusing anything that is not one. Used by the simulators. */
export function parseOptionToolHandoff(params: URLSearchParams): OptionToolContext | null {
  const context = parseToolHandoff(params);
  return context?.type === 'option' ? context : null;
}

/** The equity half, refusing anything that is not one. Used by the Stock Planner. */
export function parseEquityToolHandoff(params: URLSearchParams): EquityToolContext | null {
  const context = parseToolHandoff(params);
  return context && context.type !== 'option' ? context : null;
}

/** Whether a URL carries a portfolio handoff at all, well formed or not. */
export function hasToolHandoff(search: string): boolean {
  return new URLSearchParams(search).get(TOOL_HANDOFF_SOURCE_PARAM) === TOOL_HANDOFF_SOURCE;
}
