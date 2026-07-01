/**
 * ②パターン認識・統計シグナル層 — 類似度探索（k近傍法）
 */
import type { FeatureVector } from './features.ts';

export interface Neighbor {
  index: number;
  distance: number;
}

function euclideanDistance(a: FeatureVector, b: FeatureVector): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

/**
 * target に最も近い k件を candidates から探す（正規化済みベクター前提）。
 * candidates は { index, vector } の配列。index は candles 配列上の位置を表す。
 */
export function findNearestNeighbors(
  target: FeatureVector,
  candidates: { index: number; vector: FeatureVector }[],
  k: number,
): Neighbor[] {
  const distances = candidates.map(c => ({ index: c.index, distance: euclideanDistance(target, c.vector) }));
  distances.sort((a, b) => a.distance - b.distance);
  return distances.slice(0, k);
}
