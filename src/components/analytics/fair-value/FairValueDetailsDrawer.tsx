'use client';

import React, { useId, useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Drawer } from '@/src/components/ui/Drawer';
import type {
  FairValueAvailable,
  FairValueResult,
  ValuationDiagnostic,
} from '@/src/lib/analytics/valuation/types';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import {
  diagnosticReasonLabel,
  fairValueMissingFieldsSummary,
  fairValueSummary,
  fairValueUnavailableLabel,
  fairValueUnavailableReason,
  formatFairValueMoney,
  modelLabel,
  readableFieldLabel,
} from './presentation';

type Tab = 'summary' | 'models' | 'inputs' | 'sources';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'summary', label: 'สรุป' },
  { id: 'models', label: 'โมเดล' },
  { id: 'inputs', label: 'ข้อมูลที่ใช้' },
  { id: 'sources', label: 'แหล่งที่มา' },
];

export function FairValueDetailsDrawer({
  id,
  open,
  onClose,
  data,
  unavailableReason,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  data: FairValueResult | null;
  unavailableReason: string | null;
}) {
  const [tab, setTab] = useState<Tab>('summary');
  const tabsId = useId();

  const diagnostics = useMemo(() => normalizedDiagnostics(data), [data]);
  const available = data?.status === 'available' ? data : null;
  const type = available
    ? available.fairValue.type === 'base' ? 'Base'
      : available.fairValue.type === 'dcf' ? 'DCF' : 'Relative'
    : 'Unavailable';
  const modelsUsed = available
    ? available.modelResults.map((model) => modelLabel(model.model)).join(', ')
    : 'ไม่มีโมเดลที่ผ่าน';

  return (
    <Drawer
      id={id}
      isOpen={open}
      onClose={onClose}
      title="วิธีคำนวณ Fair Value"
      variant="responsive-dialog"
    >
      <div className="min-w-0 space-y-4 break-words text-sm leading-6 text-slate-300">
        <section className="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Overview label="Fair Value" value={available ? formatFairValueMoney(available.fairValue.value) : 'Unavailable'} />
            <Overview label="ประเภท" value={type} />
            <Overview label="Confidence" value={available?.fairValue.confidence ?? 'Unavailable'} />
            <Overview
              label="Data freshness"
              value={available ? freshnessLabel(available.dataStatus) : 'Unavailable'}
            />
          </div>
          <p className="mt-3 text-xs text-slate-400">
            โมเดลที่ใช้: <span className="text-slate-200">{modelsUsed}</span>
          </p>
        </section>

        <div
          role="tablist"
          aria-label="รายละเอียด Fair Value"
          className="grid grid-cols-2 gap-1 rounded-xl bg-slate-900 p-1 sm:grid-cols-4"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`${tabsId}-${item.id}-tab`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`${tabsId}-${item.id}-panel`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              className={`min-h-11 rounded-lg px-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[#D4FF00] ${
                tab === item.id ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div
          id={`${tabsId}-${tab}-panel`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-${tab}-tab`}
          tabIndex={0}
          className="min-w-0 outline-none"
        >
          {tab === 'summary' && (
            <SummaryTab data={data} unavailableReason={unavailableReason} />
          )}
          {tab === 'models' && <ModelsTab data={data} />}
          {tab === 'inputs' && <InputsTab diagnostics={diagnostics} />}
          {tab === 'sources' && <SourcesTab data={data} diagnostics={diagnostics} />}
        </div>

        <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
          Fair Value เป็นผลจากแบบจำลอง ไม่ใช่ราคาตลาดหรือคำแนะนำในการลงทุน และใช้ USD เป็นฐานคำนวณ
        </p>
      </div>
    </Drawer>
  );
}

function Overview({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 overflow-wrap-anywhere font-semibold text-white">{value}</p>
    </div>
  );
}

