/**
 * ⑤リスク管理・ポジションサイジング層 — 確度に応じた動的サイジング
 * PJ000001の設計方針: フラクショナルKelly基準を用い、フルKellyは禁止する。
 */
import { DEFAULT_RISK_LIMITS, type PositionSizeInput, type PositionSizeResult, type RiskLimits } from './types.ts';

/**
 * Kelly基準（対称ペイオフ簡略版）: f* = 2p - 1
 * 勝率pのみから算出する簡易版。勝ち額/負け額の非対称性は考慮していない
 * （②の近傍サンプルからwin/loss平均を分離取得できるようになったら精緻化する）。
 */
function calculateKellyFraction(winProbability: number): number {
  const kelly = 2 * winProbability - 1;
  return Math.max(0, kelly); // 負のKellyはポジションを取らない
}

export function calculatePositionSize(
  input: PositionSizeInput,
  limits: RiskLimits = DEFAULT_RISK_LIMITS,
): PositionSizeResult {
  const rationale: string[] = [];

  if (input.confidence < limits.minConfidenceToEnter) {
    rationale.push(`確信度(${input.confidence.toFixed(1)})が最低ライン(${limits.minConfidenceToEnter})未満のため見送り`);
    return { positionSizeRatio: 0, positionSizeAmount: 0, kellyFraction: 0, capped: false, rationale };
  }

  const winProbability = input.confidence / 100;
  const kellyFraction = calculateKellyFraction(winProbability);
  rationale.push(`Kelly基準(対称ペイオフ簡略版): 勝率${(winProbability * 100).toFixed(1)}%からf*=${kellyFraction.toFixed(3)}`);

  let sizeRatio = kellyFraction * limits.kellyFractionMultiplier * input.sizeMultiplier;
  rationale.push(`フラクショナルKelly(${limits.kellyFractionMultiplier}倍)×④のsizeMultiplier(${input.sizeMultiplier})を適用: ${sizeRatio.toFixed(3)}`);

  let capped = false;
  if (sizeRatio > limits.maxPositionSizeRatio) {
    sizeRatio = limits.maxPositionSizeRatio;
    capped = true;
    rationale.push(`最大ポジションサイズ上限(${limits.maxPositionSizeRatio})でキャップ`);
  }

  return {
    positionSizeRatio: sizeRatio,
    positionSizeAmount: sizeRatio * input.accountEquity,
    kellyFraction,
    capped,
    rationale,
  };
}
