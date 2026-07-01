/**
 * ②パターン認識・統計シグナル層 — 特徴量抽出
 * PJ000001参照。直近の値動きを固定長の特徴量ベクトルに変換する。
 * 類似度探索(similarity.ts)はこのベクトルの距離で「似た過去局面」を探す。
 */
import type { OHLCV } from '../types/market.ts';
import { calculateRSI } from '../shared/indicators.ts';

export const FEATURE_NAMES = [
  'return1', 'return3', 'return5', 'return10', 'return20',
  'volatility20', 'momentum10', 'rsi14', 'volumeChangeRatio',
] as const;

export type FeatureVector = number[];

const pctChange = (from: number, to: number): number => (to - from) / from;

/**
 * 指定インデックス endIndex（この足の終値まで含む）を「現在時刻」として特徴量を抽出する。
 * endIndex より前の情報のみを使用し、先読みしない。
 */
export function extractFeatureVector(candles: OHLCV[], endIndex: number): FeatureVector | null {
  if (endIndex < 20) return null; // ウォームアップ期間不足

  const closes = candles.slice(0, endIndex + 1).map(c => c.close);
  const volumes = candles.slice(0, endIndex + 1).map(c => c.volume);
  const last = closes.length - 1;

  const return1 = pctChange(closes[last - 1], closes[last]);
  const return3 = pctChange(closes[last - 3], closes[last]);
  const return5 = pctChange(closes[last - 5], closes[last]);
  const return10 = pctChange(closes[last - 10], closes[last]);
  const return20 = pctChange(closes[last - 20], closes[last]);

  const recentReturns: number[] = [];
  for (let i = last - 19; i <= last; i++) {
    recentReturns.push(pctChange(closes[i - 1], closes[i]));
  }
  const meanReturn = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
  const variance = recentReturns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / recentReturns.length;
  const volatility20 = Math.sqrt(variance);

  const momentum10 = pctChange(closes[last - 10], closes[last]);
  const rsi14 = calculateRSI(closes.slice(-30), 14);

  const recentVolAvg = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const priorVolAvg = volumes.slice(-40, -20).reduce((a, b) => a + b, 0) / Math.max(1, volumes.slice(-40, -20).length);
  const volumeChangeRatio = priorVolAvg > 0 ? recentVolAvg / priorVolAvg : 1;

  return [return1, return3, return5, return10, return20, volatility20, momentum10, rsi14, volumeChangeRatio];
}

/** 特徴量セット全体をz-score正規化する（次元ごとにスケールを揃え、距離計算の偏りを防ぐ） */
export function zScoreNormalize(vectors: FeatureVector[]): FeatureVector[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const means: number[] = [];
  const stds: number[] = [];

  for (let d = 0; d < dims; d++) {
    const values = vectors.map(v => v[d]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    means.push(mean);
    stds.push(Math.sqrt(variance) || 1); // 分散0対策
  }

  return vectors.map(v => v.map((val, d) => (val - means[d]) / stds[d]));
}