function SummaryTab({
  data,
  unavailableReason,
}: {
  data: FairValueResult | null;
  unavailableReason: string | null;
}) {
  if (data?.status === 'available') {
    const excluded = data.excludedModels.at(0);
    return (
      <section className="space-y-3 rounded-xl border border-slate-800 p-4">
        <h3 className="font-semibold text-white">ผลนี้คำนวณอย่างไร</h3>
        <p>{fairValueSummary(data)}</p>
        <p>
          ระดับความเชื่อมั่น <strong className="text-white">{data.fairValue.confidence}</strong>
          {' '}สะท้อนความครบถ้วน ความสด และการตรวจสอบย้อนกลับของข้อมูล ไม่ใช่โอกาสได้ผลตอบแทน
        </p>
        {excluded && (
          <p className="rounded-lg bg-amber-500/10 p-3 text-amber-200">
            โมเดลที่ไม่ถูกนำมาใช้: {modelLabel(excluded.model)} — {humanModelReason(excluded.reason)}
          </p>
        )}
      </section>
    );
  }
  const reason = data?.status === 'unavailable'
    ? fairValueUnavailableReason(data, 'th')
    : unavailableReason ?? 'ยังไม่มีผลที่ผ่านการตรวจสอบ';
  return (
    <section className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
      <h3 className="font-semibold text-amber-200">
        {data?.status === 'unavailable'
          ? fairValueUnavailableLabel(data.failureKind, 'th')
          : 'Fair Value ยังไม่พร้อม'}
      </h3>
      <p>{reason}</p>
      <p className="text-xs text-slate-400">
        ระบบไม่สร้างค่าทดแทน ไม่สมมติข้อมูลที่ขาด และไม่ลดเกณฑ์เพื่อให้มีราคา
      </p>
    </section>
  );
}

function ModelsTab({ data }: { data: FairValueResult | null }) {
  if (data?.status !== 'available') {
    const reason = data?.status === 'unavailable'
      ? fairValueMissingFieldsSummary(data.missingFields, 'th')
      : 'ยังไม่มีข้อมูลจากระบบ';
    return (
      <div className="space-y-3">
        <ModelState name="DCF" passed={false} reason={reason} />
        <ModelState name="Forward Multiples" passed={false} reason={reason} />
      </div>
    );
  }
  const dcf = data.modelResults.find((model) => model.model === 'fcff-dcf');
  const multiples = data.modelResults.find((model) => model.model === 'pe' || model.model === 'ev-sales');
  const dcfExcluded = data.excludedModels.find((model) => model.model === 'fcff-dcf');
  const multipleExcluded = data.excludedModels.find((model) =>
    model.model === 'pe' || model.model === 'ev-sales');
  return (
    <div className="space-y-3">
      <ModelState
        name="DCF"
        passed={Boolean(dcf)}
        fairValue={dcf?.fairValue}
        reason={dcf ? 'ข้อมูลและผลคำนวณผ่าน validation' : humanModelReason(dcfExcluded?.reason)}
        weight={data.fairValue.type === 'base' ? dcf?.weight : undefined}
      />
      <ModelState
        name="Forward Multiples"
        passed={Boolean(multiples)}
        fairValue={multiples?.fairValue}
        reason={multiples ? 'มีบริษัทจริงผ่านเกณฑ์อย่างน้อย 4 บริษัท' : humanModelReason(multipleExcluded?.reason)}
        weight={data.fairValue.type === 'base' ? multiples?.weight : undefined}
      />
    </div>
  );
}

