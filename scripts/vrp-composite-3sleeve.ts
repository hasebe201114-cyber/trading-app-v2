/**
 * EXP-OBS000037 Stage 2: ②/OBS000032との3スリーブ合成（限界寄与・spec §6）
 * spec: research/EXP-OBS000037/00-spec-stage2.md §6-0, §6-1, §6-2, §6-3, §9-3, §11-5-2
 *
 * 本スクリプトは判定を行わない。生数値のみを出力する（判定語禁止・spec §11）。
 *
 * 【2026-07-13 差し戻し是正・再実装】
 * 初版は VRP スリーブの合成リターン系列に `pnl_vrp`（VRP水準の日次1階差分・日次頻度）を
 * 流用し、②・OBS000032キャリーも日次頻度で合成していた。C品質チーム独立監査
 * （`research/EXP-OBS000037/20-verdict-stage2.md`）は、`pnl_vrp` の総和が望遠鏡和
 * （telescoping）により始点・終点差のみに退化し平均≒0のノイズになること、結果として
 * G4' が測定アーティファクトによる偽陰性を出したことを指摘した。本再実装は spec §6-0〜§6-3
 * の是正方針に従い、合成頻度を「週次」に変更する。
 *
 * 合成対象（spec §6-1・固定・週次頻度）:
 *   1. VRPスリーブ（週次・経済的に正しい系列）: `r_vrp_week_w = vegaNotionalPct × (VRP_w − C_real)`。
 *      これは `stage2-vrp-pipeline-accounting.json` の §4-1 資本equity週次リターン `equitySeries[].r`
 *      と同一系列であり、そのまま再利用する（独自に再計算しない）。
 *   2. ②モメンタム（週次）: simulatePortfolio 本番構成の日次リターンを週窓内で複利集約。
 *   3. OBS000032キャリースリーブ（週次）: 3倍w*サイズのヒストリカルL3日次リターンを週窓内で複利集約。
 * 週次グリッドは `stage1-vrp-prediction-unit.json` の `mainSeries.weeklyPoints[].date` を境界とする
 * （n=276週・週窓 = [date_w, date_{w+1})）。週内に②/032の日次が1本も無い週は3系列とも当該週を除外する
 * （暗黙ゼロ埋め禁止）。
 *
 * 選定期間（2021-03-24〜2023-06-30・Stage1踏襲）の各スリーブ「週次」stdから逆ボラウェイトを算出し凍結、
 * 確認期間（2023-07-01〜末尾）にそのまま適用する（確認データでウェイト最適化しない）。
 * 既存2スリーブ合成（②＋OBS000032）も同一の週次頻度・同一グリッドで測り直す（G4'差分をapples-to-apples化）。
 *
 * G3'（低相関維持）の相関測定は §5-1 の日次差分系列 `pnl_vrp` のまま不変（Cが「相関測定には正しい是正」
 * と確定済み。今回の是正対象は G4' の合成リターン系列の経済的定義のみ）。
 *
 * 実行: node --experimental-strip-types scripts/vrp-composite-3sleeve.ts
 * 出力: research/EXP-OBS000037/10-result/stage2-vrp-composite-3sleeve.json
 * 前提: 先に scripts/vrp-pipeline-accounting.ts → scripts/vrp-tail-correlation-pnl.ts の順に実行し、
 *       stage2-vrp-pipeline-accounting.json の equitySeries と
 *       stage2-vrp-tail-correlation-pnl.json の pnlVrpDailySeries が存在すること
 *       （本再実装ではこの2スクリプトの再実行は不要・既存出力をそのまま読み込む）。
 */

