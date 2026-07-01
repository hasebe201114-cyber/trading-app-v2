/**
 * Phase 1 PoC — 実データ（scripts/data/btc-daily-2010-2020.csv）でのwalk-forward検証。
 * 実行: node --experimental-strip-types scripts/real-data-backtest.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromCsv } from './loadCsvData.ts';
import { walkForwardBacktest } from '../src/pattern-engine/backtest.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, 'data', 'btc-daily-2010-2020.csv');

const candles = loadOhlcvFromCsv(csvPath);
console.log(`読み込んだ日足データ: ${candles.length}本`);
console.log(`期間: ${new Date(candles[0].time).toISOString().slice(0, 10)} 〜 ${new Date(candles[candles.length - 1].time).toISOString().slice(0, 10)}`);

const configs = [
  { horizon: 1, k: 15, testRatio: 0.5 },
  { horizon: 3, k: 15, testRatio: 0.5 },
  { horizon: 5, k: 15, testRatio: 0.5 },
  { horizon: 5, k: 30, testRatio: 0.5 },
  { horizon: 5, k: 10, testRatio: 0.5 },
  { horizon: 5, k: 50, testRatio: 0.5 },
  { horizon: 7, k: 15, testRatio: 0.5 },
  { horizon: 10, k: 15, testRatio: 0.5 },
  { horizon: 10, k: 30, testRatio: 0.5 },
  { horizon: 14, k: 30, testRatio: 0.5 },
];

console.log('\n=== BTC日足 実データ walk-forward検証 ===');
for (const config of configs) {
  const result = walkForwardBacktest(candles, config);
  console.log(
    `horizon=${config.horizon}日, k=${config.k}: ` +
    `方向的中率=${(result.directionAccuracy * 100).toFixed(1)}% ` +
    `(予測${result.totalPredictions}件, 正解${result.correctDirection}件, 平均確度=${result.avgConfidence.toFixed(1)})`
  );
}

console.log('\n目標（PJ000001 Phase1）: 方向的中率55%以上');
