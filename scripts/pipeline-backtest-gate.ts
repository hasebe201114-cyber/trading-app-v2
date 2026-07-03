/**
 * ②ERゲート パイプライン統合バックテスト（OBS000018）
 *
 * regime-gate-validation.ts は②の「予測単位」でERゲートの有効性を確認した。
 * 本スクリプトは実ポートフォリオ（③④⑤⑥込み・手数料/スリッページ/サイジング/非重複保有）で
 * ERゲートあり/なしを年次フォールドで比較し、閾値を振って最適点と頑健性を見る。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/pipeline-backtest-gate.ts
 *   node --experimental-strip-types scripts/pipeline-backtest-gate.ts --thresholds 0,0.2,0.3,0.4
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';
import type { PipelineResult } from '../src/pipeline/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

function argStr(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const thresholds = argStr('--thresholds', '0,0.15,0.2,0.25,0.3,0.35,0.4').split(',').map(Number);
const HORIZON = Number(argStr('--horizon', '10'));
const K = Number(argStr('--k', '30'));

const candles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-2010-2026.csv'));
const n = candles.length;
const baseConfig = { horizon: HORIZON, k: K, initialEquity: 1_000_000 };
const validLen = n - baseConfig.horizon - 20;
const utcDateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

function candleIndexAtOrAfter(date: string): number {
  for (let i = 0; i < n; i++) if (utcDateOf(candles[i].time) >= date) return i;
  return n;
}

const FOLD_DATES = ['2021-01-01', '2022-01-01', '2023-01-01', '2024-01-01', '2025-01-01'];
const lastDate = utcDateOf(candles[n - 1].time);

interface Fold { label: string; testRatio: number; testEndFraction: number; }
const folds: Fold[] = [];
for (let i = 0; i < FOLD_DATES.length; i++) {
  const startDate = FOLD_DATES[i];
  const endDate = i + 1 < FOLD_DATES.length ? FOLD_DATES[i + 1] : lastDate;
  const startPos = Math.max(0, candleIndexAtOrAfter(startDate) - 20);
  const endPos = Math.min(validLen, (i + 1 < FOLD_DATES.length ? candleIndexAtOrAfter(endDate) : n) - 20);
  if (endPos <= startPos) continue;
  folds.push({ label: `${startDate.slice(0, 4)}`, testRatio: 1 - startPos / validLen, testEndFraction: endPos / validLen });
}

const fmt = (r: PipelineResult): string =>
  `T${String(r.trades.length).padStart(2)} 勝率${(r.winRate * 100).toFixed(0)}% Ret${(r.totalReturn * 100).toFixed(1)}% DD${(r.maxDrawdown * 100).toFixed(1)}% Sharpe${r.sharpeRatio.toFixed(2)}`;
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

console.log('=== ②ERゲート パイプライン統合バックテスト（OBS000018）===\n');
console.log(`日足${n}本, フォールド: ${folds.map(f => f.label).join('/')}年\n`);

interface Summary { threshold: number; avgSharpe: number; avgDD: number; recentSharpe: number; totalTrades: number; }
const summaries: Summary[] = [];

for (const th of thresholds) {
  const cfg = th === 0 ? baseConfig : { ...baseConfig, minEfficiencyRatio: th };
  console.log(`--- minEfficiencyRatio = ${th === 0 ? 'なし(0)' : th} ---`);
  const sharpes: number[] = [];
  const dds: number[] = [];
  let totalTrades = 0;
  let recentSharpe = 0;
  for (const fold of folds) {
    const r = simulatePortfolio(candles, { ...cfg, testRatio: fold.testRatio, testEndFraction: fold.testEndFraction });
    sharpes.push(r.sharpeRatio);
    dds.push(r.maxDrawdown);
    totalTrades += r.trades.length;
    if (fold.label === '2025') recentSharpe = r.sharpeRatio;
    console.log(`  ${fold.label}: ${fmt(r)}`);
  }
  console.log(`  → 平均Sharpe ${avg(sharpes).toFixed(2)}, 平均DD ${(avg(dds) * 100).toFixed(1)}%, 総トレード ${totalTrades}\n`);
  summaries.push({ threshold: th, avgSharpe: avg(sharpes), avgDD: avg(dds), recentSharpe, totalTrades });
}

console.log('=== 閾値スイープ サマリー ===');
console.log('閾値      平均Sharpe  平均DD    2025Sharpe  総トレード');
for (const s of summaries) {
  console.log(`${(s.threshold === 0 ? 'なし' : s.threshold.toString()).padEnd(8)}  ${s.avgSharpe.toFixed(2).padStart(8)}  ${(s.avgDD * 100).toFixed(1).padStart(6)}%  ${s.recentSharpe.toFixed(2).padStart(9)}  ${String(s.totalTrades).padStart(8)}`);
}

const baseline = summaries.find(s => s.threshold === 0)!;
const best = summaries.filter(s => s.threshold > 0 && s.totalTrades >= 40).sort((a, b) => b.avgSharpe - a.avgSharpe)[0];
console.log('\n=== 判定 ===');
if (best && best.avgSharpe > baseline.avgSharpe + 0.1) {
  console.log(`✅ ERゲート(閾値${best.threshold})で平均Sharpe ${baseline.avgSharpe.toFixed(2)}→${best.avgSharpe.toFixed(2)}、2025 ${baseline.recentSharpe.toFixed(2)}→${best.recentSharpe.toFixed(2)}に改善。`);
  console.log('   ※トレード数が減るため過度に高い閾値は避け、頑健性(ETH等)を追加確認のこと。');
} else {
  console.log(`⚠️ ポートフォリオ指標では明確な改善が出ず（予測単位の結果と乖離）。手数料/サイジング/非重複保有の影響を精査。ベースSharpe ${baseline.avgSharpe.toFixed(2)}`);
}
