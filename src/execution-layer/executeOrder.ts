/**
 * ⑥執行層 — 成行注文の約定シミュレーション
 * PJ000001参照:「スリッページ・手数料を考慮した執行コストモデルをバックテストに組み込む」
 *
 * 日足の終値ベースのバックテストでは指値の約定可否を厳密にシミュレートできないため、
 * 一次実装は成行注文のみを扱う（指値注文のシミュレーションは日中データが必要なため見送り。
 * 今後の課題としてOBSに記録する）。
 */
import type { Direction } from '../pattern-engine/predict.ts';
import { DEFAULT_EXECUTION_COST, type ExecutionCostModel, type RoundTripExecutionResult } from './types.ts';

/**
 * エントリー・決済を成行注文と仮定し、往復のスリッページ・手数料を織り込んだ
 * 実現リターンを算出する。
 *
 * ロング(up): 買いは高く約定(price*(1+slippage))、売りは安く約定(price*(1-slippage))
 * ショート(down): 売りは安く約定、買い戻しは高く約定（ロングの逆）
 */
export function simulateRoundTripExecution(
  entryReferencePrice: number,
  exitReferencePrice: number,
  direction: Exclude<Direction, 'neutral'>,
  costModel: ExecutionCostModel = DEFAULT_EXECUTION_COST,
): RoundTripExecutionResult {
  const { takerFeeRate, slippageRate } = costModel;

  const entryExecutedPrice = direction === 'up'
    ? entryReferencePrice * (1 + slippageRate)  // 買いは不利な方向(高く)に約定
    : entryReferencePrice * (1 - slippageRate); // 売り(空売り)は不利な方向(安く)に約定

  const exitExecutedPrice = direction === 'up'
    ? exitReferencePrice * (1 - slippageRate)   // 決済の売りは安く約定
    : exitReferencePrice * (1 + slippageRate);  // 決済の買い戻しは高く約定

  const grossReturn = direction === 'up'
    ? (exitExecutedPrice - entryExecutedPrice) / entryExecutedPrice
    : (entryExecutedPrice - exitExecutedPrice) / entryExecutedPrice;

  const totalCostRate = 2 * takerFeeRate; // エントリー・決済それぞれでTaker手数料
  const netReturn = grossReturn - totalCostRate;

  return { entryExecutedPrice, exitExecutedPrice, grossReturn, netReturn, totalCostRate };
}
