import { useState } from 'react';
import {
  AreaChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { AlertTriangle, Download, ExternalLink, Info, Target, X } from 'lucide-react';
import { useSysFx012ForwardData, type SysFx012Trade } from '../../hooks/useSysFx012ForwardData';
import { SectionBox } from '../../ui/components/SectionBox';
import { formatJST } from '../../ui/utils/formatters';

const ACCENT = '#F97316'; // SYS-FX012（orange、carryのblue・VRPのvioletと区別）
const INITIAL_CAPITAL = 1000;

// minmax-fx-day-trading-lab側の凍結済みバックテスト結果(候補①=N_BREAKOUT単独+
// H1トレンド判定不能除外フィルター、4通貨、Train/Validation合計KPI13/18)。
// 確認済み・以後変化しない値のためハードコード(VrpForwardScreenのBACKTEST_CONFIRM
// と同じ扱い)。出典: research/method-notes/vol_breakout_trendfilter_candidate1_validation_backtest.json
// (2026-08-29再評価版のtrain_reference/validationフィールド。OBS000009不具合1＝先読み
// (エントリー起点がH1バー始値になっていた)の修正〔bar_close_anchored=True、2026-08-28〕を
// 反映した数値。修正前(2026-08-21確認)はTrain: Sharpe2.397/PF1.759/ペイオフ1.078/DD8.69%/
// permP0.031/n=300、Validation: Sharpe1.704/PF2.279/ペイオフ1.376/DD7.28%/permP0.0999/n=85
// だった。必須KPI通過数(7/9・6/9)自体は不変)。
const BACKTEST_TRAIN = {
  period: '2023-11-01 〜 2025-03-31', nTradesEffective: 308, winRate: 0.6071,
  monthlySharpe: 2.656, profitFactor: 1.713, payoffRatio: 1.108,
  maxDdPct: 8.78, permP: 0.048, kpiPass: '7/9',
};
const BACKTEST_VALIDATION = {
  period: '2025-04-01 〜 2025-11-30', nTradesEffective: 83, winRate: 0.6386,
  monthlySharpe: 1.654, profitFactor: 2.407, payoffRatio: 1.362,
  maxDdPct: 8.19, permP: 0.0919, kpiPass: '6/9',
};

// フォワードテストのチェックポイント日程(00-spec.md「フォワードテスト仕様」節で事前登録済み)。
const FORWARD_CUTOFF_ISO = '2026-08-15';
const CHECKPOINTS = [
  { days: 30, label: '30日', dateIso: '2026-09-14' },
  { days: 60, label: '60日', dateIso: '2026-10-14' },
  { days: 90, label: '90日', dateIso: '2026-11-13' },
] as const;

// ── 小ヘルパー ────────────────────────────────────────────
const signed = (v: number, digits: number, suffix = '') =>
  `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`;
const fmtUsd = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (v: number | null | undefined, digits = 1) => (v == null ? '—' : signed(v, digits, '%'));
const fmtNum = (v: number | null | undefined, digits = 3) => (v == null ? '—' : v.toFixed(digits));
const daysSince = (isoLike: string): number => {
  const start = new Date(isoLike.replace(' ', 'T'));
  if (Number.isNaN(start.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - start.getTime()) / 86_400_000));
};

// ── ペア別統計計算 ──────────────────────────────────────────
interface PairStats {
  pair: string;
  nTrades: number;
  nWins: number;
  nLosses: number;
  winRate: number;
  totalPnL: number;
  totalR: number;
  avgR: number;
  maxR: number;
  minR: number;
}

