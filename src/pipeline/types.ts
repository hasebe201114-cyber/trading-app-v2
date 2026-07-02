import type { Direction } from '../pattern-engine/predict.ts';
import type { SignalAction } from '../decision-layer/types.ts';
import type { EquityPoint } from '../risk-layer/types.ts';
import type { MarketContextOutput } from '../llm-layer/types.ts';

export interface PipelineConfig {
  horizon: number;
  k: number;
  testRatio: number;
  testEndFraction?: number;
  initialEquity: number;
  /**
   * ③LLM特徴量層の日次出力を注入する（OBS000014）。
   * UTC日付("YYYY-MM-DD")を受け取り、事前計算済みのMarketContextOutputを返す。
   * 未指定またはundefinedを返した日は、従来どおりニュースなしのmock（実質③なし）で動作する。
   */
  marketContextForDay?: (utcDate: string) => MarketContextOutput | undefined;
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
