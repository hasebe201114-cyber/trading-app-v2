export interface RiskLimits {
  /** 1トレードあたりの最大ポジションサイズ（口座資産に対する比率） */
  maxPositionSizeRatio: number;
  /** フラクショナルKellyの倍率（1.0=フルKelly。PJ000001によりフルKellyは禁止、0.5=ハーフKelly推奨） */
  kellyFractionMultiplier: number;
  /** ④統合判断層のconfidenceがこの値未満なら新規エントリーしない */
  minConfidenceToEnter: number;
  /** 当日の損失がこの比率を超えたら新規エントリーを停止（サーキットブレーカー） */
  maxDailyLossRatio: number;
  /** 直近ピークからのドローダウンがこの比率を超えたら全面停止（PJ000001 Phase3 KPI: 15%以内） */
  maxDrawdownRatio: number;
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPositionSizeRatio: 0.2,
  kellyFractionMultiplier: 0.5,
  minConfidenceToEnter: 50,
  maxDailyLossRatio: 0.05,
  maxDrawdownRatio: 0.15,
};

export interface PositionSizeInput {
  accountEquity: number;
  /** ④統合判断層のconfidence（0-100） */
  confidence: number;
  /** ④統合判断層のsizeMultiplier（レジーム等による事前縮小、0-1） */
  sizeMultiplier: number;
}

export interface PositionSizeResult {
  positionSizeRatio: number;   // 口座資産に対する比率（0-1）
  positionSizeAmount: number;  // 金額
  kellyFraction: number;       // キャップ前のKelly値（参考）
  capped: boolean;
  rationale: string[];
}

export interface EquityPoint {
  timestamp: number; // unix ms
  equity: number;
}

export interface CircuitBreakerStatus {
  halted: boolean;
  reason: string | null;
  currentDrawdown: number; // 0-1、直近ピークからの下落率
  dailyLoss: number;       // 0-1、当日始値からの下落率（マイナスは利益）
}
