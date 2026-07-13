/**
 * EXP-OBS000037 Stage 2: ②/OBS000032との3スリーブ合成（限界寄与・spec §6）
 * spec: research/EXP-OBS000037/00-spec-stage2.md §6, §9-3
 *
 * 本スクリプトは判定を行わない。生数値のみを出力する（判定語禁止・spec §11）。
 * OBS000032 Stage1-C `scripts/carry-momentum-composite.ts` の凍結逆ボラウェイト方式を参考に、
 * 独立に書き直す（コピペしない）。
 *
 * 合成対象（spec §6-1・固定）:
 *   1. ②モメンタム単体: simulatePortfolio 本番構成の日次リターン
 *   2. OBS000032キャリースリーブ: 3倍w*サイズのヒストリカルL3日次リターン
 *   3. VRPスリーブ: pnl_vrp（Stage2 vrp-tail-correlation-pnl.ts の出力 pnlVrpDailySeries をそのまま再利用。
 *      vegaNotionalPct(f=0.5)は既にpnl_vrp算出時に適用済み・再計算しない）
 *
 * 選定期間（2021-03-24〜2023-06-30・Stage1踏襲）の各スリーブ日次std から逆ボラウェイトを算出し凍結、
 * 確認期間（2023-07-01〜末尾）にそのまま適用する（確認データでウェイト最適化しない）。
 * 「既存2スリーブ合成」も同一選定期間で②/OBS000032キャリーのみの逆ボラウェイトを算出し、
 * VRP追加の限界寄与（G3'・G4'）を同一選定基盤で比較する。
 *
 * 実行: node --experimental-strip-types scripts/vrp-composite-3sleeve.ts
 * 出力: research/EXP-OBS000037/10-result/stage2-vrp-composite-3sleeve.json
 * 前提: 先に scripts/vrp-pipeline-accounting.ts → scripts/vrp-tail-correlation-pnl.ts の順に実行し、
 *       stage2-vrp-tail-correlation-pnl.json の pnlVrpDailySeries が存在すること。
 */

import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';
import type { OHLCV } from '../src/types/market.ts';
import type { EquityPoint } from '../src/risk-layer/types.ts';
import { dateKey, keyToMs, utcDateOf } from './lib/vrp-daily-series.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000037', '10-result');
const OBS032_RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000032', '10-result');
const DATA_DIR = join(__dirname, 'data');
mkdirSync(RESULT_DIR, { recursive: true });

const RUN_TIMESTAMP = new Date().toISOString();
const executionLog: string[] = [];
function log(msg: string): void {
  console.log(msg);
  executionLog.push(`[${new Date().toISOString()}] ${msg}`);
}

// ============================================================
// 固定パラメータ（spec §6・§8-1・ハードコード）
// ============================================================
const PARAMS = {
  selectionStart: '2021-03-24', // Stage1選定期（spec §8-1踏襲）
  selectionEnd: '2023-06-30',
  confirmStart: '2023-07-01',
  averageCorrelationThreshold_calm: 0.3, // G3'（判定はC）
  g4prime_conditionA: { sharpeDeltaMin: 0.15, ddDeltaMaxWorsenPt: 2 },
  g4prime_conditionB: { ddDeltaMaxImprovePt: -5, sharpeDeltaMinWorsen: -0.05 },
  momentumProductionConfig: {
    horizon: 10,
    k: 30,
    momentumLookback: 30,
    momentumConfidenceScale: 30,
    initialEquity: 1_000_000,
  },
  momentumBacktestStartDate: '2020-06-01',
  carryLeverage: 3,
};

// ============================================================
// 日付ユーティリティ
// ============================================================
function candleIndexAtOrAfter(candles: OHLCV[], date: string): number {
  for (let i = 0; i < candles.length; i++) if (utcDateOf(candles[i].time) >= date) return i;
  return candles.length;
}
function allDatesBetween(startISO: string, endISO: string): string[] {
  const dates: string[] = [];
  let cur = keyToMs(startISO);
  const end = keyToMs(endISO);
  const DAY = 86400000;
  while (cur <= end) { dates.push(dateKey(new Date(cur))); cur += DAY; }
  return dates;
}

