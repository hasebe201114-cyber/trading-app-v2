/**
 * Phase 1 PoC — 複数期間（フォールド）での頑健性検証。
 * real-data-backtest.ts の単一分割（後半50%を一括テスト）だけでは、
 * たまたま有利な相場レジーム（強いトレンド相場等）に対して過学習的に
 * 良く見えている可能性を排除できない。ここでは後半50%を5分割し、
 * 各フォールドを「それ以前の全データを学習に使う拡大窓」で個別に評価する。
 *
 * 実行: node --experimental-strip-types scripts/fold-validation.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromCsv } from './loadCsvData.ts';
import { walkForwardBacktest } from '../src/pattern-engine/backtest.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, 'data', 'btc-daily-2010-2020.csv');
const candles = loadOhlcvFromCsv(csvPath);

const FOLD_BOUNDARIES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

function runFolds(horizon: number, k: number, regimeBandwidth?: number) {
  const label = regimeBandwidth !== undefined ? `horizon=${horizon}日, k=${k}, regimeBandwidth=${regimeBandwidth}` : `horizon=${horizon}日, k=${k}`;
  console.log(`\n--- ${label} ---`);
  const accuracies: number[] = [];

  for (let i = 0; i < FOLD_BOUNDARIES.length - 1; i++) {
    const testStartFraction = FOLD_BOUNDARIES[i];
    const testEndFraction = FOLD_BOUNDARIES[i + 1];
    const result = walkForwardBacktest(candles, {
      horizon,
      k,
      testRatio: 1 - testStartFraction,
      testEndFraction,
      regimeBandwidth,
    });
    accuracies.push(result.directionAccuracy);
    console.log(
      `  フォールド${i + 1} [${testStartFraction.toFixed(1)}-${testEndFraction.toFixed(1)}]: ` +
      `方向的中率=${(result.directionAccuracy * 100).toFixed(1)}% (${result.totalPredictions}件)`
    );
  }

  const mean = accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
  const variance = accuracies.reduce((a, b) => a + (b - mean) ** 2, 0) / accuracies.length;
  const std = Math.sqrt(variance);
  console.log(`  → 平均: ${(mean * 100).toFixed(1)}%, 標準偏差: ${(std * 100).toFixed(1)}pt, 最小: ${(Math.min(...accuracies) * 100).toFixed(1)}%, 最大: ${(Math.max(...accuracies) * 100).toFixed(1)}%`);
}

console.log('=== 複数期間フォールド検証（単一分割の過学習チェック） ===');
runFolds(10, 30); // real-data-backtest.tsで最良だった設定（efficiencyRatio20をソフトな特徴量として含む）
runFolds(7, 15);
runFolds(5, 15);  // 参考: 目標未達だった短めのhorizon

console.log('\n=== レジーム条件付け（ハードフィルタ）を追加した場合 ===');
runFolds(10, 30, 0.15);
runFolds(10, 30, 0.10);
runFolds(7, 15, 0.15);
runFolds(5, 15, 0.15);
