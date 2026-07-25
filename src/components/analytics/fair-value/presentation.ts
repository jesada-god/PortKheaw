import type {
  FairValueAvailable,
  FairValueFailureKind,
  FairValueUnavailable,
  ModelId,
  ValuationDiagnostic,
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

const FIELD_LABELS: Record<string, string> = {
  beta: 'Beta',
  riskFreeRate: 'อัตราผลตอบแทนไร้ความเสี่ยง',
  equityRiskPremium: 'Equity Risk Premium',
  forwardRevenue: 'ประมาณการรายได้ล่วงหน้า',
  forwardEps: 'ประมาณการ EPS ล่วงหน้า',
  forwardEstimates: 'ประมาณการล่วงหน้า',
  targetForwardEstimate: 'ประมาณการล่วงหน้าของบริษัท',
  peerObservations: 'ข้อมูลบริษัทเทียบเคียง',
  stockPeers: 'บริษัทเทียบเคียง',
  marketCapitalization: 'มูลค่าหลักทรัพย์ตามราคาตลาด',
  sharesOutstanding: 'จำนวนหุ้นที่ออกจำหน่าย',
  dilutedShares: 'จำนวนหุ้นถัวเฉลี่ยปรับลด',
  dilutedSharesOrSharesOutstanding: 'จำนวนหุ้น',
  freeCashFlow: 'กระแสเงินสดอิสระ (FCF)',
  latestRealFreeCashFlow: 'กระแสเงินสดอิสระล่าสุด',
  latestRealRevenue: 'รายได้ล่าสุด',
  cash: 'เงินสด',
  totalDebt: 'หนี้สินรวม',
  incomeBeforeTax: 'กำไรก่อนภาษี',
  incomeTaxExpense: 'ภาษีเงินได้',
  interestExpense: 'ดอกเบี้ยจ่าย',
  marketPrice: 'ราคาตลาด',
  financialStatements: 'งบการเงินจริง',
  waccMarketInputs: 'ข้อมูลตลาดสำหรับ WACC',
  forwardRevenueEstimates: 'ประมาณการรายได้ล่วงหน้า',
  'validForwardPeers>=4': 'บริษัทเทียบเคียงที่ผ่านเกณฑ์อย่างน้อย 4 บริษัท',
  validWaccAndDcfCalculation: 'ข้อมูล WACC และผลคำนวณ DCF ที่ผ่านเกณฑ์',
};

export function modelLabel(model: ModelId | 'blended'): string {
  return MODEL_LABELS[model];
}

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
  'insufficient-periods': { th: 'งบการเงินจริงมีจำนวนงวดไม่เพียงพอ', en: 'Insufficient financial periods' },
  'currency-mismatch': { th: 'สกุลเงินของข้อมูลไม่ตรงกัน', en: 'Currency mismatch' },
  'stale-fundamentals': { th: 'งบการเงินเก่าเกินเกณฑ์', en: 'Stale fundamentals' },
  'provider-unavailable': { th: 'ผู้ให้บริการไม่มีข้อมูล', en: 'Provider data unavailable' },
  'missing-field': { th: 'ข้อมูลจริงไม่ผ่านเกณฑ์ขั้นต่ำ', en: 'Insufficient data' },
  'mapping-error': { th: 'ไม่สามารถจับคู่ข้อมูลจากผู้ให้บริการได้', en: 'Provider mapping error' },
  'provider-rate-limited': { th: 'ผู้ให้บริการจำกัดคำขอชั่วคราว', en: 'Rate limited' },
  'calculation-error': { th: 'ระบบประมวลผลไม่สำเร็จ', en: 'Server error' },
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
  return FAILURE_LABELS[normalized][language];
}

export function readableFieldLabel(field: string): string {
  if (field.startsWith('model:fcff-dcf')) return 'โมเดล DCF';
  if (field.startsWith('model:forward-multiples')) return 'โมเดล Forward Multiples';
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const periodMatch = /^(annual|quarterly):\d{4}-\d{2}-\d{2}:(.+)$/.exec(field);
  return FIELD_LABELS[periodMatch?.[2] ?? ''] ?? periodMatch?.[2] ?? field;
}

function joinHumanList(values: string[], language: 'th' | 'en'): string {
  if (values.length <= 1) return values[0] ?? '';
  return language === 'th'
    ? `${values.slice(0, -1).join(', ')} และ ${values.at(-1)}`
    : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}