// ============================================================
// ②モメンタム日次（simulatePortfolio本番構成。Stage1と同一構成）
// ============================================================
function equityCurveToDailyReturns(equityCurve: EquityPoint[]): { date: string; returnPct: number }[] {
  if (equityCurve.length === 0) return [];
  const startDate = utcDateOf(equityCurve[0].timestamp);
  const endDate = utcDateOf(equityCurve[equityCurve.length - 1].timestamp);
  const equityByDate = new Map<string, number>();
  for (const p of equityCurve) equityByDate.set(utcDateOf(p.timestamp), p.equity);
  const dates = allDatesBetween(startDate, endDate);
  const rows: { date: string; returnPct: number }[] = [];
  let current = equityCurve[0].equity;
  let prev = current;
  for (const d of dates) {
    if (equityByDate.has(d)) current = equityByDate.get(d)!;
    const returnPct = prev !== 0 ? ((current - prev) / prev) * 100 : 0;
    rows.push({ date: d, returnPct });
    prev = current;
  }
  return rows;
}
function runMomentumProduction(candles: OHLCV[], startDate: string): { equityCurve: EquityPoint[]; tradeCount: number } {
  const n = candles.length;
  const validLen = n - PARAMS.momentumProductionConfig.horizon - 20;
  const startPos = Math.max(0, candleIndexAtOrAfter(candles, startDate) - 20);
  const testRatio = 1 - startPos / validLen;
  const result = simulatePortfolio(candles, {
    horizon: PARAMS.momentumProductionConfig.horizon,
    k: PARAMS.momentumProductionConfig.k,
    initialEquity: PARAMS.momentumProductionConfig.initialEquity,
    testRatio,
    testEndFraction: 1,
    momentumLookback: PARAMS.momentumProductionConfig.momentumLookback,
    momentumConfidenceScale: PARAMS.momentumProductionConfig.momentumConfidenceScale,
  });
  return { equityCurve: result.equityCurve, tradeCount: result.trades.length };
}

// ============================================================
// OBS000032キャリー日次（ヒストリカルL3・3倍w*サイズ）
// ============================================================
function loadWStarBtc(): number {
  const raw = JSON.parse(readFileSync(join(OBS032_RESULT_DIR, 'stage1-liquidation-sim-btc.json'), 'utf-8'));
  const l3 = raw.results.find((r: { leverage: number }) => r.leverage === PARAMS.carryLeverage);
  return l3.sizing.w_star;
}
function loadCarrySleeveReturns(wStar: number): { date: string; returnPct: number }[] {
  const raw = JSON.parse(readFileSync(join(OBS032_RESULT_DIR, 'stage1-liquidation-daily-returns-btc-L3.json'), 'utf-8'));
  return (raw.data as { date: string; pnl_bps: number }[]).map(d => ({ date: d.date, returnPct: (d.pnl_bps / 10000) * wStar * 100 }));
}

// ============================================================
// VRPスリーブ日次（Stage2 vrp-tail-correlation-pnl.ts の pnl_vrp をそのまま再利用）
// ============================================================
function loadPnlVrpSleeveReturns(): { date: string; returnPct: number }[] {
  const raw = JSON.parse(readFileSync(join(RESULT_DIR, 'stage2-vrp-tail-correlation-pnl.json'), 'utf-8'));
  // pnlVrpDailySeries の value は資本比の小数（例: 0.0003 = 0.03%）。他スリーブと単位を揃えるため ×100 して%表記にする。
  return (raw.pnlVrpDailySeries as { date: string; value: number }[]).map(d => ({ date: d.date, returnPct: d.value * 100 }));
}

