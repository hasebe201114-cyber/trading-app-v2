/**
 * レジームスイッチのパイプライン統合バックテスト（OBS000025）
 *
 * regime-switch-validation.tsは予測単位で「方向は改善するがBTC2022年は解決せず、
 * 統計的有意性は弱い」という結果だった。本スクリプトは③④⑤⑥込みの実ポートフォリオで
 * モメンタム単体(確信度動的化) vs +レジームスイッチ を比較する。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/pipeline-backtest-regime-switch.ts
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
  { label: 'BTC 2022年(弱気)', start: '2022-01-01', end: '2023-01-01' },
  { label: 'BTC 2023年', start: '2023-01-01', end: '2024-01-01' },
];

console.log('=== レジームスイッチ パイプライン統合バックテスト（OBS000025）===\n');
console.log('--- 選定フェーズ（BTC）---\n');

const WARMUPS = [30, 40, 50];
let momSum = 0;
const switchSums = new Map<number, number>();
for (const w of WARMUPS) switchSums.set(w, 0);

for (const w of WINDOWS) {
  console.log(`[${w.label}]`);
  const mom = run(btc, w.start, w.end, {});
  console.log(`  モメンタムのみ:          ${fmt(mom)}`);
  momSum += mom.sharpeRatio;
  for (const warmup of WARMUPS) {
    const r = run(btc, w.start, w.end, { regimeSwitchErGateWarmup: warmup });
    console.log(`  +レジームスイッチ(w${warmup}): ${fmt(r)}`);
    switchSums.set(warmup, switchSums.get(warmup)! + r.sharpeRatio);
  }
  console.log();
}

console.log(`BTC合計Sharpe: モメンタムのみ=${momSum.toFixed(2)}`);
let bestWarmup = -1;
let bestSum = momSum;
for (const w of WARMUPS) {
  const s = switchSums.get(w)!;
  console.log(`+レジームスイッチ(w${w})=${s.toFixed(2)}`);
  if (s > bestSum) { bestSum = s; bestWarmup = w; }
}
if (bestWarmup === -1) {
  console.log('\n選定結果: モメンタム単体が最良（レジームスイッチのいずれのwarmupも上回れず）');
} else {
  console.log(`\n選定結果: warmup=${bestWarmup}（BTC合計Sharpe ${momSum.toFixed(2)}→${bestSum.toFixed(2)}）`);
}

console.log('\n--- 確認フェーズ（ETH・未見データ）---');
const ETH_WINDOWS: { label: string; start: string; end?: string }[] = [
  { label: 'ETH 2021-2026連続', start: '2021-01-01' },
  { label: 'ETH 2023-2026直近', start: '2023-01-01' },
];
let ethMomSum = 0, ethSwitchSum = 0;
for (const w of ETH_WINDOWS) {
  const mom = run(eth, w.start, w.end, {});
  const sw = bestWarmup === -1 ? mom : run(eth, w.start, w.end, { regimeSwitchErGateWarmup: bestWarmup });
  ethMomSum += mom.sharpeRatio; ethSwitchSum += sw.sharpeRatio;
  console.log(`[${w.label}] モメンタムのみ: ${fmt(mom)}  |  ${bestWarmup === -1 ? '(選定なし)' : `+スイッチ(w${bestWarmup})`}: ${fmt(sw)}`);
}

console.log('\n=== 判定 ===');
if (bestWarmup === -1) {
  console.log('⚠️ レジームスイッチはBTC選定フェーズでモメンタム単体を上回れなかった。不採用。');
} else if (ethSwitchSum > ethMomSum) {
  console.log(`✅ 選定に使っていないETHでもwarmup=${bestWarmup}が上回った（合計Sharpe ${ethMomSum.toFixed(2)}→${ethSwitchSum.toFixed(2)}）。採用する。`);
} else {
  console.log(`⚠️ ETHでは組み合わせなしの方が良かった（モメンタムのみ=${ethMomSum.toFixed(2)} vs +スイッチ=${ethSwitchSum.toFixed(2)}）。過最適の疑いがあり不採用、モメンタム単体を維持。`);
}
