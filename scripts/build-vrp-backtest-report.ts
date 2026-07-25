/**
 * EXP-OBS000037（SYS-001 VRP）バックテストデータの静的レポートを生成する。
 *
 * 入力（すべてリポジトリ内の生データ・再計算はしない）:
 *   - research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json  … Stage 1 週次VRP系列
 *   - public/data/forward-vrp/deribit-vrp-forward-ledger-btc.json       … フォワード較正ledger
 *   - scripts/templates/vrp-backtest-report.html                        … HTMLテンプレート
 *
 * 出力:
 *   - public/reports/obs000037-vrp-backtest.html（Firebase Hostingでそのまま配信される静的ページ）
 *
 * ⚠ 本スクリプトは値の再計算・平滑化・外れ値除去を一切しない。生データの転記と描画のみ。
 *   Stage 1のバックテスト系列は凍結済みで変化しないが、「ライブとの接続」表はledgerの伸長に
 *   追従するため、状況を更新したいときに再実行する。
 *
 * 実行: node --experimental-strip-types scripts/build-vrp-backtest-report.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SRC_PREDICTION = join(ROOT, 'research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json');
const SRC_LEDGER = join(ROOT, 'public/data/forward-vrp/deribit-vrp-forward-ledger-btc.json');
const TEMPLATE = join(ROOT, 'scripts/templates/vrp-backtest-report.html');
const OUT = join(ROOT, 'public/reports/obs000037-vrp-backtest.html');

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

interface WeeklyPoint {
  date: string;
  dvol: number;
  rv_forward_pct: number;
  vrp: number | null;
}
interface LedgerRow {
  date: string;
  phase: 'warmup' | 'live';
  dvol: number;
  rv_forward_7d: number | null;
  vrp: number | null;
  net_pnl_pct: number | null;
  is_cohort_anchor: 0 | 1;
}

function main() {
  const pred = JSON.parse(readFileSync(SRC_PREDICTION, 'utf-8'));
  const ledger: LedgerRow[] = JSON.parse(readFileSync(SRC_LEDGER, 'utf-8'));

  const main_ = pred.mainSeries;
  const secondary = pred.secondarySeries;

  const weekly = (main_.weeklyPoints as WeeklyPoint[])
    .filter(p => p.vrp !== null)
    .map(p => ({ d: p.date, iv: round(p.dvol, 2), rv: round(p.rv_forward_pct, 2), vrp: round(p.vrp as number, 2) }));

  const cum = (main_.pipelineStats.cumulativePayoffSeries as { date: string; cumPayoff: number }[])
    .map(p => ({ d: p.date, c: round(p.cumPayoff, 1) }));

  const live = ledger
    .filter(r => r.vrp !== null)
    .map(r => ({
      d: r.date,
      phase: r.phase,
      iv: round(r.dvol, 2),
      rv: round(r.rv_forward_7d as number, 2),
      vrp: round(r.vrp as number, 2),
      anchor: r.is_cohort_anchor,
      net: r.net_pnl_pct === null ? null : round(r.net_pnl_pct, 4),
    }));

  const payload = {
    meta: {
      runTimestampUTC: pred.runTimestampUTC,
      gitCommit: String(pred.gitCommit).slice(0, 8),
      script: pred.scriptPath,
      spec: pred.specReference,
      dvolRows: pred.dataSources.dvol.totalRows,
      dvolFirst: pred.dataSources.dvol.firstDate,
      dvolLast: pred.dataSources.dvol.lastDate,
      lookaheadViolations: pred.lookaheadSelfCheck.mainSeriesViolations,
    },
    params: pred.params,
    periodStats: main_.periodStats,
    pipeline: {
      n: main_.pipelineStats.n,
      meanWeeklyNetPayoff: main_.pipelineStats.meanWeeklyNetPayoff,
      stdWeeklyNetPayoff: main_.pipelineStats.stdWeeklyNetPayoff,
      sharpeAnnualizedSqrt52: main_.pipelineStats.sharpeAnnualizedSqrt52,
      maxDrawdown_volPt: main_.pipelineStats.maxDrawdown_volPt,
      maxDrawdown_pctOfPeak: main_.pipelineStats.maxDrawdown_pctOfPeak,
      ddPeakDate: main_.pipelineStats.ddPeakDate,
      ddTroughDate: main_.pipelineStats.ddTroughDate,
    },
    secondary: {
      meanVrpFull: round(secondary.periodStats.full.meanVrp, 3),
      sharpe: round(secondary.pipelineStats.sharpeAnnualizedSqrt52, 3),
      n: secondary.periodStats.full.n,
    },
    labRef: pred.labReferenceValues_notReproductionJudgment,
    weekly,
    cum,
    live,
  };

  const template = readFileSync(TEMPLATE, 'utf-8');
  if (!template.includes('__DATA__') || !template.includes('__GENERATED_AT__')) {
    throw new Error('テンプレートに __DATA__ / __GENERATED_AT__ プレースホルダが見つかりません');
  }

  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const html = template
    .replace('__DATA__', JSON.stringify(payload))
    .replace('__GENERATED_AT__', generatedAt);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html);

  console.log('生成: ' + OUT);
  console.log(`  週次バックテスト ${weekly.length}点 (${weekly[0].d} → ${weekly[weekly.length - 1].d})`);
  console.log(`  累積ペイオフ ${cum.length}点`);
  console.log(`  ライブ較正 ${live.length}点 (${live.length ? live[live.length - 1].d : '—'} まで)`);
  console.log(`  生成時刻 ${generatedAt} / ${html.length.toLocaleString()} bytes`);
}

main();
