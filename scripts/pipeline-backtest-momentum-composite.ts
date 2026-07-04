/**
 * マルチ時間軸モメンタム合成のパイプライン統合バックテスト（OBS000028）
 *
 * 予測単位での評価で選定した複数ホライズン合成構成を、
 * ④⑤⑥込みの実ポートフォリオ（手数料・サイジング・非重複保有）で
 * ベースラインL=30と比較する。
 *
 * W1=BTC 2023年, W2=BTC 2024年, W3=BTC 2025年, W4=ETH 2021-2026, W5=ETH 2023-2026
 * の5枠で、Sharpe/DD等を出力。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/pipeline-backtest-momentum-composite.ts
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

interface WindowResult {
  label: string;
  baseline: PipelineResult;
  composite: PipelineResult;
}

/**
 * 選定構成を決定的に返す。
 * 予測単位スクリプト（momentum-composite-robustness.ts）と同一アルゴリズムで
 * BTC 2011-2022の生シグナルSharpeで選定した結果（S2 {20,60,120} rule=zsum）を使用。
 * 両スクリプトで同一構成に収束することを保証。
 */
function selectBestComposite(
  btc: OHLCV[],
): { set: number[]; rule: 'vote' | 'zsum'; setName: string } {
  // 予測単位スクリプトで確定した選定結果をハードコード
  // → これにより、両スクリプトの選定構成が完全に一致することを保証
  return { setName: 'S2', set: [20, 60, 120], rule: 'zsum' };
}

function runWindow(label: string, candles: OHLCV[], startDate: string, endDate?: string): WindowResult {
  const n = candles.length;
  const validLen = n - HORIZON - 20;
  const startPos = Math.max(0, candleIndexAtOrAfter(candles, startDate) - 20);
  const endPos = endDate ? Math.min(validLen, candleIndexAtOrAfter(candles, endDate) - 20) : validLen;
  const testRatio = 1 - startPos / validLen;
  const testEndFraction = endPos / validLen;

  const baseConfig = { horizon: HORIZON, initialEquity: 1_000_000, testRatio, testEndFraction };

  const baseline = simulatePortfolio(candles, { ...baseConfig, k: K, momentumLookback: MOMENTUM_L, momentumConfidenceScale: CONFIDENCE_SCALE });

  // compositeはselectedConfigで指定
  const composite = simulatePortfolio(candles, { ...baseConfig, k: K, momentumLookbackSet: selectedConfig.set, momentumCompositeRule: selectedConfig.rule, momentumConfidenceScale: CONFIDENCE_SCALE });

  return { label, baseline, composite };
}

console.log('=== マルチ時間軸モメンタム合成のパイプライン統合バックテスト（OBS000028）===\n');

const btc = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
const eth = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));

console.log(`BTC: ${btc.length}本 (${utcDateOf(btc[0].time)}〜${utcDateOf(btc[btc.length - 1].time)})`);
console.log(`ETH: ${eth.length}本 (${utcDateOf(eth[0].time)}〜${utcDateOf(eth[eth.length - 1].time)})\n`);

// 選定フェーズで最良構成を決定
const selectedConfig = selectBestComposite(btc);
console.log(`選定結果: ${selectedConfig.setName} {${selectedConfig.set.join(',')}} (rule=${selectedConfig.rule})\n`);

// ウィンドウ実行
const windows: WindowResult[] = [];

console.log('--- 5つの確認ウィンドウ ---\n');

// W1: BTC 2023年
windows.push(runWindow('W1: BTC 2023', btc, '2023-01-01', '2024-01-01'));

// W2: BTC 2024年
windows.push(runWindow('W2: BTC 2024', btc, '2024-01-01', '2025-01-01'));

// W3: BTC 2025年（末尾）
windows.push(runWindow('W3: BTC 2025', btc, '2025-01-01'));

// W4: ETH 2021-2026連続
windows.push(runWindow('W4: ETH 2021-2026', eth, '2021-01-01'));

// W5: ETH 2023-2026直近
windows.push(runWindow('W5: ETH 2023-2026', eth, '2023-01-01'));

// 結果出力
const fmt = (r: PipelineResult): string =>
  `T${String(r.trades.length).padStart(3)} 勝率${(r.winRate * 100).toFixed(0).padStart(3)}% Ret${(r.totalReturn * 100).toFixed(1).padStart(6)}% DD${(r.maxDrawdown * 100).toFixed(1).padStart(5)}% Sharpe${r.sharpeRatio.toFixed(2).padStart(5)}`;

for (const w of windows) {
  console.log(`--- ${w.label} ---`);
  console.log(`  ベースラインL=30:  ${fmt(w.baseline)}`);
  console.log(`  合成:              ${fmt(w.composite)}`);
  const sharpeD = w.composite.sharpeRatio - w.baseline.sharpeRatio;
  const sign = sharpeD >= 0 ? '+' : '';
  console.log(`  Sharpe差分:        ${sign}${sharpeD.toFixed(3)}\n`);
}

// サマリー
console.log('=== サマリー ===\n');

const sharpeDiffs = windows.map(w => w.composite.sharpeRatio - w.baseline.sharpeRatio);
const avgSharpeD = sharpeDiffs.reduce((a, b) => a + b, 0) / sharpeDiffs.length;
const improvementCount = sharpeDiffs.filter(d => d >= 0).length;
const worstD = Math.min(...sharpeDiffs);

const allSharpesComposite = windows.map(w => w.composite.sharpeRatio);
const allSharpesBaseline = windows.map(w => w.baseline.sharpeRatio);
const allDDs = windows.map(w => w.composite.maxDrawdown);
const avgCompositeSharepe = allSharpesComposite.reduce((a, b) => a + b, 0) / allSharpesComposite.length;

const ethWindows = windows.filter(w => w.label.includes('ETH'));
const ethSharpeDiffs = ethWindows.map(w => w.composite.sharpeRatio - w.baseline.sharpeRatio);
const ethAvgD = ethSharpeDiffs.reduce((a, b) => a + b, 0) / ethSharpeDiffs.length;

console.log(`平均Sharpe差分（5枠）: ${avgSharpeD.toFixed(3)}`);
console.log(`改善枠数: ${improvementCount}/5`);
console.log(`最悪Sharpe差分: ${worstD.toFixed(3)}`);
console.log(`全枠の最大DD（合成）: ${Math.max(...allDDs).toFixed(1)}%`);
console.log(`全枠のSharpe符号（合成）: ${allSharpesComposite.every(s => s >= 0) ? '全て非負' : '一部負'}`);
console.log(`ETH枠（W4, W5）の平均Sharpe差分: ${ethAvgD.toFixed(3)}`);

console.log('\n=== 生データ出力完了 ===');
console.log(`選定構成: ${selectedConfig.setName} {${selectedConfig.set.join(',')}} (rule=${selectedConfig.rule})`);
