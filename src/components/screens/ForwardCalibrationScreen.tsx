import { useState, useMemo, useId, type ReactNode } from 'react';
import {
  ComposedChart, AreaChart, BarChart,
  Area, Bar, Cell, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { AlertTriangle, CheckCircle, Clock, TrendingUp } from 'lucide-react';
import { useForwardData, type LedgerRow, type Projection90d, type AssetGateMetrics } from '../../hooks/useForwardData';
import { SectionBox } from '../../ui/components/SectionBox';
import { formatJST } from '../../ui/utils/formatters';

// ── 定数 ─────────────────────────────────────────────────
const W_STAR = { BTC: 3.629, ETH: 3.789 };
const LIVE_TARGET = 90;
// フォワード較正spec（00-spec-forward-calibration.md §0-3）固定値: perpレバレッジ3倍・IMR=1/3、
// 現物レッグは全額自己資本（レバレッジなし）。sleeve_cumulative_return_pct等の生データは
// 「配分資本（証拠金相当額）に対する名目w*倍リターン」であり、投資家が実際に用意する総資金
// （現物フルキャッシュ購入 + perp証拠金）とは異なる。両者を明示的に区別するための定数。
const LEVERAGE = 3;
// 総資金 = 配分資本 × w* × (1 + 1/LEVERAGE)（現物w*倍 + perp証拠金w*/LEVERAGE倍）
// ゆえに「配分資本ベースの%」を CASH_MULTIPLIER で割ると「総資金ベースの%」になる。
const CASH_MULTIPLIER = {
  BTC: W_STAR.BTC * (1 + 1 / LEVERAGE),
  ETH: W_STAR.ETH * (1 + 1 / LEVERAGE),
};
// 総資金の内訳比率（LEVERAGE=3固定のため資産に依存せず一定）: 現物75% / perp証拠金25%
const SPOT_SHARE = LEVERAGE / (LEVERAGE + 1);
const MARGIN_SHARE = 1 / (LEVERAGE + 1);

// ── 小ヘルパー ────────────────────────────────────────────
const fmt1 = (v: number | null | undefined, suffix = '') =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}${suffix}`;
const fmtMoney = (v: number) =>
  v >= 10000 ? `${(v / 10000).toFixed(1)}万円` : `${Math.round(v).toLocaleString()}円`;

// warmup最終日の累積値を求め、live期間の収益率を0基準にするオフセット
const getLiveOffset = (rows: LedgerRow[]) => {
  const warmup = rows.filter(r => r.phase === 'warmup');
  return warmup[warmup.length - 1]?.sleeve_cumulative_return_pct ?? 0;
};

// ── 補足説明ボックス ──────────────────────────────────────
function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] leading-relaxed text-fg-2 bg-fg-4/30 border border-fg-3/50 rounded p-2.5">
      {children}
    </div>
  );
}

// ── ゲート状態バッジ ──────────────────────────────────────
function GateBadge({ value, label, sub }: { value: boolean | null; label: string; sub?: string }) {
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
      {sub && <p className="text-[11px] leading-tight opacity-70">{sub}</p>}
    </div>
  );
}

// ── 累積収益グラフ ─────────────────────────────────────────
function CumulativeChart({ rows, asset }: { rows: LedgerRow[]; asset: 'BTC' | 'ETH' }) {
  const uid = useId();
  const color = asset === 'BTC' ? '#3B82F6' : '#14B8A6';
  const liveOffset = getLiveOffset(rows);
  const liveRows = rows.filter(r => r.phase === 'live');
  const data = liveRows.map((r, i) => ({
    day: i + 1,
    date: r.date_utc.slice(5),
    cum: parseFloat((r.sleeve_cumulative_return_pct - liveOffset).toFixed(3)),
    daily: parseFloat(r.daily_net_pnl_bps.toFixed(3)),
  }));

  if (data.length === 0) return <div className="flex items-center justify-center h-32 text-fg-3 text-sm">ライブデータなし</div>;

  const gradId = `cum-grad-${uid.replace(/:/g,'')}`;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--fg-4)" />
        <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--fg-3)' }} tickLine={false} />
        <YAxis tick={{ fontSize: 11, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false}
          tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`} width={60} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--fg-4)', borderRadius: 4, fontSize: 12 }}
          formatter={(v: number) => [`${v >= 0 ? '+' : ''}${v.toFixed(3)}%`, '累積収益率']}
        />
        <ReferenceLine y={0} stroke="var(--fg-3)" strokeDasharray="2 2" />
        <Area type="monotone" dataKey="cum" stroke={color} strokeWidth={2}
          fill={`url(#${gradId})`} dot={false} name={`${asset}累積収益率(%)`} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ── 90日予測バンドチャート ────────────────────────────────
