import { Bot, AlertTriangle, Radio, Shield, History } from 'lucide-react';
import {
  useCarryExecutorData,
  type AssetSignal,
  type MarginPosition,
  type WorkflowRun,
} from '../../hooks/useCarryExecutorData';
import { SectionBox } from '../../ui/components/SectionBox';

const WORKFLOW_NAMES = ['OBS000032 Daily Signal Check', 'OBS000032 Margin Monitor'];
const TRACKED_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

const signalLabelJa = (signal: AssetSignal['signal']): string =>
  signal === 'open' ? 'オープン' : signal === 'close' ? 'クローズ' : '保留';

const sideLabelJa = (side: MarginPosition['side']): string =>
  side === 'long' ? 'ロング' : 'ショート';

const fmtUTC = (iso: string) => iso.slice(0, 16).replace('T', ' ');

// ── ワークフロー実行ステータスのドット ─────────────────────
function RunStatusDot({ run }: { run: WorkflowRun }) {
  const color =
    run.status !== 'completed' ? 'bg-amber-400'
    : run.conclusion === 'success' ? 'bg-emerald-500'
    : run.conclusion === 'failure' ? 'bg-red-500'
    : 'bg-fg-3';
  return (
    <div
      className={`w-2.5 h-2.5 rounded-full ${color}`}
      title={`${fmtUTC(run.createdAt)} UTC — ${run.conclusion ?? run.status}`}
    />
  );
}

// ── ワークフロー稼働状況の1行 ────────────────────────────
function WorkflowHealthRow({ name, runs }: { name: string; runs: WorkflowRun[] }) {
  const matched = runs.filter(r => r.name === name).slice(0, 8);
  const latest = matched[0];

  return (
    <div className="flex items-center justify-between border border-fg-3 rounded p-3 gap-3">
      <div className="min-w-0">
        <p className="text-sm font-600 truncate">{name}</p>
        <p className="text-[11px] text-fg-3">
          {latest
            ? `直近: ${fmtUTC(latest.createdAt)} UTC — ${latest.conclusion === 'success' ? '✅ 成功' : latest.conclusion === 'failure' ? '❌ 失敗' : latest.status}`
            : '実行履歴なし'}
        </p>
      </div>
      <div className="flex gap-1 shrink-0">
        {matched.length === 0
          ? <span className="text-fg-3 text-xs">—</span>
          : matched.slice().reverse().map(r => <RunStatusDot key={r.databaseId} run={r} />)}
      </div>
    </div>
  );
}

