import { describe, expect, it } from 'vitest';
import {
  diagnosticReasonLabel,
  fairValueMissingFieldsSummary,
  fairValueUnavailableLabel,
  fairValueUnavailableReason,
  formatFairValueMoney,
  formatUpsidePercent,
  modelLabel,
  readableFieldLabel,
  upsideTone,
} from './presentation';

describe('Fair Value presentation', () => {
  it('formats Fair Value in USD only', () => {
    expect(formatFairValueMoney(100)).toBe('$100.00');
    expect(formatFairValueMoney(null)).toBe('Unavailable');
    expect(formatFairValueMoney(Number.NaN)).toBe('Unavailable');
  });

  it('formats signed upside/downside without NaN or Infinity', () => {
    expect(formatUpsidePercent(12.4)).toBe('+12.40%');
    expect(formatUpsidePercent(-8.25)).toBe('-8.25%');
    expect(formatUpsidePercent(Number.NaN)).toBe('Unavailable');
    expect(upsideTone(12.4)).toBe('success');
    expect(upsideTone(-8.25)).toBe('danger');
    expect(upsideTone(0)).toBe('neutral');
  });

  it('uses direct Thai failure labels and explicit forward model names', () => {
    expect(fairValueUnavailableLabel('provider-unavailable', 'th')).toBe('ผู้ให้บริการไม่มีข้อมูล');
    expect(fairValueUnavailableLabel('insufficient-data', 'th')).toBe('ข้อมูลจริงไม่ผ่านเกณฑ์ขั้นต่ำ');
    expect(fairValueUnavailableLabel('rate-limited', 'en')).toBe('Rate limited');
    expect(modelLabel('pe')).toBe('Forward P/E');
    expect(modelLabel('ev-sales')).toBe('Forward EV/Sales');
  });

  it('maps technical fields to human-readable Thai names', () => {
    expect(fairValueMissingFieldsSummary([
      'forwardEstimates',
      'validForwardPeers>=4',
      'validWaccInputs',
    ], 'th')).toContain('ประมาณการล่วงหน้า');
    expect(fairValueMissingFieldsSummary(['validForwardPeers>=4'], 'th')).toContain('4');
    expect(readableFieldLabel('riskFreeRate')).toBe('อัตราผลตอบแทนไร้ความเสี่ยง');
    expect(readableFieldLabel('targetForwardEstimate')).toBe('ประมาณการล่วงหน้าของบริษัท');
  });

  it('keeps a safe provider reason visible', () => {
    expect(fairValueUnavailableReason({
      status: 'unavailable',
      failureKind: 'provider-unavailable',
      symbol: 'RKLB',
      currency: 'USD',
      provider: 'financial-modeling-prep',
      reason: 'ยังคำนวณไม่ได้เพราะขาด Forward Estimates',
      missingFields: ['forwardEstimates'],
      missingInputs: ['forwardEstimates'],
      staleInputs: [],
      asOf: '2026-07-25',
      calculatedAt: '2026-07-25T00:00:00.000Z',
      methodologyVersion: 'nexora-fv-v2',
      limitations: [],
      diagnostics: [],
    }, 'th')).toContain('ยังคำนวณไม่ได้');
  });

  it('explains deterministic derivations without exposing raw resolver keys', () => {
    expect(diagnosticReasonLabel({
      field: 'marketCapitalization',
      value: 2_000,
      period: '2026-07-24',
      provider: 'nexora-derived',
      asOf: '2026-07-24',
      status: 'available',
      provenance: 'derived',
      reason: 'derived-market-price-times-shares',
    })).toContain('ราคาตลาด × จำนวนหุ้น');
    expect(diagnosticReasonLabel({
      field: 'beta',
      value: 1.2,
      period: '2025-01-01/2026-07-24',
      provider: 'nexora-historical-beta',
      asOf: '2026-07-24',
      status: 'available',
      provenance: 'derived',
      reason: 'derived-historical-beta:SPY:250',
    })).toContain('SPY');
  });
});
