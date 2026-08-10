'use client';

import { useCallback, useEffect, useMemo, useState, useTransition, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, ArrowDownCircle, ArrowLeft, ArrowUpCircle, CandlestickChart, Eraser, Eye, EyeOff,
  History, Layers, LoaderCircle, Lock, MoreHorizontal, PencilLine, Plus, RefreshCw, Repeat2, Target,
  Trash2,
} from 'lucide-react';
import {
  createPortfolioTransactionAction,
  setPortfolioBaseCurrencyAction,
} from '@/app/portfolio/actions';
import { reconcilePortfolioValueAction } from '@/app/portfolio/reconcile-actions';
import { Button } from '@/src/components/ui/Button';
import { rememberInstrumentLogo } from '@/src/components/instruments/InstrumentLogoProvider';
import { ResponsiveDialog } from '@/src/components/ui/ResponsiveDialog';
import { useToast } from '@/src/components/ui/Toast';
import { calculatePortfolio } from '@/src/lib/portfolio/calculations';
import { aggregatePortfolioSummaries, calculateGoalProgress } from '@/src/lib/portfolio/aggregate';
import { addAssetDestinationId, portfolioAcceptsAsset } from '@/src/lib/portfolio/add-asset';
import { buildAssetCategories, type AssetCategoryKey } from '@/src/lib/portfolio/asset-categories';
import { latestPortfolioPriceTime, portfolioAssetCount } from '@/src/lib/portfolio/goal-card';
import { sortAssets, type HoldingSortKey } from '@/src/lib/portfolio/holdings-sort';
import type { OptionQuoteInput, OptionTarget } from '@/src/lib/portfolio/options/types';
import type {
  DeletedPortfolioSummary,
  MarketPriceInput,
  PortfolioGoal,
  PortfolioRecord,
  PortfolioSummary,
  PortfolioTransactionType,
} from '@/src/lib/portfolio/types';
import type { FxResult } from '@/src/lib/market-data/fx/service';
import type { SupportedCurrency } from '@/src/lib/market-data/fx/types';
import { fetchFxRate, formatFxRate } from '@/src/lib/market-data/fx/client';
import {
  formatPortfolioMoney,
  signedMoney,
  signedPercent,
} from '@/src/lib/portfolio/presentation';
import {
  currentDateTimeLocal,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { OptionsSection } from './OptionsSection';
import { PortfolioManager, type PortfolioManagerRequest } from './PortfolioManager';
import { PortfolioValueSheet, type PortfolioValueSubmission } from './PortfolioValueSheet';
import { TransactionFormModal, type TransactionFormState } from './TransactionFormModal';
import { AssetCategoryCard } from './tracker/AssetCategoryCard';
import { FilterChips } from './tracker/FilterChips';
import { HoldingCard } from './tracker/HoldingCard';
import { OptionPositionCard } from './tracker/OptionPositionCard';
import { PortfolioSummaryCard } from './tracker/PortfolioSummaryCard';
import {
  AccountingDetails,
  EmptyAssets,
  NavRow,
  SectionHeading,
  SortControl,
} from './tracker/SecondaryPanels';
import { TrackerHero, type HeroAllocationSlice } from './tracker/TrackerHero';
import { ViewToggle, type TrackerView } from './tracker/ViewToggle';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { usePortfolioPrivacy } from '@/src/hooks/usePortfolioPrivacy';
import { SENSITIVE_VALUE_MASK } from '@/src/lib/privacy';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { READ_ONLY_PORTFOLIO_MESSAGE } from '@/src/lib/subscription/entitlement-errors';
import {
  basicWritableStockPortfolioId,
  portfolioWriteBlock,
} from '@/src/lib/subscription/portfolio-write-access';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';

const emptyForm = (portfolioId = '', timezone = 'Asia/Bangkok'): TransactionFormState => ({
  portfolioId,
  type: 'acquisition',
  symbol: '',
  quantity: '',
  price: '',
  amount: '',
  fee: '0',
  originalCurrency: 'USD',
  fxRateAtTransaction: '',
  occurredAt: currentDateTimeLocal(timezone),
  timezone,
  broker: '',
  note: '',
  underlyingSymbol: '',
  contractSymbol: '',
  optionKind: 'call',
  optionSide: 'long',
  strikePrice: '',
  expirationDate: '',
  multiplier: '100',
  idempotencyKey: crypto.randomUUID(),
});

function transactionDate(value: string, timezone: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone })
    .format(parsed);
}

/** One colour per asset class, all theme tokens, none of them a market direction. */
const allocationColor: Record<AssetCategoryKey, string> = {
  cash: 'var(--text-muted)',
  stock: 'var(--accent)',
  etf: 'var(--info)',
  option: 'var(--color-accent-purple)',
};

/**
 * Which screen is on the phone.
 *
 * Deliberately component state rather than a route. Every figure on all three
 * screens comes from the same `summaries` map this component already holds, so a
 * navigation would re-run the page's whole server load — every quote, every
 * option chain — to show numbers that are already in memory. Back is an explicit
 * control on each drill-down instead.
 */
type Screen =
  | { kind: 'home' }
  | { kind: 'category'; key: AssetCategoryKey }
  | { kind: 'portfolio'; id: string };

