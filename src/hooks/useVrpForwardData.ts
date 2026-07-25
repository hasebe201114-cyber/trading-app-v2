import { useState, useEffect } from 'react';

// ── 型定義 ────────────────────────────────────────────────
// EXP-OBS000037（SYS-001 VRP）フォワード較正ledgerの1行。
// 生成元: scripts/deribit-vrp-forward-paper.ts（日次冪等追記）
export interface VrpLedgerRow {
  date: string;
  phase: 'warmup' | 'live';
  dvol: number;
  dvol_daily_change_vol_pts: number | null;
  dvol_spike_marker: 0 | 1;
  /** 事後実現ボラ（7日先）。当日から7日経過するまでは null（正常仕様） */
  rv_forward_7d: number | null;
  /** VRP水準 = dvol − rv_forward_7d（vol pt）。rv未確定の間は null */
  vrp: number | null;
  /** 週次コホート純益（資本比%）= (vrp − C_real) × vegaNotionalPct × 100 */
  net_pnl_pct: number | null;
  sleeve_return: number | null;
  /** go-live起点の週インデックス（warmup行は null） */
  cohort_week_index: number | null;
  /** 1 = 週次非重複サンプリングのアンカー行（F1/F3判定はこの行のみを使う） */
  is_cohort_anchor: 0 | 1;
  price_source: string;
}

export interface VrpForwardMeta {
  experiment: string;
  stage: string;
  gate: string;
  goLiveDateUTC: string;
  warmupDays: number;
  rvForwardDays: number;
  liveDaysRequiredForGate: number;
  currentLiveDaysCount: number;
  currentWarmupDaysCount: number;
  fixedParams: {
    dvolSpikeThresholdVolPts: number;
    cRealWeeklyCostVolPt: number;
    vegaNotionalPct: number;
    accountingNote: string;
  };
  runHistory: { runTimestampUTC: string; anchorDateKey: string; rowCountAfter: number }[];
}

export interface VrpForwardData {
  meta: VrpForwardMeta;
  ledger: VrpLedgerRow[];
}

// ── フック ────────────────────────────────────────────────
// 配信元は GitHub Actions（obs000037-vrp-forward.yml）が
// research/EXP-OBS000037/10-result/forward/ から public/data/forward-vrp/ へ同期したコピー。
export function useVrpForwardData() {
  const [data, setData] = useState<VrpForwardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const base = '/data/forward-vrp';
    Promise.all([
      fetch(`${base}/deribit-vrp-forward-meta.json`).then(r => { if (!r.ok) throw new Error(`meta: HTTP ${r.status}`); return r.json() as Promise<VrpForwardMeta>; }),
      fetch(`${base}/deribit-vrp-forward-ledger-btc.json`).then(r => { if (!r.ok) throw new Error(`ledger: HTTP ${r.status}`); return r.json() as Promise<VrpLedgerRow[]>; }),
    ])
      .then(([meta, ledger]) => {
        setData({ meta, ledger });
        setError(null);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
