import { describe, expect, it } from 'vitest';
import {
  UNMATCHED_OPTION_MESSAGE,
  optionPositionDescription,
  optionPositionMarketSymbol,
  optionPositionMoneyness,
  optionPositionTitle,
} from './presentation';

const legacyPosition = {
  underlyingSymbol: 'NVTS',
  contractSymbol: 'LEGACY-C307F481-B34C-4FE3-97',
  marketContractSymbol: null,
  optionKind: 'put' as const,
  strikePrice: 12,
  expirationDate: '2026-08-21',
  contracts: 1,
};

describe('option position presentation', () => {
  it('never exposes a legacy ledger identifier in user-facing labels', () => {
    const labels = [
      optionPositionTitle(legacyPosition),
      optionPositionDescription(legacyPosition),
      optionPositionMarketSymbol(legacyPosition),
      UNMATCHED_OPTION_MESSAGE,
    ];

    expect(optionPositionTitle(legacyPosition)).toBe('NVTS PUT $12');
    expect(optionPositionDescription(legacyPosition)).toContain('1 สัญญา');
    expect(labels.join(' ')).not.toContain('LEGACY-');
    expect(UNMATCHED_OPTION_MESSAGE).toBe('ยังจับคู่สัญญากับข้อมูลตลาดไม่ได้');
  });

  it('shows the provider-confirmed canonical symbol after resolution', () => {
    expect(optionPositionMarketSymbol({
      ...legacyPosition,
      marketContractSymbol: 'NVTS260821P00012000',
    })).toBe('NVTS260821P00012000');
  });
});

describe('optionPositionMoneyness', () => {
  const call = { optionKind: 'call' as const, strikePrice: 70 };
  const put = { optionKind: 'put' as const, strikePrice: 70 };

  it('reads a call and a put from opposite sides of the strike', () => {
    expect(optionPositionMoneyness({ ...call, underlyingPrice: 80 })).toBe('ITM');
    expect(optionPositionMoneyness({ ...call, underlyingPrice: 60 })).toBe('OTM');
    expect(optionPositionMoneyness({ ...put, underlyingPrice: 60 })).toBe('ITM');
    expect(optionPositionMoneyness({ ...put, underlyingPrice: 80 })).toBe('OTM');
  });

  it('calls a half-percent band around the strike at the money', () => {
    expect(optionPositionMoneyness({ ...call, underlyingPrice: 70 })).toBe('ATM');
    expect(optionPositionMoneyness({ ...call, underlyingPrice: 70.2 })).toBe('ATM');
    expect(optionPositionMoneyness({ ...call, underlyingPrice: 70.5 })).toBe('ITM');
  });

  /*
   * The badge is only ever shown when it can be checked. An unpriced underlying
   * produces no badge rather than a confident guess.
   */
  it('answers nothing at all when the underlying price is unknown or the strike is unusable', () => {
    expect(optionPositionMoneyness({ ...call, underlyingPrice: null })).toBeNull();
    expect(optionPositionMoneyness({ ...call, underlyingPrice: Number.NaN })).toBeNull();
    expect(optionPositionMoneyness({ optionKind: 'call', strikePrice: 0, underlyingPrice: 10 })).toBeNull();
  });
});
