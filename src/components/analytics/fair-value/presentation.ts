import type {
  FairValueAvailable,
  FairValueFailureKind,
  FairValueUnavailable,
  ModelId,
} from '@/src/lib/analytics/valuation/types';

export type UpsideTone = 'success' | 'danger' | 'neutral';

const MODEL_LABELS: Record<ModelId | 'blended', string> = {
  'fcff-dcf': 'DCF',
  fcfe: 'FCFE',
  ddm: 'DDM',
  relative: 'Relative',
  'asset-based': 'Asset',
  'ev-sales': 'Forward EV/Sales',
  'ev-ebitda': 'EV/EBITDA',
  pe: 'Forward P/E',
  peg: 'PEG',
  pb: 'P/B',
  blended: 'Blended',
};

export function modelLabel(model: ModelId | 'blended'): string {
  return MODEL_LABELS[model];
}

/**
 * Fair Value is always presented in the instrument's source currency (USD for US
 * stocks). The former USD/THB toggle and conversion were removed from the Fair
 * Value UI — the app-wide currency feature still governs prices and portfolio,
 * but a model estimate is never converted. USD stays the calculation source of truth.
 */
export function formatFairValueMoney(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function upsideTone(percent: number | null): UpsideTone {
  if (percent == null || !Number.isFinite(percent) || Math.abs(percent) < 0.005) return 'neutral';
  return percent > 0 ? 'success' : 'danger';
}

export function formatUpsidePercent(percent: number | null): string {
  if (percent == null || !Number.isFinite(percent)) return 'Unavailable';
  const normalized = Math.abs(percent) < 0.005 ? 0 : percent;
  return `${normalized > 0 ? '+' : ''}${normalized.toFixed(2)}%`;
}

export function displayStatus(data: FairValueAvailable): string {
  return data.dataStatus.charAt(0).toUpperCase() + data.dataStatus.slice(1);
}

const FAILURE_LABELS: Record<FairValueFailureKind, { th: string; en: string }> = {
  'insufficient-periods': { th: 'งบการเงินมีจำนวนงวดไม่เพียงพอ', en: 'Insufficient financial periods' },
  'currency-mismatch': { th: 'สกุลเงินของข้อมูลไม่ตรงกัน', en: 'Currency mismatch' },
  'stale-fundamentals': { th: 'งบการเงินเก่าเกินเกณฑ์', en: 'Stale fundamentals' },
  'provider-unavailable': {
    th: 'ผู้ให้บริการไม่มีข้อมูล',
    en: 'Provider data unavailable',
  },
  'missing-field': {
    th: 'ข้อมูลไม่ผ่านเกณฑ์ขั้นต่ำ',
    en: 'Insufficient data',
  },
  'mapping-error': {
    th: 'ไม่มีโมเดลที่มีความหมายกับข้อมูลชุดนี้',
    en: 'No meaningful valuation model',
  },
  'provider-rate-limited': {
    th: 'ผู้ให้บริการจำกัดคำขอชั่วคราว',
    en: 'Rate limited',
  },
  'calculation-error': {
    th: 'เซิร์ฟเวอร์ประมวลผลไม่สำเร็จ',
    en: 'Server error',
  },
};

export function fairValueUnavailableLabel(
  failureKind: FairValueFailureKind | 'insufficient-data' | 'not-meaningful' | 'rate-limited' | 'server-error',
  language: 'th' | 'en',
): string {
  const normalized: FairValueFailureKind = failureKind === 'insufficient-data'
    ? 'missing-field'
    : failureKind === 'not-meaningful'
      ? 'mapping-error'
      : failureKind === 'rate-limited'
        ? 'provider-rate-limited'
        : failureKind === 'server-error' ? 'calculation-error' : failureKind;
  if (language === 'th') {
    const thaiLabels: Record<FairValueFailureKind, string> = {
      'insufficient-periods': 'งบการเงินจริงไม่เพียงพอ',
      'currency-mismatch': 'สกุลเงินของข้อมูลไม่ตรงกัน',
      'stale-fundamentals': 'งบการเงินเก่าเกินเกณฑ์',
      'provider-unavailable': 'ผู้ให้บริการไม่มีข้อมูล',
      'missing-field': 'ข้อมูลจริงไม่ผ่านเกณฑ์ขั้นต่ำ',
      'mapping-error': 'ไม่สามารถจับคู่ข้อมูล provider ได้',
      'provider-rate-limited': 'ผู้ให้บริการจำกัดคำขอชั่วคราว',
      'calculation-error': 'เซิร์ฟเวอร์ประมวลผลไม่สำเร็จ',
    };
    return thaiLabels[normalized];
  }
  return FAILURE_LABELS[normalized].en;
}

function missingFieldLabel(field: string, language: 'th' | 'en'): string {
  const normalized = field.toLowerCase();
  if (normalized.includes('forwardestimate') || normalized.includes('targetforward')) {
    return 'Forward Estimates';
  }
  if (normalized.includes('wacc') || normalized.includes('riskfree') || normalized.includes('equityrisk') || normalized.includes('beta')) {
    return language === 'th' ? 'ข้อมูลจริงสำหรับ WACC' : 'traceable WACC inputs';
  }
  if (normalized.includes('peer')) {
    return language === 'th' ? 'peer ที่ผ่านเกณฑ์อย่างน้อย 4 บริษัท' : 'at least four valid peers';
  }
  const labels = language === 'th'
    ? {
        fcf: 'FCF',
        ebitda: 'EBITDA',
        history: 'ข้อมูลย้อนหลัง 3 งวด',
        ohlcv: 'ราคาย้อนหลังอย่างน้อย 50 วัน',
        income: 'งบกำไรขาดทุน',
        balance: 'งบดุล',
        cashFlow: 'งบกระแสเงินสด',
        shares: 'จำนวนหุ้นถัวเฉลี่ยปรับลด',
        marketCap: 'มูลค่าหลักทรัพย์ตามราคาตลาด',
        sector: 'Sector',
        industry: 'Industry',
        quote: 'ราคาตลาด',
        profile: 'ข้อมูลบริษัท',
        currency: 'สกุลเงินที่ตรวจสอบได้',
        aligned: 'งบการเงินที่ตรงกันตามงวด',
        peers: 'peer set ที่ตรวจสอบได้อย่างน้อย 5 บริษัท',
        forwardRevenue: 'forward/NTM revenue ที่ระบุงวด',
      }
    : {
        fcf: 'FCF',
        ebitda: 'EBITDA',
        history: 'three historical financial periods',
        ohlcv: 'at least 50 daily price rows',
        income: 'income statement',
        balance: 'balance sheet',
        cashFlow: 'cash-flow statement',
        shares: 'diluted shares',
        marketCap: 'market capitalization',
        sector: 'sector',
        industry: 'industry',
        quote: 'market quote',
        profile: 'company profile',
        currency: 'verified currency',
        aligned: 'period-aligned financial statements',
        peers: 'a verifiable peer set of at least 5 companies',
        forwardRevenue: 'forward/NTM revenue with an explicit period',
      };

  if (normalized.includes('verifiablepeerset')) return labels.peers;
  if (normalized.includes('forwardrevenue')) return labels.forwardRevenue;
  if (normalized.includes('historicalfinancials')) return labels.history;
  if (normalized.includes('historicalohlcv')) return labels.ohlcv;
  if (normalized.includes('freecashflow')) return labels.fcf;
  if (normalized.includes('ebitda')) return labels.ebitda;
  if (normalized.includes('income-statement') || normalized.includes('incomestatement')) return labels.income;
  if (normalized.includes('balance-sheet') || normalized.includes('balancesheet') || normalized.includes('cashanddebt')) return labels.balance;
  if (normalized.includes('cash-flow') || normalized.includes('cashflowstatement')) return labels.cashFlow;
  if (normalized.includes('dilutedshares')) return labels.shares;
  if (normalized.includes('marketcapitalization')) return labels.marketCap;
  if (normalized === 'sector') return labels.sector;
  if (normalized === 'industry') return labels.industry;
  if (normalized === 'quote' || normalized.includes('marketprice')) return labels.quote;
  if (normalized === 'companyprofile') return labels.profile;
  if (normalized.includes('currency')) return labels.currency;
  if (normalized.includes('alignedstatements')) return labels.aligned;
  return field;
}

function joinHumanList(values: string[], language: 'th' | 'en'): string {
  if (values.length <= 1) return values[0] ?? '';
  return language === 'th'
    ? `${values.slice(0, -1).join(', ')} และ${values.at(-1)}`
    : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}

export function fairValueMissingFieldsSummary(
  missingFields: string[],
  language: 'th' | 'en',
): string {
  const labels = [...new Set(missingFields.map((field) => missingFieldLabel(field, language)))];
  if (!labels.length) return language === 'th' ? 'ไม่มีข้อมูลที่ขาดเพิ่มเติม' : 'No additional fields are missing';
  return `${language === 'th' ? 'ขาด' : 'Missing'} ${joinHumanList(labels, language)}`;
}

export interface MissingFieldDetail {
  field: string;
  period: string | null;
  statement: string | null;
  reason: string;
  affectedModels: ModelId[];
}

function affectedModelsForField(field: string): ModelId[] {
  const normalized = field.toLowerCase();
  if (/workingcapital|freecashflow|capitalexpenditure|depreciation/.test(normalized)) return ['fcff-dcf'];
  if (/dividend/.test(normalized)) return ['ddm'];
  if (/forward.*growth/.test(normalized)) return ['peg'];
  if (/eps/.test(normalized)) return ['pe', 'peg'];
  if (/equity|asset|liabilit/.test(normalized)) return ['asset-based', 'pb'];
  if (/ebitda/.test(normalized)) return ['ev-ebitda'];
  if (/revenue/.test(normalized)) return ['fcff-dcf', 'ev-sales'];
  if (/shares/.test(normalized)) return ['fcff-dcf', 'fcfe', 'ddm', 'relative', 'asset-based', 'ev-sales', 'ev-ebitda', 'pe', 'peg', 'pb'];
  return [];
}

export function fairValueMissingFieldDetails(missingFields: string[]): MissingFieldDetail[] {
  return missingFields.map((raw) => {
    const periodMatch = /^(annual|quarterly):(\d{4}-\d{2}-\d{2}):(.+)$/.exec(raw);
    const modelMatch = /^(fcff-dcf|fcfe|ddm|relative|asset-based|ev-sales|ev-ebitda|pe|peg|pb):\s*(.+)$/.exec(raw);
    const field = periodMatch?.[3] ?? (modelMatch ? 'model input gate' : raw);
    const statement = /revenue|income|eps|shares|ebitda|interest/i.test(field)
      ? 'income statement'
      : /cash|capital|dividend|workingcapital|freecashflow/i.test(field)
        ? 'cash-flow statement'
        : /asset|liabilit|debt|equity/i.test(field) ? 'balance sheet' : null;
    return {
      field: modelMatch?.[1] ?? field,
      period: periodMatch?.[2] ?? null,
      statement,
      reason: modelMatch?.[2] ?? (periodMatch ? 'provider field unavailable or could not be mapped safely' : raw),
      affectedModels: modelMatch ? [modelMatch[1] as ModelId] : affectedModelsForField(field),
    };
  });
}

export function fairValueUnavailableReason(
  data: FairValueUnavailable,
  language: 'th' | 'en',
): string {
  const missing = data.missingFields.length > 0
    ? fairValueMissingFieldsSummary(data.missingFields, language)
    : null;
  return missing ? `${missing} · ${data.reason}` : data.reason;
}