function calculatePairStats(trades: SysFx012Trade[]): PairStats[] {
  const pairMap = new Map<string, SysFx012Trade[]>();
  trades.forEach(t => {
    if (!pairMap.has(t.pair)) pairMap.set(t.pair, []);
    pairMap.get(t.pair)!.push(t);
  });

  return Array.from(pairMap.entries()).map(([pair, pairTrades]) => {
    const closed = pairTrades.filter(t => t.dollar_pnl != null);
    const wins = closed.filter(t => (t.dollar_pnl as number) >= 0);
    const losses = closed.filter(t => (t.dollar_pnl as number) < 0);
    const totalPnL = closed.reduce((sum, t) => sum + (t.dollar_pnl || 0), 0);
    const totalR = closed.reduce((sum, t) => sum + (t.r_net || 0), 0);

    return {
      pair,
      nTrades: closed.length,
      nWins: wins.length,
      nLosses: losses.length,
      winRate: closed.length > 0 ? wins.length / closed.length : 0,
      totalPnL,
      totalR,
      avgR: closed.length > 0 ? totalR / closed.length : 0,
      maxR: closed.length > 0 ? Math.max(...closed.map(t => t.r_net)) : 0,
      minR: closed.length > 0 ? Math.min(...closed.map(t => t.r_net)) : 0,
    };
  }).sort((a, b) => b.nTrades - a.nTrades);
}

function StatTile({ label, value, sub, tone = 'neutral' }: {
  label: string; value: string; sub?: string; tone?: 'neutral' | 'pos' | 'neg' | 'accent';
}) {
  const valueColor =
    tone === 'pos' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'neg' ? 'text-red-500'
    : tone === 'accent' ? 'text-[#F97316]'
    : 'text-fg-1';
  return (
    <div className="border border-fg-3 rounded p-3">
      <p className="text-[11px] text-fg-3 mb-1">{label}</p>
      <p className={`text-xl font-700 font-mono tabular-nums ${valueColor}`}>{value}</p>
      {sub && <p className="text-[10px] text-fg-3 mt-1">{sub}</p>}
    </div>
  );
}

function InfoNote({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'warn' }) {
  const cls = tone === 'warn'
    ? 'text-[11px] leading-relaxed text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded p-2.5'
    : 'text-[11px] leading-relaxed text-fg-2 bg-fg-4/30 border border-fg-3/50 rounded p-2.5';
  return <div className={cls}>{children}</div>;
}

// ── チェックポイント進捗バー(cutoff→90日、30/60/90日の目盛り) ──────
function CheckpointProgress({ elapsedDays }: { elapsedDays: number }) {
  const horizon = 90;
  const pct = Math.min(100, (elapsedDays / horizon) * 100);
  const nextCheckpoint = CHECKPOINTS.find(c => elapsedDays < c.days);
  return (
    <div>
      <div className="relative h-2 rounded-full bg-fg-4/50 overflow-visible">
        <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: ACCENT }} />
        {CHECKPOINTS.map(c => (
          <div key={c.days} className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-fg-1/40"
            style={{ left: `${(c.days / horizon) * 100}%` }} title={`${c.label}チェックポイント (${c.dateIso})`} />
        ))}
      </div>
      <div className="flex justify-between mt-1">
        {CHECKPOINTS.map(c => (
          <span key={c.days} className={`text-[10px] font-mono ${elapsedDays >= c.days ? 'text-fg-2' : 'text-fg-3'}`}>
            {c.label}{elapsedDays >= c.days && '✓'}
          </span>
        ))}
      </div>
      <p className="text-[11px] text-fg-3 mt-1.5">
        開始から{elapsedDays}日経過
        {nextCheckpoint
          ? `（次の${nextCheckpoint.label}チェックポイントまであと${nextCheckpoint.days - elapsedDays}日、${nextCheckpoint.dateIso}予定）`
          : '（全チェックポイント到達済み）'}
      </p>
    </div>
  );
}