export function fairValueMissingFieldsSummary(
  missingFields: string[],
  language: 'th' | 'en',
): string {
  const labels = [...new Set(missingFields.map((field) =>
    language === 'th' ? readableFieldLabel(field) : field))];
  if (!labels.length) return language === 'th' ? 'ไม่พบรายการข้อมูลที่ขาดเพิ่มเติม' : 'No additional fields are missing';
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
  if (/workingcapital|freecashflow|capitalexpenditure|depreciation|wacc|beta|riskfree|equityrisk/.test(normalized)) return ['fcff-dcf'];
  if (/forward|peer|eps|revenue/.test(normalized)) return ['pe', 'ev-sales'];
  if (/shares|cash|debt/.test(normalized)) return ['fcff-dcf', 'pe', 'ev-sales'];
  return [];
}

export function fairValueMissingFieldDetails(missingFields: string[]): MissingFieldDetail[] {
  return missingFields.map((raw) => {
    const periodMatch = /^(annual|quarterly):(\d{4}-\d{2}-\d{2}):(.+)$/.exec(raw);
    const modelMatch = /^(fcff-dcf|fcfe|ddm|relative|asset-based|ev-sales|ev-ebitda|pe|peg|pb):\s*(.+)$/.exec(raw);
    const field = periodMatch?.[3] ?? (modelMatch ? 'model input gate' : raw);
    return {
      field: modelMatch?.[1] ?? field,
      period: periodMatch?.[2] ?? null,
      statement: null,
      reason: modelMatch?.[2] ?? readableFieldLabel(raw),
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
  const safeReason = /[\u0080-\u009f]/.test(data.reason)
    ? fairValueUnavailableLabel(data.failureKind, language)
    : data.reason;
  return missing
    ? `${missing} · ${safeReason}`
    : safeReason;
}

export function diagnosticReasonLabel(diagnostic: ValuationDiagnostic): string {
  if (!diagnostic.reason) return diagnostic.status === 'available' ? 'ข้อมูลพร้อมใช้งาน' : 'ไม่ระบุเหตุผล';
  if (diagnostic.reason === 'derived-market-price-times-shares') {
    return 'คำนวณจากราคาตลาด × จำนวนหุ้นที่รายงาน';
  }
  if (diagnostic.reason.startsWith('derived-historical-beta:')) {
    const [, benchmark, sampleSize] = diagnostic.reason.split(':');
    return `คำนวณ Beta จากผลตอบแทนรายวันเทียบ ${benchmark || 'benchmark'} (${sampleSize || 'ไม่ระบุ'} ตัวอย่าง)`;
  }
  const safeLabels: Record<string, string> = {
    'provider-field-missing': 'ผู้ให้บริการไม่ส่งค่านี้',
    'provider-not-configured': 'ยังไม่ได้ตั้งค่าผู้ให้บริการ',
    'stale-provider-cache': 'ใช้ข้อมูล cache ที่เก่ากว่าปกติ',
    'required-model-input-failed-validation': 'ข้อมูลไม่ผ่านเกณฑ์ของโมเดล',
    'rate-limited': 'ผู้ให้บริการจำกัดคำขอชั่วคราว',
    'provider-unavailable': 'ผู้ให้บริการไม่พร้อมใช้งาน',
  };
  if (safeLabels[diagnostic.reason]) return safeLabels[diagnostic.reason];
  const fields = diagnostic.reason.split(',').map((field) => readableFieldLabel(field.trim()));
  return fields.join(', ');
}

export function fairValueSummary(data: FairValueAvailable): string {
  if (data.fairValue.type === 'base') {
    return 'ค่านี้ผสมผล DCF 60% และ Forward Multiples 40% หลังจากทั้งสองโมเดลผ่านการตรวจสอบข้อมูลแล้ว';
  }
  if (data.fairValue.type === 'dcf') {
    return 'ค่านี้มาจาก DCF ที่ผ่านการตรวจสอบเพียงโมเดลเดียว จึงไม่เรียกว่า Base หรือ Blended Fair Value';
  }
  return 'ค่านี้เทียบประมาณการล่วงหน้ากับบริษัทจริงอย่างน้อย 4 บริษัทที่ผ่านเกณฑ์ โดยไม่มีการผสม DCF';
}