// ============================================================
// 統計ユーティリティ
// ============================================================
function toMap(rows: { date: string; returnPct: number }[]): Map<string, number> {
  return new Map(rows.map(r => [r.date, r.returnPct]));
}
function alignByDate(maps: Map<string, number>[]): { dates: string[]; series: number[][] } {
  const commonDates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  const series = maps.map(m => commonDates.map(d => m.get(d)!));
  return { dates: commonDates, series };
}
function filterByRange(dates: string[], series: number[], start: string, end: string): number[] {
  return dates.map((d, i) => ({ d, v: series[i] })).filter(x => x.d >= start && x.d <= end).map(x => x.v);
}
function stdOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, r) => s + (r - m) ** 2, 0) / arr.length);
}
function calculateCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return NaN;
  const meanX = x.reduce((a, b) => a + b, 0) / x.length;
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  const cov = x.reduce((sum, xi, i) => sum + (xi - meanX) * (y[i] - meanY), 0) / x.length;
  const stdX = Math.sqrt(x.reduce((sum, xi) => sum + (xi - meanX) ** 2, 0) / x.length);
  const stdY = Math.sqrt(y.reduce((sum, yi) => sum + (yi - meanY) ** 2, 0) / y.length);
  return stdX > 0 && stdY > 0 ? cov / (stdX * stdY) : NaN;
}

interface Metrics {
  n: number;
  mean_pct: number;
  std_pct: number;
  sharpe_annualized_sqrt365: number;
  maxDrawdown_pct: number;
  cumReturn_pct: number;
}
function calcMetrics(returnsPct: number[]): Metrics {
  const n = returnsPct.length;
  if (n === 0) return { n: 0, mean_pct: 0, std_pct: 0, sharpe_annualized_sqrt365: 0, maxDrawdown_pct: 0, cumReturn_pct: 0 };
  const mean_pct = returnsPct.reduce((a, b) => a + b, 0) / n;
  const variance = returnsPct.reduce((s, r) => s + (r - mean_pct) ** 2, 0) / n;
  const std_pct = Math.sqrt(variance);
  const sharpe_annualized_sqrt365 = std_pct > 0 ? (mean_pct / std_pct) * Math.sqrt(365) : 0;
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const r of returnsPct) {
    equity *= 1 + r / 100;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  const cumReturn_pct = (equity - 1) * 100;
  return { n, mean_pct, std_pct, sharpe_annualized_sqrt365, maxDrawdown_pct: maxDD * 100, cumReturn_pct };
}

