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
  /**
   * ②レジームゲート・固定閾値方式（OBS000018）。効率比(efficiencyRatio20)がこの閾値未満の
   * 局面ではエントリーを見送る。※固定閾値は過最適の傾向があるため本番非推奨。検証用途。
   * 未指定ならゲートなし。adaptiveErGateWarmup が指定された場合はそちらが優先される。
   */
  minEfficiencyRatio?: number;
  /**
   * ②レジームゲート・適応的中央値方式（OBS000018、推奨）。効率比が「過去に評価した局面の
   * 効率比の中央値」未満なら見送る自己校正ゲート。固定閾値の過最適を避ける。
   * 値は中央値を確定するのに必要な最小サンプル数（ウォームアップ）。この件数が貯まるまでは
   * 中央値が不安定なためエントリーを見送る。未指定ならこのゲートは無効。
   */
  adaptiveErGateWarmup?: number;
  /**
   * ②パターン認識層をk-NNからトレンドフォロー(モメンタム)に置き換える（OBS000020）。
   * 指定した日数のリターンの符号を方向シグナルとする。確信度は固定値(60)を用いる
   * （近傍合意率という概念がk-NNと異なるため、Kelly比率がわずかに正になる程度の暫定値）。
   * 未指定なら従来どおりk-NNを使用する。
   */
  momentumLookback?: number;
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
