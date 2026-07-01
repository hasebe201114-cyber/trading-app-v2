/**
 * ②パターン認識・統計シグナル層 — ウォークフォワード検証ハーネス
 * PJ000001 Phase 1 の目標（方向的中率55%以上）を測定するための土台。
 *
 * リーク防止ルール:
 *   - 特徴量抽出は endIndex 以前の情報のみ使用（features.ts）
 *   - 近傍候補は「forward return が現在時刻 t 以前に確定している」もののみ
 *     （candidateIndex + horizon <= t）
 *
 * 既知の簡略化（TODO）:
 *   - 正規化（z-score）の平均・分散はテスト開始時点までの学習データで一度だけ算出し、
 *     テスト期間全体で固定している。厳密な逐次再学習ではないため、将来的に
 *     一定間隔で再計算するように拡張する余地がある。
 */
import type { OHLCV } from '../types/market.ts';
import { extractFeatureVector, zScoreNormalize, type FeatureVector } from './features.ts';
import { findNearestNeighbors } from './similarity.ts';
import { predictFromNeighborReturns, type Direction } from './predict.ts';

export interface BacktestConfig {
  horizon: number;       // 何本先の将来リターンを予測するか
  k: number;             // 近傍数
  testRatio: number;     // データ全体のうち後半何割をテスト期間にするか（残りは近傍プール専用）
}

export interface BacktestResult {
  totalPredictions: number;      // neutral以外の予測件数
  correctDirection: number;
  directionAccuracy: number;     // 0-1、totalPredictionsに対する正答率
  avgConfidence: number;
  skippedNeutral: number;
}

const NEUTRAL_THRESHOLD = 0.0005;
const pctChange = (from: number, to: number): number => (to - from) / from;

function actualDirection(ret: number): Direction {
  if (ret > NEUTRAL_THRESHOLD) return 'up';
  if (ret < -NEUTRAL_THRESHOLD) return 'down';
  return 'neutral';
}

export function walkForwardBacktest(candles: OHLCV[], config: BacktestConfig): BacktestResult {
  const { horizon, k, testRatio } = config;
  const n = candles.length;

  // 全有効インデックス（特徴量抽出可能かつforward returnが取得できる範囲）の特徴量を一括算出
  const minIndex = 20;
  const maxIndex = n - horizon - 1;
  const validIndices: number[] = [];
  const rawVectors: FeatureVector[] = [];

  for (let i = minIndex; i <= maxIndex; i++) {
    const vec = extractFeatureVector(candles, i);
    if (vec) {
      validIndices.push(i);
      rawVectors.push(vec);
    }
  }

  const testStart = Math.floor(validIndices.length * (1 - testRatio));
  if (testStart < 10 || testStart >= validIndices.length) {
    return { totalPredictions: 0, correctDirection: 0, directionAccuracy: 0, avgConfidence: 0, skippedNeutral: 0 };
  }

  // 正規化統計はテスト開始時点までの学習データのみで算出（リーク防止の簡略版。backtest.ts冒頭のTODO参照）
  const trainVectors = rawVectors.slice(0, testStart);
  const normalizedAll = zScoreNormalize([...trainVectors, ...rawVectors.slice(testStart)]);

  let totalPredictions = 0;
  let correctDirection = 0;
  let confidenceSum = 0;
  let skippedNeutral = 0;

  for (let t = testStart; t < validIndices.length; t++) {
    const currentCandleIndex = validIndices[t];
    const targetVector = normalizedAll[t];

    // 近傍候補: forward returnが現在時刻より前に確定しているもののみ（リーク防止）
    const candidates = validIndices
      .map((idx, pos) => ({ index: idx, vector: normalizedAll[pos] }))
      .filter(c => c.index + horizon <= currentCandleIndex);

    if (candidates.length < k) continue;

    const neighbors = findNearestNeighbors(targetVector, candidates, k);
    const forwardReturns = neighbors.map(nb =>
      pctChange(candles[nb.index].close, candles[nb.index + horizon].close)
    );
    const prediction = predictFromNeighborReturns(forwardReturns);

    if (prediction.direction === 'neutral') {
      skippedNeutral++;
      continue;
    }

    const actualReturn = pctChange(candles[currentCandleIndex].close, candles[currentCandleIndex + horizon].close);
    const actual = actualDirection(actualReturn);

    totalPredictions++;
    confidenceSum += prediction.confidence;
    if (prediction.direction === actual) correctDirection++;
  }

  return {
    totalPredictions,
    correctDirection,
    directionAccuracy: totalPredictions > 0 ? correctDirection / totalPredictions : 0,
    avgConfidence: totalPredictions > 0 ? confidenceSum / totalPredictions : 0,
    skippedNeutral,
  };
}
