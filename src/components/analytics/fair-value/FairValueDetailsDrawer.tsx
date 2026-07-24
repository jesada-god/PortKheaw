'use client';

import { Drawer } from '@/src/components/ui/Drawer';
import type { FairValueResult } from '@/src/lib/analytics/valuation/types';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import {
  fairValueMissingFieldDetails,
  fairValueUnavailableLabel,
  fairValueUnavailableReason,
  formatFairValueMoney,
  formatUpsidePercent,
  modelLabel,
} from './presentation';

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
  const missingDetails = data?.status === 'unavailable'
    ? fairValueMissingFieldDetails(data.missingFields)
    : [];
  return (
    <Drawer id={id} isOpen={open} onClose={onClose} title="ดูวิธีคำนวณ Fair Value">
      <div className="space-y-6 break-words text-sm leading-6 text-slate-300">
        <section>
          <h3 className="font-semibold text-white">หลักการ</h3>
          <p className="mt-1">
            คำนวณแบบ deterministic จาก DCF และ Forward Multiples เท่านั้น
            ทุก input ต้องย้อนกลับไปยัง provider หรืองบการเงินจริงได้ และใช้ USD เป็น source of truth
          </p>
        </section>
        {data?.status !== 'available' ? (
          <section>
            <h3 className="font-semibold text-white">เหตุผลที่ยังคำนวณไม่ได้</h3>
            <p className="mt-1 font-semibold text-amber-300">
              {data?.status === 'unavailable'
                ? fairValueUnavailableLabel(data.failureKind, 'th')
                : 'เกิดข้อผิดพลาด'}
            </p>
            <p className="mt-1">
              {data?.status === 'unavailable'
                ? fairValueUnavailableReason(data, 'th')
                : unavailableReason ?? 'ไม่มีผล Fair Value ที่ผ่าน validation'}
            </p>
            {data?.status === 'unavailable' && (
              <>
                <p className="mt-2 text-xs text-slate-500">
                  Provider: {data.provider ?? 'ไม่ทราบ'} · as of {formatBangkokDateTime(data.asOf)}
                </p>
                {missingDetails.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {missingDetails.map((item, index) => (
                      <dl
                        key={`${item.field}:${item.period ?? index}`}
                        className="grid grid-cols-[6rem_1fr] gap-x-2 rounded-lg border border-slate-800 p-3 text-xs"
                      >
                        <dt className="text-slate-500">Field</dt><dd>{item.field}</dd>
                        <dt className="text-slate-500">Period</dt><dd>{item.period ?? 'ไม่ระบุ'}</dd>
                        <dt className="text-slate-500">Reason</dt><dd>{item.reason}</dd>
                      </dl>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        ) : (
          <>
            <section>
              <h3 className="font-semibold text-white">ผลลัพธ์</h3>
              <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
                <Summary label="Fair Value" value={formatFairValueMoney(data.fundamentalFairValue.centralEstimate)} />
                <Summary label="Current Price" value={formatFairValueMoney(data.marketPrice.value)} />
                <Summary label="Upside/Downside" value={formatUpsidePercent(data.upsidePercent)} />
                <Summary label="Data Quality" value={data.dataQualityLabel} />
                {data.modelResults.map((model) => (
                  <Summary key={model.model} label={modelLabel(model.model)} value={formatFairValueMoney(model.fairValue)} />
                ))}
              </dl>
            </section>
            <section>
              <h3 className="font-semibold text-white">สูตรและ intermediate calculations</h3>
              <div className="mt-2 space-y-3">
                {data.modelResults.map((model) => (
                  <article key={model.model} className="rounded-lg border border-slate-800 p-3">
                    <h4 className="font-semibold text-[#D4FF00]">
                      {modelLabel(model.model)} · {(model.weight * 100).toFixed(0)}%
                    </h4>
                    <p className="mt-1 text-xs">{model.methodology}</p>
                    <dl className="mt-2 grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-2 text-xs">
                      {Object.entries(model.inputs).map(([field, value]) => (
                        <div key={field} className="contents">
                          <dt className="text-slate-500">{field}</dt>
                          <dd className="overflow-wrap-anywhere font-mono">{String(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
            </section>
            <section>
              <h3 className="font-semibold text-white">Inputs และแหล่งข้อมูล</h3>
              <div className="mt-2 space-y-2">
                {data.inputDetails.map((item) => (
                  <dl key={`${item.field}:${item.period}`} className="rounded-lg border border-slate-800 p-3 text-xs">
                    <dt className="font-semibold text-slate-200">{item.field}</dt>
                    <dd className="mt-1 font-mono">{String(item.value)} {item.currency ?? ''}</dd>
                    <dd className="text-slate-500">
                      {item.period} · {item.provider} · as of {item.asOf} · {item.origin}
                    </dd>
                  </dl>
                ))}
              </div>
            </section>
            <section>
              <h3 className="font-semibold text-white">Assumptions ที่กำหนดชัดเจน</h3>
              <ul className="mt-2 list-disc pl-5 text-xs text-slate-400">
                {data.assumptionDetails.map((item) => (
                  <li key={item.field}>
                    {item.field}: {String(item.value)} · {item.source} · {item.ruleVersion}
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3 className="font-semibold text-white">Data Quality และเวลา</h3>
              <p className="mt-1">{data.dataQualityLabel} · {data.dataQuality.score.toFixed(0)}/100</p>
              <ul className="mt-2 list-disc pl-5 text-xs text-slate-400">
                {data.reliabilityReasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                Latest data {formatBangkokDateTime(data.latestDataAt)} · calculated {formatBangkokDateTime(data.calculatedAt)}
                {' '}· methodology {data.methodologyVersion}
              </p>
            </section>
          </>
        )}
        <section className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
          Fair Value เป็นผลจากแบบจำลอง ไม่ใช่ราคาตลาดหรือคำแนะนำในการลงทุน
        </section>
      </div>
    </Drawer>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 p-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="mt-1 font-mono text-white">{value}</dd>
    </div>
  );
}