function ProjectionBandChart({
  rows, proj, asset,
}: { rows: LedgerRow[]; proj: Projection90d | undefined; asset: 'BTC' | 'ETH' }) {
  const accentColor = asset === 'BTC' ? '#3B82F6' : '#14B8A6';
  const wStar = W_STAR[asset];
  const liveOffset = getLiveOffset(rows);
  const liveRows = rows.filter(r => r.phase === 'live');
  const liveDays = liveRows.length;

  const data = useMemo(() => {
    const points: {
      day: number;
      actual: number | null;
      p10base: number | null;
      p10p90band: number | null;
      p50: number | null;
    }[] = [];

    for (let day = 0; day <= LIVE_TARGET; day++) {
      const actualVal = day <= liveDays && day > 0
        ? parseFloat((liveRows[day - 1].sleeve_cumulative_return_pct - liveOffset).toFixed(3))
        : day === 0 ? 0 : null;

      let p10base: number | null = null;
      let p10p90band: number | null = null;
      let p50: number | null = null;

      if (proj?.p10_cumBps != null && proj.p50_cumBps != null && proj.p90_cumBps != null) {
        const toSleeveReturnPct = (cumBps: number) => cumBps * wStar / 10000 * 100;
        const total90_p10 = toSleeveReturnPct(proj.p10_cumBps);
        const total90_p50 = toSleeveReturnPct(proj.p50_cumBps);
        const total90_p90 = toSleeveReturnPct(proj.p90_cumBps);
        const t = day / LIVE_TARGET;
        p10base = parseFloat((total90_p10 * t).toFixed(3));
        p10p90band = parseFloat(((total90_p90 - total90_p10) * t).toFixed(3));
        p50 = parseFloat((total90_p50 * t).toFixed(3));
      }

      points.push({ day, actual: actualVal, p10base, p10p90band, p50 });
    }
    return points;
  }, [liveRows, liveOffset, proj, wStar]);

  const hasProjection = proj?.p50_cumBps != null;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--fg-4)" />
        <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--fg-3)' }} tickLine={false}
          label={{ value: '経過日数', position: 'insideBottomRight', offset: -4, fontSize: 11, fill: 'var(--fg-3)' }} />
        <YAxis tick={{ fontSize: 11, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false}
          tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`} width={60} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--fg-4)', borderRadius: 4, fontSize: 12 }}
          formatter={(v: number, name: string) => {
            if (name === '実績') return [`${v >= 0 ? '+' : ''}${v.toFixed(3)}%`, '実績累積収益率'];
            if (name === 'P50予測') return [`${v >= 0 ? '+' : ''}${v.toFixed(2)}%`, 'P50（中央値）予測'];
            return [v, name];
          }}
        />
        {hasProjection && (
          <>
            {/* P10〜P90バンド: stackedAreaで下部透明・上部着色 */}
            <Area type="monotone" dataKey="p10base" stackId="band"
              stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
            <Area type="monotone" dataKey="p10p90band" stackId="band" name="P10-P90予測幅"
              stroke="none" fill={accentColor} fillOpacity={0.18} isAnimationActive={false} />
            <Line type="monotone" dataKey="p50" stroke={accentColor} strokeWidth={1.5}
              strokeDasharray="6 3" dot={false} name="P50予測" isAnimationActive={false} />
          </>
        )}
        <ReferenceLine x={liveDays} stroke="#F59E0B" strokeWidth={1.5}
          label={{ value: `Day${liveDays}`, position: 'top', fontSize: 10, fill: '#F59E0B' }} />
        <ReferenceLine y={0} stroke="var(--fg-3)" strokeDasharray="2 2" />
        <Line type="monotone" dataKey="actual" stroke="#10B981" strokeWidth={2.5}
          dot={false} name="実績" isAnimationActive={false} connectNulls={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── 日次PnLバーチャート ───────────────────────────────────
function DailyPnlChart({ rows }: { rows: LedgerRow[] }) {
  const liveRows = rows.filter(r => r.phase === 'live');
  const data = liveRows.map((r, i) => ({
    day: i + 1,
    date: r.date_utc.slice(5),
    pnl: parseFloat(r.daily_net_pnl_bps.toFixed(3)),
  }));

  if (data.length === 0) return <div className="flex items-center justify-center h-24 text-fg-3 text-sm">ライブデータなし</div>;

  return (
    <ResponsiveContainer width="100%" height={140}>
      <BarChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--fg-4)" vertical={false} />
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--fg-3)' }} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false}
          tickFormatter={v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`} width={44} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--fg-4)', borderRadius: 4, fontSize: 12 }}
          formatter={(v: number) => [`${v >= 0 ? '+' : ''}${v.toFixed(3)} bps`, '日次純損益']}
        />
        <ReferenceLine y={0} stroke="var(--fg-3)" />
        <Bar dataKey="pnl" isAnimationActive={false}>
          {data.map((entry, i) => (
            <Cell key={i} fill={entry.pnl >= 0 ? '#10B981' : '#EF4444'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ── F1-F4ゲートセクション ──────────────────────────────────
function GateSection({ metrics, asset }: { metrics: AssetGateMetrics; asset: 'BTC' | 'ETH' }) {
  const { f1, f2, f3, f4 } = metrics;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <GateBadge value={f1.f1a_cumulativePositive} label="F1a 累積プラス"
        sub={`累積 ${f1.cumulativeLivePnlBps.toFixed(2)} bps`} />
      <GateBadge value={f1.f1b_liveMeanGteLowerBound} label="F1b Bootstrap下限"
        sub={f1.f1bLowerBoundBps != null ? `下限 ${f1.f1bLowerBoundBps.toFixed(3)} bps` : undefined} />
      <GateBadge value={f2.f2_gte80pct} label="F2 符号一致率≥80%"
        sub={f2.eventSignAgreementPct != null ? `${f2.eventSignAgreementPct.toFixed(1)}%` : `${f2.eventPairsCount}ペア`} />
      <GateBadge value={f3.f3_zeroLiquidationAndMarginCall} label="F3 清算ゼロ"
        sub={`清算 ${f3.liquidationCount} / 追証 ${f3.marginCallCount}`} />
      <div className="col-span-2 sm:col-span-4">
        <GateBadge value={f4.f4_lteT1Threshold} label="F4 Basis変動≤T1"
          sub={`実測 ${f4.liveBasisDailyDeltaStdBps?.toFixed(2) ?? '—'} bps / T1閾値 ${f4.t1ThresholdBps.toFixed(2)} bps`} />
      </div>
    </div>
  );
}

// ── 損益額 進捗チャート ────────────────────────────────────
// series: 表示対象の資産1つ、または複数（複数の場合は日毎に単純平均する＝「平均」表示用）
// principalは投資家が実際に用意する総資金（現物フルキャッシュ＋perp証拠金の合計）として扱う。
function ProfitProjectionChart({
  series, principal, color,
}: { series: { rows: LedgerRow[]; proj: Projection90d | undefined; wStar: number; cashMultiplier: number }[]; principal: number; color: string }) {
  const liveDays = Math.max(...series.map(s => s.rows.filter(r => r.phase === 'live').length), 0);

  const data = useMemo(() => {
    const points: {
      day: number;
      actual: number | null;
      p10base: number | null;
      p10p90band: number | null;
      p50: number | null;
    }[] = [];

    for (let day = 0; day <= LIVE_TARGET; day++) {
      // 実績（%）: 対象資産（複数なら単純平均）の当日累積収益率（配分資本ベース→総資金ベースに換算）
      const actualPcts: number[] = [];
      let actualMissing = false;
      for (const s of series) {
        const liveOffset = getLiveOffset(s.rows);
        const liveRows = s.rows.filter(r => r.phase === 'live');
        if (day === 0) { actualPcts.push(0); continue; }
        if (day > liveRows.length) { actualMissing = true; break; }
        actualPcts.push((liveRows[day - 1].sleeve_cumulative_return_pct - liveOffset) / s.cashMultiplier);
      }
      const actualVal = !actualMissing
        ? Math.round(principal * (actualPcts.reduce((a, b) => a + b, 0) / actualPcts.length) / 100)
        : null;

      // 予測（金額）: 対象資産（複数なら単純平均）のP10/P50/P90（総資金principalベース）
      let p10base: number | null = null;
      let p10p90band: number | null = null;
      let p50: number | null = null;
      const amounts10: number[] = [];
      const amounts50: number[] = [];
      const amounts90: number[] = [];
      let projMissing = false;
      for (const s of series) {
        if (s.proj?.p10_cumBps == null || s.proj.p50_cumBps == null || s.proj.p90_cumBps == null) { projMissing = true; break; }
        const toAmount = (cumBps: number) => principal * (cumBps * s.wStar / 10000) / s.cashMultiplier;
        amounts10.push(toAmount(s.proj.p10_cumBps));
        amounts50.push(toAmount(s.proj.p50_cumBps));
        amounts90.push(toAmount(s.proj.p90_cumBps));
      }
      if (!projMissing) {
        const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
        const total90_p10 = avg(amounts10);
        const total90_p50 = avg(amounts50);
        const total90_p90 = avg(amounts90);
        const t = day / LIVE_TARGET;
        p10base = Math.round(total90_p10 * t);
        p10p90band = Math.round((total90_p90 - total90_p10) * t);
        p50 = Math.round(total90_p50 * t);
      }

      points.push({ day, actual: actualVal, p10base, p10p90band, p50 });
    }
    return points;
  }, [series, principal]);

  const hasProjection = data.some(d => d.p50 != null);

  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--fg-4)" />
        <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--fg-3)' }} tickLine={false}
          label={{ value: '経過日数', position: 'insideBottomRight', offset: -4, fontSize: 11, fill: 'var(--fg-3)' }} />
        <YAxis tick={{ fontSize: 11, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false}
          tickFormatter={v => fmtMoney(v)} width={72} />
        <Tooltip
          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--fg-4)', borderRadius: 4, fontSize: 12 }}
          formatter={(v: number, name: string) => {
            if (name === '実績') return [fmtMoney(v), '実績損益額'];
            if (name === 'P50予測') return [fmtMoney(v), 'P50（中央値）予測損益額'];
            return [v, name];
          }}
        />
        {hasProjection && (
          <>
            <Area type="monotone" dataKey="p10base" stackId="band"
              stroke="none" fill="transparent" legendType="none" isAnimationActive={false} />
            <Area type="monotone" dataKey="p10p90band" stackId="band" name="P10-P90予測幅"
              stroke="none" fill={color} fillOpacity={0.18} isAnimationActive={false} />
            <Line type="monotone" dataKey="p50" stroke={color} strokeWidth={1.5}
              strokeDasharray="6 3" dot={false} name="P50予測" isAnimationActive={false} />
          </>
        )}
        <ReferenceLine x={liveDays} stroke="#F59E0B" strokeWidth={1.5}
          label={{ value: `Day${liveDays}`, position: 'top', fontSize: 10, fill: '#F59E0B' }} />
        <ReferenceLine y={0} stroke="var(--fg-3)" strokeDasharray="2 2" />
        <Line type="monotone" dataKey="actual" stroke="#10B981" strokeWidth={2.5}
          dot={false} name="実績" isAnimationActive={false} connectNulls={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── 収益シミュレーション ──────────────────────────────────
function SimulationPanel({
  btcRows, ethRows, btcProj, ethProj,
}: {
  btcRows: LedgerRow[];
  ethRows: LedgerRow[];
  btcProj?: Projection90d;
  ethProj?: Projection90d;
}) {
  const [principal, setPrincipal] = useState(1000000);
  const [simAsset, setSimAsset] = useState<'AVG' | 'BTC' | 'ETH'>('AVG');

  const btcLive = btcRows.filter(r => r.phase === 'live');
  const ethLive = ethRows.filter(r => r.phase === 'live');
  const btcOffset = getLiveOffset(btcRows);
  const ethOffset = getLiveOffset(ethRows);

  // 現在の実績累積収益率（配分資本ベース・ライブ開始基準）
  const btcActualPctAlloc = (btcLive[btcLive.length - 1]?.sleeve_cumulative_return_pct ?? btcOffset) - btcOffset;
  const ethActualPctAlloc = (ethLive[ethLive.length - 1]?.sleeve_cumulative_return_pct ?? ethOffset) - ethOffset;
  // 総資金（現物フルキャッシュ＋perp証拠金）ベースに換算＝投資家が実際に用意する金額に対する利回り
  const btcActualPct = btcActualPctAlloc / CASH_MULTIPLIER.BTC;
  const ethActualPct = ethActualPctAlloc / CASH_MULTIPLIER.ETH;
  const avgActualPct = (btcActualPct + ethActualPct) / 2;

  // 90日予測（P10/P50/P90 sleeve return %・配分資本ベース→総資金ベースに換算）
  const toSleeveRet = (proj: Projection90d | undefined, ws: number, cashMultiplier: number) => {
    if (!proj?.p10_cumBps) return null;
    return {
      p10: (proj.p10_cumBps * ws / 10000 * 100) / cashMultiplier,
      p50: (proj.p50_cumBps! * ws / 10000 * 100) / cashMultiplier,
      p90: (proj.p90_cumBps! * ws / 10000 * 100) / cashMultiplier,
    };
  };
  const btcRet = toSleeveRet(btcProj, W_STAR.BTC, CASH_MULTIPLIER.BTC);
  const ethRet = toSleeveRet(ethProj, W_STAR.ETH, CASH_MULTIPLIER.ETH);

  const avgP50Pct = btcRet && ethRet ? (btcRet.p50 + ethRet.p50) / 2 : null;
  const avgP10Pct = btcRet && ethRet ? (btcRet.p10 + ethRet.p10) / 2 : null;
  const avgP90Pct = btcRet && ethRet ? (btcRet.p90 + ethRet.p90) / 2 : null;

  const STEPS = [100000, 300000, 500000, 1000000, 3000000, 5000000, 10000000];

  // 選択中の資産に応じた表示切替
  const viewByAsset = {
    AVG: { actualPct: avgActualPct, p10: avgP10Pct, p50: avgP50Pct, p90: avgP90Pct, color: '#8B5CF6', label: '平均（BTC+ETH）' },
    BTC: { actualPct: btcActualPct, p10: btcRet?.p10 ?? null, p50: btcRet?.p50 ?? null, p90: btcRet?.p90 ?? null, color: '#3B82F6', label: 'BTC' },
    ETH: { actualPct: ethActualPct, p10: ethRet?.p10 ?? null, p50: ethRet?.p50 ?? null, p90: ethRet?.p90 ?? null, color: '#14B8A6', label: 'ETH' },
  } as const;
  const view = viewByAsset[simAsset];

  return (
    <div className="space-y-4">
      {/* 元本スライダー */}
      <div>
        <label className="text-sm font-600 mb-2 block">投資元本: {fmtMoney(principal)}</label>
        <input
          type="range" min={0} max={STEPS.length - 1} step={1}
          value={STEPS.indexOf(principal) >= 0 ? STEPS.indexOf(principal) : 3}
          onChange={e => setPrincipal(STEPS[Number(e.target.value)])}
          className="w-full accent-blue-500"
        />
        <div className="flex justify-between text-[10px] text-fg-3 mt-1">
          <span>10万</span><span>30万</span><span>50万</span><span>100万</span><span>300万</span><span>500万</span><span>1000万</span>
        </div>
      </div>

      {/* 資金内訳（デルタニュートラル・ポジションを建てるのに実際に必要な資金の内訳） */}
      <InfoNote>
        この元本{fmtMoney(principal)}を投資すると、資産ごとに以下の内訳で資金を使います
        （perpレバレッジ{LEVERAGE}倍・現物は全額自己資本のため、比率は資産によらず一定）：
        <span className="font-600"> 現物購入 {fmtMoney(principal * SPOT_SHARE)}（{(SPOT_SHARE * 100).toFixed(0)}%）</span>
        ＋
        <span className="font-600"> perp証拠金 {fmtMoney(principal * MARGIN_SHARE)}（{(MARGIN_SHARE * 100).toFixed(0)}%）</span>
        。下記の利回り・損益額は、この「投資家が実際に用意する総資金」に対する数値です。
      </InfoNote>

      {/* 資産選択タブ */}
      <div className="flex gap-2">
        {(['AVG', 'BTC', 'ETH'] as const).map(a => (
          <button key={a} onClick={() => setSimAsset(a)}
            className={`px-3 py-1 rounded text-xs font-600 border transition-colors ${simAsset === a ? 'text-white' : 'border-fg-3 text-fg-2 hover:border-blue-400'}`}
            style={simAsset === a ? { backgroundColor: viewByAsset[a].color, borderColor: viewByAsset[a].color } : undefined}>
            {viewByAsset[a].label}
          </button>
        ))}
      </div>

      {/* 結果グリッド */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="border border-fg-3 rounded p-3">
          <p className="text-[11px] text-fg-3 mb-1">現在の実績収益</p>
          <p className={`text-xl font-700 font-mono tabular-nums ${view.actualPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
            {fmt1(view.actualPct, '%')}
          </p>
          <p className={`text-sm font-mono ${view.actualPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
            {fmtMoney(principal * view.actualPct / 100)}
          </p>
        </div>
        <div className="border border-fg-3 rounded p-3 opacity-60">
          <p className="text-[11px] text-fg-3 mb-1">90日予測 P10（悲観）</p>
          <p className="text-xl font-700 font-mono tabular-nums text-red-400">
            {view.p10 != null ? fmt1(view.p10, '%') : '—'}
          </p>
          <p className="text-sm font-mono text-red-400">
            {view.p10 != null ? fmtMoney(principal * view.p10 / 100) : '—'}
          </p>
        </div>
        <div className="border border-blue-400 dark:border-blue-600 rounded p-3 bg-blue-50 dark:bg-blue-950/20">
          <p className="text-[11px] text-blue-600 dark:text-blue-400 mb-1">90日予測 P50（中央値）</p>
          <p className="text-xl font-700 font-mono tabular-nums text-blue-600 dark:text-blue-400">
            {view.p50 != null ? fmt1(view.p50, '%') : '—'}
          </p>
          <p className="text-sm font-mono text-blue-600 dark:text-blue-400">
            {view.p50 != null ? fmtMoney(principal * view.p50 / 100) : '—'}
          </p>
        </div>
        <div className="border border-fg-3 rounded p-3 opacity-60">
          <p className="text-[11px] text-fg-3 mb-1">90日予測 P90（楽観）</p>
          <p className="text-xl font-700 font-mono tabular-nums text-emerald-500">
            {view.p90 != null ? fmt1(view.p90, '%') : '—'}
          </p>
          <p className="text-sm font-mono text-emerald-500">
            {view.p90 != null ? fmtMoney(principal * view.p90 / 100) : '—'}
          </p>
        </div>
      </div>

      {/* 進捗による予測損益額の推移チャート */}
      <div>
        <p className="text-xs font-600 text-fg-2 mb-2">
          予測損益額の推移（{view.label}・元本{fmtMoney(principal)}時）
        </p>
        <ProfitProjectionChart
          series={
            simAsset === 'AVG'
              ? [
                  { rows: btcRows, proj: btcProj, wStar: W_STAR.BTC, cashMultiplier: CASH_MULTIPLIER.BTC },
                  { rows: ethRows, proj: ethProj, wStar: W_STAR.ETH, cashMultiplier: CASH_MULTIPLIER.ETH },
                ]
              : simAsset === 'ETH'
              ? [{ rows: ethRows, proj: ethProj, wStar: W_STAR.ETH, cashMultiplier: CASH_MULTIPLIER.ETH }]
              : [{ rows: btcRows, proj: btcProj, wStar: W_STAR.BTC, cashMultiplier: CASH_MULTIPLIER.BTC }]
          }
          principal={principal}
          color={view.color}
        />
      </div>

      {(btcProj?.reliabilityNote || ethProj?.reliabilityNote) && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          ⚠ {btcProj?.reliabilityNote ?? ethProj?.reliabilityNote} — calm期間基準のため楽観バイアスあり
        </p>
      )}
    </div>
  );
}

// ── メイン画面 ────────────────────────────────────────────
export const ForwardCalibrationScreen = () => {
  const { data, loading, error } = useForwardData();
  const [asset, setAsset] = useState<'BTC' | 'ETH'>('BTC');

  if (loading) return (
    <div className="p-6 space-y-4">
      <h1 className="text-h1 font-700">フォワード較正モニター</h1>
      <div className="text-fg-2">読み込み中…</div>
    </div>
  );

  if (error || !data) return (
    <div className="p-6 space-y-4">
      <h1 className="text-h1 font-700">フォワード較正モニター</h1>
      <div className="text-red-500">エラー: {error ?? 'データが見つかりません'}</div>
    </div>
  );

  const { metrics, btcLedger, ethLedger } = data;
  const ledger = asset === 'BTC' ? btcLedger : ethLedger;
  const liveOffset = getLiveOffset(ledger);
  const liveRows = ledger.filter(r => r.phase === 'live');
  const liveDays = metrics.liveDaysCount[asset];
  const gateMetrics = metrics.f1234[asset];
  const proj = metrics.projection90d?.[asset];
  const progressPct = Math.min(100, (liveDays / LIVE_TARGET) * 100);
  // ライブ開始基準の現在累積収益率
  const liveCumPct = (liveRows[liveRows.length - 1]?.sleeve_cumulative_return_pct ?? liveOffset) - liveOffset;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-h1 font-700 flex items-center gap-2">
            <TrendingUp size={22} className="text-blue-500" />
            フォワード較正モニター
          </h1>
          <p className="text-sm text-fg-2">OBS000032 · EXP デルタニュートラル・キャリー戦略</p>
        </div>
        <div className="text-right">
          <p className="text-[11px] text-fg-3">最終更新（JST）</p>
          <p className="text-xs font-mono text-fg-2">{formatJST(metrics.generatedAtUTC)}</p>
        </div>
      </div>

      {/* アラート */}
      {metrics.alertActive && (
        <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-700 rounded text-red-600 dark:text-red-400 text-sm">
          <AlertTriangle size={16} />
          <span className="font-600">チェックポイント警告が発火しています — forward-alerts.log を確認してください</span>
        </div>
      )}

      {/* 進捗バー */}
      <SectionBox title={`フォワード較正進捗 — Day ${liveDays} / ${LIVE_TARGET}`}>
        <div className="space-y-2">
          <div className="w-full bg-fg-4 rounded-full h-3">
            <div className="bg-blue-500 h-3 rounded-full transition-all" style={{ width: `${progressPct}%` }} />
          </div>
          <div className="flex justify-between text-xs text-fg-3 font-mono">
            <span>Go-live 2026-07-04</span>
            <span className="text-amber-600 dark:text-amber-400 font-600">Day {liveDays}/90 ({progressPct.toFixed(1)}%)</span>
            <span>Day 90 2026-10-02</span>
          </div>
          <div className="grid grid-cols-3 gap-2 mt-2">
            {[{ label: 'Day 30', date: '2026-08-03' }, { label: 'Day 60', date: '2026-09-02' }, { label: 'Day 90 正式判定', date: '2026-10-02' }].map(m => (
              <div key={m.label} className={`text-center text-[11px] py-1 rounded border ${liveDays >= parseInt(m.label.match(/\d+/)?.[0] ?? '0') ? 'border-emerald-400 text-emerald-600 dark:text-emerald-400' : 'border-fg-3 text-fg-3'}`}>
                <div className="font-600">{m.label}</div>
                <div>{m.date}</div>
              </div>
            ))}
          </div>
        </div>
      </SectionBox>

      {/* 用語ミニガイド: bps */}
      <InfoNote>
        <span className="font-600">bps（ベーシスポイント）</span>とは「1万分の1」を表す単位です（1bps = 0.01%）。
        金利や利回りのようなごく小さな変化率を扱う際に使われ、例えば「10bps」は「0.1%」を意味します。
        下記の各セクションで頻出するので、迷ったらここに戻ってきてください。
      </InfoNote>

      {/* 資産タブ */}
      <div className="flex gap-2">
        {(['BTC', 'ETH'] as const).map(a => (
          <button key={a} onClick={() => setAsset(a)}
            className={`px-4 py-1.5 rounded text-sm font-600 border transition-colors ${asset === a ? 'bg-blue-500 border-blue-500 text-white' : 'border-fg-3 text-fg-2 hover:border-blue-400'}`}>
            {a}
          </button>
        ))}
      </div>

      {/* F1-F4 ゲート */}
      <SectionBox title={`F1–F4 ゲート状態 — ${asset}（試験値: Day${liveDays} < 90）`}>
        <InfoNote>
          本番反映の判定基準となる4つのゲートです。<span className="font-600">90日ライブ到達（2026-10-02予定）まではすべて「試験値」</span>で、正式な採否はC品質チームの較正監査で決まります。
          <br /><br />
          <span className="font-600">F1（ネットキャリー）</span>: 日々の純損益が①累積でプラス基調か（F1a）、②バックテスト平時（calm）水準の統計的下限を上回っているか（F1b）。
          <br />
          <span className="font-600">F2（取引所間の符号一致率）</span>: 実運用先Bitgetと参照先Binanceで、Funding金利の方向（プラス/マイナス）が80%以上一致しているか＝データの構造的な整合性の確認。
          <br />
          <span className="font-600">F3（清算・追証ゼロ）</span>: デルタニュートラル・ポジションが証拠金不足で強制清算・追証扱いになっていないか（0件が正常）。
          <br />
          <span className="font-600">F4（Basis変動幅）</span>: 現物とperp先物の価格差（ベーシス）の日々の変動が、バックテストの最大ストレス期（コロナショック時=T1）の水準を超えていないか。
        </InfoNote>
        <GateSection metrics={gateMetrics} asset={asset} />
      </SectionBox>

      {/* 累積収益率グラフ */}
      <SectionBox title={`累積スリーブ収益率 — ${asset}`}>
        <InfoNote>
          「スリーブ」とは、この戦略単体（現物ロング＋perpショートを同量保有し、価格変動の影響を打ち消す＝デルタニュートラル）が生み出す損益のことです。
          方向を当てにいかず、Funding金利差とベーシス（現物・先物の価格差）から生じる収益だけを積み上げます。
          グラフはライブ開始日（2026-07-04）を0%として、その後の累積収益率（%）の推移を示します。
          <br /><br />
          <span className="font-600">⚠ この%は「証拠金（配分資本）」に対する名目利回り</span>です。投資家が実際に用意する総資金（現物購入＋perp証拠金の合計）に対する利回りに換算すると、
          {asset === 'BTC' ? `約1/${CASH_MULTIPLIER.BTC.toFixed(2)}` : `約1/${CASH_MULTIPLIER.ETH.toFixed(2)}`}に薄まります（下記「損益額シミュレーション」は総資金ベースで換算済みです）。
        </InfoNote>
        {liveRows.length > 0 ? (
          <>
            <div className="flex items-baseline gap-3 mb-3">
              <span className={`text-2xl font-700 font-mono tabular-nums ${liveCumPct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
                {fmt1(liveCumPct, '%')}
              </span>
              <span className="text-sm text-fg-3">Day {liveDays} 時点（ライブ開始比）</span>
            </div>
            <CumulativeChart rows={ledger} asset={asset} />
          </>
        ) : <div className="text-fg-2 text-sm py-4">ライブデータ蓄積待ち</div>}
      </SectionBox>

      {/* 90日予測バンド */}
      <SectionBox title={`90日予測バンド（P10/P50/P90）— ${asset}`}>
        <InfoNote>
          バックテストの平時（calm）相場データを使い、統計的な再抽出手法（ブロック・ブートストラップ法・5,000回試行）で「90日後にどのくらいの収益になりそうか」の分布を推定したものです。
          <br /><br />
          <span className="font-600 text-red-400">P10</span>＝下位10%点（悲観的な下振れシナリオ）、
          <span className="font-600 text-blue-500"> P50</span>＝中央値（最も可能性が高いシナリオ）、
          <span className="font-600 text-emerald-500"> P90</span>＝上位10%点（楽観的な上振れシナリオ）を表します。
          <br /><br />
          チャートの見方：<span className="text-emerald-500 font-600">緑の実線</span>が実績の累積収益率、
          <span className="font-600" style={{ color: asset === 'BTC' ? '#3B82F6' : '#14B8A6' }}> 点線</span>がP50予測の推移、
          帯（塗りつぶし部分）がP10〜P90の予測幅です。オレンジの縦線が「現在地点（Day{liveDays}）」を示します。
          日数が浅いうちは予測の信頼度が低く、Day30以降で徐々に精度が上がります。
          <br /><br />
          <span className="font-600">⚠ この%も「証拠金（配分資本）」に対する名目利回り</span>です（上の累積収益率グラフと同じ換算率が適用されます）。
        </InfoNote>
        {proj ? (
          <>
            <div className="grid grid-cols-3 gap-2 mb-3 text-center">
              <div className="text-[11px]"><span className="text-red-400 font-600">P10</span><br />
                <span className="font-mono text-sm">{proj.p10_cumBps != null ? `${(proj.p10_cumBps * W_STAR[asset] / 10000 * 100).toFixed(2)}%` : '—'}</span>
              </div>
              <div className="text-[11px]"><span className="text-blue-500 font-600">P50（中央値）</span><br />
                <span className="font-mono text-sm font-700">{proj.p50_cumBps != null ? `${(proj.p50_cumBps * W_STAR[asset] / 10000 * 100).toFixed(2)}%` : '—'}</span>
              </div>
              <div className="text-[11px]"><span className="text-emerald-500 font-600">P90</span><br />
                <span className="font-mono text-sm">{proj.p90_cumBps != null ? `${(proj.p90_cumBps * W_STAR[asset] / 10000 * 100).toFixed(2)}%` : '—'}</span>
              </div>
            </div>
            <ProjectionBandChart rows={ledger} proj={proj} asset={asset} />
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-2">
              ⚠ {proj.reliabilityNote}
            </p>
          </>
        ) : (
          <div className="text-fg-3 text-sm py-4">
            projection90d は次回のGitHub Actions実行（毎日10:00 JST）後に表示されます。
          </div>
        )}
      </SectionBox>

      {/* 日次PnL */}
      <SectionBox title={`日次純損益 (bps) — ${asset}`}>
        <p className="text-xs text-fg-3 mb-2">ライブ期間のみ表示。上=収益、下=損失（単位はbps＝1万分の1）</p>
        <DailyPnlChart rows={ledger} />
      </SectionBox>

      {/* 収益シミュレーション */}
      <SectionBox title="損益額シミュレーション">
        <InfoNote>
          ここで入力する「投資元本」は、<span className="font-600">投資家が実際に用意する総資金</span>
          （現物ロング購入費用＋perpショート証拠金の合計）を指します。上の「累積スリーブ収益率」「90日予測バンド」の%は
          証拠金（配分資本）に対する名目利回りのため、このシミュレーションではperpレバレッジ{LEVERAGE}倍を踏まえて
          総資金ベースの実効利回りに換算してから金額を試算しています。
          「平均」はBTC・ETH両スリーブにそれぞれ同額の元本を投資した場合の想定値、「BTC」「ETH」は各資産単体の想定値です。
          下のチャートは、選択した元本に対する予測損益額が、経過日数に応じてどう変化していくかを示します。
        </InfoNote>
        <SimulationPanel
          btcRows={btcLedger} ethRows={ethLedger}
          btcProj={metrics.projection90d?.BTC}
          ethProj={metrics.projection90d?.ETH}
        />
      </SectionBox>
    </div>
  );
};
