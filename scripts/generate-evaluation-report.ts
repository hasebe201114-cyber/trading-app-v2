/**
 * ⑦評価・チューニング層 — パイプラインバックテスト結果をJSONスナップショットとして
 * src/data/evaluationReport.json に出力する。EvaluationScreen.tsx がこれを読み込んで
 * 目標(PJ000001)と実績を並べて表示する。
 *
 * ブラウザ上で毎回バックテストを実行するのは現段階では過剰なため、Node側で事前計算した
 * スナップショットを表示する方式にしている（将来的にFirebase接続後は定期実行 + Firestore
 * 保存に置き換える想定。D001参照）。
 *
 * 2026-07-04更新（OBS000023/024）: ②をk-NNからモメンタム(直近30日リターンの符号、
 * 確信度動的化scale=30)へ切替。データもGitHub暫定CSVからBinance直接API取得の
 * 連続データへ切替（OBS000021）。フォールドも年次に変更。
 *
 * 実行: node --experimental-strip-types scripts/generate-evaluation-report.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = join(__dirname, 'data', 'btc-daily-binance-2017-2026.csv');
const outPath = join(__dirname, '..', 'src', 'data', 'evaluationReport.json');

const candles = loadOhlcvFromDailyCsv(csvPath);
const baseConfig = { horizon: 10, k: 30, momentumLookback: 30, momentumConfidenceScale: 30, initialEquity: 1_000_000 };

const utcDateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
function candleIndexAtOrAfter(date: string): number {
  for (let i = 0; i < candles.length; i++) if (utcDateOf(candles[i].time) >= date) return i;
  return candles.length;
}
const n = candles.length;
const horizon = baseConfig.horizon;
const validLen = n - horizon - 20;
const lastDate = utcDateOf(candles[n - 1].time);

const FOLD_DATES = ['2021-01-01', '2022-01-01', '2023-01-01', '2024-01-01', '2025-01-01'];

interface Fold { label: string; tradeCount: number; winRate: number; totalReturn: number; maxDrawdown: number; sharpeRatio: number; }
const folds: Fold[] = [];
for (let i = 0; i < FOLD_DATES.length; i++) {
  const startDate = FOLD_DATES[i];
  const endDate = i + 1 < FOLD_DATES.length ? FOLD_DATES[i + 1] : lastDate;
  const startPos = Math.max(0, candleIndexAtOrAfter(startDate) - 20);
  const endPos = Math.min(validLen, (i + 1 < FOLD_DATES.length ? candleIndexAtOrAfter(endDate) : n) - 20);
  if (endPos <= startPos) continue;

  const result = simulatePortfolio(candles, {
    ...baseConfig,
    testRatio: 1 - startPos / validLen,
    testEndFraction: endPos / validLen,
  });
  folds.push({
    label: `${startDate.slice(0, 4)}年 [${startDate}〜${endDate}]`,
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
  dataSource: 'Binance spot直接API取得（scripts/data/btc-daily-binance-2017-2026.csv、日次・欠落なし。scripts/data/README.md参照）',
  caveats: [
    '②はモメンタム（直近30日リターンの符号、確信度は変動幅をボラティリティ正規化したz値ベースで動的算出）。従来のk-NN方式はBTC固有の過学習だったためETHクロス検証(OBS000019)を経て撤退した（OBS000023/024）',
    '③LLM特徴量層はmockClient使用（実ニュースデータなし）。②④⑤⑥の配線確認であり③の実効果は含まない',
    'ETH側でも同一設計で概ね同等以上の傾向を確認済み（OBS000019/020/023）。ただしSharpeはまだPJ000001目標(0.8)未達で、改善作業を継続中',
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
