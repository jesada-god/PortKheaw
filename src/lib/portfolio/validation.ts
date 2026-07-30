import { z } from 'zod';
import { transactionTypes, type OptionKind, type OptionSide, type PortfolioTransactionType } from './types';

const unsignedDecimal = z.string().trim().regex(/^\d+(?:\.\d{1,8})?$/, 'กรอกทศนิยมได้ไม่เกิน 8 ตำแหน่ง');
const positiveDecimal = unsignedDecimal.refine((value) => Number(value) > 0 && Number.isFinite(Number(value)), 'ค่าต้องมากกว่า 0');
const nonnegativeDecimal = z.string().trim().refine(
  (value) => value === '' || (/^\d+(?:\.\d{1,8})?$/.test(value) && Number.isFinite(Number(value))),
  'ค่าต้องเป็น 0 หรือมากกว่า',
);
const signedDecimal = z.string().trim().regex(/^-?\d+(?:\.\d{1,8})?$/, 'กรอกจำนวนบวกหรือลบได้ไม่เกิน 8 ตำแหน่ง')
  .refine((value) => Number(value) !== 0 && Number.isFinite(Number(value)), 'ค่าปรับยอดต้องไม่เป็น 0');
const symbol = z.string().trim().toUpperCase().regex(/^(\^[A-Z0-9]+|[A-Z0-9][A-Z0-9.-]{0,19})$/, 'Symbol ไม่ถูกต้อง');
const contractSymbol = z.string().trim().toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9._:-]{2,79}$/, 'Contract symbol ไม่ถูกต้อง');
const occurredAt = z.string().trim().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return false;
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+07:00` : value;
  return Number.isFinite(Date.parse(instant)) && Date.parse(instant) <= Date.now();
}, 'วันและเวลารายการไม่ถูกต้องหรืออยู่ในอนาคต');

export const portfolioTransactionSchema = z.object({
  type: z.enum(transactionTypes),
  symbol: z.string().optional().default(''),
  quantity: z.string().optional().default(''),
  price: z.string().optional().default(''),
  amount: z.string().optional().default(''),
  fee: z.string().optional().default(''),
  originalCurrency: z.enum(['USD', 'THB']).optional().default('USD'),
  fxRateAtTransaction: z.string().optional().default(''),
  occurredAt,
  broker: z.string().trim().max(100, 'ชื่อโบรกเกอร์ต้องไม่เกิน 100 ตัวอักษร').optional().default(''),
  note: z.string().trim().max(500, 'หมายเหตุต้องไม่เกิน 500 ตัวอักษร').optional().default(''),
  underlyingSymbol: z.string().optional().default(''),
  contractSymbol: z.string().optional().default(''),
  optionKind: z.enum(['call', 'put']).optional(),
  optionSide: z.enum(['long', 'short']).optional(),
  strikePrice: z.string().optional().default(''),
  expirationDate: z.string().optional().default(''),
  multiplier: z.string().optional().default('100'),
  idempotencyKey: z.string().uuid(),
}).superRefine((value, context) => {
  const stockType = value.type === 'acquisition' || value.type === 'disposal' || value.type === 'initial_position';
  const optionType = value.type === 'buy_to_open' || value.type === 'sell_to_close'
    || value.type === 'sell_to_open' || value.type === 'buy_to_close'
    || value.type === 'exercise' || value.type === 'assignment' || value.type === 'expired';
  const cashType = !stockType && !optionType;
  const issue = (path: string, result: z.ZodSafeParseResult<unknown>) => {
    if (!result.success) context.addIssue({ code: 'custom', path: [path], message: result.error.issues[0].message });
  };

  if (stockType) {
    issue('symbol', symbol.safeParse(value.symbol));
    issue('quantity', positiveDecimal.safeParse(value.quantity));
    issue('price', positiveDecimal.safeParse(value.price));
    issue('fee', nonnegativeDecimal.safeParse(value.fee));
    if (value.type === 'initial_position' && value.amount !== '') issue('amount', nonnegativeDecimal.safeParse(value.amount));
  }
  if (cashType) {
    issue('amount', value.type === 'adjustment' ? signedDecimal.safeParse(value.amount) : positiveDecimal.safeParse(value.amount));
  }
  if (optionType) {
    issue('underlyingSymbol', symbol.safeParse(value.underlyingSymbol));
    issue('contractSymbol', contractSymbol.safeParse(value.contractSymbol));
    issue('quantity', z.string().regex(/^\d+$/, 'จำนวนสัญญาต้องเป็นจำนวนเต็ม').refine((item) => Number(item) > 0 && Number(item) <= 1_000_000, 'จำนวนสัญญาไม่ถูกต้อง').safeParse(value.quantity));
    issue('strikePrice', positiveDecimal.safeParse(value.strikePrice));
    issue('multiplier', positiveDecimal.safeParse(value.multiplier));
    issue('fee', nonnegativeDecimal.safeParse(value.fee));
    issue('expirationDate', z.string().date('วันหมดอายุไม่ถูกต้อง').safeParse(value.expirationDate));
    if (!value.optionKind) context.addIssue({ code: 'custom', path: ['optionKind'], message: 'เลือก Call หรือ Put' });
    const premiumOptional = value.type === 'exercise' || value.type === 'assignment' || value.type === 'expired';
    issue('price', premiumOptional ? nonnegativeDecimal.safeParse(value.price) : positiveDecimal.safeParse(value.price));
    if (value.type === 'expired' && !value.optionSide) {
      context.addIssue({ code: 'custom', path: ['optionSide'], message: 'เลือกฝั่ง Long หรือ Short ของสัญญาที่หมดอายุ' });
    }
    const eventDate = value.occurredAt.slice(0, 10);
    if (value.type === 'buy_to_open' || value.type === 'sell_to_open') {
      if (value.expirationDate < eventDate) context.addIssue({ code: 'custom', path: ['expirationDate'], message: 'วันหมดอายุต้องไม่ก่อนวันเปิดสัญญา' });
    }
  }
  if (value.originalCurrency === 'THB') {
    const rate = positiveDecimal.safeParse(value.fxRateAtTransaction);
    if (!rate.success) context.addIssue({ code: 'custom', path: ['fxRateAtTransaction'], message: 'ต้องระบุ USD/THB ณ เวลาที่เกิดรายการ' });
  }
});

export interface TransactionInput {
  type: PortfolioTransactionType;
  symbol?: string;
  quantity?: string;
  price?: string;
  amount?: string;
  fee?: string;
  originalCurrency: 'USD' | 'THB';
  fxRateAtTransaction?: string;
  occurredAt: string;
  broker?: string;
  note?: string;
  underlyingSymbol?: string;
  contractSymbol?: string;
  optionKind?: OptionKind;
  optionSide?: OptionSide;
  strikePrice?: string;
  expirationDate?: string;
  multiplier?: string;
  idempotencyKey: string;
}
