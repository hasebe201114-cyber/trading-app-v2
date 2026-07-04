/**
 * モメンタム(OBS000023/024) + ERレジームゲート(OBS000018)の組み合わせ検証
 *
 * OBS000024で「モメンタム+確信度動的化」はBTC2022年(弱気相場)で固定60より
 * 不利という留保点が残った。ERゲート（効率比が低いレンジ局面を見送る）を
 * 組み合わせることで、方向感の乏しい局面のポジションを間引き、この弱点を
 * 緩和できるかを検証する。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/momentum-er-gate-validation.ts
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
const CONFIDENCE_SCALE = 30;
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
const fmt = (r: PipelineResult): string => `Sharpe${r.sharpeRatio.toFixed(2)} DD${(r.maxDrawdown * 100).toFixed(1)}% Ret${(r.totalReturn * 100).toFixed(1)}% T${r.trades.length}`;

function run(candles: OHLCV[], start: string, end: string | undefined, extra: Record<string, unknown>): PipelineResult {
  const w = windowConfig(candles, start, end);
  return simulatePortfolio(candles, {
    horizon: HORIZON, k: K, initialEquity: 1_000_000,
    momentumLookback: MOMENTUM_L, momentumConfidenceScale: CONFIDENCE_SCALE,
    ...w, ...extra,
  });
}

const btc = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
const eth = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));

const WINDOWS: { label: string; start: string; end?: string }[] = [
  { label: 'BTC 2021-2026連続', start: '2021-01-01' },
  { label: 'BTC 2023-2026直近', start: '2023-01-01' },
  { label: 'BTC 2022年(弱気・留保点)', start: '2022-01-01', end: '2023-01-01' },
  { label: 'BTC 2023年', start: '2023-01-01', end: '2024-01-01' },
];

console.log('=== モメンタム + ERゲート 組み合わせ検証 ===\n');
console.log('--- 選定フェーズ（BTC、モメンタム単体 vs +適応的ERゲート）---\n');

const WARMUPS = [20, 30, 40, 50];
const avgByConfig = new Map<string, number[]>();
avgByConfig.set('momentumOnly', []);
for (const w of WARMUPS) avgByConfig.set(`erGate${w}`, []);

for (const w of WINDOWS) {
  console.log(`[${w.label}]`);
  const baseline = run(btc, w.start, w.end, {});
  console.log(`  モメンタムのみ:        ${fmt(baseline)}`);
  avgByConfig.get('momentumOnly')!.push(baseline.sharpeRatio);
  for (const warmup of WARMUPS) {
    const r = run(btc, w.start, w.end, { adaptiveErGateWarmup: warmup });
    console.log(`  +ERゲート(warmup${warmup}): ${fmt(r)}`);
    avgByConfig.get(`erGate${warmup}`)!.push(r.sharpeRatio);
  }
  console.log();
}

const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log('--- BTC平均Sharpe ---');
console.log(`モメンタムのみ: ${avg(avgByConfig.get('momentumOnly')!).toFixed(3)}`);
let bestWarmup = -1;
let bestAvg = avg(avgByConfig.get('momentumOnly')!);
for (const w of WARMUPS) {
  const a = avg(avgByConfig.get(`erGate${w}`)!);
  console.log(`+ERゲート(warmup${w}): ${a.toFixed(3)}`);
  if (a > bestAvg) { bestAvg = a; bestWarmup = w; }
}

if (bestWarmup === -1) {
  console.log('\n選定結果: モメンタム単体が最良（ERゲートのいずれのwarmupも上回れず）');
} else {
  console.log(`\n選定結果: warmup=${bestWarmup}（BTC平均Sharpe ${avg(avgByConfig.get('momentumOnly')!).toFixed(3)}→${bestAvg.toFixed(3)}）`);
}

console.log('\n--- 確認フェーズ（ETH・未見データ）---');
const ETH_WINDOWS: { label: string; start: string; end?: string }[] = [
  { label: 'ETH 2021-2026連続', start: '2021-01-01' },
  { label: 'ETH 2023-2026直近', start: '2023-01-01' },
];
let ethBaselineSum = 0;
let ethGatedSum = 0;
for (const w of ETH_WINDOWS) {
  const baseline = run(eth, w.start, w.end, {});
  const gated = bestWarmup === -1 ? baseline : run(eth, w.start, w.end, { adaptiveErGateWarmup: bestWarmup });
  ethBaselineSum += baseline.sharpeRatio;
  ethGatedSum += gated.sharpeRatio;
  console.log(`[${w.label}] モメンタムのみ: ${fmt(baseline)}  |  ${bestWarmup === -1 ? '(選定なし)' : `+ERゲート(w${bestWarmup})`}: ${fmt(gated)}`);
}

console.log('\n=== 判定 ===');
if (bestWarmup === -1) {
  console.log('⚠️ ERゲートはBTCの選定フェーズでモメンタム単体を上回れなかった。組み合わせは不採用とし、モメンタム単体(確信度動的化のみ)を維持する。');
} else if (ethGatedSum > ethBaselineSum) {
  console.log(`✅ 選定に使っていないETHでもwarmup=${bestWarmup}が上回った（合計Sharpe ${ethBaselineSum.toFixed(2)}→${ethGatedSum.toFixed(2)}）。ERゲートとの組み合わせを採用する。`);
} else {
  console.log(`⚠️ ETHでは組み合わせなしの方が良かった（合計Sharpe モメンタムのみ=${ethBaselineSum.toFixed(2)} vs +ERゲート=${ethGatedSum.toFixed(2)}）。BTCでの改善は過最適の疑いがあり、不採用としモメンタム単体を維持する。`);
}
