import { describe, expect, it } from 'vitest';
import {
  UNMATCHED_OPTION_MESSAGE,
  optionPositionDescription,
  optionPositionMarketSymbol,
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
