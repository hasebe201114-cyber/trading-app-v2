import type { Direction } from '../pattern-engine/predict.ts';
import type { SignalAction } from '../decision-layer/types.ts';
import type { EquityPoint } from '../risk-layer/types.ts';

export interface PipelineConfig {
  horizon: number;
  k: number;
  testRatio: number;
  testEndFraction?: number;
  initialEquity: number;
}

export interface TradeRecord {
  entryIndex: number;
  entryTime: number;
  exitTime: number;
  direction: Direction;
  action: SignalAction;
  positionSizeRatio: number;
  priceReturn: number;   // 銘柄価格そのもののリターン（方向調整前）
  directionalReturn: number; // ポジション方向を加味したリターン
  pnl: number;
  equityAfter: number;
}

export interface PipelineResult {
  trades: TradeRecord[];
  equityCurve: EquityPoint[];
  finalEquity: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpeRatio: number;
  winRate: number;
  haltedByDrawdown: boolean;
  skippedByCircuitBreaker: number;
}
