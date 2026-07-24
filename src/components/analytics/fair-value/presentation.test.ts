import { describe, expect, it } from 'vitest';
import {
  fairValueMissingFieldsSummary,
  fairValueUnavailableLabel,
  fairValueUnavailableReason,
  formatFairValueMoney,
  formatUpsidePercent,
  modelLabel,
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

  it('maps v2 missing fields to human-readable reasons', () => {
    expect(fairValueMissingFieldsSummary([
      'forwardEstimates',
      'validForwardPeers>=4',
      'validWaccInputs',
    ], 'th')).toContain('Forward Estimates');
    expect(fairValueMissingFieldsSummary(['validForwardPeers>=4'], 'th')).toContain('4');
  });

  it('keeps the provider reason visible', () => {
    expect(fairValueUnavailableReason({
      status: 'unavailable',
      failureKind: 'provider-unavailable',
      symbol: 'RKLB',
      currency: 'USD',
      provider: 'financial-modeling-prep',
      reason: 'ยังคำนวณ Fair Value ไม่ได้ เพราะขาด Forward Estimates',
      missingFields: ['forwardEstimates'],
      missingInputs: ['forwardEstimates'],
      staleInputs: [],
      asOf: '2026-07-25',
      calculatedAt: '2026-07-25T00:00:00.000Z',
      methodologyVersion: 'nexora-fv-v2',
      limitations: [],
    }, 'th')).toContain('ยังคำนวณ Fair Value ไม่ได้');
  });
});