import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';
import type { OHLCV } from '../src/types/market.ts';
import type { EquityPoint } from '../src/risk-layer/types.ts';
import { dateKey, keyToMs, addDaysKey, utcDateOf } from './lib/vrp-daily-series.ts';

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
// 固定パラメータ（spec §6・§8-1・ハードコード・G4'閾値は初版から不変）
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
  compositeFrequency: 'weekly', // spec §6-0是正: 初版'daily'から'weekly'へ変更
  weeklyBoundarySource: 'research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json#mainSeries.weeklyPoints[].date',
  vrpWeeklyReturnSource: 'research/EXP-OBS000037/10-result/stage2-vrp-pipeline-accounting.json#equitySeries[].r',
  vrpDailyPnlSourceForG3prime: 'research/EXP-OBS000037/10-result/stage2-vrp-tail-correlation-pnl.json#pnlVrpDailySeries（G3\'相関測定のみ・不変）',
  weeklyAnnualizationSqrt: Math.sqrt(52),
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
// VRPスリーブ日次 pnl_vrp（G3'相関測定専用・§5-1定義のまま不変）
// ============================================================
function loadPnlVrpSleeveReturns(): { date: string; returnPct: number }[] {
  const raw = JSON.parse(readFileSync(join(RESULT_DIR, 'stage2-vrp-tail-correlation-pnl.json'), 'utf-8'));
  // pnlVrpDailySeries の value は資本比の小数（例: 0.0003 = 0.03%）。他スリーブと単位を揃えるため ×100 して%表記にする。
  return (raw.pnlVrpDailySeries as { date: string; value: number }[]).map(d => ({ date: d.date, returnPct: d.value * 100 }));
}

// ============================================================
// VRPスリーブ週次リターン r_vrp_week_w（§6-1是正版・vrp-pipeline-accounting.tsの資本equity r をそのまま再利用）
// ============================================================
function loadVrpWeeklyReturns(): Map<string, number> {
  const raw = JSON.parse(readFileSync(join(RESULT_DIR, 'stage2-vrp-pipeline-accounting.json'), 'utf-8'));
  const map = new Map<string, number>();
  for (const row of raw.equitySeries as { date: string; r: number }[]) map.set(row.date, row.r);
  return map;
}

