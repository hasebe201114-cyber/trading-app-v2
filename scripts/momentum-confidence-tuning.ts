/**
 * モメンタムの確信度動的化チューニング（OBS000024）
 *
 * OBS000023でモメンタムを②の後継として採用したが、確信度は固定値60（暫定）だった。
 * 本スクリプトは、モメンタムの強さをボラティリティで正規化したz値に基づく動的確信度
 * （momentumConfidenceScale）が、固定値60より実ポートフォリオ成績を改善するかを検証する。
 *
 * 選定→確認プロトコル（多重検定を回避、OBS000020と同じ考え方）:
 *   1. 選定: BTCの複数期間でconfidenceScaleを走査し、固定60を上回る最良の値を選ぶ
 *   2. 確認: 選定に使っていないETHで、そのscaleを固定適用して確認する
 *
 * 実行例:
 *   node --experimental-strip-types scripts/momentum-confidence-tuning.ts
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

function windowConfig(candles: OHLCV[], startDate: string, endDate?: string) {
  const n = candles.length;
  const validLen = n - HORIZON - 20;
  const startPos = Math.max(0, candleIndexAtOrAfter(candles, startDate) - 20);
  const endPos = endDate ? Math.min(validLen, candleIndexAtOrAfter(candles, endDate) - 20) : validLen;
  return { testRatio: 1 - startPos / validLen, testEndFraction: endPos / validLen };
}

function runMomentum(candles: OHLCV[], startDate: string, endDate: string | undefined, confidenceScale: number | undefined): PipelineResult {
  const w = windowConfig(candles, startDate, endDate);
  const cfg = { horizon: HORIZON, k: K, initialEquity: 1_000_000, momentumLookback: MOMENTUM_L, ...w, ...(confidenceScale !== undefined ? { momentumConfidenceScale: confidenceScale } : {}) };
  return simulatePortfolio(candles, cfg);
}

const btc = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
const eth = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));

const BTC_WINDOWS: { label: string; start: string; end?: string }[] = [
  { label: 'BTC 2021-2026連続', start: '2021-01-01' },
  { label: 'BTC 2023-2026直近', start: '2023-01-01' },
  { label: 'BTC 2022年', start: '2022-01-01', end: '2023-01-01' },
  { label: 'BTC 2023年', start: '2023-01-01', end: '2024-01-01' },
];

console.log('=== モメンタム確信度チューニング（OBS000024）===\n');
console.log('--- 選定フェーズ（BTC複数期間、固定60 vs 動的scale）---\n');

const SCALES = [5, 10, 15, 20, 30];
const fmt = (r: PipelineResult): string => `Sharpe${r.sharpeRatio.toFixed(2)} DD${(r.maxDrawdown * 100).toFixed(1)}% Ret${(r.totalReturn * 100).toFixed(1)}% T${r.trades.length}`;

const avgByScale = new Map<string, number[]>();
avgByScale.set('fixed60', []);
for (const s of SCALES) avgByScale.set(`scale${s}`, []);

for (const w of BTC_WINDOWS) {
  console.log(`[${w.label}]`);
  const baseline = runMomentum(btc, w.start, w.end, undefined);
  console.log(`  固定60:    ${fmt(baseline)}`);
  avgByScale.get('fixed60')!.push(baseline.sharpeRatio);
  for (const s of SCALES) {
    const r = runMomentum(btc, w.start, w.end, s);
    console.log(`  scale${String(s).padEnd(3)}:  ${fmt(r)}`);
    avgByScale.get(`scale${s}`)!.push(r.sharpeRatio);
  }
  console.log();
}

const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log('--- BTC平均Sharpe ---');
console.log(`固定60: ${avg(avgByScale.get('fixed60')!).toFixed(3)}`);
let bestScale = -1;
let bestAvg = avg(avgByScale.get('fixed60')!);
for (const s of SCALES) {
  const a = avg(avgByScale.get(`scale${s}`)!);
  console.log(`scale${s}: ${a.toFixed(3)}`);
  if (a > bestAvg) { bestAvg = a; bestScale = s; }
}

if (bestScale === -1) {
  console.log('\n選定結果: 固定60が最良（動的化のいずれのscaleも上回れず）');
} else {
  console.log(`\n選定結果: scale=${bestScale}（BTC平均Sharpe ${avg(avgByScale.get('fixed60')!).toFixed(3)}→${bestAvg.toFixed(3)}）`);
}

// --- 確認フェーズ: ETH（選定に使っていない未見データ）---
console.log(`\n--- 確認フェーズ（ETH・未見データ）---`);
const ETH_WINDOWS: { label: string; start: string; end?: string }[] = [
  { label: 'ETH 2021-2026連続', start: '2021-01-01' },
  { label: 'ETH 2023-2026直近', start: '2023-01-01' },
];
let ethBaselineSum = 0;
let ethScaledSum = 0;
for (const w of ETH_WINDOWS) {
  const baseline = runMomentum(eth, w.start, w.end, undefined);
  const scaled = bestScale === -1 ? baseline : runMomentum(eth, w.start, w.end, bestScale);
  ethBaselineSum += baseline.sharpeRatio;
  ethScaledSum += scaled.sharpeRatio;
  console.log(`[${w.label}] 固定60: ${fmt(baseline)}  |  ${bestScale === -1 ? '(選定なし)' : `scale${bestScale}`}: ${fmt(scaled)}`);
}

console.log('\n=== 判定 ===');
if (bestScale === -1) {
  console.log('⚠️ BTCの選定フェーズで固定60を上回るscaleが見つからなかった。確信度動的化は不採用とし、固定60を維持する。');
} else if (ethScaledSum > ethBaselineSum) {
  console.log(`✅ 選定に使っていないETHでもscale=${bestScale}が固定60を上回った（合計Sharpe ${ethBaselineSum.toFixed(2)}→${ethScaledSum.toFixed(2)}）。確信度動的化を採用する。`);
} else {
  console.log(`⚠️ ETHでは固定60の方が良かった（合計Sharpe 固定60=${ethBaselineSum.toFixed(2)} vs scale${bestScale}=${ethScaledSum.toFixed(2)}）。BTCでの改善は過最適の疑いがあり、確信度動的化は不採用とし固定60を維持する。`);
}
