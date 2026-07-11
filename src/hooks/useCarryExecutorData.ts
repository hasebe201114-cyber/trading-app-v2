import { useState, useEffect } from 'react';

// ── 型定義 ────────────────────────────────────────────────
export interface AssetSignal {
  asset: string;
  signal: 'open' | 'close' | 'hold';
  sma_bps: number;
  need_open: boolean;
  need_close: boolean;
  has_perp_short: boolean;
  short_size: number;
  unrealized_pnl: number;
  error: string | null;
}

export interface SignalStatus {
  generatedAtUTC: string;
  liveMode: boolean;
  capitalUsdt: number;
  aborted: boolean;
  abortReason?: string;
  accountMarginRatioPct: number;
  assets: { btc: AssetSignal; eth: AssetSignal };
}

export interface MarginPosition {
  symbol: string;
  side: 'long' | 'short';
  total: string;
  marginRatioPct: number;
  unrealizedPL: number;
}

export interface MarginStatus {
  generatedAtUTC: string;
  positions: MarginPosition[];
  hasCritical: boolean;
  hasWarn: boolean;
  fetchError: string | null;
}

export interface WorkflowRun {
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  event: string;
}

export interface CarryExecutorStatus {
  syncedAtUTC: string;
  signal: SignalStatus | null;
  margin: MarginStatus | null;
  runs: WorkflowRun[];
}

// ── フック ────────────────────────────────────────────────
export function useCarryExecutorData() {
  const [data, setData] = useState<CarryExecutorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/data/carry-executor/status.json')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<CarryExecutorStatus>; })
      .then(d => { setData(d); setError(null); })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