// ============================================================
// 週次グリッド境界（Stage1 weeklyPoints[].date をそのまま再利用・VRP再構築なし）
// ============================================================
function loadWeeklyBoundaryDates(): string[] {
  const raw = JSON.parse(readFileSync(join(RESULT_DIR, 'stage1-vrp-prediction-unit.json'), 'utf-8'));
  return (raw.mainSeries.weeklyPoints as { date: string }[]).map(p => p.date);
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
  sharpe_annualized: number;
  maxDrawdown_pct: number;
  cumReturn_pct: number;
}
function calcMetrics(returnsPct: number[], annualizationSqrt: number): Metrics {
  const n = returnsPct.length;
  if (n === 0) return { n: 0, mean_pct: 0, std_pct: 0, sharpe_annualized: 0, maxDrawdown_pct: 0, cumReturn_pct: 0 };
  const mean_pct = returnsPct.reduce((a, b) => a + b, 0) / n;
  const variance = returnsPct.reduce((s, r) => s + (r - mean_pct) ** 2, 0) / n;
  const std_pct = Math.sqrt(variance);
  const sharpe_annualized = std_pct > 0 ? (mean_pct / std_pct) * annualizationSqrt : 0;
  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const r of returnsPct) {
    equity *= 1 + r / 100;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  const cumReturn_pct = (equity - 1) * 100;
  return { n, mean_pct, std_pct, sharpe_annualized, maxDrawdown_pct: maxDD * 100, cumReturn_pct };
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
// 週次複利集約（週窓 [start, end) 内の日次リターンを複利集約）
// ============================================================
function weeklyCompoundReturn(
  dailyMap: Map<string, number>,
  startInclusive: string,
  endExclusive: string,
): { returnPct: number | null; daysUsed: number; windowCalendarDays: number } {
  let compound = 1;
  let daysUsed = 0;
  let windowCalendarDays = 0;
  let cur = startInclusive;
  while (cur < endExclusive) {
    windowCalendarDays++;
    if (dailyMap.has(cur)) {
      compound *= 1 + dailyMap.get(cur)! / 100;
      daysUsed++;
    }
    cur = addDaysKey(cur, 1);
  }
  if (daysUsed === 0) return { returnPct: null, daysUsed: 0, windowCalendarDays };
  return { returnPct: (compound - 1) * 100, daysUsed, windowCalendarDays };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 Stage 2: vrp-composite-3sleeve.ts（§6-0是正・週次頻度再実装） ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim();
  } catch { /* ignore */ }
  log(`Git commit: ${gitCommit}`);
  log(`Node version: ${process.version}`);

  // ---- 1. ②単体（日次・週次集約前） ----
  log('\n>>> ②モメンタム単体（simulatePortfolio本番構成・日次）');
  const btcCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
  const momentumRun = runMomentumProduction(btcCandles, PARAMS.momentumBacktestStartDate);
  const momentumRows = equityCurveToDailyReturns(momentumRun.equityCurve);
  log(`  ②: trades=${momentumRun.tradeCount} daily-rows=${momentumRows.length}（期間 ${momentumRows[0]?.date}〜${momentumRows[momentumRows.length - 1]?.date}）`);

  // ---- 2. OBS000032キャリースリーブ（3倍w*・日次・週次集約前） ----
  log('\n>>> OBS000032キャリースリーブ（3倍w*・ヒストリカルL3・日次）');
  const wStarBtc = loadWStarBtc();
  const carryRows = loadCarrySleeveReturns(wStarBtc);
  log(`  w*(L=3)=${wStarBtc.toFixed(6)} daily-rows=${carryRows.length}（期間 ${carryRows[0]?.date}〜${carryRows[carryRows.length - 1]?.date}）`);

  // ---- 3. VRPスリーブ日次 pnl_vrp（G3'相関測定専用・不変） ----
  log('\n>>> VRPスリーブ日次 pnl_vrp（§5-1定義のまま・G3\'相関測定専用）');
  const vrpDailyRows = loadPnlVrpSleeveReturns();
  log(`  pnl_vrp daily-rows=${vrpDailyRows.length}（期間 ${vrpDailyRows[0]?.date}〜${vrpDailyRows[vrpDailyRows.length - 1]?.date}）`);

  // ---- 4. VRPスリーブ週次リターン r_vrp_week_w（§6-1是正版） ----
  log('\n>>> VRPスリーブ週次リターン r_vrp_week_w（stage2-vrp-pipeline-accounting.json equitySeries[].r 再利用）');
  const vrpWeeklyMap = loadVrpWeeklyReturns();
  log(`  vrpWeeklyMap size=${vrpWeeklyMap.size}`);

  // ---- 5. 週次グリッド境界（Stage1 weeklyPoints[].date） ----
  const boundaryDates = loadWeeklyBoundaryDates();
  const nWeeksTotal = boundaryDates.length - 1;
  log(`\n>>> 週次グリッド境界: weeklyPoints点数=${boundaryDates.length} → 週数(境界差分)=${nWeeksTotal}`);

  // ---- 6. 週次グリッド構築（②・032を週窓内で複利集約。1本も日次が無い週は3系列とも除外） ----
  const momentumMap = toMap(momentumRows);
  const carryMap = toMap(carryRows);
  interface WeekRow {
    week: number;
    date: string;
    weekEndExclusive: string;
    windowCalendarDays: number;
    vrpPct: number | null;
    momentumPct: number | null;
    carryPct: number | null;
    momentumDaysUsed: number;
    carryDaysUsed: number;
    missing: boolean;
    missingReason: string | null;
  }
  const weekRows: WeekRow[] = [];
  for (let w = 0; w < nWeeksTotal; w++) {
    const weekStart = boundaryDates[w];
    const weekEnd = boundaryDates[w + 1];
    const vrpR = vrpWeeklyMap.get(weekStart);
    const momRes = weeklyCompoundReturn(momentumMap, weekStart, weekEnd);
    const carryRes = weeklyCompoundReturn(carryMap, weekStart, weekEnd);
    const reasons: string[] = [];
    if (vrpR === undefined) reasons.push('vrp週次リターン欠損');
    if (momRes.daysUsed === 0) reasons.push('②日次データ0本');
    if (carryRes.daysUsed === 0) reasons.push('032日次データ0本');
    const missing = reasons.length > 0;
    weekRows.push({
      week: w,
      date: weekStart,
      weekEndExclusive: weekEnd,
      windowCalendarDays: momRes.windowCalendarDays,
      vrpPct: vrpR !== undefined ? vrpR * 100 : null,
      momentumPct: momRes.returnPct,
      carryPct: carryRes.returnPct,
      momentumDaysUsed: momRes.daysUsed,
      carryDaysUsed: carryRes.daysUsed,
      missing,
      missingReason: missing ? reasons.join('; ') : null,
    });
  }
  const includedWeeks = weekRows.filter(r => !r.missing);
  const missingWeeks = weekRows.filter(r => r.missing);
  log(`  週次グリッド行数=${weekRows.length} 欠損週数=${missingWeeks.length} 採用週数=${includedWeeks.length}`);
  if (missingWeeks.length > 0) {
    for (const m of missingWeeks) log(`    欠損週: week=${m.week} date=${m.date} reason=${m.missingReason}`);
  }

  // ---- 7. 選定/確認期間の分割（週次行の date で判定） ----
  const selectionWeeks = includedWeeks.filter(r => r.date >= PARAMS.selectionStart && r.date <= PARAMS.selectionEnd);
  const confirmationWeeks = includedWeeks.filter(r => r.date >= PARAMS.confirmStart);
  log(`\n>>> 選定期間(${PARAMS.selectionStart}~${PARAMS.selectionEnd}) 採用週数=${selectionWeeks.length}`);
  log(`>>> 確認期間(${PARAMS.confirmStart}~末尾) 採用週数=${confirmationWeeks.length}`);

  // ---- 8. 選定期間: 週次std → 逆ボラ凍結ウェイト ----
  const selMomentumWeekly = selectionWeeks.map(r => r.momentumPct!);
  const selCarryWeekly = selectionWeeks.map(r => r.carryPct!);
  const selVrpWeekly = selectionWeeks.map(r => r.vrpPct!);
  const stdMomentumSelWeekly = stdOf(selMomentumWeekly);
  const stdCarrySelWeekly = stdOf(selCarryWeekly);
  const stdVrpSelWeekly = stdOf(selVrpWeekly);
  log(`  選定期間週次std: ②=${stdMomentumSelWeekly.toFixed(4)}% 032キャリー=${stdCarrySelWeekly.toFixed(4)}% VRP=${stdVrpSelWeekly.toFixed(4)}%`);

  const w2 = inverseVolWeights([stdMomentumSelWeekly, stdCarrySelWeekly]);
  const frozenWeight2_momentum = w2[0];
  const frozenWeight2_carry = w2[1];
  log(`  2スリーブ週次凍結逆ボラウェイト: ②=${frozenWeight2_momentum.toFixed(4)} 032キャリー=${frozenWeight2_carry.toFixed(4)}`);

  const w3 = inverseVolWeights([stdMomentumSelWeekly, stdCarrySelWeekly, stdVrpSelWeekly]);
  const frozenWeight3_momentum = w3[0];
  const frozenWeight3_carry = w3[1];
  const frozenWeight3_vrp = w3[2];
  log(`  3スリーブ週次凍結逆ボラウェイト: ②=${frozenWeight3_momentum.toFixed(4)} 032キャリー=${frozenWeight3_carry.toFixed(4)} VRP=${frozenWeight3_vrp.toFixed(4)}`);

  // ---- 9. 確認期間: 週次系列（個別スリーブ・複利集約系列） ----
  const confMomentumWeekly = confirmationWeeks.map(r => r.momentumPct!);
  const confCarryWeekly = confirmationWeeks.map(r => r.carryPct!);
  const confVrpWeekly = confirmationWeeks.map(r => r.vrpPct!);

  const momentumMetricsWeekly = calcMetrics(confMomentumWeekly, PARAMS.weeklyAnnualizationSqrt);
  const carryMetricsWeekly = calcMetrics(confCarryWeekly, PARAMS.weeklyAnnualizationSqrt);
  const vrpMetricsWeekly = calcMetrics(confVrpWeekly, PARAMS.weeklyAnnualizationSqrt);
  log(`\n>>> 確認期間 週次個別スリーブ Sharpe(√52): ②=${momentumMetricsWeekly.sharpe_annualized.toFixed(4)} 032=${carryMetricsWeekly.sharpe_annualized.toFixed(4)} VRP=${vrpMetricsWeekly.sharpe_annualized.toFixed(4)}`);

  // ---- 10. 週次頻度の2スリーブ/3スリーブ合成（凍結ウェイト・素朴等ウェイト） ----
  const composite2FrozenWeekly = confirmationWeeks.map(r => frozenWeight2_momentum * r.momentumPct! + frozenWeight2_carry * r.carryPct!);
  const composite2NaiveWeekly = confirmationWeeks.map(r => 0.5 * r.momentumPct! + 0.5 * r.carryPct!);
  const composite3FrozenWeekly = confirmationWeeks.map(r => frozenWeight3_momentum * r.momentumPct! + frozenWeight3_carry * r.carryPct! + frozenWeight3_vrp * r.vrpPct!);
  const composite3NaiveWeekly = confirmationWeeks.map(r => (1 / 3) * r.momentumPct! + (1 / 3) * r.carryPct! + (1 / 3) * r.vrpPct!);

  const composite2FrozenMetricsWeekly = calcMetrics(composite2FrozenWeekly, PARAMS.weeklyAnnualizationSqrt);
  const composite2NaiveMetricsWeekly = calcMetrics(composite2NaiveWeekly, PARAMS.weeklyAnnualizationSqrt);
  const composite3FrozenMetricsWeekly = calcMetrics(composite3FrozenWeekly, PARAMS.weeklyAnnualizationSqrt);
  const composite3NaiveMetricsWeekly = calcMetrics(composite3NaiveWeekly, PARAMS.weeklyAnnualizationSqrt);

  log(`\n>>> 週次2スリーブ合成(frozen) Sharpe(√52)=${composite2FrozenMetricsWeekly.sharpe_annualized.toFixed(4)} maxDD%=${composite2FrozenMetricsWeekly.maxDrawdown_pct.toFixed(4)}`);
  log(`>>> 週次3スリーブ合成(frozen) Sharpe(√52)=${composite3FrozenMetricsWeekly.sharpe_annualized.toFixed(4)} maxDD%=${composite3FrozenMetricsWeekly.maxDrawdown_pct.toFixed(4)}`);
  log(`>>> 週次2スリーブ合成(naive) Sharpe(√52)=${composite2NaiveMetricsWeekly.sharpe_annualized.toFixed(4)} maxDD%=${composite2NaiveMetricsWeekly.maxDrawdown_pct.toFixed(4)}`);
  log(`>>> 週次3スリーブ合成(naive) Sharpe(√52)=${composite3NaiveMetricsWeekly.sharpe_annualized.toFixed(4)} maxDD%=${composite3NaiveMetricsWeekly.maxDrawdown_pct.toFixed(4)}`);

  // ---- 11. G4'（週次頻度・frozen/naive両方） ----
  const sharpeDelta_frozen = composite3FrozenMetricsWeekly.sharpe_annualized - composite2FrozenMetricsWeekly.sharpe_annualized;
  const ddDelta_frozen = composite3FrozenMetricsWeekly.maxDrawdown_pct - composite2FrozenMetricsWeekly.maxDrawdown_pct;
  const g4prime_conditionA_met = sharpeDelta_frozen >= PARAMS.g4prime_conditionA.sharpeDeltaMin && ddDelta_frozen <= PARAMS.g4prime_conditionA.ddDeltaMaxWorsenPt;
  const g4prime_conditionB_met = ddDelta_frozen <= PARAMS.g4prime_conditionB.ddDeltaMaxImprovePt && sharpeDelta_frozen >= PARAMS.g4prime_conditionB.sharpeDeltaMinWorsen;
  const g4prime_any_condition_met = g4prime_conditionA_met || g4prime_conditionB_met;

  const sharpeDelta_naive = composite3NaiveMetricsWeekly.sharpe_annualized - composite2NaiveMetricsWeekly.sharpe_annualized;
  const ddDelta_naive = composite3NaiveMetricsWeekly.maxDrawdown_pct - composite2NaiveMetricsWeekly.maxDrawdown_pct;
  const g4prime_conditionA_met_naive = sharpeDelta_naive >= PARAMS.g4prime_conditionA.sharpeDeltaMin && ddDelta_naive <= PARAMS.g4prime_conditionA.ddDeltaMaxWorsenPt;
  const g4prime_conditionB_met_naive = ddDelta_naive <= PARAMS.g4prime_conditionB.ddDeltaMaxImprovePt && sharpeDelta_naive >= PARAMS.g4prime_conditionB.sharpeDeltaMinWorsen;
  const g4prime_any_condition_met_naive = g4prime_conditionA_met_naive || g4prime_conditionB_met_naive;

  log(`\n>>> G4'(週次・frozen): sharpeDelta(3sleeve-2sleeve)=${sharpeDelta_frozen.toFixed(6)} ddDelta_pt=${ddDelta_frozen.toFixed(6)}`);
  log(`  conditionA_formulaResult=${g4prime_conditionA_met} conditionB_formulaResult=${g4prime_conditionB_met} any=${g4prime_any_condition_met}`);
  log(`>>> G4'(週次・naive): sharpeDelta=${sharpeDelta_naive.toFixed(6)} ddDelta_pt=${ddDelta_naive.toFixed(6)}`);
  log(`  conditionA_formulaResult=${g4prime_conditionA_met_naive} conditionB_formulaResult=${g4prime_conditionB_met_naive} any=${g4prime_any_condition_met_naive}`);

  // ---- 12. G3'（低相関維持）: §5-1の日次差分系列 pnl_vrp のまま不変（相関是正は不変） ----
  const momentumMap_G3 = momentumMap;
  const carryMap_G3 = carryMap;
  const vrpDailyMap = toMap(vrpDailyRows);
  const { dates: allDatesDaily, series: seriesDaily } = alignByDate([momentumMap_G3, carryMap_G3, vrpDailyMap]);
  const [momentumAlignedDaily, carryAlignedDaily, vrpAlignedDaily] = seriesDaily;
  log(`\n>>> G3'相関測定用 日次3系列(②,032キャリー,pnl_vrp)共通突合日数=${allDatesDaily.length}（${allDatesDaily[0]}〜${allDatesDaily[allDatesDaily.length - 1]}）`);

  const confMomentumDaily = filterByRange(allDatesDaily, momentumAlignedDaily, PARAMS.confirmStart, '2099-12-31');
  const confCarryDaily = filterByRange(allDatesDaily, carryAlignedDaily, PARAMS.confirmStart, '2099-12-31');
  const confVrpDaily = filterByRange(allDatesDaily, vrpAlignedDaily, PARAMS.confirmStart, '2099-12-31');
  const confDatesOnlyDaily = allDatesDaily.filter(d => d >= PARAMS.confirmStart);
  const confMidDaily = Math.floor(confDatesOnlyDaily.length / 2);

  const corr_vrp_momentum_full = calculateCorrelation(confVrpDaily, confMomentumDaily);
  const corr_vrp_carry_full = calculateCorrelation(confVrpDaily, confCarryDaily);
  const corr_vrp_momentum_h1 = calculateCorrelation(confVrpDaily.slice(0, confMidDaily), confMomentumDaily.slice(0, confMidDaily));
  const corr_vrp_carry_h1 = calculateCorrelation(confVrpDaily.slice(0, confMidDaily), confCarryDaily.slice(0, confMidDaily));
  const corr_vrp_momentum_h2 = calculateCorrelation(confVrpDaily.slice(confMidDaily), confMomentumDaily.slice(confMidDaily));
  const corr_vrp_carry_h2 = calculateCorrelation(confVrpDaily.slice(confMidDaily), confCarryDaily.slice(confMidDaily));

  log(`>>> G3'(日次pnl_vrpベース・不変): 確認期間相関 |corr(pnl_vrp,②)|=${Math.abs(corr_vrp_momentum_full).toFixed(4)} |corr(pnl_vrp,032キャリー)|=${Math.abs(corr_vrp_carry_full).toFixed(4)}`);

  // ============================================================
  // 出力
  // ============================================================
  const output = {
    experiment: 'EXP-OBS000037',
    stage: 'Stage 2',
    scriptPath: 'scripts/vrp-composite-3sleeve.ts',
    specReference: 'research/EXP-OBS000037/00-spec-stage2.md §6-0, §6-1, §6-2, §6-3',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    revisionNote: '2026-07-13差し戻し是正: 初版の日次頻度+pnl_vrp流用による合成を撤回し、週次頻度合成（VRPスリーブ=vrp-pipeline-accounting.tsのequitySeries[].rを再利用、②/032キャリーは日次を週窓内で複利集約）に変更。G3\'相関測定は§5-1の日次差分系列pnl_vrpのまま不変。G4\'の数値閾値・ウェイト方式・窓・選定確認分割は不変。',
    scope: { assets: ['BTC'], note: 'ETH取得禁止（spec §8-2固定）' },
    params: PARAMS,
    inputSources: {
      momentumProduction: { config: PARAMS.momentumProductionConfig, backtestStartDateUsed: PARAMS.momentumBacktestStartDate, tradeCount: momentumRun.tradeCount, dailyRows: momentumRows.length },
      carrySleeve: { path: 'research/EXP-OBS000032/10-result/stage1-liquidation-daily-returns-btc-L3.json', wStar_L3: wStarBtc, dailyRows: carryRows.length },
      vrpWeeklyReturn: { path: 'research/EXP-OBS000037/10-result/stage2-vrp-pipeline-accounting.json', field: 'equitySeries[].r', note: 'r_vrp_week_w = vegaNotionalPct×(VRP_w−C_real)。§4-1資本equity週次リターンと同一系列をそのまま再利用（再計算しない）。', weeklyRows: vrpWeeklyMap.size },
      vrpDailyPnlForG3prime: { path: 'research/EXP-OBS000037/10-result/stage2-vrp-tail-correlation-pnl.json', field: 'pnlVrpDailySeries', dailyRows: vrpDailyRows.length, note: 'G3\'相関測定専用（§5-1定義のまま不変）。合成リターン（G4\'）には使わない。' },
      weeklyBoundary: { path: 'research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json', field: 'mainSeries.weeklyPoints[].date', weeklyPointsCount: boundaryDates.length, nWeeksTotal },
    },
    weeklyGrid: {
      nWeeksTotal,
      includedWeeksCount: includedWeeks.length,
      missingWeeksCount: missingWeeks.length,
      missingWeeks: missingWeeks.map(m => ({ week: m.week, date: m.date, weekEndExclusive: m.weekEndExclusive, reason: m.missingReason, momentumDaysUsed: m.momentumDaysUsed, carryDaysUsed: m.carryDaysUsed, windowCalendarDays: m.windowCalendarDays })),
      rows: weekRows.map(r => ({
        week: r.week, date: r.date, weekEndExclusive: r.weekEndExclusive, windowCalendarDays: r.windowCalendarDays,
        vrpPct: r.vrpPct, momentumPct: r.momentumPct, carryPct: r.carryPct,
        momentumDaysUsed: r.momentumDaysUsed, carryDaysUsed: r.carryDaysUsed,
        momentumDaysMissing: r.windowCalendarDays - r.momentumDaysUsed, carryDaysMissing: r.windowCalendarDays - r.carryDaysUsed,
        missing: r.missing, missingReason: r.missingReason,
      })),
    },
    selectionPeriod_weeklyStd: {
      start: PARAMS.selectionStart, end: PARAMS.selectionEnd, n: selectionWeeks.length,
      std_momentum_pct: stdMomentumSelWeekly, std_carry_pct: stdCarrySelWeekly, std_vrp_pct: stdVrpSelWeekly,
    },
    frozenWeights_2sleeve_weekly_inverseVol: { momentum: frozenWeight2_momentum, carry: frozenWeight2_carry },
    frozenWeights_2sleeve_weekly_naive: { momentum: 0.5, carry: 0.5 },
    frozenWeights_3sleeve_weekly_inverseVol: { momentum: frozenWeight3_momentum, carry: frozenWeight3_carry, vrp: frozenWeight3_vrp },
    frozenWeights_3sleeve_weekly_naive: { momentum: 1 / 3, carry: 1 / 3, vrp: 1 / 3 },
    confirmationPeriod_weekly: { start: PARAMS.confirmStart, end: includedWeeks[includedWeeks.length - 1]?.date, n: confirmationWeeks.length },
    sleeveMetrics_weekly_confirmationPeriod: { momentum: momentumMetricsWeekly, carry: carryMetricsWeekly, vrp: vrpMetricsWeekly },
    composite2Sleeve_weekly_frozenWeight_confirmationPeriod: composite2FrozenMetricsWeekly,
    composite2Sleeve_weekly_naiveWeight_confirmationPeriod: composite2NaiveMetricsWeekly,
    composite3Sleeve_weekly_frozenWeight_confirmationPeriod: composite3FrozenMetricsWeekly,
    composite3Sleeve_weekly_naiveWeight_confirmationPeriod: composite3NaiveMetricsWeekly,
    g4prime_marginalContribution_weekly: {
      formula_a: '(3スリーブ合成Sharpe − 2スリーブ合成Sharpe) ≥ +0.15 かつ (3スリーブ合成maxDD − 2スリーブ合成maxDD) ≤ +2pt',
      formula_b: '(3スリーブ合成maxDD − 2スリーブ合成maxDD) ≤ −5pt かつ (3スリーブ合成Sharpe − 2スリーブ合成Sharpe) ≥ −0.05',
      annualizationFactor: 'sqrt(52)（週次頻度）',
      maxDDDefinition: '週次複利equityのglobal running peak基準%（spec §4-2と同一流儀）',
      frozenWeight: {
        sharpeDelta: sharpeDelta_frozen,
        ddDelta_pt: ddDelta_frozen,
        conditionA_formulaResult: g4prime_conditionA_met,
        conditionB_formulaResult: g4prime_conditionB_met,
        anyCondition_formulaResult: g4prime_any_condition_met,
      },
      naiveWeight: {
        sharpeDelta: sharpeDelta_naive,
        ddDelta_pt: ddDelta_naive,
        conditionA_formulaResult: g4prime_conditionA_met_naive,
        conditionB_formulaResult: g4prime_conditionB_met_naive,
        anyCondition_formulaResult: g4prime_any_condition_met_naive,
      },
    },
    g3prime_correlation_dailyPnlVrp_unchanged: {
      note: '§5-1の日次差分系列pnl_vrpによる相関測定。合成頻度が週次でもG3\'の直交性診断は日次差分のまま（spec §6-3・§9-3・§11-5-2）。',
      alignedDailyDates: { count: allDatesDaily.length, start: allDatesDaily[0], end: allDatesDaily[allDatesDaily.length - 1] },
      confirmationPeriod: { start: PARAMS.confirmStart, end: allDatesDaily[allDatesDaily.length - 1], n: confMomentumDaily.length },
      corr_vrp_momentum: { full: corr_vrp_momentum_full, abs_full: Math.abs(corr_vrp_momentum_full), h1: corr_vrp_momentum_h1, abs_h1: Math.abs(corr_vrp_momentum_h1), h2: corr_vrp_momentum_h2, abs_h2: Math.abs(corr_vrp_momentum_h2) },
      corr_vrp_carry: { full: corr_vrp_carry_full, abs_full: Math.abs(corr_vrp_carry_full), h1: corr_vrp_carry_h1, abs_h1: Math.abs(corr_vrp_carry_h1), h2: corr_vrp_carry_h2, abs_h2: Math.abs(corr_vrp_carry_h2) },
    },
  };

  const outPath = join(RESULT_DIR, 'stage2-vrp-composite-3sleeve.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  const runLogPath = join(RESULT_DIR, 'stage2-vrp-run.log');
  const block = [
    '='.repeat(70),
    `=== vrp-composite-3sleeve.ts 実行 ${RUN_TIMESTAMP}（§6-0是正・週次頻度再実装） ===`,
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/vrp-pipeline-accounting.ts       (1. vegaNotionalPct・equitySeries[].r 供給元・再実行不要)',
    '  node --experimental-strip-types scripts/vrp-tail-correlation-pnl.ts      (2. pnl_vrp日次系列供給元・G3\'専用・再実行不要)',
    '  node --experimental-strip-types scripts/vrp-composite-3sleeve.ts         (3. 本スクリプト・週次頻度再実装)',
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