// ── BTC/ETHシグナルカード ─────────────────────────────────
function AssetSignalCard({ label, signal }: { label: string; signal: AssetSignal }) {
  if (signal.error) {
    return (
      <div className="border border-red-300 dark:border-red-700 rounded p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-lg font-700">{label}</span>
          <span className="text-xs text-red-500 font-700">エラー</span>
        </div>
        <p className="text-xs text-red-500 font-mono break-all">{signal.error}</p>
      </div>
    );
  }

  return (
    <div className="border border-fg-3 rounded p-4 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-lg font-700">{label}</span>
        <span className={`text-xs font-700 px-2 py-0.5 rounded ${
          signal.signal === 'open'
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
            : 'bg-fg-4 text-fg-2'
        }`}>
          {signalLabelJa(signal.signal)}
        </span>
      </div>
      <p className="text-sm text-fg-2">SMA: <span className="font-mono">{signal.sma_bps.toFixed(2)} bps</span></p>
      <p className="text-sm text-fg-2">
        ポジション: {signal.has_perp_short ? `保有中（${signal.short_size}）` : 'なし'}
      </p>
      {signal.has_perp_short && (
        <p className={`text-sm font-mono ${signal.unrealized_pnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
          含み損益: {signal.unrealized_pnl >= 0 ? '+' : ''}{signal.unrealized_pnl.toFixed(2)}
        </p>
      )}
      {signal.need_open && <p className="text-xs text-blue-500 font-600">→ オープン対象</p>}
      {signal.need_close && <p className="text-xs text-amber-500 font-600">→ クローズ対象</p>}
    </div>
  );
}

// ── 証拠金ポジション1行 ────────────────────────────────────
function MarginPositionRow({ pos }: { pos: MarginPosition }) {
  const isTracked = TRACKED_SYMBOLS.includes(pos.symbol);
  const color =
    pos.marginRatioPct > 90 ? 'text-red-500'
    : pos.marginRatioPct > 85 ? 'text-amber-500'
    : 'text-emerald-600 dark:text-emerald-400';

  return (
    <div className="flex items-center justify-between border border-fg-3 rounded p-3">
      <div>
        <p className="text-sm font-600">
          {pos.symbol}
          {!isTracked && <span className="text-[10px] text-fg-3 font-400 ml-1">（戦略対象外）</span>}
        </p>
        <p className="text-xs text-fg-3">{sideLabelJa(pos.side)} {pos.total}</p>
      </div>
      <div className="text-right">
        <p className={`font-mono text-sm font-700 ${color}`}>{pos.marginRatioPct.toFixed(2)}%</p>
        <p className={`text-xs font-mono ${pos.unrealizedPL >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
          {pos.unrealizedPL >= 0 ? '+' : ''}{pos.unrealizedPL.toFixed(2)} USDT
        </p>
      </div>
    </div>
  );
}

// ── メイン画面 ────────────────────────────────────────────
export const CarryExecutorScreen = () => {
  const { data, loading, error } = useCarryExecutorData();

  if (loading) return (
    <div className="p-6 space-y-4">
      <h1 className="text-h1 font-700">実行状況モニター</h1>
      <div className="text-fg-2">読み込み中…</div>
    </div>
  );

  if (error || !data) return (
    <div className="p-6 space-y-4">
      <h1 className="text-h1 font-700">実行状況モニター</h1>
      <div className="text-red-500">エラー: {error ?? 'データが見つかりません'}</div>
    </div>
  );

  const { signal, margin, runs } = data;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* ヘッダー */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h1 className="text-h1 font-700 flex items-center gap-2">
            <Bot size={22} className="text-blue-500" />
            実行状況モニター
          </h1>
          <p className="text-sm text-fg-2">btc-carry-executor · OBS000032 デルタニュートラル・キャリー実行層</p>
        </div>
        <div className="text-right flex flex-col sm:items-end gap-1">
          {signal && (
            <span className={`inline-block px-2 py-0.5 rounded text-xs font-700 w-fit ${
              signal.liveMode
                ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                : 'bg-fg-4 text-fg-2'
            }`}>
              {signal.liveMode ? '🔴 本番' : '⚪ ドライラン'}
            </span>
          )}
          <p className="text-[11px] text-fg-3">最終同期</p>
          <p className="text-xs font-mono text-fg-2">{fmtUTC(data.syncedAtUTC)} UTC</p>
        </div>
      </div>

      {/* アラート */}
      {signal?.aborted && (
        <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-700 rounded text-red-600 dark:text-red-400 text-sm">
          <AlertTriangle size={16} />
          <span className="font-600">日次シグナルチェックが中断しました（理由: {signal.abortReason ?? '不明'}）</span>
        </div>
      )}
      {margin?.hasCritical && (
        <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-700 rounded text-red-600 dark:text-red-400 text-sm">
          <AlertTriangle size={16} />
          <span className="font-600">証拠金が緊急水準です。手動対応が必要な可能性があります。</span>
        </div>
      )}
      {margin?.hasWarn && !margin?.hasCritical && (
        <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded text-amber-600 dark:text-amber-400 text-sm">
          <AlertTriangle size={16} />
          <span className="font-600">証拠金が警告水準に近づいています。</span>
        </div>
      )}
      {margin?.fetchError && (
        <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-700 rounded text-amber-600 dark:text-amber-400 text-sm">
          <AlertTriangle size={16} />
          <span className="font-600">証拠金データの取得に失敗しました: {margin.fetchError}</span>
        </div>
      )}

      {/* ワークフロー稼働状況 */}
      <SectionBox title="ワークフロー稼働状況" icon={<History size={16} />}>
        <div className="space-y-2">
          {WORKFLOW_NAMES.map(name => (
            <WorkflowHealthRow key={name} name={name} runs={runs} />
          ))}
        </div>
      </SectionBox>

      {/* シグナル状況 */}
      <SectionBox title="シグナル状況" icon={<Radio size={16} />}>
        {signal ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <AssetSignalCard label="BTC" signal={signal.assets.btc} />
            <AssetSignalCard label="ETH" signal={signal.assets.eth} />
          </div>
        ) : (
          <div className="text-fg-3 text-sm py-4">まだ同期データがありません（daily-run.ymlの初回実行待ち）。</div>
        )}
      </SectionBox>

      {/* 証拠金状況 */}
      <SectionBox title="証拠金状況" icon={<Shield size={16} />}>
        {margin ? (
          margin.positions.length > 0 ? (
            <div className="space-y-2">
              {margin.positions.map(pos => (
                <MarginPositionRow key={pos.symbol} pos={pos} />
              ))}
            </div>
          ) : (
            <div className="text-fg-2 text-sm py-4">オープンポジションなし</div>
          )
        ) : (
          <div className="text-fg-3 text-sm py-4">まだ同期データがありません（monitor-margin.ymlの初回実行待ち）。</div>
        )}
      </SectionBox>
    </div>
  );
};
