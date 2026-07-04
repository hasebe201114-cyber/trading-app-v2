/**
 * ③あり/なし 比較バックテスト（OBS000014 / PJ000001 5.2節 Phase2 KPI検証）
 *
 * llm-feature-extraction.ts が生成した日次LLM特徴量キャッシュをパイプラインに注入し、
 * 「②単体（③なし）」と「②+③」のポートフォリオ指標差分をフォールドごとに測定する。
 * Phase2 KPI: ③ありで シャープレシオ+0.2以上 または 最大DD-3pt以上 の改善。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/pipeline-backtest-llm.ts            # live優先で自動選択
 *   node --experimental-strip-types scripts/pipeline-backtest-llm.ts --mock     # mockキャッシュで配線検証
 *
 * フォールドは年次（2021〜）。ニュースデータが高密度な期間に限定する（scripts/data/README.md参照）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';
import type { PipelineResult } from '../src/pipeline/types.ts';
import type { MarketContextLogEntry } from '../src/llm-layer/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const useMock = process.argv.includes('--mock');

// キャッシュ選択: --mock 指定時はmock。無指定時はliveを優先し、無ければmockにフォールバック（警告表示）
const livePath = join(DATA_DIR, 'llm-features-daily.live.json');
const mockPath = join(DATA_DIR, 'llm-features-daily.mock.json');
let cachePath: string;
if (useMock) {
  cachePath = mockPath;
} else if (existsSync(livePath)) {
  cachePath = livePath;
} else {
  cachePath = mockPath;
  console.warn('[警告] liveキャッシュが見つからないためmockキャッシュを使用します。');
  console.warn('       実LLMの効果測定には llm-feature-extraction.ts を APIキーありで実行してください。\n');
}

if (!existsSync(cachePath)) {
  console.error(`キャッシュが見つかりません: ${cachePath}`);
  console.error('先に llm-feature-extraction.ts を実行してください。');
  process.exit(1);
}

const cache: Record<string, MarketContextLogEntry> = JSON.parse(readFileSync(cachePath, 'utf-8'));
const candles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-2010-2026.csv'));

const baseConfig = { horizon: 10, k: 30, initialEquity: 1_000_000, momentumLookback: 30, momentumConfidenceScale: 30 };

// --- 年次フォールド境界（UTC日付）をvalidIndices空間の比率に変換 ---
// simulatePortfolio内部: validIndices = [20 .. n-horizon-1] → 長さ n-horizon-20
const n = candles.length;
const validLen = n - baseConfig.horizon - 20;
const utcDateOf = (timeMs: number): string => new Date(timeMs).toISOString().slice(0, 10);

function candleIndexAtOrAfter(date: string): number {
  for (let i = 0; i < n; i++) {
    if (utcDateOf(candles[i].time) >= date) return i;
  }
  return n;
}

const FOLD_DATES = ['2021-01-01', '2022-01-01', '2023-01-01', '2024-01-01', '2025-01-01'];
const lastDate = utcDateOf(candles[n - 1].time);

interface Fold {
  label: string;
  testRatio: number;
  testEndFraction: number;
}

const folds: Fold[] = [];
for (let i = 0; i < FOLD_DATES.length; i++) {
  const startDate = FOLD_DATES[i];
  const endDate = i + 1 < FOLD_DATES.length ? FOLD_DATES[i + 1] : lastDate;
  const startIdx = candleIndexAtOrAfter(startDate);
  const endIdx = i + 1 < FOLD_DATES.length ? candleIndexAtOrAfter(endDate) : n;
  const startPos = Math.max(0, startIdx - 20);
  const endPos = Math.min(validLen, endIdx - 20);
  if (endPos <= startPos) continue;
  folds.push({
    label: `${startDate.slice(0, 4)}年 [${startDate}〜${endDate}]`,
    testRatio: 1 - startPos / validLen,
    testEndFraction: endPos / validLen,
  });
}

// --- ③特徴量プロバイダー ---
const marketContextForDay = (utcDate: string) => cache[utcDate]?.output;

// キャッシュの信号統計
const entries = Object.entries(cache);
const vetoLevel = entries.filter(([, e]) => Math.abs(e.output.eventImpactScore) >= 0.5).length;
const confirmLevel = entries.filter(([, e]) => Math.abs(e.output.eventImpactScore) >= 0.3).length;
const source = entries[0]?.[1].source ?? '不明';
const model = entries[0]?.[1].model ?? '不明';

console.log('=== ③あり/なし 比較バックテスト（Phase2 KPI検証） ===\n');
console.log(`日足データ: ${n}本（${utcDateOf(candles[0].time)}〜${lastDate}）`);
console.log(`③キャッシュ: ${cachePath}`);
console.log(`  ソース=${source}, モデル=${model}, 収録=${entries.length}日`);
console.log(`  |impact|>=0.5(veto級)=${vetoLevel}日, |impact|>=0.3(確信度加点級)=${confirmLevel}日\n`);

const fmt = (r: PipelineResult): string =>
  `トレード${String(r.trades.length).padStart(3)}件 勝率${(r.winRate * 100).toFixed(1)}% ` +
  `総リターン${(r.totalReturn * 100).toFixed(1)}% 最大DD${(r.maxDrawdown * 100).toFixed(1)}% シャープ${r.sharpeRatio.toFixed(2)}`;

let kpiAchievedFolds = 0;
const sharpeDiffs: number[] = [];
const ddDiffs: number[] = [];

for (const fold of folds) {
  const without = simulatePortfolio(candles, { ...baseConfig, testRatio: fold.testRatio, testEndFraction: fold.testEndFraction });
  const withLlm = simulatePortfolio(candles, { ...baseConfig, testRatio: fold.testRatio, testEndFraction: fold.testEndFraction, marketContextForDay });

  const sharpeDiff = withLlm.sharpeRatio - without.sharpeRatio;
  const ddDiff = (without.maxDrawdown - withLlm.maxDrawdown) * 100; // 正の値=改善(pt)
  sharpeDiffs.push(sharpeDiff);
  ddDiffs.push(ddDiff);
  const kpiAchieved = sharpeDiff >= 0.2 || ddDiff >= 3;
  if (kpiAchieved) kpiAchievedFolds++;

  console.log(`--- ${fold.label} ---`);
  console.log(`  ③なし: ${fmt(without)}`);
  console.log(`  ③あり: ${fmt(withLlm)}`);
  console.log(`  差分: シャープ${sharpeDiff >= 0 ? '+' : ''}${sharpeDiff.toFixed(2)}, 最大DD${ddDiff >= 0 ? '-' : '+'}${Math.abs(ddDiff).toFixed(1)}pt` +
    ` → Phase2 KPI ${kpiAchieved ? '達成' : '未達'}`);
  console.log();
}

const avg = (xs: number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log('=== サマリー ===');
console.log(`シャープレシオ差分 平均: ${avg(sharpeDiffs) >= 0 ? '+' : ''}${avg(sharpeDiffs).toFixed(2)}`);
console.log(`最大DD改善 平均: ${avg(ddDiffs).toFixed(1)}pt`);
console.log(`Phase2 KPI（シャープ+0.2以上 or 最大DD-3pt以上）達成フォールド: ${kpiAchievedFolds}/${folds.length}`);
if (source === 'mock') {
  console.log('\n[注意] mockキャッシュによる結果です。配線検証用であり③の実効果を示すものではありません。');
}
