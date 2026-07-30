import {
  ComposedChart, BarChart, Area, Bar, Cell, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { AlertTriangle, CheckCircle, Clock, Activity, ExternalLink } from 'lucide-react';
import { useVrpForwardData, type VrpLedgerRow, type VrpForwardMeta } from '../../hooks/useVrpForwardData';
import {
  deriveVrpGateSnapshot, addDaysUTC, latestRunTimestamp,
  F2_POSITIVE_WEEK_RATIO_PCT, RUIN1_WEEKLY_LOSS_PCT_OF_CAPITAL, F4_ABS_CORR_MAX,
  type VrpGateSnapshot,
} from '../../lib/vrpForwardGates';
import { SectionBox } from '../../ui/components/SectionBox';
import { formatJST } from '../../ui/utils/formatters';

const LIVE_TARGET = 90;
const ACCENT = '#8B5CF6';   // VRP（violet）
const IV_COLOR = '#F59E0B'; // DVOL（IV）
const RV_COLOR = '#3B82F6'; // 実現RV

// Stage 2 実測コスト後の凍結バックテスト値（research/EXP-OBS000037/10-result/stage2-vrp-pipeline-accounting.json・
// gitCommit 5e5fef29・確認2026-07-13）。C品質チーム確定済み（20-verdict-stage2.md）で以後変化しない値のためハードコード。
// 年率換算は equitySeries の複利equityCompound比から (endEquity/startEquity)^(52/n)-1 で導出（戦略の再計算ではなく
// 既存equity系列2点の比率＋annualizeのみ）。年率換算そのものはC品質チームの正式宣言でなく、SC-1/SC-2生数値からの機械的換算。
const BACKTEST_CONFIRM = {
  meanWeeklyNetVolPt: 6.461139290632751,
  sharpeAnnualizedSqrt52: 2.3760662223595332,
  annualizedReturnPctCompound: 6.933012041729314,
  weeks: 157,
  windowStart: '2023-07-01',
  windowEnd: '2026-07-01',
};
const BACKTEST_FULL = {
  meanWeeklyNetVolPt: 9.702913618064535,
  sharpeAnnualizedSqrt52: 2.98868218478209,
  annualizedReturnPctCompound: 10.590366352495838,
  weeks: 276,
  windowStart: '2021-03-24',
  windowEnd: '2026-07-01',
};

// ── 小ヘルパー ────────────────────────────────────────────
const signed = (v: number, digits: number, suffix = '') =>
  `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`;
const fmtPct = (v: number | null | undefined, digits = 4) =>
  v == null ? '—' : signed(v, digits, '%');
const fmtVol = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v.toFixed(digits)}`;

function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] leading-relaxed text-fg-2 bg-fg-4/30 border border-fg-3/50 rounded p-2.5">
      {children}
    </div>
  );
}

// ── ゲート状態バッジ ──────────────────────────────────────
// value=null は「判定不能（データ待ち）」または「UI未算出（C監査で算出）」を表す。
function GateBadge({ value, label, sub, pending }: {
  value: boolean | null; label: string; sub?: string; pending?: string;
}) {
  const color =
    value === true ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-700'
    : value === false ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border-red-300 dark:border-red-700'
    : 'text-fg-2 bg-fg-4 border-fg-3';
  const icon =
    value === true ? <CheckCircle size={14} className="text-emerald-500" />
    : value === false ? <AlertTriangle size={14} className="text-red-500" />
    : <Clock size={14} className="text-fg-3" />;

  return (
    <div className={`flex flex-col gap-1 border rounded p-3 ${color}`}>
      <div className="flex items-center gap-1.5 text-xs font-700">{icon}{label}</div>
      {sub && <p className="text-[11px] leading-tight opacity-70 font-mono tabular-nums">{sub}</p>}
      {pending && <p className="text-[10px] leading-tight text-fg-3">{pending}</p>}
    </div>
  );
}

// ── 断面サマリのタイル ────────────────────────────────────
function StatTile({ label, value, sub, tone = 'neutral' }: {
  label: string; value: string; sub?: string; tone?: 'neutral' | 'pos' | 'neg' | 'accent';
}) {
  const valueColor =
    tone === 'pos' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'neg' ? 'text-red-500'
    : tone === 'accent' ? 'text-violet-600 dark:text-violet-400'
    : 'text-fg-1';
  return (
    <div className="border border-fg-3 rounded p-3">
      <p className="text-[11px] text-fg-3 mb-1">{label}</p>
      <p className={`text-xl font-700 font-mono tabular-nums ${valueColor}`}>{value}</p>
      {sub && <p className="text-[10px] text-fg-3 mt-1">{sub}</p>}
    </div>
  );
}

// ── DVOL（IV）vs 事後実現RV チャート ──────────────────────
// 帯（violet）がVRP＝IVが実現ボラをどれだけ上回っているか＝収穫源。
function VrpLevelChart({ rows, goLiveDate }: { rows: VrpLedgerRow[]; goLiveDate: string }) {
  const data = rows.map(r => ({
    date: r.date.slice(5),
    fullDate: r.date,
    dvol: r.dvol,
    rv: r.rv_forward_7d,
    vrp: r.vrp,
  }));

  if (data.length === 0) {
    return <div className="flex items-center justify-center h-40 text-fg-3 text-sm">データなし</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={230}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--fg-4)" />
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--fg-3)' }} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false}
          width={44} tickFormatter={v => `${v}`} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--fg-4)', borderRadius: 4, fontSize: 12 }}
          formatter={(v: number, name: string) => [`${v?.toFixed?.(2) ?? v} vol pt`, name]}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <ReferenceLine x={goLiveDate.slice(5)} stroke="#10B981" strokeDasharray="3 3"
          label={{ value: 'go-live', position: 'insideTopLeft', fontSize: 9, fill: '#10B981' }} />
        <Area type="monotone" dataKey="vrp" name="VRP（IV−RV）" stroke="none"
          fill={ACCENT} fillOpacity={0.18} connectNulls={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="dvol" name="DVOL（IV）" stroke={IV_COLOR} strokeWidth={2}
          dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="rv" name="事後実現RV(7日)" stroke={RV_COLOR} strokeWidth={2}
          strokeDasharray="5 3" dot={false} connectNulls={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── 週次コホート純益チャート ──────────────────────────────
// F1/F3の判定母集団そのもの（is_cohort_anchor=1 の非重複サンプル）。
function WeeklyCohortChart({ snapshot }: { snapshot: VrpGateSnapshot }) {
  let running = 0;
  const data = snapshot.weeklyAnchors.map(r => {
    const settled = r.net_pnl_pct != null;
    if (settled) running += r.net_pnl_pct as number;
    return {
      label: `W${r.cohort_week_index ?? '?'}`,
      date: r.date,
      net: settled ? parseFloat((r.net_pnl_pct as number).toFixed(4)) : null,
      cum: settled ? parseFloat(running.toFixed(4)) : null,
      vrp: r.vrp,
    };
  });

  if (data.length === 0) {
    return <div className="flex items-center justify-center h-24 text-fg-3 text-sm">週次アンカー未発生</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={180}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--fg-4)" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--fg-3)' }} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false}
          width={60} tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--fg-4)', borderRadius: 4, fontSize: 12 }}
          formatter={(v: number, name: string) => [v == null ? '確定待ち' : signed(v, 4, '%'), name]}
          labelFormatter={(l, p) => `${l}（${p?.[0]?.payload?.date ?? ''}）`}
        />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <ReferenceLine y={0} stroke="var(--fg-3)" />
        <Bar dataKey="net" name="週次ネット" isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.net == null ? 'var(--fg-4)' : d.net >= 0 ? '#10B981' : '#EF4444'} />
          ))}
        </Bar>
        <Line type="monotone" dataKey="cum" name="累積" stroke={ACCENT} strokeWidth={2}
          dot={{ r: 3 }} connectNulls={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── DVOL日次変化（スパイク検出）チャート ──────────────────
function DvolChangeChart({ rows, spikeThreshold }: { rows: VrpLedgerRow[]; spikeThreshold: number }) {
  const data = rows
    .filter(r => r.phase === 'live')
    .map(r => ({
      date: r.date.slice(5),
      change: r.dvol_daily_change_vol_pts != null ? parseFloat(r.dvol_daily_change_vol_pts.toFixed(2)) : null,
      spike: r.dvol_spike_marker === 1,
    }));

  if (data.length === 0) {
    return <div className="flex items-center justify-center h-24 text-fg-3 text-sm">ライブデータなし</div>;
  }

  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--fg-4)" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--fg-3)' }} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false}
          width={44} tickFormatter={v => `${v >= 0 ? '+' : ''}${v}`} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--fg-4)', borderRadius: 4, fontSize: 12 }}
          formatter={(v: number) => [`${signed(v, 2)} vol pt`, 'DVOL前日比']}
        />
        <ReferenceLine y={0} stroke="var(--fg-3)" />
        <ReferenceLine y={spikeThreshold} stroke="#EF4444" strokeDasharray="4 3"
          label={{ value: `スパイク閾値 +${spikeThreshold}`, position: 'insideTopRight', fontSize: 9, fill: '#EF4444' }} />
        <Bar dataKey="change" isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.spike ? '#EF4444' : (d.change ?? 0) >= 0 ? IV_COLOR : RV_COLOR} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── 固定パラメータ表 ──────────────────────────────────────
function FixedParamsTable({ meta }: { meta: VrpForwardMeta }) {
  const p = meta.fixedParams;
  const rows: [string, string, string][] = [
    ['C_real（週次実測コスト）', `${p.cRealWeeklyCostVolPt.toFixed(4)} vol pt/週`, 'spec §2の実測コスト。VRP水準からこれを引いた残りが純益'],
    ['vegaNotionalPct', `${(p.vegaNotionalPct * 100).toFixed(6)} %/vol pt`, 'spec §3のCVaR基準サイジング（f=0.5）。vol pt → 資本比%への換算率'],
    ['DVOLスパイク閾値', `+${p.dvolSpikeThresholdVolPts} vol pt/日`, 'F4のテール窓を前向きに拾うためのマーカー条件'],
    ['warmup / RV先行日数', `${meta.warmupDays}日 / ${meta.rvForwardDays}日`, 'RVは7日先まで待って確定するため、直近7日はVRP未確定が正常'],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-fg-3 border-b border-fg-4">
            <th className="text-left font-600 py-1.5 pr-2">パラメータ</th>
            <th className="text-right font-600 py-1.5 pr-2 whitespace-nowrap">値</th>
            <th className="text-left font-600 py-1.5 hidden sm:table-cell">意味</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v, note]) => (
            <tr key={k} className="border-b border-fg-4/50">
              <td className="py-1.5 pr-2 text-fg-2">{k}</td>
              <td className="py-1.5 pr-2 text-right font-mono tabular-nums text-fg-1 whitespace-nowrap">{v}</td>
              <td className="py-1.5 text-fg-3 hidden sm:table-cell">{note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── メイン画面 ────────────────────────────────────────────
export const VrpForwardScreen = () => {
  const { data, loading, error } = useVrpForwardData();

  if (loading) return <div className="p-4 sm:p-6 text-fg-2">読み込み中…</div>;
  if (error || !data) return (
    <div className="p-4 sm:p-6 text-red-500">エラー: {error ?? 'データが見つかりません'}</div>
  );

  const { meta, ledger } = data;
  const s = deriveVrpGateSnapshot(ledger);
  const liveDays = meta.currentLiveDaysCount;
  const progressPct = Math.min(100, (liveDays / LIVE_TARGET) * 100);
  const goLive = meta.goLiveDateUTC;
  const lastRun = latestRunTimestamp(meta);
  const milestones = [30, 60, 90].map(d => ({
    label: d === 90 ? 'Day 90 正式判定' : `Day ${d}`,
    day: d,
    date: addDaysUTC(goLive, d),
  }));

  const latestDvol = s.latestRow?.dvol ?? null;
  const latestDvolChange = s.latestRow?.dvol_daily_change_vol_pts ?? null;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-h1 font-700 flex items-center gap-2">
            <Activity size={22} className="text-violet-500" />
            VRPフォワード較正モニター
          </h1>
          <p className="text-sm text-fg-2">OBS000037 · SYS-001 バリアンス・リスクプレミアム（BTCデルタニュートラル・ショートボラ）</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-fg-3">最終更新（JST）</p>
          <p className="text-xs font-mono text-fg-2">{lastRun ? formatJST(lastRun) : '—'}</p>
        </div>
      </div>

      {/* 進捗バー */}
      <SectionBox title={`フォワード較正進捗 — Day ${liveDays} / ${LIVE_TARGET}`}>
        <div className="space-y-2">
          <div className="w-full bg-fg-4 rounded-full h-3">
            <div className="h-3 rounded-full transition-all" style={{ width: `${progressPct}%`, backgroundColor: ACCENT }} />
          </div>
          <div className="flex justify-between text-xs text-fg-3 font-mono">
            <span>Go-live {goLive}</span>
            <span className="text-violet-600 dark:text-violet-400 font-600">Day {liveDays}/{LIVE_TARGET} ({progressPct.toFixed(1)}%)</span>
            <span>Day {LIVE_TARGET} {addDaysUTC(goLive, LIVE_TARGET)}</span>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-2">
            {milestones.map(m => (
              <div key={m.label}
                className={`text-center text-[11px] py-1 rounded border ${liveDays >= m.day ? 'border-emerald-400 text-emerald-600 dark:text-emerald-400' : 'border-fg-3 text-fg-3'}`}>
                <div className="font-600">{m.label}</div>
                <div>{m.date}</div>
              </div>
            ))}
          </div>
        </div>
      </SectionBox>

      {/* 断面サマリ */}
      <SectionBox title="いまの断面">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile
            label={`DVOL（IV）${s.latestRow ? `— ${s.latestRow.date}` : ''}`}
            value={fmtVol(latestDvol)}
            sub={latestDvolChange != null ? `前日比 ${signed(latestDvolChange, 2)} vol pt` : undefined}
            tone="accent"
          />
          <StatTile
            label={`直近の確定VRP${s.latestSettled ? ` — ${s.latestSettled.date}` : ''}`}
            value={fmtVol(s.latestSettled?.vrp ?? null)}
            sub={s.latestSettled ? `IV ${s.latestSettled.dvol.toFixed(2)} − RV ${s.latestSettled.rv_forward_7d?.toFixed(2)}` : 'RV確定待ち'}
            tone={(s.latestSettled?.vrp ?? 0) > 0 ? 'pos' : 'neg'}
          />
          <StatTile
            label="週次累積ネット（資本比）"
            value={fmtPct(s.f1.cumulativeWeeklyNetPct)}
            sub={`確定 ${s.f2.settledWeeks}週 / アンカー ${s.weeklyAnchors.length}週`}
            tone={(s.f1.cumulativeWeeklyNetPct ?? 0) >= 0 ? 'pos' : 'neg'}
          />
          <StatTile
            label="RV確定待ち"
            value={`${s.pendingRvDays}日`}
            sub={`直近${meta.rvForwardDays}日は未確定が正常仕様`}
          />
        </div>
        <InfoNote>
          <span className="font-600">この戦略は何をしているか</span>：オプション市場が織り込む予想ボラティリティ（DVOL＝IV）は、
          あとから実際に起きたボラティリティ（実現RV）を構造的に上回る傾向があります。この差額
          <span className="font-600 text-violet-600 dark:text-violet-400">（VRP＝バリアンス・リスクプレミアム）</span>
          を、価格の方向を当てにいかずに（デルタニュートラルで）収穫するのが本戦略です。
          <br /><br />
          <span className="font-600">なぜ直近{meta.rvForwardDays}日はVRPが空欄なのか</span>：実現RVは「その日から{meta.rvForwardDays}日先まで」を見ないと確定しません。
          そのため直近{meta.rvForwardDays}日分は必ず未確定になります（データ欠損ではありません）。
        </InfoNote>
      </SectionBox>

      {/* バックテスト参照値（確認期間・OOS） */}
      <SectionBox title="バックテスト参照値 — 確認期間（OOS）の期待収益率">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile
            label="年率換算（複利・確認期間）"
            value={`+${BACKTEST_CONFIRM.annualizedReturnPctCompound.toFixed(2)}%`}
            sub={`${BACKTEST_CONFIRM.windowStart} 〜 ${BACKTEST_CONFIRM.windowEnd}（${BACKTEST_CONFIRM.weeks}週・未見データ）`}
            tone="pos"
          />
          <StatTile
            label="週次ネット平均（実測コスト後）"
            value={`+${BACKTEST_CONFIRM.meanWeeklyNetVolPt.toFixed(2)}`}
            sub="vol pt / 週（SC-1・確認期間）"
          />
          <StatTile
            label="年率Sharpe（√52）"
            value={BACKTEST_CONFIRM.sharpeAnnualizedSqrt52.toFixed(3)}
            sub="SC-2・確認期間（OOS）"
          />
          <StatTile
            label="参考：全期間ベース"
            value={`+${BACKTEST_FULL.annualizedReturnPctCompound.toFixed(2)}%`}
            sub={`Sharpe ${BACKTEST_FULL.sharpeAnnualizedSqrt52.toFixed(3)}（${BACKTEST_FULL.weeks}週・選定期間を含む）`}
          />
        </div>
        <InfoNote>
          <span className="font-600">これは何の数字か</span>：Stage 2でC品質チームが確定した「実測コスト控除後・確認期間（OOS＝未見データ）」の
          週次ネットpayoff（SC-1・SC-2、単位は資本比のvol pt換算）を、本番と同じサイジング式
          （<span className="font-mono text-[10px]">vegaNotionalPct=0.0002008・f=0.5・下側5%CVaR基準</span>）で年率換算したものです。
          確認期間は選定期間（2021-03-24〜2023-06-30）でパラメータを固定した<span className="font-600">後</span>の未見データのみを使っており、
          過学習の影響を受けにくい数字です。全期間ベース（選定期間を含む）はやや高めに出るため参考併記です。
          <br /><br />
          <span className="font-600 text-amber-600 dark:text-amber-400">⚠ あくまでバックテストの数値です。</span>
          上の「フォワード較正進捗」で追跡している実際のライブ成績（Deribitペーパートレード）とは別物で、
          本番反映にはF1〜F4ゲートの90日合格が必要です。年率換算はSC-1/SC-2の生数値を機械的に換算したものであり、
          C品質チームが「年率○%」という形で宣言した文言そのものではありません。
          詳細は<a href="/reports/obs000037-vrp-backtest.html" className="underline hover:text-violet-500">バックテストデータのページ</a>を参照してください。
        </InfoNote>
      </SectionBox>

      {/* F1〜F4 ゲート */}
      <SectionBox title={`F1–F4 ゲート状態（試験値: Day${liveDays} < ${LIVE_TARGET}）`}>
        {s.f2.settledWeeks < 3 && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded text-amber-700 dark:text-amber-400 text-xs">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <span>
              <span className="font-600">確定済みの週が{s.f2.settledWeeks}週しかありません。</span>
              下の赤バッジは「不合格」ではなく、標本が足りず数値が定まっていないだけです。
              実現RVの確定に{meta.rvForwardDays}日かかるため、判定に意味が出るのはDay30以降になります。
            </span>
          </div>
        )}
        <InfoNote>
          本番反映の判定基準となる4つのゲート（spec §7-1）です。
          <span className="font-600">90日ライブ到達（{addDaysUTC(goLive, LIVE_TARGET)}予定）まではすべて「試験値」</span>で、
          正式な採否はC品質チームの較正監査で決まります。
          <br /><br />
          <span className="font-600">F1（実現VRP整合）</span>: 週次の累積ネットがプラスで、かつバックテスト確認期間の統計的下限を下回っていないか。
          <br />
          <span className="font-600">F2（プレミアム存在の再検証）</span>: 実現VRP（IV−RV）がプラスになる週の比率が{F2_POSITIVE_WEEK_RATIO_PCT}%以上か＝プレミアムがライブでも消えていないか。
          <br />
          <span className="font-600">F3（テール被害がサイジング内）</span>: 単一週の実現損失が破産サニティRUIN-1（資本{RUIN1_WEEKLY_LOSS_PCT_OF_CAPITAL}%）を超えた週が0件か。
          <br />
          <span className="font-600">F4（スパイク時のテール挙動）</span>: DVOLが急騰した窓で、②モメンタム・OBS000032キャリーとの相関が|ρ|&lt;{F4_ABS_CORR_MAX}を保つか。
          <br /><br />
          <span className="font-600 text-amber-600 dark:text-amber-400">⚠ F1bとF4はこの画面では算出していません。</span>
          F1bは事前登録したseedでのブロック・ブートストラップ、F4は他スリーブの損益系列との突合が必要で、
          いずれもC品質チームの正式監査で算出されます。この画面が推定値で埋めることはしません（後付けの基準変更を防ぐため）。
        </InfoNote>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <GateBadge value={s.f1.f1a_cumulativePositive} label="F1a 累積ネット>0"
            sub={`累積 ${fmtPct(s.f1.cumulativeWeeklyNetPct)}`}
            pending={s.f2.settledWeeks === 0 ? '確定週なし' : `確定${s.f2.settledWeeks}週の合算`} />
          <GateBadge value={null} label="F1b Bootstrap下限"
            pending="C正式監査で算出（UI未算出）" />
          <GateBadge value={s.f2.f2_gte60pct} label={`F2 VRP>0週比率≥${F2_POSITIVE_WEEK_RATIO_PCT}%`}
            sub={s.f2.positiveWeekRatioPct != null ? `${s.f2.positiveWeekRatioPct.toFixed(1)}%（${s.f2.positiveWeeks}/${s.f2.settledWeeks}週）` : '—'}
            pending={s.f2.settledWeeks < 3 ? '標本週数が少なく参考外' : undefined} />
          <GateBadge value={s.f3.f3_zeroRuin1Breach} label="F3 RUIN-1超過ゼロ"
            sub={`超過 ${s.f3.ruin1BreachWeeks}件 / 最悪週 ${fmtPct(s.f3.worstWeeklyNetPct)}`}
            pending={`閾値 −${RUIN1_WEEKLY_LOSS_PCT_OF_CAPITAL}%（資本比）`} />
          <div className="col-span-2 sm:col-span-4">
            <GateBadge value={null} label={`F4 スパイク窓 |ρ| < ${F4_ABS_CORR_MAX}`}
              sub={`ライブ期のDVOLスパイク発生 ${s.f4.spikeDays}日${s.f4.spikeDates.length > 0 ? `（${s.f4.spikeDates.join(', ')}）` : ''}`}
              pending="相関そのものはC正式監査で算出（UI未算出）。ここではスパイク発生の前向き蓄積のみ表示" />
          </div>
        </div>
      </SectionBox>

      {/* バックテストデータへの導線 */}
      <SectionBox title="バックテストデータ">
        <InfoNote>
          いま見ているのは<span className="font-600">ライブ蓄積中</span>の断面です。
          「そもそもこのプレミアムは過去どれくらいあったのか」を確認したいときは、
          Stage 1で検証した<span className="font-600">週次276点（2021-03-24〜2026-07-01）の全数</span>を
          別ページにまとめてあります。全期間の平均VRP・年別の推移・分布の裾・ライブとの接続部まで、
          生データをそのまま掲載しています。
        </InfoNote>
        <a
          href="/reports/obs000037-vrp-backtest.html"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded border border-violet-400 dark:border-violet-600 bg-violet-50 dark:bg-violet-950/20 text-violet-700 dark:text-violet-300 text-sm font-600 hover:bg-violet-100 dark:hover:bg-violet-950/40 transition-colors"
        >
          <ExternalLink size={15} />
          DVOL・VRPのバックテストデータを開く
        </a>
      </SectionBox>

      {/* IV vs RV */}
      <SectionBox title="DVOL（IV）と事後実現RVの推移">
        <InfoNote>
          <span className="font-600" style={{ color: IV_COLOR }}>オレンジ実線</span>＝オプション市場の予想ボラ（DVOL）、
          <span className="font-600" style={{ color: RV_COLOR }}> 青の破線</span>＝あとから確定した実現ボラ（{meta.rvForwardDays}日先まで）、
          <span className="font-600 text-violet-600 dark:text-violet-400"> 紫の帯</span>＝その差＝VRP（収穫源）。
          帯が厚いほどプレミアムが厚い局面です。緑の縦線がライブ開始（go-live）で、それ以前はwarmup期間です。
        </InfoNote>
        <VrpLevelChart rows={ledger} goLiveDate={goLive} />
      </SectionBox>

      {/* 週次コホート */}
      <SectionBox title="週次コホート純益（F1/F3の判定母集団）">
        <InfoNote>
          <span className="font-600">この戦略の損益は「週次」で数えます。</span>
          go-live起点で7日ごとに1本だけサンプリングした非重複の週（コホート・アンカー）が、
          F1（累積プラス）とF3（テール被害）の判定に使われる正式な母集団です。
          <br />
          <span className="font-600 text-amber-600 dark:text-amber-400">⚠ 日次の全行を単純合計すると約7倍の過大計上になります</span>
          （同じ週のプレミアムを7回数えてしまうため）。この画面の累積値は週次アンカーのみで算出しています。
          <br /><br />
          グレーのバーは「RV確定待ち」の週です。単位は投下資本に対する%です。
        </InfoNote>
        <WeeklyCohortChart snapshot={s} />
      </SectionBox>

      {/* DVOL日次変化 */}
      <SectionBox title="DVOL日次変化とスパイク検出（F4の前向き蓄積）">
        <InfoNote>
          前日比で<span className="font-600 text-red-500">+{meta.fixedParams.dvolSpikeThresholdVolPts} vol pt超</span>
          動いた日を「スパイク」としてマークします（赤いバー）。
          バックテストではコロナショック級のテールがDVOLの取得可能期間（2021年起点）の外側にあり測れないため、
          この前向き蓄積がテール挙動の唯一の実測手段になります。
        </InfoNote>
        <DvolChangeChart rows={ledger} spikeThreshold={meta.fixedParams.dvolSpikeThresholdVolPts} />
      </SectionBox>

      {/* 固定パラメータ */}
      <SectionBox title="固定パラメータ（回す前に確定・変更禁止）">
        <FixedParamsTable meta={meta} />
        <InfoNote>
          これらはspec確定時に数値で固定した値で、結果を見てから調整することは禁止されています（HARKing防止）。
          会計式は <span className="font-mono">net_pnl_pct =（VRP − C_real）× vegaNotionalPct × 100</span> です。
          <br /><br />
          <span className="font-600">なお、OBS000032キャリーにある「90日予測バンド」「損益額シミュレーション」は本実験では表示しません。</span>
          VRPスリーブについてはブロック・ブートストラップによる90日予測が算出されていないためで、
          推定値をこの画面で作って表示することはしません。
        </InfoNote>
      </SectionBox>
    </div>
  );
};