// ============================================================
// 逆ボラ（リスクパリティ）凍結ウェイト算出
// ============================================================
function inverseVolWeights(stds: number[]): number[] {
  const inv = stds.map(s => (s > 0 ? 1 / s : 0));
  const sum = inv.reduce((a, b) => a + b, 0);
  return sum > 0 ? inv.map(v => v / sum) : stds.map(() => 1 / stds.length);
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 Stage 2: vrp-composite-3sleeve.ts ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim();
  } catch { /* ignore */ }
  log(`Git commit: ${gitCommit}`);
  log(`Node version: ${process.version}`);

  // ---- 1. ②単体 ----
  log('\n>>> ②モメンタム単体（simulatePortfolio本番構成）');
  const btcCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
  const momentumRun = runMomentumProduction(btcCandles, PARAMS.momentumBacktestStartDate);
  const momentumRows = equityCurveToDailyReturns(momentumRun.equityCurve);
  log(`  ②: trades=${momentumRun.tradeCount} daily-rows=${momentumRows.length}（期間 ${momentumRows[0]?.date}〜${momentumRows[momentumRows.length - 1]?.date}）`);

  // ---- 2. OBS000032キャリースリーブ（3倍w*） ----
  log('\n>>> OBS000032キャリースリーブ（3倍w*・ヒストリカルL3）');
  const wStarBtc = loadWStarBtc();
  const carryRows = loadCarrySleeveReturns(wStarBtc);
  log(`  w*(L=3)=${wStarBtc.toFixed(6)} daily-rows=${carryRows.length}（期間 ${carryRows[0]?.date}〜${carryRows[carryRows.length - 1]?.date}）`);

  // ---- 3. VRPスリーブ（pnl_vrp再利用） ----
  log('\n>>> VRPスリーブ（Stage2 pnl_vrp再利用）');
  const vrpRows = loadPnlVrpSleeveReturns();
  log(`  VRPスリーブ daily-rows=${vrpRows.length}（期間 ${vrpRows[0]?.date}〜${vrpRows[vrpRows.length - 1]?.date}）`);

  // ---- 突合（3系列共通日付） ----
  const momentumMap = toMap(momentumRows);
  const carryMap = toMap(carryRows);
  const vrpMap = toMap(vrpRows);
  const { dates: allDates, series } = alignByDate([momentumMap, carryMap, vrpMap]);
  const [momentumAligned, carryAligned, vrpAligned] = series;
  log(`\n>>> 3系列(②,032キャリー,VRP)共通突合日数=${allDates.length}（${allDates[0]}〜${allDates[allDates.length - 1]}）`);

  // ---- 選定期間: 逆ボラウェイト算出・凍結 ----
  const selMomentum = filterByRange(allDates, momentumAligned, PARAMS.selectionStart, PARAMS.selectionEnd);
  const selCarry = filterByRange(allDates, carryAligned, PARAMS.selectionStart, PARAMS.selectionEnd);
  const selVrp = filterByRange(allDates, vrpAligned, PARAMS.selectionStart, PARAMS.selectionEnd);
  const stdMomentumSel = stdOf(selMomentum);
  const stdCarrySel = stdOf(selCarry);
  const stdVrpSel = stdOf(selVrp);
  log(`  選定期間(${PARAMS.selectionStart}~${PARAMS.selectionEnd}) n=${selMomentum.length} std: ②=${stdMomentumSel.toFixed(4)}% 032キャリー=${stdCarrySel.toFixed(4)}% VRP=${stdVrpSel.toFixed(6)}%`);

  // 2スリーブ（②+032キャリー）の凍結逆ボラウェイト（同一選定期間で算出）
  const w2 = inverseVolWeights([stdMomentumSel, stdCarrySel]);
  const frozenWeight2_momentum = w2[0];
  const frozenWeight2_carry = w2[1];
  log(`  2スリーブ凍結逆ボラウェイト: ②=${frozenWeight2_momentum.toFixed(4)} 032キャリー=${frozenWeight2_carry.toFixed(4)}`);

  // 3スリーブ（②+032キャリー+VRP）の凍結逆ボラウェイト
  const w3 = inverseVolWeights([stdMomentumSel, stdCarrySel, stdVrpSel]);
  const frozenWeight3_momentum = w3[0];
  const frozenWeight3_carry = w3[1];
  const frozenWeight3_vrp = w3[2];
  log(`  3スリーブ凍結逆ボラウェイト: ②=${frozenWeight3_momentum.toFixed(4)} 032キャリー=${frozenWeight3_carry.toFixed(4)} VRP=${frozenWeight3_vrp.toFixed(4)}`);

  // ---- 確認期間: G3'（相関）・G4'（Sharpe/DD差分） ----
  const confMomentum = filterByRange(allDates, momentumAligned, PARAMS.confirmStart, '2099-12-31');
  const confCarry = filterByRange(allDates, carryAligned, PARAMS.confirmStart, '2099-12-31');
  const confVrp = filterByRange(allDates, vrpAligned, PARAMS.confirmStart, '2099-12-31');
  const confDatesOnly = allDates.filter(d => d >= PARAMS.confirmStart);
  const confMid = Math.floor(confDatesOnly.length / 2);

  const corr_vrp_momentum_full = calculateCorrelation(confVrp, confMomentum);
  const corr_vrp_carry_full = calculateCorrelation(confVrp, confCarry);
  const corr_vrp_momentum_h1 = calculateCorrelation(confVrp.slice(0, confMid), confMomentum.slice(0, confMid));
  const corr_vrp_carry_h1 = calculateCorrelation(confVrp.slice(0, confMid), confCarry.slice(0, confMid));
  const corr_vrp_momentum_h2 = calculateCorrelation(confVrp.slice(confMid), confMomentum.slice(confMid));
  const corr_vrp_carry_h2 = calculateCorrelation(confVrp.slice(confMid), confCarry.slice(confMid));

  log(`\n>>> G3': 確認期間相関 |corr(VRP,②)|=${Math.abs(corr_vrp_momentum_full).toFixed(4)} |corr(VRP,032キャリー)|=${Math.abs(corr_vrp_carry_full).toFixed(4)}`);

  const momentumMetrics = calcMetrics(confMomentum);
  const carryMetrics = calcMetrics(confCarry);
  const vrpMetrics = calcMetrics(confVrp);

  const composite2Frozen = confMomentum.map((m, i) => frozenWeight2_momentum * m + frozenWeight2_carry * confCarry[i]);
  const composite2Naive = confMomentum.map((m, i) => 0.5 * m + 0.5 * confCarry[i]);
  const composite3Frozen = confMomentum.map((m, i) => frozenWeight3_momentum * m + frozenWeight3_carry * confCarry[i] + frozenWeight3_vrp * confVrp[i]);
  const composite3Naive = confMomentum.map((m, i) => (1 / 3) * m + (1 / 3) * confCarry[i] + (1 / 3) * confVrp[i]);

  const composite2FrozenMetrics = calcMetrics(composite2Frozen);
  const composite2NaiveMetrics = calcMetrics(composite2Naive);
  const composite3FrozenMetrics = calcMetrics(composite3Frozen);
  const composite3NaiveMetrics = calcMetrics(composite3Naive);

  // G4'（frozen weight ベース: 3スリーブ − 2スリーブ）
  const sharpeDelta_frozen = composite3FrozenMetrics.sharpe_annualized_sqrt365 - composite2FrozenMetrics.sharpe_annualized_sqrt365;
  const ddDelta_frozen = composite3FrozenMetrics.maxDrawdown_pct - composite2FrozenMetrics.maxDrawdown_pct;
  const g4prime_conditionA_met = sharpeDelta_frozen >= PARAMS.g4prime_conditionA.sharpeDeltaMin && ddDelta_frozen <= PARAMS.g4prime_conditionA.ddDeltaMaxWorsenPt;
  const g4prime_conditionB_met = ddDelta_frozen <= PARAMS.g4prime_conditionB.ddDeltaMaxImprovePt && sharpeDelta_frozen >= PARAMS.g4prime_conditionB.sharpeDeltaMinWorsen;
  const g4prime_any_condition_met = g4prime_conditionA_met || g4prime_conditionB_met;

  const sharpeDelta_naive = composite3NaiveMetrics.sharpe_annualized_sqrt365 - composite2NaiveMetrics.sharpe_annualized_sqrt365;
  const ddDelta_naive = composite3NaiveMetrics.maxDrawdown_pct - composite2NaiveMetrics.maxDrawdown_pct;

  log(`  G4' frozen: sharpeDelta(3sleeve-2sleeve)=${sharpeDelta_frozen.toFixed(4)} ddDelta_pt=${ddDelta_frozen.toFixed(4)}`);
  log(`  G4' conditionA_met=${g4prime_conditionA_met} conditionB_met=${g4prime_conditionB_met} any=${g4prime_any_condition_met}`);

  const output = {
    experiment: 'EXP-OBS000037',
    stage: 'Stage 2',
    scriptPath: 'scripts/vrp-composite-3sleeve.ts',
    specReference: 'research/EXP-OBS000037/00-spec-stage2.md §6',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    scope: { assets: ['BTC'], note: 'ETH取得禁止（spec §8-2固定）' },
    params: PARAMS,
    inputSources: {
      momentumProduction: { config: PARAMS.momentumProductionConfig, backtestStartDateUsed: PARAMS.momentumBacktestStartDate, tradeCount: momentumRun.tradeCount, dailyRows: momentumRows.length },
      carrySleeve: { path: 'research/EXP-OBS000032/10-result/stage1-liquidation-daily-returns-btc-L3.json', wStar_L3: wStarBtc, dailyRows: carryRows.length },
      vrpSleeve: { path: 'research/EXP-OBS000037/10-result/stage2-vrp-tail-correlation-pnl.json', field: 'pnlVrpDailySeries', dailyRows: vrpRows.length, note: 'pnl_vrpは資本比小数のため×100して%表記に変換（②・032キャリーと単位を揃える）。vegaNotionalPct(f=0.5)適用は§5のpnl_vrp算出時点で完了済み・本スクリプトで再計算しない。' },
    },
    alignedDates: { count: allDates.length, start: allDates[0], end: allDates[allDates.length - 1] },
    selectionPeriod: {
      start: PARAMS.selectionStart, end: PARAMS.selectionEnd, n: selMomentum.length,
      std_momentum_pct: stdMomentumSel, std_carry_pct: stdCarrySel, std_vrp_pct: stdVrpSel,
    },
    frozenWeights_2sleeve_inverseVol: { momentum: frozenWeight2_momentum, carry: frozenWeight2_carry },
    frozenWeights_2sleeve_naive: { momentum: 0.5, carry: 0.5 },
    frozenWeights_3sleeve_inverseVol: { momentum: frozenWeight3_momentum, carry: frozenWeight3_carry, vrp: frozenWeight3_vrp },
    frozenWeights_3sleeve_naive: { momentum: 1 / 3, carry: 1 / 3, vrp: 1 / 3 },
    confirmationPeriod: { start: PARAMS.confirmStart, end: allDates[allDates.length - 1], n: confMomentum.length },
    g3prime_correlation: {
      corr_vrp_momentum: { full: corr_vrp_momentum_full, abs_full: Math.abs(corr_vrp_momentum_full), h1: corr_vrp_momentum_h1, abs_h1: Math.abs(corr_vrp_momentum_h1), h2: corr_vrp_momentum_h2, abs_h2: Math.abs(corr_vrp_momentum_h2) },
      corr_vrp_carry: { full: corr_vrp_carry_full, abs_full: Math.abs(corr_vrp_carry_full), h1: corr_vrp_carry_h1, abs_h1: Math.abs(corr_vrp_carry_h1), h2: corr_vrp_carry_h2, abs_h2: Math.abs(corr_vrp_carry_h2) },
    },
    sleeveMetrics_confirmationPeriod: { momentum: momentumMetrics, carry: carryMetrics, vrp: vrpMetrics },
    composite2Sleeve_frozenWeight_confirmationPeriod: composite2FrozenMetrics,
    composite2Sleeve_naiveWeight_confirmationPeriod: composite2NaiveMetrics,
    composite3Sleeve_frozenWeight_confirmationPeriod: composite3FrozenMetrics,
    composite3Sleeve_naiveWeight_confirmationPeriod: composite3NaiveMetrics,
    g4prime_marginalContribution: {
      formula_a: '(3スリーブ合成Sharpe − 2スリーブ合成Sharpe) ≥ +0.15 かつ (3スリーブ合成maxDD − 2スリーブ合成maxDD) ≤ +2pt',
      formula_b: '(3スリーブ合成maxDD − 2スリーブ合成maxDD) ≤ −5pt かつ (3スリーブ合成Sharpe − 2スリーブ合成Sharpe) ≥ −0.05',
      frozenWeight: {
        sharpeDelta: sharpeDelta_frozen,
        ddDelta_pt: ddDelta_frozen,
        conditionA_formulaResult: g4prime_conditionA_met,
        conditionB_formulaResult: g4prime_conditionB_met,
        anyCondition_formulaResult: g4prime_any_condition_met,
      },
      naiveWeight_reference: { sharpeDelta: sharpeDelta_naive, ddDelta_pt: ddDelta_naive },
    },
  };

  const outPath = join(RESULT_DIR, 'stage2-vrp-composite-3sleeve.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  const runLogPath = join(RESULT_DIR, 'stage2-vrp-run.log');
  const block = [
    '='.repeat(70),
    `=== vrp-composite-3sleeve.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/vrp-pipeline-accounting.ts       (1. vegaNotionalPct供給元)',
    '  node --experimental-strip-types scripts/vrp-tail-correlation-pnl.ts      (2. pnl_vrp日次系列供給元)',
    '  node --experimental-strip-types scripts/vrp-composite-3sleeve.ts         (3. 本スクリプト)',
    '',
    'EXECUTION LOG:',
    ...executionLog,
    '',
  ].join('\n');
  appendFileSync(runLogPath, block);
  log(`>>> 保存: ${runLogPath}`);

  log('\n=== 実行完了 ===');
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
