import {
  AreaChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { AlertTriangle, ExternalLink, Info } from 'lucide-react';
import { useSysFx012ForwardData, type SysFx012Trade } from '../../hooks/useSysFx012ForwardData';
import { SectionBox } from '../../ui/components/SectionBox';
import { formatJST } from '../../ui/utils/formatters';

const ACCENT = '#F97316'; // SYS-FX012（orange、carryのblue・VRPのvioletと区別）
const INITIAL_CAPITAL = 1000;

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

// ── 残高推移チャート ──────────────────────────────────────
function EquityChart({ points }: { points: { time: string; balance: number }[] }) {
  if (points.length < 2) {
    return <div className="flex items-center justify-center h-40 text-fg-3 text-sm">データ蓄積中（まだ決済済みトレードなし）</div>;
  }
  const data = points.map(p => ({ time: p.time.slice(0, 16), balance: p.balance }));

  return (
    <ResponsiveContainer width="100%" height={230}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
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
  );
}

// ── トレード台帳テーブル ──────────────────────────────────
function TradeTable({ trades }: { trades: SysFx012Trade[] }) {
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
            return (
              <tr key={i} className="border-b border-fg-4/30">
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

export const SysFx012ForwardScreen = () => {
  const { data, loading, error } = useSysFx012ForwardData();

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

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl">
      <div>
        <h2 className="text-lg font-700 text-fg-1">SYS-FX012 フォワードテスト</h2>
        <p className="text-xs text-fg-3 mt-1">minmax-fx-day-trading-lab / EXP-FX000006・JPYクロス4通貨（USD/JPY・EUR/JPY・GBP/JPY・AUD/JPY）</p>
      </div>

      <InfoNote tone="warn">
        <div className="flex items-center gap-1.5 font-700 mb-1"><AlertTriangle size={14} />検証中（採用GOではない）</div>
        Train+Validation合計で必須KPI13/18未達（実効n・ペイオフレシオ・permutation有意性がサンプル数不足で未達）、
        C品質チームの正式な採用可否レビューも未実施の状態のまま、司令塔の明示指示によりフォワードテスト（ペーパートレード、実発注なし）を実施中。
        cutoff={data.cutoff}以降のみを対象とし、設計パラメータは完全凍結（一切変更しない）。
      </InfoNote>

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

      <SectionBox title="残高推移">
        <EquityChart points={bt.equity_curve} />
      </SectionBox>

      <SectionBox title="質的指標（決済済みトレードベース）">
        {bt.n_trades_closed > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <StatTile label="勝率" value={bt.win_rate != null ? `${(bt.win_rate * 100).toFixed(1)}%` : '—'} />
            <StatTile label="Profit Factor" value={fmtNum(bt.profit_factor, 3)} />
            <StatTile label="ペイオフレシオ" value={fmtNum(bt.payoff_ratio, 3)} sub="Train基準1.078 / Validation基準1.376" />
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
            {' '}（参考値。母数がまだ小さいため機械的な採否判定には使わない。Train実効n=300・Validation実効n=85が判断基準）
          </InfoNote>
        ) : (
          <InfoNote>正式KPI評価は決済済みトレードが一定数貯まってから参考値として算出予定（現時点は未算出）</InfoNote>
        )}
      </SectionBox>

      <SectionBox title="トレード台帳">
        <TradeTable trades={bt.trades} />
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