// ── 残高推移チャート ──────────────────────────────────────
function EquityChart({ points, elapsedDays }: { points: { time: string; balance: number }[]; elapsedDays: number }) {
  return (
    <div className="space-y-3">
      <CheckpointProgress elapsedDays={elapsedDays} />
      {points.length < 2 ? (
        <div className="flex items-center justify-center h-32 text-fg-3 text-sm">データ蓄積中（まだ決済済みトレードなし）</div>
      ) : (
        <ResponsiveContainer width="100%" height={230}>
          <AreaChart data={points.map(p => ({ time: p.time.slice(0, 16), balance: p.balance }))}
            margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="sysfx012Fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity={0.25} />
                <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--fg-4)" />
            <XAxis dataKey="time" tick={{ fontSize: 10, fill: 'var(--fg-3)' }} tickLine={false}
              tickFormatter={v => String(v).slice(5, 10)} />
            <YAxis tick={{ fontSize: 11, fill: 'var(--fg-3)' }} tickLine={false} axisLine={false}
              width={56} domain={['auto', 'auto']} tickFormatter={v => `$${Math.round(v).toLocaleString('en-US')}`} />
            <Tooltip
              contentStyle={{ background: 'var(--surface)', border: '1px solid var(--fg-4)', borderRadius: 4, fontSize: 12 }}
              formatter={(v: number) => [fmtUsd(v), '残高']}
              labelFormatter={l => String(l)}
            />
            <ReferenceLine y={INITIAL_CAPITAL} stroke="var(--fg-3)" strokeDasharray="3 4"
              label={{ value: '初期資金 $1,000', position: 'insideTopRight', fontSize: 9, fill: 'var(--fg-3)' }} />
            <Area type="stepAfter" dataKey="balance" stroke="none" fill="url(#sysfx012Fill)" isAnimationActive={false} />
            <Line type="stepAfter" dataKey="balance" stroke={ACCENT} strokeWidth={2} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ── トレード台帳テーブル ──────────────────────────────────
function TradeTable({
  trades,
  selectedIndex,
  onSelectTrade,
}: {
  trades: SysFx012Trade[];
  selectedIndex: number | null;
  onSelectTrade: (index: number) => void;
}) {
  if (trades.length === 0) {
    return <p className="text-sm text-fg-3 py-4 text-center">まだ検出イベントからトレードは生成されていません</p>;
  }
  const rows = [...trades].reverse(); // 新しい順
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-fg-3 border-b border-fg-3/50">
            <th className="text-left py-1.5 pr-2">通貨</th>
            <th className="text-left py-1.5 pr-2">方向</th>
            <th className="text-left py-1.5 pr-2">エントリー</th>
            <th className="text-left py-1.5 pr-2">決済</th>
            <th className="text-left py-1.5 pr-2">理由</th>
            <th className="text-right py-1.5 pr-2">r_net</th>
            <th className="text-right py-1.5">損益</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t, i) => {
            const closed = t.dollar_pnl != null;
            const pnlColor = !closed ? 'text-fg-3' : (t.dollar_pnl as number) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500';
            const isSelected = selectedIndex === i;
            const rowBg = isSelected ? 'bg-[#F97316]/10' : 'hover:bg-fg-4/20';
            return (
              <tr
                key={i}
                className={`border-b border-fg-4/30 cursor-pointer transition-colors ${rowBg}`}
                onClick={() => onSelectTrade(i)}
              >
                <td className="py-1.5 pr-2 font-mono">{t.pair}</td>
                <td className="py-1.5 pr-2">{t.direction === 'UP' ? '買い' : '売り'}</td>
                <td className="py-1.5 pr-2 font-mono tabular-nums">{formatJST(t.entry_time)}</td>
                <td className="py-1.5 pr-2 font-mono tabular-nums">{closed && t.exit_time ? formatJST(t.exit_time) : '保有中'}</td>
                <td className="py-1.5 pr-2 text-fg-2">{t.exit_reason ?? '—'}</td>
                <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{fmtNum(t.r_net, 3)}</td>
                <td className={`py-1.5 text-right font-mono tabular-nums ${pnlColor}`}>
                  {closed ? signed(t.dollar_pnl as number, 2, '$').replace('$', '') + '$' : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── ペア別統計パネル ──────────────────────────────────────
function PairSummary({ stats, selectedPair, onSelectPair }: {
  stats: PairStats[];
  selectedPair: string | null;
  onSelectPair: (pair: string | null) => void;
}) {
  if (stats.length === 0) return null;

  return (
    <div className="space-y-2">
      {stats.map((s) => {
        const isSelected = selectedPair === s.pair;
        const bgColor = isSelected ? 'bg-[#F97316]/10 border-[#F97316]' : 'bg-fg-4/20 border-fg-3/30 hover:border-fg-3';
        return (
          <div
            key={s.pair}
            onClick={() => onSelectPair(isSelected ? null : s.pair)}
            className={`border rounded p-2.5 cursor-pointer transition-all ${bgColor}`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="font-mono font-700 text-sm text-fg-1">{s.pair}</div>
              <div className="text-xs text-fg-3">{s.nTrades}件</div>
            </div>
            <div className="grid grid-cols-2 gap-1 text-[10px]">
              <div>
                <p className="text-fg-3">勝率</p>
                <p className="font-mono text-fg-1">{(s.winRate * 100).toFixed(1)}%</p>
              </div>
              <div>
                <p className="text-fg-3">平均R</p>
                <p className={`font-mono ${s.avgR >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{s.avgR.toFixed(3)}R</p>
              </div>
              <div>
                <p className="text-fg-3">合計PnL</p>
                <p className={`font-mono ${s.totalPnL >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>${s.totalPnL.toFixed(0)}</p>
              </div>
              <div>
                <p className="text-fg-3">合計R</p>
                <p className={`font-mono ${s.totalR >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>{s.totalR.toFixed(2)}R</p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── トレード詳細パネル ──────────────────────────────────────
function TradeDetailPanel({
  trade,
  onClose
}: {
  trade: SysFx012Trade | null;
  onClose: () => void;
}) {
  if (!trade) return null;

  const closed = trade.dollar_pnl != null;
  const isWin = closed && (trade.dollar_pnl as number) >= 0;
  const winLossLabel = !closed ? '保有中' : isWin ? '勝ち' : '負け';
  const winLossColor = !closed ? 'text-fg-2' : isWin ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500';

  return (
    <div className="border border-fg-3 rounded p-4 space-y-3">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-sm font-700 text-fg-1">{trade.pair}</div>
          <div className={`text-xs font-700 mt-1 ${winLossColor}`}>{winLossLabel}</div>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-fg-4 rounded transition-colors"
          title="パネルを閉じる"
        >
          <X size={14} className="text-fg-3" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-fg-3 mb-1">エントリー</p>
          <p className="font-mono text-fg-1">{formatJST(trade.entry_time)}</p>
        </div>
        <div>
          <p className="text-fg-3 mb-1">決済</p>
          <p className="font-mono text-fg-1">{trade.exit_time ? formatJST(trade.exit_time) : '保有中'}</p>
        </div>

        <div>
          <p className="text-fg-3 mb-1">方向</p>
          <p className="font-mono text-fg-1">{trade.direction === 'UP' ? '買い' : '売り'}</p>
        </div>
        <div>
          <p className="text-fg-3 mb-1">決済理由</p>
          <p className="font-mono text-fg-1">{trade.exit_reason ?? '—'}</p>
        </div>

        <div>
          <p className="text-fg-3 mb-1">エントリー価格</p>
          <p className="font-mono text-fg-1">{trade.entry_price.toFixed(3)}</p>
        </div>
        <div>
          <p className="text-fg-3 mb-1">初期リスク</p>
          <p className="font-mono text-fg-1">{trade.initial_risk.toFixed(6)} pips</p>
        </div>

        <div>
          <p className="text-fg-3 mb-1">r_gross</p>
          <p className="font-mono text-fg-1">{trade.r_gross.toFixed(3)}R</p>
        </div>
        <div>
          <p className="text-fg-3 mb-1">コスト (cost_r)</p>
          <p className="font-mono text-fg-1">{trade.cost_r.toFixed(6)}R</p>
        </div>

        <div>
          <p className="text-fg-3 mb-1">コミッション (commission_r)</p>
          <p className="font-mono text-fg-1">{trade.commission_r.toFixed(6)}R</p>
        </div>
        <div>
          <p className="text-fg-3 mb-1">r_net</p>
          <p className={`font-mono font-700 ${isWin ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
            {trade.r_net.toFixed(3)}R
          </p>
        </div>

        <div>
          <p className="text-fg-3 mb-1">レバレッジ</p>
          <p className="font-mono text-fg-1">{trade.leverage_ratio.toLocaleString('en-US', { maximumFractionDigits: 1 })}x</p>
        </div>
        <div>
          <p className="text-fg-3 mb-1">リスク額</p>
          <p className="font-mono text-fg-1">{trade.risk_dollars ? `$${trade.risk_dollars.toFixed(2)}` : '—'}</p>
        </div>

        <div>
          <p className="text-fg-3 mb-1">実効リスク率</p>
          <p className="font-mono text-fg-1">{trade.effective_risk_pct ? `${(trade.effective_risk_pct * 100).toFixed(2)}%` : '—'}</p>
        </div>
        <div>
          <p className="text-fg-3 mb-1">損益</p>
          <p className={`font-mono font-700 ${isWin ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
            {closed ? signed(trade.dollar_pnl as number, 2, '$').replace('$', '') + '$' : '—'}
          </p>
        </div>
      </div>
    </div>
  );
}

export const SysFx012ForwardScreen = () => {
  const { data, loading, error } = useSysFx012ForwardData();
  const [selectedTradeIndex, setSelectedTradeIndex] = useState<number | null>(null);
  const [selectedPair, setSelectedPair] = useState<string | null>(null);

  if (loading) return <div className="p-6 text-fg-3 text-sm">読み込み中…</div>;
  if (error || !data) {
    return (
      <div className="p-6">
        <InfoNote tone="warn">
          <div className="flex items-center gap-1.5 font-700 mb-1"><AlertTriangle size={14} />データ取得エラー</div>
          {error ?? 'データがありません'}
        </InfoNote>
      </div>
    );
  }

  const { backtest: bt, kpi } = data;
  const totalReturnPct = ((bt.final_balance / INITIAL_CAPITAL) - 1) * 100;
  const elapsedDays = daysSince(data.cutoff);
  const pairStats = calculatePairStats(bt.trades);

  // selectedTradeIndexはreverse後のインデックスなので、実際のトレード参照は逆順にして取得
  const selectedTrade = selectedTradeIndex !== null && selectedTradeIndex < bt.trades.length
    ? bt.trades[bt.trades.length - 1 - selectedTradeIndex]
    : null;

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl">
      <div>
        <h2 className="text-lg font-700 text-fg-1">SYS-FX012 フォワードテスト</h2>
        <p className="text-xs text-fg-3 mt-1">minmax-fx-day-trading-lab / EXP-FX000006・JPYクロス4通貨（USD/JPY・EUR/JPY・GBP/JPY・AUD/JPY）</p>
      </div>

      <InfoNote tone="warn">
        <div className="flex items-center gap-1.5 font-700 mb-1"><AlertTriangle size={14} />既にREJECT確定済み。本フォワードテストは採用トラックではない</div>
        下表のTrain/Validation（17ヶ月/8ヶ月、実効nは300/85未満）は必須KPI13/18未達のまま「実効n不足で判断できない」状態だったが、
        別途実施された<strong>実効n=300超を満たす拡張Train評価（41ヶ月、EXP-FX000020）で2026-08-28にREJECTが正式確定済み</strong>
        （構造的な壁＝スプレッドコスト倍率K5m≥3.0が届かない。サンプルを増やしても解消しない）。
        さらに先読み修正（OBS000009不具合1、2026-08-28）後の再計算（2026-08-29）でも結論は変わらずREJECT確定のまま。
        なお同再計算では最大DDが14.00%→20.04%へ悪化し必須KPI 6/9→5/9に転落しており、
        「先読みはDD・見栄えを実際より良くしていた」ことが裏付けられている。
        本ページのフォワードテスト（ペーパートレード、実発注なし）は、このREJECT確定を覆すものではなく、
        C品質チームの正式レビューも未実施のまま、司令塔の明示指示により実データ蓄積のみを目的として継続中。
        cutoff={data.cutoff}以降のみを対象とし、設計パラメータは完全凍結（一切変更しない）。
      </InfoNote>

      <SectionBox title="バックテストの結果と評価">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-fg-3 border-b border-fg-3/50">
                <th className="text-left py-1.5 pr-2">指標</th>
                <th className="text-right py-1.5 pr-2">Train</th>
                <th className="text-right py-1.5">Validation</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {[
                ['期間', BACKTEST_TRAIN.period, BACKTEST_VALIDATION.period],
                ['実効n', `${BACKTEST_TRAIN.nTradesEffective}`, `${BACKTEST_VALIDATION.nTradesEffective}`],
                ['勝率', `${(BACKTEST_TRAIN.winRate * 100).toFixed(1)}%`, `${(BACKTEST_VALIDATION.winRate * 100).toFixed(1)}%`],
                ['月次シャープ', BACKTEST_TRAIN.monthlySharpe.toFixed(3), BACKTEST_VALIDATION.monthlySharpe.toFixed(3)],
                ['Profit Factor', BACKTEST_TRAIN.profitFactor.toFixed(3), BACKTEST_VALIDATION.profitFactor.toFixed(3)],
                ['ペイオフレシオ', BACKTEST_TRAIN.payoffRatio.toFixed(3), BACKTEST_VALIDATION.payoffRatio.toFixed(3)],
                ['最大DD', `${BACKTEST_TRAIN.maxDdPct.toFixed(2)}%`, `${BACKTEST_VALIDATION.maxDdPct.toFixed(2)}%`],
                ['permutation p値', BACKTEST_TRAIN.permP.toFixed(4), BACKTEST_VALIDATION.permP.toFixed(4)],
                ['必須KPI達成', BACKTEST_TRAIN.kpiPass, BACKTEST_VALIDATION.kpiPass],
              ].map(([label, t, v]) => (
                <tr key={label} className="border-b border-fg-4/30">
                  <td className="py-1.5 pr-2 font-sans text-fg-2">{label}</td>
                  <td className="py-1.5 pr-2 text-right">{t}</td>
                  <td className="py-1.5 text-right">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <InfoNote>
          Train+Validation合計で必須KPI13/18。未達3項目（ペイオフレシオ・実効n・permutation有意性、いずれもValidation側）はサンプル数不足に起因。
          通貨拡大（EUR_USD追加）・CALM_RATIO調整・DD改善用のコスト比率フィルターなど、改善ループ上限5回すべてを試したが、この結果を上回る設計は見つからなかった。
          フォワードテストは、この凍結済み設計の実データでの再現性を確認するために実施している。
        </InfoNote>
        <div className="flex flex-wrap gap-2">
          <a href="/data/forward-fx-sysfx012/sysfx012-train-trades.csv" download="sysfx012-train-trades.csv"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-fg-3 text-fg-2 hover:border-[#F97316] hover:text-[#F97316] transition-colors">
            <Download size={13} />Trainトレード記録（CSV・300件、先読み修正前）
          </a>
          <a href="/data/forward-fx-sysfx012/sysfx012-validation-trades.csv" download="sysfx012-validation-trades.csv"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-fg-3 text-fg-2 hover:border-[#F97316] hover:text-[#F97316] transition-colors">
            <Download size={13} />Validationトレード記録（CSV・85件、先読み修正前）
          </a>
        </div>
      </SectionBox>

      <SectionBox title="現在の状況">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatTile label="現在の残高" value={fmtUsd(bt.final_balance)}
            tone={bt.final_balance >= INITIAL_CAPITAL ? 'pos' : 'neg'} />
          <StatTile label="累積リターン" value={fmtPct(totalReturnPct, 1)}
            tone={totalReturnPct >= 0 ? 'pos' : 'neg'} sub="初期資金$1,000比" />
          <StatTile label="決済済みトレード" value={`${bt.n_trades_closed}件`}
            sub={bt.n_trades_open > 0 ? `保有中${bt.n_trades_open}件` : undefined} />
          <StatTile label="検出イベント" value={`${bt.n_events_trendfiltered}件`}
            sub={`raw${bt.n_events_raw}→dedup${bt.n_events_dedup}→判定不能除外後${bt.n_events_trendfiltered}`} />
        </div>
        <p className="text-[11px] text-fg-3">開始（cutoff）から{elapsedDays}日経過 / 最新データ: {formatJST(data.generated_at)}</p>
      </SectionBox>

      <SectionBox title="フォワードテストのポイント">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div className="border border-fg-3 rounded p-2.5">
            <div className="flex items-center gap-1.5 text-xs font-700 mb-1"><Target size={12} />実効n</div>
            <p className="text-[11px] text-fg-2 leading-relaxed">
              現在{bt.n_trades_closed}件。Trainの実効n=308・Validationの実効n=83が判断基準。
              実運用ペース（週あたり平均4.1件、4通貨プール）だと90日でも50件前後の見込みで、機械的なKPI判定にはまだ使えない。
            </p>
          </div>
          <div className="border border-fg-3 rounded p-2.5">
            <div className="flex items-center gap-1.5 text-xs font-700 mb-1"><Target size={12} />K6m（乖離率）</div>
            <p className="text-[11px] text-fg-2 leading-relaxed">
              バックテストとフォワードテストのKPI乖離率≤30%が基準。90日チェックポイントで初めて評価する。
              母数が育つまでは参考程度にとどめる。
            </p>
          </div>
          <div className="border border-fg-3 rounded p-2.5">
            <div className="flex items-center gap-1.5 text-xs font-700 mb-1"><Target size={12} />質的傾向の再現</div>
            <p className="text-[11px] text-fg-2 leading-relaxed">
              勝率61〜64%前後・ペイオフレシオ1.1〜1.4・DDの小ささ（Validation実績8.19%）が実データでも保たれるか。
              大きく下回る場合は懸念シグナル。
            </p>
          </div>
        </div>
      </SectionBox>

      <SectionBox title="残高推移">
        <EquityChart points={bt.equity_curve} elapsedDays={elapsedDays} />
      </SectionBox>

      <SectionBox title="質的指標（決済済みトレードベース）">
        {bt.n_trades_closed > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatTile label="勝率" value={bt.win_rate != null ? `${(bt.win_rate * 100).toFixed(1)}%` : '—'} />
            <StatTile label="Profit Factor" value={fmtNum(bt.profit_factor, 3)} />
            <StatTile label="ペイオフレシオ" value={fmtNum(bt.payoff_ratio, 3)} sub="Train基準1.108 / Validation基準1.362" />
            <StatTile label="permutation p値" value={fmtNum(bt.perm_p_block, 4)} />
          </div>
        ) : (
          <InfoNote>
            <div className="flex items-center gap-1.5 mb-1"><Info size={13} />決済済みトレードがまだ無いため質的指標は算出できません。母数が小さい初期段階では正常な状態です。</div>
          </InfoNote>
        )}
        {kpi ? (
          <InfoNote>
            <span className="font-700">正式KPI必須ゲート: {kpi.kpi_required_pass_count}</span>
            {' '}（参考値。母数がまだ小さいため機械的な採否判定には使わない。Train実効n=308・Validation実効n=83が判断基準）
          </InfoNote>
        ) : (
          <InfoNote>正式KPI評価は決済済みトレードが一定数貯まってから参考値として算出予定（現時点は未算出）</InfoNote>
        )}
      </SectionBox>

      <SectionBox title="トレード台帳">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="lg:col-span-1">
            <div className="text-xs font-700 text-fg-2 mb-2">通貨別統計</div>
            <PairSummary
              stats={pairStats}
              selectedPair={selectedPair}
              onSelectPair={setSelectedPair}
            />
          </div>
          <div className="lg:col-span-2">
            <TradeTable
              trades={bt.trades}
              selectedIndex={selectedTradeIndex}
              onSelectTrade={setSelectedTradeIndex}
            />
          </div>
          {selectedTrade && (
            <div className="lg:col-span-2">
              <div className="text-xs font-700 text-fg-2 mb-2">トレード詳細</div>
              <TradeDetailPanel
                trade={selectedTrade}
                onClose={() => setSelectedTradeIndex(null)}
              />
            </div>
          )}
        </div>
      </SectionBox>

      <div className="text-[11px] text-fg-3 space-y-1 border-t border-fg-4/40 pt-3">
        <p>・週次（毎週月曜09:00 JST）にminmax-fx-day-trading-lab側で自動再計算、その後追いで本アプリへ同期（毎週月曜12:00 JST頃）。90日チェックポイント（2026-11-13予定）でK6m（バックテストとのKPI乖離率）を評価。</p>
        <p>・複利で再投資しているため、残高が大きくなった時期の値動きは金額として誇張されて見える。優位性の判断は上表の質的指標で行うこと。</p>
        <a href="https://github.com/hasebe201114-cyber/minmax-fx-day-trading-lab/blob/main/research/EXP-FX000006/00-spec.md"
          target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-[#F97316] hover:underline">
          仕様の詳細（00-spec.md「フォワードテスト仕様」節）<ExternalLink size={11} />
        </a>
      </div>
    </div>
  );
};
