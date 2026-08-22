import { useState, useEffect } from 'react';

// ── 型定義 ────────────────────────────────────────────────
// SYS-FX012（minmax-fx-day-trading-lab、EXP-FX000006）のフォワードテストledger。
// 生成元: minmax-fx-day-trading-lab側 scripts/forward_test/run_forward_test_cycle.py
// （週次Routineで自動実行、research/method-notes/sysfx012_forward_test_ledger.jsonに出力）。
export interface SysFx012Trade {
  pair: string;
  direction: 'UP' | 'DOWN';
  entry_time: string;
  exit_time?: string;
  entry_price: number;
  initial_risk: number;
  exit_reason?: string;
  n_levels_hit: number;
  fraction_via_tp?: number;
  r_gross: number;
  cost_r: number;
  commission_r: number;
  r_net: number;
  leverage_ratio: number;
  risk_dollars?: number;
  dollar_pnl?: number;
  balance_after?: number;
  skipped_ruin?: boolean;
}

export interface SysFx012EquityPoint {
  time: string;
  balance: number;
}

export interface SysFx012Backtest {
  period: string;
  cutoff: string;
  n_events_raw: number;
  n_events_dedup: number;
  n_events_trendfiltered: number;
  n_trades_total: number;
  n_trades_closed: number;
  n_trades_open: number;
  win_rate: number | null;
  mean_r_net: number | null;
  profit_factor: number | null;
  payoff_ratio: number | null;
  perm_p_clustered: number | null;
  perm_p_block: number | null;
  final_balance: number;
  trades: SysFx012Trade[];
  equity_curve: SysFx012EquityPoint[];
}

export interface SysFx012Kpi {
  kpi_required_pass_count: string;
  monthly_sharpe: number | null;
  max_dd_pct: number | null;
  profit_factor: number | null;
  payoff_ratio: number | null;
  permutation_p_clustered?: number | null;
  n_trades_effective?: number | null;
  [key: string]: unknown;
}

export interface SysFx012ForwardData {
  generated_at: string;
  design: string;
  note: string;
  cutoff: string;
  latest_bar_by_pair: Record<string, string>;
  backtest: SysFx012Backtest;
  kpi: SysFx012Kpi | null;
}

// 配信元: trading-app-v2側 GitHub Actions（sysfx012-fx-forward-sync.yml）が、
// minmax-fx-day-trading-lab（public repo、同一オーナー）の
// research/method-notes/sysfx012_forward_test_ledger.json を
// public/data/forward-fx-sysfx012/ へ週次同期したコピー。検出・シミュレーションロジックは
// minmax-fx-day-trading-lab側にのみ存在し、本アプリは表示専用。
export function useSysFx012ForwardData() {
  const [data, setData] = useState<SysFx012ForwardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/data/forward-fx-sysfx012/sysfx012-forward-ledger.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<SysFx012ForwardData>; })
      .then(d => { setData(d); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
