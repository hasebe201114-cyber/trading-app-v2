/**
 * ②パターン認識・統計シグナル層 — 近傍サンプルの将来リターンから予測を生成
 * PJ000001の「方向・強さ・確度」に対応する。
 */

export type Direction = 'up' | 'down' | 'neutral';

export interface Prediction {
  direction: Direction;
  strength: number;   // 近傍の将来リターン絶対値の中央値
  confidence: number; // 0-100。近傍間で方向が一致している割合
  neighborCount: number;
}

/** 方向を無視するとみなす閾値（ノイズ帯） */
const NEUTRAL_THRESHOLD = 0.0005;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function predictFromNeighborReturns(forwardReturns: number[]): Prediction {
  if (forwardReturns.length === 0) {
    return { direction: 'neutral', strength: 0, confidence: 0, neighborCount: 0 };
  }

  const medianReturn = median(forwardReturns);
  const direction: Direction =
    medianReturn > NEUTRAL_THRESHOLD ? 'up' :
    medianReturn < -NEUTRAL_THRESHOLD ? 'down' :
    'neutral';

  const strength = median(forwardReturns.map(r => Math.abs(r)));

  const upCount = forwardReturns.filter(r => r > 0).length;
  const downCount = forwardReturns.filter(r => r < 0).length;
  const agreeCount = Math.max(upCount, downCount);
  const confidence = (agreeCount / forwardReturns.length) * 100;

  return { direction, strength, confidence, neighborCount: forwardReturns.length };
}
