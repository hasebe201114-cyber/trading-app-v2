export interface ExecutionCostModel {
  /** 成行注文の手数料率（Taker、1回の約定に対して） */
  takerFeeRate: number;
  /** 成行注文のスリッページ率（不利な方向に価格が動くと仮定） */
  slippageRate: number;
}

/** BTC/USDT無期限先物の一般的なTaker手数料・流動性を想定した参考値。実運用時は取引所の実値に置き換えること */
export const DEFAULT_EXECUTION_COST: ExecutionCostModel = {
  takerFeeRate: 0.0005,  // 0.05%
  slippageRate: 0.0005,  // 0.05%
};

export interface RoundTripExecutionResult {
  entryExecutedPrice: number;
  exitExecutedPrice: number;
  /** コスト控除前の価格変動リターン */
  grossReturn: number;
  /** 手数料・スリッページ控除後の実現リターン */
  netReturn: number;
  /** 往復で発生した総コスト率（grossReturn - netReturn） */
  totalCostRate: number;
}
