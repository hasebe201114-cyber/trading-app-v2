import { useState, useEffect } from 'react';

// ── 型定義 ────────────────────────────────────────────────
export interface LedgerRow {
  date_utc: string;
  phase: 'warmup' | 'live';
  daily_net_pnl_bps: number;
  cumulative_net_pnl_bps: number;
  sleeve_daily_return_pct: number;
  sleeve_cumulative_return_pct: number;
  funding_rate_daily_bps: number;
  basis_bps: number | null;
  liquidation_flag: 0 | 1;
  margin_call_flag: 0 | 1;
  data_gap_flag: 0 | 1;
}

export interface Projection90d {
  basedOnLiveDays: number;
  reliabilityNote: string;
  // FULL期間ベース（保守シナリオ・主表示）
  p10_cumBps: number | null;
  p50_cumBps: number | null;
  p90_cumBps: number | null;
  p50_annualReturnPct: number | null;
  bootstrapNote: string;
  // calm期間参照（反実仮想・2021H1高funding継続時の楽観シナリオ）
  calm_p50_cumBps?: number | null;
  calm_p50_annualReturnPct?: number | null;
  calm_bootstrapNote?: string;
}

export interface AssetGateMetrics {
  f1: {
    liveDaysCount: number;
    cumulativeLivePnlBps: number;
    f1a_cumulativePositive: boolean | null;
    liveDailyMeanBps: number | null;
    f1bLowerBoundBps: number | null;
    f1b_liveMeanGteLowerBound: boolean | null;
    backtestReference: { calmMeanDailyNetCarryBps: number; fullMeanDailyNetCarryBps: number };
  };
  f2: {
    eventPairsCount: number;
    eventSignAgreementPct: number | null;
    f2_gte80pct: boolean | null;
    g02BaselineReferencePct: number;
  };
  f3: {
    liquidationCount: number;
    marginCallCount: number;
    f3_zeroLiquidationAndMarginCall: boolean | null;
  };
  f4: {
    liveBasisDailyDeltaStdBps: number | null;
    t1ThresholdBps: number;
    f4_lteT1Threshold: boolean | null;
  };
}

export interface InterimMetrics {
  generatedAtUTC: string;
  liveDaysCount: { BTC: number; ETH: number };
  f1234: { BTC: AssetGateMetrics; ETH: AssetGateMetrics };
  projection90d?: { BTC: Projection90d; ETH: Projection90d };
  alertActive: boolean;
  checkpoints: {
    BTC: { immediateLiquidationOrMarginCall: { triggered: boolean } };
    ETH: { immediateLiquidationOrMarginCall: { triggered: boolean } };
  };
}

export interface ForwardData {
  metrics: InterimMetrics;
  btcLedger: LedgerRow[];
  ethLedger: LedgerRow[];
}

// ── フック ────────────────────────────────────────────────
export function useForwardData() {
  const [data, setData] = useState<ForwardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const base = '/data/forward';
    Promise.all([
      fetch(`${base}/forward-interim-metrics.json`).then(r => { if (!r.ok) throw new Error(`metrics: HTTP ${r.status}`); return r.json() as Promise<InterimMetrics>; }),
      fetch(`${base}/forward-paper-ledger-btc.json`).then(r => { if (!r.ok) throw new Error(`btc ledger: HTTP ${r.status}`); return r.json() as Promise<LedgerRow[]>; }),
      fetch(`${base}/forward-paper-ledger-eth.json`).then(r => { if (!r.ok) throw new Error(`eth ledger: HTTP ${r.status}`); return r.json() as Promise<LedgerRow[]>; }),
    ])
      .then(([metrics, btcLedger, ethLedger]) => {
        setData({ metrics, btcLedger, ethLedger });
        setError(null);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
