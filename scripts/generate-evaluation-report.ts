/**
 * ⑦評価・チューニング層 — パイプラインバックテスト結果をJSONスナップショットとして
 * src/data/evaluationReport.json に出力する。EvaluationScreen.tsx がこれを読み込んで
 * 目標(PJ000001)と実績を並べて表示する。
 *
 * ブラウザ上でk近傍探索を毎回実行するのは現段階では過剰なため、Node側で事前計算した
 * スナップショットを表示する方式にしている（将来的にFirebase接続後は定期実行 + Firestore
 * 保存に置き換える想定。D001参照）。
 *
 * 実行: node --experimental-strip-types scripts/generate-evaluation-report.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadOhlcvFromCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, 'data', 'btc-daily-2010-2020.csv');
const outPath = join(__dirname, '..', 'src', 'data', 'evaluationReport.json');

const candles = loadOhlcvFromCsv(csvPath);
const baseConfig = { horizon: 10, k: 30, initialEquity: 1_000_000 };
const FOLD_BOUNDARIES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

const folds = [];
for (let i = 0; i < FOLD_BOUNDARIES.length - 1; i++) {
  const testStartFraction = FOLD_BOUNDARIES[i];
  const testEndFraction = FOLD_BOUNDARIES[i + 1];
  const result = simulatePortfolio(candles, {
    ...baseConfig,
    testRatio: 1 - testStartFraction,
    testEndFraction,
  });
  folds.push({
    label: `フォールド${i + 1} [${(testStartFraction * 100).toFixed(0)}-${(testEndFraction * 100).toFixed(0)}%]`,
    tradeCount: result.trades.length,
    winRate: result.winRate,
    totalReturn: result.totalReturn,
    maxDrawdown: result.maxDrawdown,
    sharpeRatio: result.sharpeRatio,
  });
}

const sharpeValues = folds.map(f => f.sharpeRatio);
const ddValues = folds.map(f => f.maxDrawdown);

const report = {
  generatedAt: new Date().toISOString(),
  config: baseConfig,
  dataSource: 'scripts/data/btc-daily-2010-2020.csv（GitHub経由の暫定データ、取引所API未接続。scripts/data/README.md参照）',
  caveats: [
    '③LLM特徴量層はmockClient使用（実ニュースデータなし）。②④⑤⑥の配線確認であり③の実効果は含まない',
    '単一銘柄(BTC)・単一データソースでの検証。複数銘柄・複数データソースでの再現性は未確認',
    'このレポートはNode側で事前計算したスナップショット。ブラウザでのリアルタイム再計算ではない',
  ],
  targets: {
    directionAccuracy: 0.55,
    sharpeRatio: 0.8,
    maxDrawdown: 0.15,
  },
  folds,
  summary: {
    avgSharpeRatio: sharpeValues.reduce((a, b) => a + b, 0) / sharpeValues.length,
    minSharpeRatio: Math.min(...sharpeValues),
    maxDrawdownAcrossFolds: Math.max(...ddValues),
    foldsAboveSharpeTarget: sharpeValues.filter(s => s >= 0.8).length,
    foldsWithinDrawdownTarget: ddValues.filter(d => d <= 0.15).length,
    totalFolds: folds.length,
  },
};

writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`書き出し完了: ${outPath}`);
console.log(JSON.stringify(report.summary, null, 2));
