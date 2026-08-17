'use client';

import { useEffect, useMemo, useState, useTransition, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  loadOptionPurchasePortfoliosAction,
  purchaseOptionFromChainAction,
  type OptionPurchasePortfolioChoice,
} from '@/app/portfolio/option-purchase-actions';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';
import { Button } from '@/src/components/ui/Button';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import { useToast } from '@/src/components/ui/Toast';
import {
  calculateOptionPurchasePreview,
  optionPurchaseBreakeven,
  optionPurchaseQuoteFingerprint,
  resolveOptionFeeTotal,
  validateOptionPurchaseQuote,
  type OptionFeeMode,
  type OptionPurchaseQuoteSnapshot,
} from '@/src/lib/portfolio/options/purchase';
import { currentDateTimeLocal, maximumTransactionDateTimeLocal } from '@/src/lib/portfolio/transaction-datetime';

function money(value: number | null) {
  return value === null ? '—' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function number(value: number | null) {
  return value === null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/**
 * The fee the reader last paid, offered as the next order's starting point.
 * Commission is a property of the broker, not of the contract, so the same
 * number is right nearly every time and re-typing it is pure friction.
 *
 * Storage is read defensively: it is absent during SSR and throws outright in
 * private-browsing modes, and neither is a reason to fail to open the sheet.
 */
const FEE_STORAGE_KEY = 'options_default_fee';

function readStoredFee(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(FEE_STORAGE_KEY);
    return stored !== null && /^\d+(?:\.\d{1,8})?$/.test(stored.trim()) ? stored.trim() : null;
  } catch {
    return null;
  }
}

function writeStoredFee(value: string) {
  try {
    window.localStorage.setItem(FEE_STORAGE_KEY, value);
  } catch {
    // A reader who blocks storage simply starts from 0 next time.
  }
}

/** An empty box means no fee; anything else has to be a real, non-negative one. */
function normalizeFeeInput(value: string) {
  return value.trim() === '' ? '0' : value.trim();
}

export function OptionPortfolioSheet({ quote, onClose }: {
  quote: OptionPurchaseQuoteSnapshot | null;
  onClose(): void;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const { requestUpgrade } = useEntitlement();
  const [pending, startTransition] = useTransition();
  const [effectiveQuote, setEffectiveQuote] = useState<OptionPurchaseQuoteSnapshot | null>(quote);
  const [portfolios, setPortfolios] = useState<OptionPurchasePortfolioChoice[]>([]);
  const [portfolioId, setPortfolioId] = useState('');
  const [contracts, setContracts] = useState('1');
  const [purchasePrice, setPurchasePrice] = useState(quote?.ask === null || quote?.ask === undefined ? '' : String(quote.ask));
  /*
   * Read once, as the initial value, rather than assigned from an effect: the
   * sheet's fields are only ever put in the document after a click, so the
   * server's 0 and the browser's remembered fee never both reach the DOM.
   */
  const [fee, setFee] = useState(() => readStoredFee() ?? '0');
  const [feeMode, setFeeMode] = useState<OptionFeeMode>('total');
  const [timezone, setTimezone] = useState('Asia/Bangkok');
  const [occurredAt, setOccurredAt] = useState(() => currentDateTimeLocal('Asia/Bangkok'));
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [loadingPortfolios, setLoadingPortfolios] = useState(Boolean(quote));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!quote) return;
    let active = true;
    void loadOptionPurchasePortfoliosAction().then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.code === 'upgrade-required') {
          onClose();
          requestUpgrade({ capability: 'portfolio.options.create', source: 'analysis.options-chain-add' });
          return;
        }
        setError(result.message);
        return;
      }
      setPortfolios(result.portfolios);
      setPortfolioId((current) => result.portfolios.some((item) => item.id === current)
        ? current
        : result.portfolios[0]?.id ?? '');
      setTimezone(result.timezone);
      setOccurredAt(currentDateTimeLocal(result.timezone));
    }).catch(() => {
      if (active) setError('โหลดพอร์ตออปชันไม่สำเร็จ');
    }).finally(() => {
      if (active) setLoadingPortfolios(false);
    });
    return () => { active = false; };
  }, [onClose, quote, requestUpgrade]);

  const selected = portfolios.find((item) => item.id === portfolioId) ?? null;
  const normalizedFee = normalizeFeeInput(fee);
  /*
   * The fee is judged on its own — as one non-negative decimal, with no contract
   * count involved — rather than through the preview's single null. An empty or
   * fractional contract count is not a fee problem, and must not put a red line
   * under the fee box.
   */
  const feeValid = resolveOptionFeeTotal(normalizedFee, 'total', 1) !== null;
  const feeError = feeValid ? '' : 'ค่าธรรมเนียมต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป (ทศนิยมไม่เกิน 8 ตำแหน่ง)';
  const preview = useMemo(() => calculateOptionPurchasePreview(
    Number(contracts), purchasePrice, selected?.cashBalance ?? 0, normalizedFee, feeMode,
  ), [contracts, feeMode, normalizedFee, purchasePrice, selected?.cashBalance]);
  const quoteState = effectiveQuote ? validateOptionPurchaseQuote(effectiveQuote) : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !effectiveQuote || !portfolioId || !preview || !feeValid) return;
    setError('');
    startTransition(async () => {
      const result = await purchaseOptionFromChainAction({
        portfolioId,
        underlyingSymbol: effectiveQuote.underlyingSymbol,
        expiration: effectiveQuote.expiration,
        contractSymbol: effectiveQuote.contractSymbol,
        contracts: Number(contracts),
        purchasePrice,
        // As typed, with the mode beside it — the server resolves the total
        // itself rather than trusting a product computed in the browser.
        fee: normalizedFee,
        feeMode,
        occurredAt,
        timezone,
        quoteFingerprint: optionPurchaseQuoteFingerprint(effectiveQuote),
        idempotencyKey,
      });
      if (!result.ok) {
        if (result.code === 'upgrade-required') {
          onClose();
          requestUpgrade({ capability: 'portfolio.options.create', source: 'analysis.options-chain-add-confirm' });
          return;
        }
        if ('quote' in result && result.quote) {
          setEffectiveQuote(result.quote);
          setPurchasePrice(result.quote.ask === null ? '' : String(result.quote.ask));
        }
        setError(result.message);
        return;
      }
      writeStoredFee(normalizedFee);
      addToast({
        title: 'เพิ่มออปชันเข้าพอร์ตแล้ว',
        message: `ใช้เงิน ${money(result.cost)} (ค่าธรรมเนียม ${money(result.fee)}) · เงินสดคงเหลือ ${money(result.cashAfter)}`,
        type: 'success',
      });
      onClose();
      router.refresh();
    });
  }

  return <ResponsiveDialog
    isOpen={quote !== null}
    onClose={() => !pending && onClose()}
    title={effectiveQuote ? `เพิ่ม ${effectiveQuote.optionKind === 'call' ? 'Call' : 'Put'} เข้าพอร์ต` : 'เพิ่มออปชันเข้าพอร์ต'}
  >
    {!effectiveQuote ? null : <form className="min-w-0 space-y-4" onSubmit={submit} data-testid="option-portfolio-sheet">
      <section className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[#D4FF00]">{effectiveQuote.underlyingSymbol} · {effectiveQuote.optionKind.toUpperCase()}</p>
            <p className="truncate font-mono text-xs text-slate-400" title={effectiveQuote.contractSymbol}>{effectiveQuote.contractSymbol}</p>
          </div>
          <p className="font-mono font-bold text-white">Strike {money(effectiveQuote.strike)}</p>
        </div>
        <dl className="mt-3 grid min-w-0 grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <QuoteMetric label="หมดอายุ" value={effectiveQuote.expiration} />
          <QuoteMetric label="Multiplier" value={String(effectiveQuote.multiplier)} />
          <QuoteMetric label="Bid / Ask" value={`${money(effectiveQuote.bid)} / ${money(effectiveQuote.ask)}`} />
          <QuoteMetric label="Mid / Last" value={`${money(effectiveQuote.mid)} / ${money(effectiveQuote.last)}`} />
          <QuoteMetric label="Spot" value={money(effectiveQuote.spot)} />
          <QuoteMetric label="IV" value={number(effectiveQuote.impliedVolatility)} />
          <QuoteMetric label="Delta / Gamma" value={`${number(effectiveQuote.delta)} / ${number(effectiveQuote.gamma)}`} />
          <QuoteMetric label="Theta / Vega / Rho" value={`${number(effectiveQuote.theta)} / ${number(effectiveQuote.vega)} / ${number(effectiveQuote.rho)}`} />
        </dl>
        <p className="mt-3 break-words text-[10px] text-slate-500">ราคา ณ {new Date(effectiveQuote.quoteTimestamp).toLocaleString('th-TH', { timeZone: timezone })} · {effectiveQuote.marketDataProvider ?? effectiveQuote.provider}</p>
      </section>

      {loadingPortfolios ? <p className="text-sm text-slate-400">กำลังโหลดพอร์ต…</p> : portfolios.length === 0 ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          <p className="font-semibold">ยังไม่มีพอร์ตออปชันที่ใช้งานอยู่</p>
          <Link href="/portfolio" className="mt-2 inline-flex min-h-11 items-center underline underline-offset-2">ไปสร้างพอร์ตออปชัน</Link>
        </div>
      ) : <>
        <label className="block text-sm text-slate-300">พอร์ต
          <select className="form-input mt-1" value={portfolioId} onChange={(event) => setPortfolioId(event.target.value)}>
            {portfolios.map((portfolio) => <option key={portfolio.id} value={portfolio.id}>{portfolio.name} · เงินสด {money(portfolio.cashBalance)}</option>)}
          </select>
        </label>
        {/*
          * Two fields to a row from 480px up, one below it. The datetime control
          * is sized by its column rather than by a width of its own, which is
          * what stops a `datetime-local` input from running the full width of
          * the sheet with nothing beside it.
          */}
        <div className="grid min-w-0 grid-cols-1 gap-4 min-[480px]:grid-cols-2">
          <label className="block text-sm text-slate-300">จำนวนสัญญา
            <input className="form-input mt-1" inputMode="numeric" min={1} max={1_000_000} step={1} type="number" value={contracts} onChange={(event) => setContracts(event.target.value)} />
          </label>
          <label className="block text-sm text-slate-300">ราคาซื้อต่อหุ้น (USD)
            <input className="form-input mt-1" inputMode="decimal" min="0.00000001" step="0.00000001" type="number" value={purchasePrice} onChange={(event) => setPurchasePrice(event.target.value)} />
            <span className="mt-1 block text-xs text-slate-500">ค่าเริ่มต้นคือ Ask ล่าสุด</span>
          </label>
        </div>
        <div className="grid min-w-0 grid-cols-1 gap-4 min-[480px]:grid-cols-2">
          <label className="block text-sm text-slate-300">วันที่และเวลา
            <input className="form-input mt-1" type="datetime-local" max={maximumTransactionDateTimeLocal(timezone)} value={occurredAt.slice(0, 16)} onChange={(event) => setOccurredAt(event.target.value)} />
          </label>
          <div className="min-w-0 text-sm text-slate-300">
            <label className="block">ค่าธรรมเนียม (USD)
              <input
                className="form-input mt-1"
                inputMode="decimal"
                min="0"
                step="0.01"
                type="number"
                value={fee}
                aria-invalid={feeError ? true : undefined}
                aria-describedby="option-fee-help"
                data-testid="option-fee-input"
                onChange={(event) => setFee(event.target.value)}
              />
            </label>
            <div className="mt-2 inline-flex rounded-lg border border-slate-700 p-1" role="group" aria-label="รูปแบบค่าธรรมเนียม">
              {([['total', 'รวมทั้งออเดอร์'], ['per_contract', 'ต่อสัญญา']] as const).map(([mode, label]) =>
                <button
                  key={mode}
                  type="button"
                  aria-pressed={feeMode === mode}
                  onClick={() => setFeeMode(mode)}
                  className={`min-h-10 rounded-md px-3 text-xs font-semibold ${feeMode === mode ? 'bg-[#D4FF00] text-slate-950' : 'text-slate-300'}`}
                >{label}</button>)}
            </div>
            <span id="option-fee-help" className="mt-1 block text-xs text-slate-500">ค่าคอมมิชชัน + ค่าธรรมเนียมทั้งหมดของออเดอร์นี้</span>
            {feeMode === 'per_contract' && preview && <span className="mt-1 block text-xs text-slate-400" data-testid="option-fee-total">รวมทั้งออเดอร์ {money(preview.feeTotal)}</span>}
            {feeError && <p role="alert" className="mt-1 text-xs text-red-300">{feeError}</p>}
          </div>
        </div>

        <dl className="grid min-w-0 grid-cols-2 gap-3 rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-xs" data-testid="option-purchase-summary">
          <QuoteMetric label="เงินที่ใช้" value={preview ? money(preview.cost) : '—'} />
          <QuoteMetric label="ค่าธรรมเนียม" value={preview ? money(preview.feeTotal) : '—'} />
          <QuoteMetric label="ต้นทุนสถานะ" value={preview ? money(preview.cost) : '—'} />
          <QuoteMetric label="Max loss (Long)" value={preview ? money(preview.maxLoss) : '—'} />
          <QuoteMetric
            label="จุดคุ้มทุน"
            value={preview ? money(optionPurchaseBreakeven(effectiveQuote.optionKind, effectiveQuote.strike, preview.breakevenOffset)) : '—'}
          />
          <QuoteMetric label="เงินสดหลังซื้อ" value={preview ? money(preview.cashAfter) : '—'} tone={preview && preview.cashAfter < 0 ? 'text-red-300' : 'text-white'} />
        </dl>
      </>}

      {quoteState && !quoteState.ok && <p role="alert" className="text-sm text-amber-300">{quoteState.message}</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <div className="sticky bottom-0 flex gap-2 bg-[#0F1420] pb-[max(.25rem,env(safe-area-inset-bottom))] pt-2">
        <Button type="button" variant="outline" className="flex-1" disabled={pending} onClick={onClose}>ยกเลิก</Button>
        <Button type="submit" className="flex-1" disabled={pending || loadingPortfolios || portfolios.length === 0 || !preview || !feeValid || preview.cashAfter < 0 || (quoteState !== null && !quoteState.ok)}>
          {pending ? 'กำลังบันทึก…' : 'ยืนยันเพิ่มเข้าพอร์ต'}
        </Button>
      </div>
    </form>}
  </ResponsiveDialog>;
}

function QuoteMetric({ label, value, tone = 'text-white' }: { label: string; value: string; tone?: string }) {
  return <div className="min-w-0"><dt className="text-slate-500">{label}</dt><dd className={`mt-1 break-words font-mono font-semibold ${tone}`}>{value}</dd></div>;
}
