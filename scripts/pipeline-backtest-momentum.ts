/**
 * モメンタム(OBS000020)のパイプライン統合バックテスト
 *
 * 予測単位ではモメンタム(L=30)が②(k-NN)より頑健（OBS000019/020）だった。
 * 本スクリプトは③④⑤⑥込みの実ポートフォリオ（手数料・サイジング・非重複保有）で
 * ②(k-NN) vs モメンタムを、BTC/ETH双方・複数期間で比較する。
 * データはOBS000021で取得した連続・欠落なしのBinance直接データを使用する。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/pipeline-backtest-momentum.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';
import type { PipelineResult } from '../src/pipeline/types.ts';
import type { OHLCV } from '../src/types/market.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const HORIZON = 10;
const K = 30;
const MOMENTUM_L = 30;
const utcDateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

function candleIndexAtOrAfter(candles: OHLCV[], date: string): number {
  for (let i = 0; i < candles.length; i++) if (utcDateOf(candles[i].time) >= date) return i;
  return candles.length;
}

function runWindow(label: string, candles: OHLCV[], startDate: string, endDate?: string): void {
  const n = candles.length;
  const validLen = n - HORIZON - 20;
  const startPos = Math.max(0, candleIndexAtOrAfter(candles, startDate) - 20);
  const endPos = endDate ? Math.min(validLen, candleIndexAtOrAfter(candles, endDate) - 20) : validLen;
  const testRatio = 1 - startPos / validLen;
  const testEndFraction = endPos / validLen;

  const baseConfig = { horizon: HORIZON, initialEquity: 1_000_000, testRatio, testEndFraction };
  const knn = simulatePortfolio(candles, { ...baseConfig, k: K });
  const momentum = simulatePortfolio(candles, { ...baseConfig, k: K, momentumLookback: MOMENTUM_L });

  const fmt = (r: PipelineResult): string =>
    `T${String(r.trades.length).padStart(3)} 勝率${(r.winRate * 100).toFixed(0)}% Ret${(r.totalReturn * 100).toFixed(1)}% DD${(r.maxDrawdown * 100).toFixed(1)}% Sharpe${r.sharpeRatio.toFixed(2)}`;

  console.log(`--- ${label} [${startDate}〜${endDate ?? '末尾'}] ---`);
  console.log(`  ②k-NN:     ${fmt(knn)}`);
  console.log(`  モメンタム: ${fmt(momentum)}`);
  console.log();
}

console.log('=== モメンタム(L=30) パイプライン統合バックテスト（OBS000020後続）===\n');

const btc = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
const eth = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));

console.log(`BTC: ${btc.length}本 (${utcDateOf(btc[0].time)}〜${utcDateOf(btc[btc.length - 1].time)})`);
console.log(`ETH: ${eth.length}本 (${utcDateOf(eth[0].time)}〜${utcDateOf(eth[eth.length - 1].time)})\n`);

runWindow('BTC 2021-2026連続', btc, '2021-01-01');
runWindow('BTC 2023-2026直近', btc, '2023-01-01');
runWindow('ETH 2021-2026連続', eth, '2021-01-01');
runWindow('ETH 2023-2026直近', eth, '2023-01-01');

// 年次フォールドでも比較（OBS000016/018と同じ粒度）
console.log('=== BTC 年次フォールド比較 ===\n');
const FOLD_DATES = ['2021-01-01', '2022-01-01', '2023-01-01', '2024-01-01', '2025-01-01', undefined];
for (let i = 0; i < FOLD_DATES.length - 1; i++) {
  runWindow(`BTC ${FOLD_DATES[i]!.slice(0, 4)}年`, btc, FOLD_DATES[i]!, FOLD_DATES[i + 1]);
}
