import {
  optionContractSchema,
  type MarketTimestampKind,
  type NormalizedOptionContracts,
  type OptionContract,
} from './contracts';

export interface RawOptionContractInput {
  contractSymbol: unknown;
  underlyingSymbol: unknown;
  type: unknown;
  expiration: unknown;
  strike: unknown;
  bid?: unknown;
  ask?: unknown;
  last?: unknown;
  mark?: unknown;
  volume?: unknown;
  openInterest?: unknown;
  impliedVolatility?: unknown;
  delta?: unknown;
  gamma?: unknown;
  theta?: unknown;
  vega?: unknown;
  rho?: unknown;
  inTheMoney?: unknown;
  multiplier?: unknown;
  currency?: unknown;
  asOf?: unknown;
}

export interface NormalizeOptionContext {
  provider: string;
  asOf: string;
  timestampKind: MarketTimestampKind;
  status: 'live' | 'delayed';
  delayedMinutes: number | null;
  ivUnit: 'decimal' | 'percent' | 'auto';
  defaultMultiplier?: number;
  defaultCurrency?: string;
  expiration?: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function nonnegative(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const parsed = numberOrNull(value);
  return parsed !== null && parsed >= 0 && Number.isInteger(parsed) ? parsed : null;
}

export function normalizeImpliedVolatility(
  value: unknown,
  unit: NormalizeOptionContext['ivUnit'],
): number | null {
  const parsed = nonnegative(value);
  if (parsed === null) return null;
  if (unit === 'percent') return parsed / 100;
  if (unit === 'auto') return parsed > 5 ? parsed / 100 : parsed;
  return parsed;
}

function completeness(contract: OptionContract): number {
  const fields = [
    contract.bid, contract.ask, contract.last, contract.mark,
    contract.volume, contract.openInterest, contract.impliedVolatility,
    contract.delta, contract.gamma, contract.theta, contract.vega, contract.rho,
  ];
  return fields.filter((value) => value !== null).length / fields.length;
}

function validDate(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

export function normalizeOptionContracts(
  rows: readonly RawOptionContractInput[],
  context: NormalizeOptionContext,
): NormalizedOptionContracts {
  const warnings = new Set<string>();
  const byIdentity = new Map<string, OptionContract>();
  const snapshotAsOf = new Set<string>();

  for (const row of rows) {
    const contractSymbol = text(row.contractSymbol);
    const underlyingSymbol = text(row.underlyingSymbol)?.toUpperCase() ?? null;
    const type = row.type === 'call' || row.type === 'put' ? row.type : null;
    const expiration = validDate(row.expiration);
    const strike = numberOrNull(row.strike);
    if (!contractSymbol || !underlyingSymbol || !type || !expiration || strike === null || strike <= 0) {
      warnings.add('Excluded option rows with invalid identity, type, expiration, or strike');
      continue;
    }
    if (context.expiration && expiration !== context.expiration) {
      warnings.add('Provider response contained contracts outside the requested expiration');
      continue;
    }

    let bid = nonnegative(row.bid);
    let ask = nonnegative(row.ask);
    if (bid !== null && ask !== null && bid > ask) {
      bid = null;
      ask = null;
      warnings.add('Invalid crossed bid/ask quotes were excluded');
    }
    const multiplier = numberOrNull(row.multiplier) ?? context.defaultMultiplier ?? null;
    if (multiplier === null || multiplier <= 0) {
      warnings.add('Excluded contracts without a valid multiplier');
      continue;
    }
    if (row.multiplier == null && context.defaultMultiplier !== undefined) {
      warnings.add('Provider omits deliverable multiplier; standard US equity option multiplier 100 is disclosed as an assumption');
    }
    const asOf = text(row.asOf) ?? context.asOf;
    snapshotAsOf.add(asOf);
    const parsed = optionContractSchema.safeParse({
      contractSymbol,
      underlyingSymbol,
      type,
      expiration,
      strike,
      bid,
      ask,
      last: nonnegative(row.last),
      mark: nonnegative(row.mark),
      volume: nonnegativeInteger(row.volume),
      openInterest: nonnegativeInteger(row.openInterest),
      impliedVolatility: normalizeImpliedVolatility(row.impliedVolatility, context.ivUnit),
      delta: numberOrNull(row.delta),
      gamma: numberOrNull(row.gamma),
      theta: numberOrNull(row.theta),
      vega: numberOrNull(row.vega),
      rho: numberOrNull(row.rho),
      inTheMoney: typeof row.inTheMoney === 'boolean' ? row.inTheMoney : null,
      multiplier,
      currency: text(row.currency) ?? context.defaultCurrency ?? 'USD',
      provider: context.provider,
      asOf,
      timestampKind: context.timestampKind,
      status: context.status,
    });
    if (!parsed.success) {
      warnings.add('Excluded option rows that failed the normalized contract');
      continue;
    }

    const previous = byIdentity.get(contractSymbol);
    if (previous) {
      if (previous.expiration !== parsed.data.expiration || previous.asOf !== parsed.data.asOf) {
        warnings.add('Duplicate contract identity crossed expiration or as-of snapshots; one snapshot was retained');
      } else {
        warnings.add('Duplicate option contract identities were deduplicated');
      }
      if (completeness(parsed.data) > completeness(previous)) byIdentity.set(contractSymbol, parsed.data);
    } else {
      byIdentity.set(contractSymbol, parsed.data);
    }
  }

  if (snapshotAsOf.size > 1) warnings.add('Contracts contain more than one as-of snapshot');
  const contracts = [...byIdentity.values()].sort((left, right) => (
    left.expiration.localeCompare(right.expiration)
    || left.strike - right.strike
    || left.type.localeCompare(right.type)
    || left.contractSymbol.localeCompare(right.contractSymbol)
  ));
  const expirations = [...new Set(contracts.map((contract) => contract.expiration))].sort();
  const averageCompleteness = contracts.length
    ? contracts.reduce((sum, contract) => sum + completeness(contract), 0) / contracts.length
    : 0;

  return {
    underlyingSymbol: contracts[0]?.underlyingSymbol ?? '',
    contracts,
    expirations,
    provider: context.provider,
    asOf: context.asOf,
    timestampKind: context.timestampKind,
    status: context.status,
    delayedMinutes: context.delayedMinutes,
    completeness: averageCompleteness,
    warnings: [...warnings],
  };
}
