/**
 * パイプライン統合（②③④⑤）を実データ（BTC日足）で実行し、
 * ポートフォリオレベルの指標（総リターン・最大DD・シャープレシオ・勝率）を測定する。
 * 実行: node --experimental-strip-types scripts/pipeline-backtest.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, 'data', 'btc-daily-2010-2020.csv');
const candles = loadOhlcvFromCsv(csvPath);

const baseConfig = { horizon: 10, k: 30, initialEquity: 1_000_000 };
const FOLD_BOUNDARIES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

console.log(`読み込んだ日足データ: ${candles.length}本\n`);
console.log('=== パイプライン統合バックテスト（②③④⑤、フォールドごと） ===\n');

for (let i = 0; i < FOLD_BOUNDARIES.length - 1; i++) {
  const testStartFraction = FOLD_BOUNDARIES[i];
  const testEndFraction = FOLD_BOUNDARIES[i + 1];
  const result = simulatePortfolio(candles, {
    ...baseConfig,
    testRatio: 1 - testStartFraction,
    testEndFraction,
  });

  console.log(`--- フォールド${i + 1} [${testStartFraction.toFixed(1)}-${testEndFraction.toFixed(1)}] ---`);
  console.log(`  トレード数=${result.trades.length}, 勝率=${(result.winRate * 100).toFixed(1)}%`);
  console.log(`  総リターン=${(result.totalReturn * 100).toFixed(1)}%, 最大DD=${(result.maxDrawdown * 100).toFixed(1)}%, シャープレシオ=${result.sharpeRatio.toFixed(2)}`);
  console.log(`  最終資産=${result.finalEquity.toFixed(0)}円, DDによる全面停止=${result.haltedByDrawdown}, サーキットブレーカー発動回数=${result.skippedByCircuitBreaker}`);
  console.log();
}

console.log('目標（PJ000001）: シャープレシオ0.8以上、最大ドローダウン15%以内（Phase3基準）');