export function PortfolioClient({
  portfolios,
  aggregateGoal,
  marketPrices,
  optionQuotes,
  optionTargets,
  recentlyDeleted,
  fx,
  timezone,
  effectiveTier,
  assetTypes = {},
  companyNames = {},
}: {
  portfolios: PortfolioRecord[];
  aggregateGoal: PortfolioGoal;
  marketPrices: Record<string, MarketPriceInput | null>;
  optionQuotes: Record<string, OptionQuoteInput | null>;
  optionTargets: OptionTarget[];
  recentlyDeleted: DeletedPortfolioSummary[];
  fx: FxResult;
  timezone: string;
  effectiveTier: SubscriptionTier;
  /**
   * `asset_type` and display name straight off the instrument master, for the
   * symbols this page already priced. They classify a holding into หุ้น or ETF
   * and let a row show a company name; nothing here is a price or a valuation.
   */
  assetTypes?: Record<string, string | null>;
  companyNames?: Record<string, string | null>;
}) {
  const router = useRouter();
  const { addToast } = useToast();
  const { requestUpgrade } = useEntitlement();
  const [pending, startTransition] = useTransition();
  const { visible: showBalances, toggleVisibility } = usePortfolioPrivacy();
  const isOnline = useOnlineStatus();
  const [formOpen, setFormOpen] = useState(false);
  const [selectedPortfolioId, setSelectedPortfolioId] = useState(portfolios.find((item) => item.archivedAt === null)?.id ?? portfolios[0]?.id ?? '');
  const portfolio = (portfolios.find((item) => item.id === selectedPortfolioId) ?? portfolios[0])!;
  const [currency, setCurrency] = useState<SupportedCurrency>(portfolio?.baseCurrency ?? 'USD');
  const [currentFx, setCurrentFx] = useState(fx);
  const [fxLoading, setFxLoading] = useState(true);
  const [fxError, setFxError] = useState(fx.quote === null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [valueSheetOpen, setValueSheetOpen] = useState(false);
  const [valueSheetError, setValueSheetError] = useState('');
  /*
   * Minted when the sheet opens, and used both as the sheet's `key` — so every
   * opening starts from a clean form — and as the ledger idempotency key, so a
   * double submit lands on the same row instead of two.
   */
  const [valueSheetKey, setValueSheetKey] = useState('');
  const [form, setForm] = useState<TransactionFormState>(() => emptyForm(portfolio?.id, timezone));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [addAssetSheetOpen, setAddAssetSheetOpen] = useState(false);
  const [optionActionRequest, setOptionActionRequest] = useState<{ id: number; type: 'buy' | 'sell' } | null>(null);
  const [managerRequest, setManagerRequest] = useState<PortfolioManagerRequest | null>(null);
  const [view, setView] = useState<TrackerView>('assets');
  const [assetFilter, setAssetFilter] = useState<'all' | AssetCategoryKey>('all');
  const [portfolioFilter, setPortfolioFilter] = useState<'all' | 'STOCK' | 'OPTION'>('all');
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [sortKey, setSortKey] = useState<HoldingSortKey>('value');
  const [accountingOpen, setAccountingOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const prices = useMemo(
    () => Object.fromEntries(Object.entries(marketPrices).filter((entry): entry is [string, MarketPriceInput] => entry[1] != null)),
    [marketPrices],
  );
  const summaries = useMemo(
    () => Object.fromEntries(portfolios.map((item) => [
      item.id,
      calculatePortfolio(item.transactions, prices, optionQuotes),
    ])),
    [optionQuotes, portfolios, prices],
  );
  const summary = summaries[portfolio.id];
  /*
   * `portfolios` arrives ordered by (created_at, id) from the repository, which
   * is the same order the database resolves its writable choice in — so the
   * list must be read as given, not re-sorted.
   */
  const writableStockId = useMemo(() => basicWritableStockPortfolioId(portfolios), [portfolios]);
  const writeBlock = portfolioWriteBlock(effectiveTier, portfolio, writableStockId);
  const aggregateSummary = useMemo(
    () => aggregatePortfolioSummaries(portfolios.map((item) => summaries[item.id])),
    [portfolios, summaries],
  );
  const activePortfolios = useMemo(() => portfolios.filter((item) => item.archivedAt === null), [portfolios]);

  /*
   * The asset view, grouped from the very same summaries the portfolio view
   * reads. Two ways of looking at one calculation — never two calculations.
   */
  const categories = useMemo(() => buildAssetCategories({
    cash: portfolios.map((item) => ({
      portfolioId: item.id,
      portfolioName: item.name,
      balance: summaries[item.id].cashBalance,
    })),
    holdings: portfolios.flatMap((item) => summaries[item.id].holdings.map((holding) => ({
      portfolioId: item.id,
      portfolioName: item.name,
      holding,
    }))),
    options: portfolios.flatMap((item) => summaries[item.id].optionPositions.map((position) => ({
      portfolioId: item.id,
      portfolioName: item.name,
      position,
    }))),
    assetTypeBySymbol: assetTypes,
  }), [assetTypes, portfolios, summaries]);

  const allocation = useMemo<HeroAllocationSlice[]>(() => {
    const priced = categories.filter((group) => group.value !== null && group.value > 0);
    const total = priced.reduce((sum, group) => sum + (group.value ?? 0), 0);
    if (total <= 0) return [];
    return priced.map((group) => ({
      key: group.key,
      label: group.label,
      percent: (group.value ?? 0) / total * 100,
      color: allocationColor[group.key],
    }));
  }, [categories]);

  async function loadFx() {
    setFxLoading(true);
    setFxError(false);
    try {
      const parsed = await fetchFxRate(fetch, 1);
      setCurrentFx({ quote: parsed.quote, unavailable: parsed.unavailable });
    } catch {
      setFxError(true);
    } finally {
      setFxLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetchFxRate(fetch, 1)
      .then((parsed) => {
        if (active) {
          setCurrentFx({ quote: parsed.quote, unavailable: parsed.unavailable });
          setFxError(false);
        }
      })
      .catch(() => { if (active) setFxError(true); })
      .finally(() => { if (active) setFxLoading(false); });
    return () => { active = false; };
  }, []);

  /*
   * `portfolioId` defaults to the portfolio on screen, which is what every
   * contextual action wants. The one add-asset entry point overrides it, because
   * the kind being added — not the portfolio being read — decides where the row
   * can legally land.
   */
  function openCreate(
    type: PortfolioTransactionType = 'acquisition',
    symbol = '',
    quantity = '',
    portfolioId = portfolio.id,
  ) {
    setErrors({});
    setForm({ ...emptyForm(portfolioId, timezone), type, symbol, quantity });
    setFormOpen(true);
  }

  function openValueSheet() {
    setValueSheetKey(crypto.randomUUID());
    setValueSheetError('');
    setValueSheetOpen(true);
  }

  function requestPortfolioWrite() {
    if (portfolio.archivedAt || !isOnline) return false;
    if (writeBlock) {
      requestUpgrade({
        capability: portfolio.type === 'OPTION' ? 'portfolio.options.create' : 'portfolio.multiple.create',
        source: 'portfolio.add-transaction',
      });
      return false;
    }
    return true;
  }

  const handleOptionActionRequest = useCallback(() => setOptionActionRequest(null), []);

  function closeForm() {
    setFormOpen(false);
    setErrors({});
    setForm(emptyForm(portfolio.id, timezone));
  }

  function change(name: keyof TransactionFormState, value: string) {
    setForm((current) => ({ ...current, [name]: value }));
    setErrors((current) => ({ ...current, [name]: '' }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (!isOnline) {
      addToast({ title: 'บันทึกไม่ได้ขณะออฟไลน์', message: 'เชื่อมต่ออินเทอร์เน็ตก่อนเพื่อป้องกันข้อมูลขัดแย้ง', type: 'error' });
      return;
    }
    const dateTime = validateTransactionDateTime(form.occurredAt, form.timezone);
    if (!dateTime.ok) {
      setErrors((current) => ({ ...current, occurredAt: dateTime.message }));
      return;
    }
    startTransition(async () => {
      const result = await createPortfolioTransactionAction(form);
      if (!result.ok) {
        setErrors(result.fields ?? {});
        addToast({ title: 'บันทึกไม่สำเร็จ', message: result.message, type: 'error' });
        return;
      }
      closeForm();
      /*
       * The logo the action resolved for a newly opened position, applied before
       * the refresh so the holding draws it on the very first frame it appears
       * in rather than after the server round trip.
       */
      rememberInstrumentLogo(result.symbol ?? '', result.logoUrl);
      addToast({ title: 'เพิ่มรายการแล้ว', message: 'พอร์ตจะคำนวณใหม่จาก Ledger ทั้งหมด', type: 'success' });
      router.refresh();
    });
  }

  /*
   * The wanted total goes to the server as typed; the server recomputes the
   * portfolio from the ledger, decides the delta itself and writes one deposit
   * or one withdrawal. Nothing here is trusted as the source of the change.
   */
  function submitPortfolioValue(submission: PortfolioValueSubmission) {
    if (pending || !isOnline) return;
    setValueSheetError('');
    startTransition(async () => {
      const result = await reconcilePortfolioValueAction(submission);
      if (!result.ok) {
        setValueSheetError(result.message);
        return;
      }
      setValueSheetOpen(false);
      addToast({
        title: result.plan.type === 'deposit' ? 'ปรับยอดขึ้นแล้ว' : 'ปรับยอดลงแล้ว',
        message: 'บันทึกเป็นเงินเข้า–ออกใน Ledger จำนวนสินทรัพย์และกำไร/ขาดทุนไม่เปลี่ยน',
        type: 'success',
      });
      router.refresh();
    });
  }

  const hidden = (value: string) => showBalances ? value : SENSITIVE_VALUE_MASK;
  const rate = currentFx.quote?.rate ?? null;
  const hasValidRate = rate !== null;
  const money = (value: number | string | null) => value === null ? '—' : formatPortfolioMoney(value, currency, rate, showBalances);
  const signed = (value: number | null) => value === null ? '—' : signedMoney(value, currency, rate, showBalances);
  const percent = (value: number | null) => value === null ? '—' : signedPercent(value, showBalances);

  function selectCurrency(next: SupportedCurrency) {
    if (next === currency || pending || !isOnline || (next === 'THB' && !hasValidRate)) return;
    setCurrency(next);
    startTransition(async () => {
      const result = await setPortfolioBaseCurrencyAction(next);
      if (!result.ok) {
        setCurrency(currency);
        addToast({ title: 'บันทึกสกุลเงินไม่สำเร็จ', message: result.message, type: 'error' });
      }
    });
  }

  function openPortfolio(portfolioId: string) {
    setSelectedPortfolioId(portfolioId);
    setExpandedKey(null);
    closeForm();
    setScreen({ kind: 'portfolio', id: portfolioId });
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }

  function goHome() {
    setScreen({ kind: 'home' });
    setExpandedKey(null);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }

  function requestManager(kind: PortfolioManagerRequest['kind'], portfolioId?: string) {
    setOverflowOpen(false);
    setManagerRequest({ id: Date.now(), kind, portfolioId });
  }

  /*
   * One entry point, two kinds, and a destination chosen per kind.
   *
   * A reader standing in a stock portfolio can still add an option, and one
   * standing in an option portfolio can still add a share — what is already held
   * never decides what may be added. When nothing in the account can accept the
   * kind at all, the answer is to create a portfolio for it, which is the same
   * flow the manage panel already owns.
   */
  const stockDestinationId = addAssetDestinationId(portfolios, 'stock', portfolio.id);
  const optionDestinationId = addAssetDestinationId(portfolios, 'option', portfolio.id);

  function chooseStockAsset() {
    setAddAssetSheetOpen(false);
    if (!stockDestinationId) { requestManager('create'); return; }
    openCreate('acquisition', '', '', stockDestinationId);
  }

  function chooseOptionAsset() {
    setAddAssetSheetOpen(false);
    if (!optionDestinationId) { requestManager('create'); return; }
    setOptionActionRequest({ id: Date.now(), type: 'buy' });
  }

  const privacyButton = <button
    type="button"
    onClick={toggleVisibility}
    aria-label={showBalances ? 'ซ่อนยอดเงินทั้งหมด' : 'แสดงยอดเงินชั่วคราว'}
    aria-pressed={!showBalances}
    className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
  >{showBalances ? <EyeOff size={19} /> : <Eye size={19} />}</button>;

  const fxFooter = <div className="flex flex-col gap-2 border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--text-muted)] sm:flex-row sm:items-center sm:justify-between sm:px-6">
    <div className="min-w-0">
      {fxLoading && <p className="flex items-center gap-2"><LoaderCircle className="animate-spin" size={14} /> กำลังโหลดอัตราแลกเปลี่ยน…</p>}
      {hasValidRate && <p className="break-words">🇺🇸 1 USD = {formatFxRate(rate)} THB · อัปเดต {transactionDate(currentFx.quote!.asOf, timezone)}</p>}
      {!fxLoading && !hasValidRate && <p className="text-[var(--warning)]">ไม่มีอัตราแลกเปลี่ยนจริง จึงปิดการแสดงผล THB</p>}
      {currentFx.quote?.stale && <p className="mt-1 text-[var(--warning)]">กำลังใช้อัตราแลกเปลี่ยนล่าสุดที่บันทึกไว้ (Stale)</p>}
      {fxError && hasValidRate && <p className="mt-1 text-[var(--warning)]">โหลดอัตราใหม่ไม่สำเร็จ แต่ยังใช้อัตราที่มีอยู่ได้</p>}
    </div>
    <button
      type="button"
      onClick={() => void loadFx()}
      disabled={fxLoading}
      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start rounded-lg border border-[var(--border)] px-3 text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:opacity-50"
    >
      <RefreshCw className={fxLoading ? 'animate-spin' : ''} size={14} /> อัตราแลกเปลี่ยน
    </button>
  </div>;

  const categoryChips = [
    { key: 'all', label: 'ทั้งหมด' },
    ...categories.map((group) => ({ key: group.key, label: group.label, count: group.count })),
  ];
  const visibleCategories = assetFilter === 'all'
    ? categories
    : categories.filter((group) => group.key === assetFilter);

  const portfolioChips = [
    { key: 'all', label: 'ทั้งหมด', count: activePortfolios.length },
    { key: 'STOCK', label: 'พอร์ตหุ้น', count: activePortfolios.filter((item) => item.type !== 'OPTION').length },
    { key: 'OPTION', label: 'พอร์ตออปชัน', count: activePortfolios.filter((item) => item.type === 'OPTION').length },
  ].filter((chip) => chip.key === 'all' || chip.count > 0);
  const visiblePortfolios = portfolios.filter((item) => {
    if (portfolioFilter === 'all') return true;
    if (portfolioFilter === 'OPTION') return item.type === 'OPTION';
    return item.type !== 'OPTION';
  });

  const missingPriceNote = aggregateSummary.hasMissingPrices
    ? <p className="mt-3 text-xs text-[var(--warning)]">มูลค่ารวมแสดง “—” เพราะมีสินทรัพย์ที่ยังไม่มีราคาจริง ระบบไม่แทนราคาด้วย 0</p>
    : null;

  function heroFor(
    target: PortfolioSummary,
    label: string,
    updatedAt: string | null,
    slices: HeroAllocationSlice[],
    onEdit?: () => void,
  ) {
    return <TrackerHero
      testId="portfolio-hero"
      label={label}
      value={money(target.totalValue)}
      updatedAtLabel={updatedAt ? transactionDate(updatedAt, timezone) : null}
      todayChange={target.todayChange}
      todayChangeText={`${signed(target.todayChange)} · ${percent(target.todayChangePercent)}`}
      totalGain={target.totalGain}
      totalGainText={`${signed(target.totalGain)} · ${percent(target.totalGainPercent)}`}
      currency={currency}
      onCurrencyChange={selectCurrency}
      currencyDisabled={pending}
      thbDisabled={!hasValidRate}
      showBalances={showBalances}
      onEditValue={onEdit}
      editDisabled={!isOnline || Boolean(portfolio.archivedAt)}
      allocation={slices}
      notes={<>
        {missingPriceNote}
        {target.todayChange === null && <p className="mt-2 text-xs text-[var(--text-muted)]" data-testid="portfolio-today-unavailable">
          ยังคำนวณกำไร/ขาดทุนวันนี้ไม่ได้ เพราะไม่มีราคาปิดวันก่อน
        </p>}
      </>}
      footer={fxFooter}
    />;
  }

  /*
   * A portfolio can disappear underneath this screen — deleted from the
   * overflow menu, or reset and re-read after `router.refresh()`. Standing on a
   * detail screen for a portfolio the server no longer returns would put the
   * fallback portfolio's numbers under the deleted one's heading, so the screen
   * resolves back to the home view. Derived during render rather than corrected
   * in an effect: there is no frame in which the wrong portfolio is painted.
   */
  const activeScreen: Screen = screen.kind === 'portfolio' && !portfolios.some((item) => item.id === screen.id)
    ? { kind: 'home' }
    : screen;
  const detailPortfolio = activeScreen.kind === 'portfolio'
    ? portfolios.find((item) => item.id === activeScreen.id) ?? portfolio
    : portfolio;
  const detailSummary = summaries[detailPortfolio.id];
  const detailWriteBlock = portfolioWriteBlock(effectiveTier, detailPortfolio, writableStockId);
  const detailCanWrite = !detailWriteBlock && isOnline && !detailPortfolio.archivedAt;
  const detailIsEmpty = portfolioAssetCount(detailSummary) === 0 && detailSummary.optionPositions.length === 0;

  /*
   * The page's only call to action.
   *
   * It is written once and placed in whichever header is on screen, so there is
   * never a second way to add — not in a section heading, not inside an empty
   * state. Everything it can open is a flow that already existed.
   */
  const addAssetCta = <Button
    size="sm"
    disabled={!isOnline || Boolean(portfolio.archivedAt)}
    onClick={() => { if (requestPortfolioWrite()) setAddAssetSheetOpen(true); }}
    data-testid="portfolio-add-asset"
  ><Plus size={16} /> เพิ่มสินทรัพย์</Button>;

  /*
   * The option flow, mounted exactly once.
   *
   * Its dialogs are the only option entry this product has, and the add-asset
   * sheet must reach them from screens that show no option positions at all — so
   * the section is hidden rather than absent there, the way the manage panel
   * already works. The two placements below are mutually exclusive, so only one
   * instance is ever mounted and no second ledger or persistence path exists.
   */
  const optionsShownInline = activeScreen.kind === 'portfolio'
    && portfolioAcceptsAsset(detailPortfolio.type, 'option')
    && !detailIsEmpty;
  const optionsHost = optionsShownInline
    ? detailPortfolio
    : portfolios.find((item) => item.id === optionDestinationId) ?? null;
  const optionsSection = optionsHost && <OptionsSection
    portfolio={optionsHost}
    portfolios={portfolios.filter((item) => item.archivedAt === null && (item.type === 'OPTION' || item.type === 'LEGACY'))}
    positions={summaries[optionsHost.id].optionPositions}
    targets={optionTargets.filter((target) => target.portfolioId === optionsHost.id)}
    cashByPortfolioId={Object.fromEntries(portfolios.map((item) => [item.id, summaries[item.id].cashBalance]))}
    currency={currency}
    usdThbRate={rate}
    showBalances={showBalances}
    isOnline={isOnline}
    timezone={timezone}
    readOnly={Boolean(portfolioWriteBlock(effectiveTier, optionsHost, writableStockId))}
    sectionHidden={!optionsShownInline}
    actionRequest={optionActionRequest}
    onActionRequestHandled={handleOptionActionRequest}
  />;

  return <main className="mx-auto w-full max-w-5xl space-y-4 overflow-x-clip p-3 sm:p-4 md:p-6">
    {!isOnline && <aside className="rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] p-3 text-sm text-[var(--warning)]">
      โหมดอ่านอย่างเดียวขณะออฟไลน์ — ปิดการเพิ่ม แก้ไข และลบเพื่อป้องกันข้อมูลขัดแย้ง
    </aside>}

    {activeScreen.kind === 'home' && <>
      <header className="flex min-w-0 items-center justify-between gap-2">
        <h1 className="min-w-0 truncate text-xl font-black tracking-tight text-[var(--text)]">สินทรัพย์ของฉัน</h1>
        <div className="flex shrink-0 items-center gap-2">
          {privacyButton}
          {addAssetCta}
        </div>
      </header>

      <ViewToggle value={view} onChange={(next) => { setView(next); setAssetFilter('all'); setPortfolioFilter('all'); }} />

      {view === 'assets'
        ? <FilterChips items={categoryChips} value={assetFilter} onChange={(key) => setAssetFilter(key as 'all' | AssetCategoryKey)} label="ประเภทสินทรัพย์" />
        : <FilterChips items={portfolioChips} value={portfolioFilter} onChange={(key) => setPortfolioFilter(key as 'all' | 'STOCK' | 'OPTION')} label="ประเภทพอร์ต" />}

      {heroFor(
        aggregateSummary,
        'มูลค่าสินทรัพย์รวม',
        latestPortfolioPriceTime(aggregateSummary),
        allocation,
        () => { if (requestPortfolioWrite()) openValueSheet(); },
      )}

      {view === 'assets'
        ? <section className="min-w-0 space-y-3" data-testid="asset-category-list">
          <SectionHeading title="สินทรัพย์ตามประเภท" />
          {visibleCategories.length === 0
            ? <EmptyAssets
              title="ยังไม่มีสินทรัพย์"
              description="ใช้ปุ่ม “เพิ่มสินทรัพย์” ด้านบนเพื่อบันทึกหุ้น ETF หรือออปชันรายการแรก"
            />
            : <div className="grid min-w-0 gap-3 lg:grid-cols-2">
              {visibleCategories.map((group) => <AssetCategoryCard
                key={group.key}
                group={group}
                showBalances={showBalances}
                valueText={money(group.value)}
                todayText={group.todayChange === null ? '— วันนี้' : `${signed(group.todayChange)} วันนี้`}
                gainText={group.unrealizedGain === null ? null : signed(group.unrealizedGain)}
                onOpen={() => { setScreen({ kind: 'category', key: group.key }); setExpandedKey(null); }}
              />)}
            </div>}
        </section>
        : <section className="min-w-0 space-y-3" data-testid="portfolio-card-list">
          <SectionHeading
            title="พอร์ตของฉัน"
            action={<Button size="sm" variant="outline" disabled={!isOnline} onClick={() => requestManager('create')}>
              <Plus size={15} /> สร้างพอร์ต
            </Button>}
          />
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            {visiblePortfolios.map((item) => {
              const itemSummary = summaries[item.id];
              const goalProgress = calculateGoalProgress(itemSummary.totalValue, {
                targetValueUsd: item.targetValueUsd,
                targetDate: item.targetDate,
              });
              return <PortfolioSummaryCard
                key={item.id}
                portfolio={item}
                summary={itemSummary}
                assetCount={portfolioAssetCount(itemSummary)}
                valueText={money(itemSummary.totalValue)}
                todayText={itemSummary.todayChange === null ? '—' : `${signed(itemSummary.todayChange)} · ${percent(itemSummary.todayChangePercent)}`}
                totalGainText={`${signed(itemSummary.totalGain)} · ${percent(itemSummary.totalGainPercent)}`}
                goalPercent={goalProgress.progressPercent}
                readOnly={Boolean(portfolioWriteBlock(effectiveTier, item, writableStockId))}
                showBalances={showBalances}
                onOpen={() => openPortfolio(item.id)}
              />;
            })}
          </div>
        </section>}

      <AccountingDetails
        summary={aggregateSummary}
        open={accountingOpen}
        onToggle={() => setAccountingOpen((current) => !current)}
        money={money}
        signed={signed}
        note="ทุกตัวเลขคำนวณใหม่จาก Transaction Ledger ทั้งหมดในทุกครั้งที่เปิดหน้านี้"
      />

      {/*
        No ledger rows live on this page any more — not even a preview of the
        latest one. A portfolio page is about what is held now; what happened is
        a statement, and it has its own route.
      */}
      <NavRow
        testId="portfolio-history-entry"
        icon={<History size={19} />}
        title="ประวัติเงินเข้า–ออก"
        detail="ดูรายการซื้อ ขาย ฝาก ถอน โอน และปรับยอดทั้งหมด"
        href="/portfolio/transactions"
      />
    </>}

    {activeScreen.kind === 'category' && (() => {
      const group = categories.find((item) => item.key === activeScreen.key);
      return <>
        <DrillHeader title={group?.label ?? 'สินทรัพย์'} onBack={goHome} action={privacyButton} />
        {!group
          ? <EmptyAssets title="ไม่มีสินทรัพย์ในหมวดนี้แล้ว" description="กลับไปหน้าสินทรัพย์เพื่อดูหมวดที่มีอยู่" />
          : <>
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
              <div className="min-w-0">
                <p className="text-xs text-[var(--text-muted)]">มูลค่ารวมในหมวดนี้</p>
                <p className="mt-1 break-all font-mono text-2xl font-black text-[var(--text)]">{money(group.value)}</p>
              </div>
              <p className="text-sm text-[var(--text-muted)]">{group.count} รายการ</p>
            </div>

            {group.key === 'cash'
              ? <ul className="grid min-w-0 gap-3">
                {group.cash.map((entry) => <li key={entry.portfolioId} className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                  <span className="min-w-0 break-words text-sm font-semibold text-[var(--text)]">{entry.portfolioName}</span>
                  <span className="shrink-0 break-all font-mono text-base font-bold text-[var(--text)]">{money(entry.balance)}</span>
                </li>)}
              </ul>
              : <>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <SortControl id="category-sort" value={sortKey} onChange={setSortKey} options={['value', 'today', 'gain', 'name']} />
                </div>
                <div className="grid min-w-0 gap-3" data-testid="category-asset-list">
                  {group.key === 'option'
                    ? sortAssets(group.positions, sortKey, (entry) => ({
                      name: entry.position.contractSymbol,
                      value: entry.position.marketValue,
                      todayChange: entry.position.todayChange,
                      unrealizedGain: entry.position.unrealizedGain,
                    })).map((entry) => <OptionPositionCard
                      key={`${entry.portfolioId}-${entry.position.key}`}
                      position={entry.position}
                      portfolioLabel={entry.portfolioName}
                      expanded={expandedKey === `${entry.portfolioId}-${entry.position.key}`}
                      showBalances={showBalances}
                      timezone={timezone}
                      money={money}
                      signed={signed}
                      onToggle={() => setExpandedKey((current) => current === `${entry.portfolioId}-${entry.position.key}` ? null : `${entry.portfolioId}-${entry.position.key}`)}
                    >
                      <Button size="sm" variant="outline" onClick={() => openPortfolio(entry.portfolioId)}>เปิดพอร์ต {entry.portfolioName}</Button>
                    </OptionPositionCard>)
                    : sortAssets(group.holdings, sortKey, (entry) => ({
                      name: entry.holding.symbol,
                      value: entry.holding.marketValue,
                      todayChange: entry.holding.todayChange,
                      unrealizedGain: entry.holding.unrealizedGain,
                    })).map((entry) => <HoldingCard
                      key={`${entry.portfolioId}-${entry.holding.symbol}`}
                      holding={entry.holding}
                      companyName={companyNames[entry.holding.symbol]}
                      portfolioLabel={entry.portfolioName}
                      expanded={expandedKey === `${entry.portfolioId}-${entry.holding.symbol}`}
                      showBalances={showBalances}
                      timezone={timezone}
                      portfolioId={entry.portfolioId}
                      canWrite={false}
                      money={money}
                      signed={signed}
                      hidden={hidden}
                      onToggle={() => setExpandedKey((current) => current === `${entry.portfolioId}-${entry.holding.symbol}` ? null : `${entry.portfolioId}-${entry.holding.symbol}`)}
                      onBuy={() => undefined}
                      onSell={() => undefined}
                      onCloseAll={() => undefined}
                    />)}
                </div>
              </>}
          </>}
      </>;
    })()}

    {activeScreen.kind === 'portfolio' && <>
      <DrillHeader
        title={detailPortfolio.name}
        onBack={goHome}
        action={<>
          {privacyButton}
          <button
            type="button"
            onClick={() => setOverflowOpen(true)}
            aria-label={`ตัวเลือกของพอร์ต ${detailPortfolio.name}`}
            data-testid="portfolio-overflow"
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
          ><MoreHorizontal size={19} /></button>
          {addAssetCta}
        </>}
      />

      <FilterChips
        label="เลือกพอร์ต"
        value={detailPortfolio.id}
        onChange={(key) => { if (key === '__all') goHome(); else openPortfolio(key); }}
        items={[
          { key: '__all', label: '← ทั้งหมด' },
          /*
             Active portfolios, plus the one being read if it has been archived:
             an archived portfolio is still readable, and a rail with no selected
             chip on it reads as a bug.
          */
          ...portfolios
            .filter((item) => item.archivedAt === null || item.id === detailPortfolio.id)
            .map((item) => ({ key: item.id, label: item.name })),
        ]}
      />

      {heroFor(
        detailSummary,
        'มูลค่าพอร์ต',
        latestPortfolioPriceTime(detailSummary),
        [],
        () => { if (requestPortfolioWrite()) openValueSheet(); },
      )}

      {detailPortfolio.targetValueUsd !== null && (() => {
        const progress = calculateGoalProgress(detailSummary.totalValue, {
          targetValueUsd: detailPortfolio.targetValueUsd,
          targetDate: detailPortfolio.targetDate,
        });
        return <section className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="portfolio-detail-goal">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
            <span className="inline-flex items-center gap-2 font-bold text-[var(--text)]"><Target aria-hidden="true" size={16} className="text-[var(--accent)]" /> เป้าหมายพอร์ต</span>
            <span className="font-mono text-[var(--text-secondary)]">
              {money(detailSummary.totalValue)} / {money(detailPortfolio.targetValueUsd)}
              {' · '}
              {progress.progressPercent === null || !showBalances ? '—' : `${progress.progressPercent.toFixed(2)}%`}
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="ความคืบหน้าเป้าหมายพอร์ต"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.progressPercent === null || !showBalances ? undefined : Math.min(100, Math.max(0, progress.progressPercent))}
            className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-hover)]"
          >
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${showBalances ? Math.min(100, Math.max(0, progress.progressPercent ?? 0)) : 0}%` }}
            />
          </div>
          {progress.reason && <p className="mt-2 text-xs text-[var(--warning)]">{progress.reason}</p>}
        </section>;
      })()}

      {detailPortfolio.archivedAt && <p className="text-xs text-[var(--warning)]">พอร์ตนี้ถูก Archive แล้ว จึงรับ transaction ใหม่ไม่ได้ แต่ยังรวมในพอร์ตรวมและเก็บ history ครบถ้วน</p>}

      {/*
        Says what is still possible before what is not: the ledger is fully
        readable on the statement route, and only writing needs a higher tier.
        The database is what actually refuses the write; this explains it first.
      */}
      {detailWriteBlock && <p className="flex items-start gap-2 text-xs text-[var(--warning)]">
        <Lock aria-hidden="true" size={13} className="mt-0.5 shrink-0" />
        <span>
          {detailWriteBlock === 'upgrade'
            ? 'พอร์ต Options นี้ยังเปิดดูได้ครบ แต่ต้องใช้ Pro เพื่อแก้ไขต่อ'
            : READ_ONLY_PORTFOLIO_MESSAGE}
          {' '}
          <Link href="/settings/subscription" className="font-medium underline underline-offset-2">ดูแพ็กเกจ</Link>
        </span>
      </p>}

      {detailIsEmpty
        ? <EmptyAssets
          title="ยังไม่มีสินทรัพย์ในพอร์ตนี้"
          description="ใช้ปุ่ม “เพิ่มสินทรัพย์” ด้านบนเพื่อบันทึกรายการซื้อ หรือนำเข้าสถานะตั้งต้น แล้วระบบจะเริ่มคำนวณมูลค่าและกำไร/ขาดทุน"
        />
        : <>
          {detailPortfolio.type !== 'OPTION' && <section className="min-w-0 space-y-3">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <SectionHeading title="สินทรัพย์ที่ถืออยู่" />
              <SortControl id="portfolio-sort" value={sortKey} onChange={setSortKey} options={['value', 'today', 'gain', 'name']} />
            </div>
            {detailSummary.holdings.length === 0
              ? <p className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-6 text-center text-sm text-[var(--text-muted)]">ยังไม่มีหุ้นหรือ ETF ในพอร์ตนี้</p>
              : <div className="grid min-w-0 gap-3" data-testid="holdings-list">
                {sortAssets(detailSummary.holdings, sortKey, (holding) => ({
                  name: holding.symbol,
                  value: holding.marketValue,
                  todayChange: holding.todayChange,
                  unrealizedGain: holding.unrealizedGain,
                })).map((holding) => <HoldingCard
                  key={holding.symbol}
                  holding={holding}
                  companyName={companyNames[holding.symbol]}
                  expanded={expandedKey === holding.symbol}
                  showBalances={showBalances}
                  timezone={timezone}
                  portfolioId={detailPortfolio.id}
                  canWrite={detailCanWrite}
                  money={money}
                  signed={signed}
                  hidden={hidden}
                  onToggle={() => setExpandedKey((current) => current === holding.symbol ? null : holding.symbol)}
                  onBuy={() => openCreate('acquisition', holding.symbol)}
                  onSell={() => openCreate('disposal', holding.symbol)}
                  onCloseAll={() => openCreate('disposal', holding.symbol, String(holding.quantity))}
                />)}
              </div>}
            <p className="text-xs text-[var(--text-muted)]">
              ทุกสถานะคำนวณจาก Transaction Ledger เท่านั้น การเพิ่มซื้อ ขาย แก้ไข หรือลบจะสร้างหรือเปลี่ยนรายการต้นทางแล้วคำนวณใหม่ทั้งพอร์ต
            </p>
          </section>}

          {optionsShownInline && optionsSection}
        </>}

      <AccountingDetails
        summary={detailSummary}
        open={accountingOpen}
        onToggle={() => setAccountingOpen((current) => !current)}
        money={money}
        signed={signed}
      />

      <NavRow
        testId="portfolio-history-link"
        icon={<History size={19} />}
        title="ประวัติเงินเข้า–ออก"
        detail={`รายการทั้งหมดของ ${detailPortfolio.name}`}
        href={`/portfolio/transactions?portfolio=${detailPortfolio.id}`}
      />
    </>}

    {/*
      Off screen, but mounted: the add-asset sheet opens this flow from every
      screen, including ones with no option positions on them.
    */}
    {!optionsShownInline && optionsSection}

    {/*
      Kheaw and the goal he is reporting on, then the one row that leads to
      managing a portfolio — both below the holdings and the statement, because
      progressive disclosure puts what is held first and what is administered
      last.
    */}
    <PortfolioManager
      portfolios={portfolios}
      summaries={summaries}
      aggregate={aggregateSummary}
      aggregateGoal={aggregateGoal}
      selectedPortfolioId={portfolio.id}
      optionTargetCounts={Object.fromEntries(portfolios.map((item) => [item.id, optionTargets.filter((target) => target.portfolioId === item.id).length]))}
      recentlyDeleted={recentlyDeleted}
      timezone={timezone}
      effectiveTier={effectiveTier}
      showBalances={showBalances}
      isOnline={isOnline}
      money={money}
      signed={signed}
      percent={percent}
      onSelect={openPortfolio}
      openRequest={managerRequest}
      onOpenRequestHandled={() => setManagerRequest(null)}
      sectionHidden={activeScreen.kind !== 'home'}
    />

    {/*
      The disclaimer, compact and last. It is a standing fact about the whole
      product rather than a step in reading a portfolio, so it stops interrupting
      the flow — but it is on every screen this page has, at every width.
    */}
    <aside className="flex items-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--warning)_28%,transparent)] bg-[color-mix(in_srgb,var(--warning)_7%,transparent)] px-2.5 py-2 text-[11px] leading-snug text-[var(--warning)]" role="note">
      <AlertTriangle className="mt-px shrink-0" size={13} aria-hidden="true" />
      <p className="min-w-0"><strong>พอร์ตจำลองเพื่อบันทึกย้อนหลังเท่านั้น</strong> — ไม่มีการส่งคำสั่งไปยังตลาดหลักทรัพย์ โบรกเกอร์ หรือผู้ให้บริการซื้อขายใด ๆ</p>
    </aside>

    <ResponsiveDialog isOpen={overflowOpen} onClose={() => setOverflowOpen(false)} title={`ตัวเลือกพอร์ต ${detailPortfolio.name}`}>
      <div className="grid gap-2" data-testid="portfolio-overflow-menu">
        <OverflowChoice icon={<PencilLine size={18} />} label="แก้ไขพอร์ต" disabled={!isOnline || Boolean(detailWriteBlock)} onClick={() => requestManager('edit', detailPortfolio.id)} />
        <OverflowChoice icon={<Target size={18} />} label="ตั้งเป้าหมายพอร์ต" disabled={!isOnline || Boolean(detailWriteBlock)} onClick={() => requestManager('goal', detailPortfolio.id)} />
        <OverflowChoice icon={<Repeat2 size={18} />} label="ย้ายสินทรัพย์ไปพอร์ตอื่น" disabled={!isOnline || activePortfolios.length < 2} onClick={() => requestManager('moveAssets', detailPortfolio.id)} />
        <OverflowChoice icon={<Eraser size={18} />} label="รีเซ็ตพอร์ต" tone="danger" disabled={!isOnline || Boolean(detailWriteBlock)} onClick={() => requestManager('reset', detailPortfolio.id)} />
        {!detailPortfolio.isLegacy && <OverflowChoice
          icon={<Trash2 size={18} />}
          label="ลบพอร์ต"
          tone="danger"
          disabled={!isOnline || Boolean(detailWriteBlock)}
          onClick={() => requestManager('delete', detailPortfolio.id)}
        />}
      </div>
      <p className="mt-4 text-xs text-[var(--text-muted)]">
        การลบจะนำพอร์ตนี้พร้อมรายการใน Transaction Ledger ออกจากทุกหน้า และกู้คืนได้ภายใน 7 วัน
      </p>
    </ResponsiveDialog>

    {/*
      The one sheet the one call to action opens. Asset kind first, because that
      is the decision somebody came here to make; the cash rows underneath are
      the same ledger entries they always were, kept reachable rather than moved.
      Each choice hands off to a flow that already exists — this sheet routes,
      and calculates nothing.
    */}
    <ResponsiveDialog isOpen={addAssetSheetOpen} onClose={() => setAddAssetSheetOpen(false)} title="+ เพิ่มสินทรัพย์">
      <p className="mb-4 text-sm text-[var(--text-muted)]">เลือกประเภทสินทรัพย์ที่ต้องการเพิ่ม ทุกอย่างบันทึกเป็นรายการใน Transaction Ledger เดิม</p>
      <div className="grid gap-3 sm:grid-cols-2" data-testid="portfolio-add-asset-sheet">
        <ActionChoice
          testId="add-asset-stock"
          icon={<CandlestickChart size={20} />}
          title="หุ้น / ETF"
          detail="เพิ่มรายการซื้อ ขาย หรือสินทรัพย์ที่ถืออยู่"
          onClick={chooseStockAsset}
        />
        <ActionChoice
          testId="add-asset-option"
          icon={<Layers size={20} />}
          title="ออปชัน"
          detail="เพิ่ม Call / Put position"
          onClick={chooseOptionAsset}
        />
      </div>
      <div className="mt-5 border-t border-[var(--border)] pt-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">เงินสดในพอร์ต</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <ActionChoice icon={<ArrowDownCircle size={20} />} title="เติมเงินจำลอง" detail="เพิ่มเงินสดเข้าพอร์ต" onClick={() => { setAddAssetSheetOpen(false); openCreate('deposit'); }} />
          <ActionChoice icon={<ArrowUpCircle size={20} />} title="ถอนเงินจำลอง" detail="ลดเงินสดออกจากพอร์ต" onClick={() => { setAddAssetSheetOpen(false); openCreate('withdrawal'); }} />
          <ActionChoice icon={<Repeat2 size={20} />} title="โอนระหว่างพอร์ต" detail="ย้ายเงินด้วยรายการคู่ใน Ledger" disabled={activePortfolios.length < 2} onClick={() => { setAddAssetSheetOpen(false); requestManager('transfer'); }} />
        </div>
      </div>
    </ResponsiveDialog>

    <TransactionFormModal
      open={formOpen}
      editing={false}
      form={form}
      errors={errors}
      pending={pending || !isOnline}
      portfolios={portfolios.filter((item) => item.archivedAt === null)}
      cashByPortfolioId={Object.fromEntries(portfolios.map((item) => [item.id, summaries[item.id].cashBalance]))}
      replacedTransaction={null}
      onChange={change}
      onClose={() => !pending && closeForm()}
      onSubmit={submit}
    />
    <PortfolioValueSheet
      key={valueSheetKey}
      idempotencyKey={valueSheetKey}
      open={valueSheetOpen}
      portfolios={portfolios.filter((item) => item.archivedAt === null)}
      summaries={summaries}
      defaultPortfolioId={portfolio.id}
      currency={currency}
      usdThbRate={rate}
      timezone={timezone}
      pending={pending}
      isOnline={isOnline}
      error={valueSheetError}
      onClose={() => { setValueSheetOpen(false); setValueSheetError(''); }}
      onSubmit={submitPortfolioValue}
    />
  </main>;
}

/** Back, title and the screen's own actions — the header a drill-down needs. */
function DrillHeader({ title, onBack, action }: { title: string; onBack: () => void; action?: React.ReactNode }) {
  return <header className="flex min-w-0 items-center gap-2">
    <button
      type="button"
      onClick={onBack}
      aria-label="กลับไปหน้าสินทรัพย์ของฉัน"
      className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
    ><ArrowLeft size={19} /></button>
    <h1 className="min-w-0 flex-1 truncate text-xl font-black tracking-tight text-[var(--text)]">{title}</h1>
    <div className="flex shrink-0 items-center gap-2">{action}</div>
  </header>;
}

function OverflowChoice({ icon, label, onClick, disabled = false, tone = 'default' }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}) {
  return <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={`flex min-h-14 w-full min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] px-4 text-left text-sm font-semibold transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40 ${tone === 'danger' ? 'text-[var(--negative)]' : 'text-[var(--text)]'}`}
  >
    <span aria-hidden="true" className="shrink-0">{icon}</span>
    <span className="min-w-0 break-words">{label}</span>
  </button>;
}

function ActionChoice({ icon, title, detail, onClick, disabled = false, testId }: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return <button type="button" disabled={disabled} onClick={onClick} data-testid={testId} className="flex min-h-20 min-w-0 items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-left hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40">
    <span className="mt-0.5 shrink-0 text-[var(--accent)]">{icon}</span>
    <span className="min-w-0"><strong className="block break-words text-sm text-[var(--text)]">{title}</strong><span className="mt-1 block break-words text-xs text-[var(--text-muted)]">{detail}</span></span>
  </button>;
}