function ModelState({
  name,
  passed,
  fairValue,
  reason,
  weight,
}: {
  name: string;
  passed: boolean;
  fairValue?: number;
  reason: string;
  weight?: number;
}) {
  return (
    <article className="rounded-xl border border-slate-800 p-4">
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
          passed ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'
        }`}>
          {passed ? <Check size={15} aria-hidden="true" /> : <X size={15} aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-white">{passed ? 'ผ่าน' : 'ไม่ผ่าน'} · {name}</h3>
          {fairValue !== undefined && (
            <p className="mt-1 font-mono text-base text-[#D4FF00]">{formatFairValueMoney(fairValue)}</p>
          )}
          <p className="mt-1 text-xs text-slate-400">{reason}</p>
          {weight !== undefined && (
            <p className="mt-2 text-xs text-slate-300">น้ำหนักใน Base Fair Value: {(weight * 100).toFixed(0)}%</p>
          )}
        </div>
      </div>
    </article>
  );
}

function InputsTab({ diagnostics }: { diagnostics: ValuationDiagnostic[] }) {
  const inputs = diagnostics.filter((item) => !item.field.startsWith('model:'));
  if (!inputs.length) {
    return <p className="rounded-xl border border-slate-800 p-4 text-slate-400">ยังไม่มีรายละเอียดข้อมูล</p>;
  }
  return (
    <div className="space-y-2">
      {inputs.map((item, index) => (
        <details
          key={`${item.field}:${item.period ?? 'none'}:${index}`}
          className="group rounded-xl border border-slate-800"
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:content-none">
            <span className="min-w-0 font-medium text-slate-200">{readableFieldLabel(item.field)}</span>
            <span className={item.status === 'available' ? 'text-emerald-400' : 'text-amber-300'}>
              {diagnosticSourceStatus(item)}
            </span>
          </summary>
          <dl className="grid grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-3 border-t border-slate-800 px-4 py-3 text-xs">
            <Technical label="Value" value={formatDiagnosticValue(item.value)} />
            <Technical label="Period" value={item.period ?? 'ไม่ระบุ'} />
            <Technical label="Provider" value={item.provider ?? 'ไม่ระบุ'} />
            <Technical label="As of" value={formatBangkokDateTime(item.asOf)} />
            <Technical label="Provenance" value={item.provenance} />
            <Technical label="สถานะ" value={diagnosticReasonLabel(item)} />
          </dl>
          {(item.sourceUrl || item.evidence?.length) && (
            <div className="space-y-2 border-t border-slate-800 px-4 py-3 text-xs">
              {item.sourceUrl && (
                <a
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center overflow-wrap-anywhere text-sky-300 underline decoration-sky-500/50 underline-offset-2"
                >
                  เปิดแหล่งข้อมูล
                </a>
              )}
              {item.evidence?.map((source) => (
                <article key={`${item.field}:${source.url}`} className="rounded-lg bg-slate-900/70 p-3">
                  <p className="font-medium text-slate-200">{source.publisher}</p>
                  <p className="mt-1 text-slate-400">{source.evidence}</p>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex min-h-11 items-center overflow-wrap-anywhere text-sky-300 underline decoration-sky-500/50 underline-offset-2"
                  >
                    ดูหลักฐานต้นทาง
                  </a>
                </article>
              ))}
            </div>
          )}
        </details>
      ))}
    </div>
  );
}

function Technical({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="min-w-0 overflow-wrap-anywhere font-mono text-slate-300">{value}</dd>
    </>
  );
}

function SourcesTab({
  data,
  diagnostics,
}: {
  data: FairValueResult | null;
  diagnostics: ValuationDiagnostic[];
}) {
  const providers = new Map<string, { asOf: string; freshness: string }>();
  const evidence = data?.status === 'available'
    ? data.inputDetails.flatMap((item) => item.evidence ?? [])
    : diagnostics.flatMap((item) => item.evidence ?? []);
  for (const item of diagnostics) {
    if (!item.provider) continue;
    const existing = providers.get(item.provider);
    if (!existing || item.asOf > existing.asOf) {
      providers.set(item.provider, {
        asOf: item.asOf,
        freshness: item.status === 'stale' ? 'เก่า' : item.status === 'available' ? 'พร้อม' : 'มีข้อจำกัด',
      });
    }
  }
  if (data?.status === 'available') {
    for (const source of data.sources) {
      if (!providers.has(source.name)) {
        providers.set(source.name, { asOf: source.asOf, freshness: freshnessLabel(data.dataStatus) });
      }
    }
  } else if (data?.status === 'unavailable' && data.provider && !providers.has(data.provider)) {
    providers.set(data.provider, { asOf: data.asOf, freshness: 'ไม่พร้อม' });
  }
  return (
    <div className="space-y-3">
      {[...providers].map(([provider, detail]) => (
        <article key={provider} className="rounded-xl border border-slate-800 p-4">
          <h3 className="font-semibold text-white">{provider}</h3>
          <p className="mt-1 text-xs text-slate-400">อัปเดต {formatBangkokDateTime(detail.asOf)}</p>
          <p className="mt-1 text-xs text-slate-400">Freshness: {detail.freshness}</p>
        </article>
      ))}
      {!providers.size && (
        <p className="rounded-xl border border-slate-800 p-4 text-slate-400">ยังไม่มีแหล่งข้อมูลที่ยืนยันได้</p>
      )}
      {[...new Map(evidence.map((source) => [source.url, source])).values()].map((source) => (
        <article key={source.url} className="rounded-xl border border-slate-800 p-4">
          <h3 className="font-semibold text-white">{source.publisher}</h3>
          <p className="mt-1 text-xs text-slate-400">{source.evidence}</p>
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex min-h-11 items-center overflow-wrap-anywhere text-xs text-sky-300 underline decoration-sky-500/50 underline-offset-2"
          >
            เปิดหลักฐาน
          </a>
        </article>
      ))}
      {data?.status === 'available' && (
        <p className="text-xs text-slate-500">
          คำนวณ {formatBangkokDateTime(data.calculatedAt)} · {data.methodologyVersion}
        </p>
      )}
    </div>
  );
}

function normalizedDiagnostics(data: FairValueResult | null): ValuationDiagnostic[] {
  if (!data) return [];
  if (data.status === 'unavailable') {
    if (data.diagnostics.length) return data.diagnostics;
    return data.missingFields.map((field) => ({
      field,
      value: null,
      period: null,
      provider: data.provider,
      asOf: data.asOf,
      status: 'missing',
      provenance: 'validation',
      reason: 'required-model-input-failed-validation',
    }));
  }
  const disclosed = data.inputDetails.map((item): ValuationDiagnostic => ({
    field: item.field,
    value: item.value,
    period: item.period,
    provider: item.provider,
    asOf: item.asOf,
    status: item.status === 'available' ? 'available' : 'stale',
    provenance: item.origin,
    sourceType: item.sourceType,
    sourceUrl: item.sourceUrl,
    evidence: item.evidence,
    reason: item.status === 'available' ? null : 'stale-provider-cache',
  }));
  const disclosedKeys = new Set(disclosed.map((item) =>
    `${item.field.toLowerCase()}:${item.period ?? ''}`));
  return [
    ...disclosed,
    ...data.diagnostics.filter((item) =>
      item.status !== 'available'
      || !disclosedKeys.has(`${item.field.toLowerCase()}:${item.period ?? ''}`)),
  ];
}

function diagnosticSourceStatus(item: ValuationDiagnostic): string {
  if (item.status === 'missing' || item.status === 'rejected') return '✕ ไม่พบ';
  if (item.status === 'stale') return '△ ข้อมูลเก่า';
  if (item.sourceType === 'gemini-grounded' || item.provenance === 'gemini-grounded') {
    return '◐ ค้นคว้าจากแหล่งภายนอก';
  }
  if (item.sourceType === 'derived' || item.provenance === 'derived') {
    return '◈ คำนวณจากข้อมูลจริง';
  }
  return '✓ พร้อมจาก Provider';
}

function freshnessLabel(status: FairValueAvailable['dataStatus']): string {
  const labels: Record<FairValueAvailable['dataStatus'], string> = {
    live: 'สด',
    delayed: 'ล่าช้า',
    cached: 'Cache',
    stale: 'เก่า',
    limited: 'มีข้อจำกัด',
  };
  return labels[status];
}

function humanModelReason(reason?: string): string {
  if (!reason) return 'ไม่มีข้อมูลที่ผ่าน validation';
  return reason.split(',').map((field) => readableFieldLabel(field.trim())).join(', ');
}

function formatDiagnosticValue(value: ValuationDiagnostic['value']): string {
  if (value === null) return 'ไม่มีค่า';
  if (typeof value === 'number') return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 6,
  }).format(value);
  return value;
}
