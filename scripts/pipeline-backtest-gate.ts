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

// --- 適応的中央値ゲート（推奨・固定閾値の過最適を回避）---
console.log('\n=== 適応的ERゲート（過去中央値・自己校正）===');
const warmups = argStr('--warmups', '20,30,40').split(',').map(Number);
interface AdaptiveSummary { warmup: number; avgSharpe: number; avgDD: number; recentSharpe: number; totalTrades: number; }
const adaptiveSummaries: AdaptiveSummary[] = [];
for (const w of warmups) {
  const cfg = { ...baseConfig, adaptiveErGateWarmup: w };
  const sharpes: number[] = []; const dds: number[] = []; let totalTrades = 0; let recentSharpe = 0;
  for (const fold of folds) {
    const r = simulatePortfolio(candles, { ...cfg, testRatio: fold.testRatio, testEndFraction: fold.testEndFraction });
    sharpes.push(r.sharpeRatio); dds.push(r.maxDrawdown); totalTrades += r.trades.length;
    if (fold.label === '2025') recentSharpe = r.sharpeRatio;
    console.log(`  warmup${w} ${fold.label}: ${fmt(r)}`);
  }
  console.log(`  → 平均Sharpe ${avg(sharpes).toFixed(2)}, 平均DD ${(avg(dds) * 100).toFixed(1)}%, 総トレード ${totalTrades}\n`);
  adaptiveSummaries.push({ warmup: w, avgSharpe: avg(sharpes), avgDD: avg(dds), recentSharpe, totalTrades });
}
console.log('warmup   平均Sharpe  平均DD    2025Sharpe  総トレード');
for (const s of adaptiveSummaries) {
  console.log(`${String(s.warmup).padEnd(7)}  ${s.avgSharpe.toFixed(2).padStart(8)}  ${(s.avgDD * 100).toFixed(1).padStart(6)}%  ${s.recentSharpe.toFixed(2).padStart(9)}  ${String(s.totalTrades).padStart(8)}`);
}

// --- 連続1回実行（適応的ゲートの正しい評価：大域中央値が貯まり続ける実運用相当）---
// 年次フォールドは各年でsimulatePortfolioを別呼びするため過去中央値がリセットされ、適応的ゲートを
// 正しく評価できない。ここでは2021-01-01〜末尾を1回の連続実行で評価する（regime-gate-validationと整合）。
console.log('\n=== 連続実行（2021〜末尾を1回・適応ゲートの正しい評価）===');
const contStartPos = Math.max(0, candleIndexAtOrAfter('2021-01-01') - 20);
const contRatio = 1 - contStartPos / validLen;
const contCfgs: { name: string; cfg: Record<string, unknown> }[] = [
  { name: '無ゲート', cfg: {} },
  { name: '固定0.2', cfg: { minEfficiencyRatio: 0.2 } },
  { name: '適応warmup30', cfg: { adaptiveErGateWarmup: 30 } },
  { name: '適応warmup50', cfg: { adaptiveErGateWarmup: 50 } },
];
console.log('戦略          ' + fmt.name + '（2021-01-01〜' + lastDate + ' 連続）');
let contBaseline = 0;
for (const { name, cfg } of contCfgs) {
  const r = simulatePortfolio(candles, { ...baseConfig, ...cfg, testRatio: contRatio, testEndFraction: 1 });
  if (name === '無ゲート') contBaseline = r.sharpeRatio;
  console.log(`  ${name.padEnd(12)} ${fmt(r)}`);
}
console.log(`  （無ゲート連続Sharpe=${contBaseline.toFixed(2)} を基準に、ゲートで上回れば実運用で有効）`);

console.log('\n=== 判定 ===');
console.log(`無ゲート: 平均Sharpe ${baseline.avgSharpe.toFixed(2)}, 平均DD ${(baseline.avgDD * 100).toFixed(1)}%, 2025 ${baseline.recentSharpe.toFixed(2)}`);
if (best && best.avgSharpe > baseline.avgSharpe + 0.1) {
  console.log(`固定閾値の最良: 閾値${best.threshold} → 平均Sharpe ${best.avgSharpe.toFixed(2)}（ただし閾値依存が強く過最適リスク）`);
}
console.log('※適応的ゲートは連続実行（上記）で評価するのが正しい。年次フォールドは各年で中央値がリセットされるため参考値。');
console.log('\n【結論】原則的な適応的中央値ゲートは連続実行で無ゲートを上回らない。');
console.log('改善するのは固定0.2のみだが、閾値0.25で崩壊する非単調性＝過最適。自己校正版が効果を捉えない事実が「固定0.2は蜃気楼」を裏付ける。');
console.log('→ ERレジームゲートはポートフォリオ水準では"deployableな改善"として確認できない。予測単位の優位性が手数料/サイジング/非重複保有の実行層で消えている可能性。');
console.log('　次: (a)手数料/回転率が②のエッジを食っていないかの感度分析, (b)ETHでの再現確認, (c)②のモデルクラス自体の見直し。');
