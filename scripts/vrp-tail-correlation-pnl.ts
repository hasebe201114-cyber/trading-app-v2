/**
 * EXP-OBS000037 Stage 2: テール相関の日次損益ベース再測定（spec §5・C申し送り(ii)是正）
 * spec: research/EXP-OBS000037/00-spec-stage2.md §5, §9-2
 *
 * 本スクリプトは判定を行わない。生数値のみを出力する（判定語禁止・spec §11）。
 * Stage 1 `scripts/vrp-tail-correlation.ts` を流用（DVOL/価格取得・RV_forward・日次VRP水準系列構築は
 * `scripts/lib/vrp-daily-series.ts` 経由でStage1と同一コード。RV窓長7リターン=D+1..D+8・√365・
 * アンカー2021-03-24は不変・再構築しない）。
 *
 * Cバイアス是正（spec §5-1）: VRP水準そのものでなく、水準の1階差分×vegaNotionalPct（§3・
 * `stage2-vrp-pipeline-accounting.json` の vegaNotionalPct_f05_main を再利用）を日次損益 pnl_vrp として
 * 相関・テールDDを再測定する。
 *
 * 実行: node --experimental-strip-types scripts/vrp-tail-correlation-pnl.ts
 * 出力: research/EXP-OBS000037/10-result/stage2-vrp-tail-correlation-pnl.json
 * 前提: 先に scripts/vrp-pipeline-accounting.ts を実行し
 *       research/EXP-OBS000037/10-result/stage2-vrp-pipeline-accounting.json が存在すること
 *       （vegaNotionalPct_f05_main を読み込む）。
 */

import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';
import type { OHLCV } from '../src/types/market.ts';
import type { EquityPoint } from '../src/risk-layer/types.ts';
import { fetchDvolDaily, fetchDeribitPerpPriceDaily, buildDailyVrpSeries, dateKey, keyToMs, addDaysKey, utcDateOf } from './lib/vrp-daily-series.ts';

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
// 固定パラメータ（spec §5-2・Stage1と同一閾値・ハードコード）
// ============================================================
const PARAMS = {
  anchorDate: '2021-03-24',
  rvForwardReturnCount: 7, // Stage1と同一・不変
  annualizationRv: Math.sqrt(365),
  confirmStart: '2023-07-01',
  tailWindows: {
    T2: { start: '2022-05-01', end: '2022-06-30', label: 'LUNA/UST崩壊' },
    T3: { start: '2022-10-25', end: '2022-12-15', label: 'FTX破綻' },
  },
  averageCorrelationThreshold_calm: 0.3, // G1-A1'（判定はC。ここでは数値のみ）
  tailCorrelationThreshold: 0.6, // G1-A2'（判定はC）
  momentumProductionConfig: {
    horizon: 10,
    k: 30,
    momentumLookback: 30,
    momentumConfidenceScale: 30,
    initialEquity: 1_000_000,
  },
  momentumBacktestStartDate: '2020-06-01',
};

// ============================================================
// vegaNotionalPct（§3・script1出力の再利用）
// ============================================================
function loadVegaNotionalPct(): number {
  const raw = JSON.parse(readFileSync(join(RESULT_DIR, 'stage2-vrp-pipeline-accounting.json'), 'utf-8'));
  return raw.cvarSizing.vegaNotionalPct_f05_main as number;
}

// ============================================================
// OBS000032キャリー日次（ヒストリカルL3）読み込み（Stage1と同一）
// ============================================================
function loadCarryL3(): { date: string; value: number }[] {
  const raw = JSON.parse(readFileSync(join(OBS032_RESULT_DIR, 'stage1-liquidation-daily-returns-btc-L3.json'), 'utf-8'));
  return (raw.data as { date: string; pnl_bps: number }[]).map(d => ({ date: d.date, value: d.pnl_bps }));
}

// ============================================================
// ②モメンタム日次（simulatePortfolio本番構成。Stage1と同一）
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
  while (cur <= end) {
    dates.push(dateKey(new Date(cur)));
    cur += DAY;
  }
  return dates;
}
function equityCurveToDailyReturns(equityCurve: EquityPoint[]): { date: string; value: number }[] {
  if (equityCurve.length === 0) return [];
  const startDate = utcDateOf(equityCurve[0].timestamp);
  const endDate = utcDateOf(equityCurve[equityCurve.length - 1].timestamp);
  const equityByDate = new Map<string, number>();
  for (const p of equityCurve) equityByDate.set(utcDateOf(p.timestamp), p.equity);
  const dates = allDatesBetween(startDate, endDate);
  const rows: { date: string; value: number }[] = [];
  let current = equityCurve[0].equity;
  let prev = current;
  for (const d of dates) {
    if (equityByDate.has(d)) current = equityByDate.get(d)!;
    const returnPct = prev !== 0 ? ((current - prev) / prev) * 100 : 0;
    rows.push({ date: d, value: returnPct });
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
// 統計ユーティリティ（Stage1と同一）
// ============================================================
function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}
function stdPopulation(arr: number[]): number {
  if (arr.length === 0) return NaN;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}
function correlation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return NaN;
  const mx = mean(x);
  const my = mean(y);
  const cov = x.reduce((s, xi, i) => s + (xi - mx) * (y[i] - my), 0) / x.length;
  const sx = stdPopulation(x);
  const sy = stdPopulation(y);
  return sx > 0 && sy > 0 ? cov / (sx * sy) : NaN;
}
function toMap(rows: { date: string; value: number }[]): Map<string, number> {
  return new Map(rows.map(r => [r.date, r.value]));
}
function joinByDate(maps: Map<string, number>[]): { dates: string[]; series: number[][] } {
  const commonDates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  const series = maps.map(m => commonDates.map(d => m.get(d)!));
  return { dates: commonDates, series };
}
function normalizeByOwnWindowStd(values: number[]): { normalized: number[]; windowStd: number } {
  const std = stdPopulation(values);
  const normalized = std > 0 ? values.map(v => v / std) : values.map(() => 0);
  return { normalized, windowStd: std };
}
interface DdResult {
  cumulativeReturn: number;
  maxDrawdown: number;
  ddPeakDate: string | null;
  ddTroughDate: string | null;
}
function computeCumulativeDD(dates: string[], values: number[]): DdResult {
  let cum = 0;
  let peak = 0;
  let peakDate: string | null = null;
  let curPeakDate: string | null = null;
  let maxDD = 0;
  let troughDate: string | null = null;
  for (let i = 0; i < values.length; i++) {
    cum += values[i];
    if (cum >= peak) { peak = cum; curPeakDate = dates[i]; }
    const dd = peak - cum;
    if (dd > maxDD) { maxDD = dd; peakDate = curPeakDate; troughDate = dates[i]; }
  }
  return { cumulativeReturn: cum, maxDrawdown: maxDD, ddPeakDate: peakDate, ddTroughDate: troughDate };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 Stage 2: vrp-tail-correlation-pnl.ts ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim();
  } catch { /* ignore */ }
  log(`Git commit: ${gitCommit}`);
  log(`Node version: ${process.version}`);

  const vegaNotionalPct = loadVegaNotionalPct();
  log(`vegaNotionalPct(f=0.5, script1由来)=${vegaNotionalPct}`);

  const todayKey = dateKey(new Date());

  // ---- 1. VRP日次水準系列構築（Stage1と同一コード・再構築ではなく流用） ----
  log('\n>>> DVOL BTC 日次取得');
  const dvolFetch = await fetchDvolDaily('BTC', PARAMS.anchorDate, todayKey, log);
  const dvolByDate = new Map(dvolFetch.rows.map(r => [r.date, r.close]));
  log(`  DVOL総取得件数=${dvolFetch.rows.length}`);

  log('\n>>> 主系列価格取得（Deribit-tradingview BTC-PERPETUAL）');
  const mainPrice = await fetchDeribitPerpPriceDaily('BTC-PERPETUAL', PARAMS.anchorDate, todayKey, log);

  log('\n>>> VRP日次水準系列構築（Stage1 buildDailyVrpSeriesを流用）');
  const dvolLastDate = dvolFetch.rows[dvolFetch.rows.length - 1]?.date ?? todayKey;
  const vrpDailyRows = buildDailyVrpSeries(PARAMS.anchorDate, dvolLastDate, dvolByDate, mainPrice.closeByDate, PARAMS.rvForwardReturnCount, PARAMS.annualizationRv);
  log(`  VRP日次構築可能日数=${vrpDailyRows.length}（期間 ${vrpDailyRows[0]?.date}〜${vrpDailyRows[vrpDailyRows.length - 1]?.date}）`);

  // ---- 2. pnl_vrp = vegaNotionalPct × ΔVRP_daily（1階差分・Cバイアス是正） ----
  const pnlVrpRows: { date: string; value: number }[] = [];
  for (let i = 1; i < vrpDailyRows.length; i++) {
    const deltaVrp = vrpDailyRows[i].vrp_level - vrpDailyRows[i - 1].vrp_level;
    pnlVrpRows.push({ date: vrpDailyRows[i].date, value: vegaNotionalPct * deltaVrp });
  }
  log(`  pnl_vrp日次系列構築: n=${pnlVrpRows.length}（1階差分のため水準系列よりn-1）`);

  // ---- 3. OBS000032キャリー日次（ヒストリカルL3） ----
  log('\n>>> OBS000032キャリー日次（ヒストリカルL3）読み込み');
  const carryRows = loadCarryL3();
  log(`  キャリーL3行数=${carryRows.length}（期間 ${carryRows[0]?.date}〜${carryRows[carryRows.length - 1]?.date}）`);

  // ---- 4. ②モメンタム日次 ----
  log('\n>>> ②モメンタム日次（simulatePortfolio本番構成）');
  const btcCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
  const momentumRun = runMomentumProduction(btcCandles, PARAMS.momentumBacktestStartDate);
  log(`  ②: trades=${momentumRun.tradeCount} equityCurvePoints=${momentumRun.equityCurve.length}`);
  const momentumRows = equityCurveToDailyReturns(momentumRun.equityCurve);
  log(`  ②日次リターン行数=${momentumRows.length}（期間 ${momentumRows[0]?.date}〜${momentumRows[momentumRows.length - 1]?.date}）`);

  // ---- 突合 ----
  const pnlVrpMap = toMap(pnlVrpRows);
  const carryMap = toMap(carryRows);
  const momentumMap = toMap(momentumRows);
  const { dates: joinedDates, series: joinedSeries } = joinByDate([pnlVrpMap, carryMap, momentumMap]);
  const [pnlVrpJoined, carryJoined, momentumJoined] = joinedSeries;
  log(`\n>>> 3系列共通突合日数=${joinedDates.length}（${joinedDates[0]}〜${joinedDates[joinedDates.length - 1]}）`);

  const pnlVrpDatesSet = new Set(pnlVrpRows.map(r => r.date));
  const missingInCarry = [...pnlVrpDatesSet].filter(d => !carryMap.has(d)).length;
  const missingInMomentum = [...pnlVrpDatesSet].filter(d => !momentumMap.has(d)).length;
  log(`  pnl_vrp日付基準の片側欠損: carry非突合=${missingInCarry} momentum非突合=${missingInMomentum}`);

  // ---- G1-A1': 確認期間全体の平時相関（日次損益ベース） ----
  log('\n>>> G1-A1\': 確認期間の平時相関（pnl_vrp）');
  const confirmEnd = joinedDates[joinedDates.length - 1];
  const confirmFiltered = joinedDates.map((d, i) => ({ d, vrp: pnlVrpJoined[i], carry: carryJoined[i], mom: momentumJoined[i] })).filter(x => x.d >= PARAMS.confirmStart && x.d <= confirmEnd);
  const confirmVrp = confirmFiltered.map(x => x.vrp);
  const confirmCarry = confirmFiltered.map(x => x.carry);
  const confirmMom = confirmFiltered.map(x => x.mom);
  const confirmMid = Math.floor(confirmFiltered.length / 2);

  const corr_confirm_full_vrp_carry = correlation(confirmVrp, confirmCarry);
  const corr_confirm_full_vrp_momentum = correlation(confirmVrp, confirmMom);
  const corr_confirm_h1_vrp_carry = correlation(confirmVrp.slice(0, confirmMid), confirmCarry.slice(0, confirmMid));
  const corr_confirm_h1_vrp_momentum = correlation(confirmVrp.slice(0, confirmMid), confirmMom.slice(0, confirmMid));
  const corr_confirm_h2_vrp_carry = correlation(confirmVrp.slice(confirmMid), confirmCarry.slice(confirmMid));
  const corr_confirm_h2_vrp_momentum = correlation(confirmVrp.slice(confirmMid), confirmMom.slice(confirmMid));

  log(`  確認期間(${PARAMS.confirmStart}〜${confirmEnd}) n=${confirmFiltered.length}`);
  log(`  |corr(pnl_vrp,032キャリー)| full=${Math.abs(corr_confirm_full_vrp_carry).toFixed(4)} h1=${Math.abs(corr_confirm_h1_vrp_carry).toFixed(4)} h2=${Math.abs(corr_confirm_h2_vrp_carry).toFixed(4)}`);
  log(`  |corr(pnl_vrp,②)|        full=${Math.abs(corr_confirm_full_vrp_momentum).toFixed(4)} h1=${Math.abs(corr_confirm_h1_vrp_momentum).toFixed(4)} h2=${Math.abs(corr_confirm_h2_vrp_momentum).toFixed(4)}`);

  // ---- G1-A2'/G1-A3': テール窓別（日次損益ベース） ----
  log('\n>>> G1-A2\'/G1-A3\': テール窓別相関・同時DD（pnl_vrp）');
  const tailWindowResults: Record<string, unknown> = {};
  for (const [key, w] of Object.entries(PARAMS.tailWindows)) {
    const windowRows = joinedDates.map((d, i) => ({ d, vrp: pnlVrpJoined[i], carry: carryJoined[i], mom: momentumJoined[i] })).filter(x => x.d >= w.start && x.d <= w.end);
    const wDates = windowRows.map(x => x.d);
    const wVrp = windowRows.map(x => x.vrp);
    const wCarry = windowRows.map(x => x.carry);
    const wMom = windowRows.map(x => x.mom);

    const corr_tail_vrp_carry = correlation(wVrp, wCarry);
    const corr_tail_vrp_momentum = correlation(wVrp, wMom);

    const expectedCalendarDays = Math.round((keyToMs(w.end) - keyToMs(w.start)) / 86400000) + 1;
    const unmatchedDays = expectedCalendarDays - windowRows.length;

    const { normalized: vrpNorm, windowStd: vrpStd } = normalizeByOwnWindowStd(wVrp);
    const { normalized: carryNorm, windowStd: carryStd } = normalizeByOwnWindowStd(wCarry);
    const { normalized: momNorm, windowStd: momStd } = normalizeByOwnWindowStd(wMom);

    const vrpDD = computeCumulativeDD(wDates, vrpNorm);
    const carryDD = computeCumulativeDD(wDates, carryNorm);
    const momDD = computeCumulativeDD(wDates, momNorm);

    const composite2 = wDates.map((_, i) => 0.5 * momNorm[i] + 0.5 * carryNorm[i]);
    const composite2DD = computeCumulativeDD(wDates, composite2);

    const composite3 = wDates.map((_, i) => (1 / 3) * momNorm[i] + (1 / 3) * carryNorm[i] + (1 / 3) * vrpNorm[i]);
    const composite3DD = computeCumulativeDD(wDates, composite3);

    tailWindowResults[key] = {
      windowStart: w.start,
      windowEnd: w.end,
      label: w.label,
      expectedCalendarDays,
      matchedDays: windowRows.length,
      unmatchedDays,
      correlation: {
        corr_tail_pnlVrp_032carry: corr_tail_vrp_carry,
        abs_corr_tail_pnlVrp_032carry: Math.abs(corr_tail_vrp_carry),
        corr_tail_pnlVrp_momentum: corr_tail_vrp_momentum,
        abs_corr_tail_pnlVrp_momentum: Math.abs(corr_tail_vrp_momentum),
      },
      individualSleeves_windowNormalized: {
        pnlVrp: { windowStd_rawUnits: vrpStd, cumulativeReturn_normalizedUnits: vrpDD.cumulativeReturn, maxDrawdown_normalizedUnits: vrpDD.maxDrawdown, ddPeakDate: vrpDD.ddPeakDate, ddTroughDate: vrpDD.ddTroughDate },
        obs032carry: { windowStd_rawUnits: carryStd, cumulativeReturn_normalizedUnits: carryDD.cumulativeReturn, maxDrawdown_normalizedUnits: carryDD.maxDrawdown, ddPeakDate: carryDD.ddPeakDate, ddTroughDate: carryDD.ddTroughDate },
        momentum: { windowStd_rawUnits: momStd, cumulativeReturn_normalizedUnits: momDD.cumulativeReturn, maxDrawdown_normalizedUnits: momDD.maxDrawdown, ddPeakDate: momDD.ddPeakDate, ddTroughDate: momDD.ddTroughDate },
      },
      composite2Sleeve_momentumPlus032carry_equalVol: {
        formula: '0.5 * momentum_normalized + 0.5 * obs032carry_normalized（各系列を自窓std(母集団)で規格化）',
        cumulativeReturn_normalizedUnits: composite2DD.cumulativeReturn,
        maxDrawdown_normalizedUnits: composite2DD.maxDrawdown,
        ddPeakDate: composite2DD.ddPeakDate,
        ddTroughDate: composite2DD.ddTroughDate,
      },
      composite3Sleeve_momentumPlus032carryPlusPnlVrp_equalVol: {
        formula: '(1/3) * momentum_normalized + (1/3) * obs032carry_normalized + (1/3) * pnlVrp_normalized（VRP日次損益を1/3ウェイトで追加）',
        cumulativeReturn_normalizedUnits: composite3DD.cumulativeReturn,
        maxDrawdown_normalizedUnits: composite3DD.maxDrawdown,
        ddPeakDate: composite3DD.ddPeakDate,
        ddTroughDate: composite3DD.ddTroughDate,
      },
      maxDrawdownDiff_composite3MinusComposite2_normalizedUnits: composite3DD.maxDrawdown - composite2DD.maxDrawdown,
    };
    log(`  ${key}(${w.start}〜${w.end}): matched=${windowRows.length}/${expectedCalendarDays} corr(pnlVrp,032carry)=${corr_tail_vrp_carry.toFixed(4)} corr(pnlVrp,②)=${corr_tail_vrp_momentum.toFixed(4)} DD2sleeve=${composite2DD.maxDrawdown.toFixed(4)} DD3sleeve=${composite3DD.maxDrawdown.toFixed(4)}`);
  }

  const output = {
    experiment: 'EXP-OBS000037',
    stage: 'Stage 2',
    scriptPath: 'scripts/vrp-tail-correlation-pnl.ts',
    specReference: 'research/EXP-OBS000037/00-spec-stage2.md §5',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    scope: { assets: ['BTC'], note: 'ETH取得禁止（spec §8-2固定）' },
    params: PARAMS,
    vegaNotionalPct_f05_source: 'research/EXP-OBS000037/10-result/stage2-vrp-pipeline-accounting.json cvarSizing.vegaNotionalPct_f05_main',
    vegaNotionalPct_f05: vegaNotionalPct,
    pnlVrpDefinition: 'pnl_vrp_t = vegaNotionalPct(f=0.5) × (VRP_daily_t − VRP_daily_{t-1})。VRP_daily_tはStage1と同一コード（RV窓長7リターン=D+1..D+8・√365・アンカー2021-03-24）で再構築した日次VRP水準系列（Stage1 stage1-vrp-tail-correlation.jsonが集計統計のみでraw配列を保存していないため、Stage1と同一コードを再実行して同一系列を得ている＝VRP系列の再構築ではなく流用）。',
    dataSources: {
      dvol: { totalRows: dvolFetch.rows.length, pageLog: dvolFetch.pageLog, pagingPolicyNote: '終了条件は空応答またはcontinuation null/undefinedのみ。' },
      mainPriceSeries: { source: 'deribit-tradingview', ticksReturned: mainPrice.ticksReturned, rawTickHourUtc: mainPrice.rawTickHourUtc },
      vrpDailyConstructibleRange: { start: vrpDailyRows[0]?.date ?? null, end: vrpDailyRows[vrpDailyRows.length - 1]?.date ?? null, count: vrpDailyRows.length },
      pnlVrpRange: { start: pnlVrpRows[0]?.date ?? null, end: pnlVrpRows[pnlVrpRows.length - 1]?.date ?? null, count: pnlVrpRows.length },
      carryL3: { path: 'research/EXP-OBS000032/10-result/stage1-liquidation-daily-returns-btc-L3.json', rowCount: carryRows.length, firstDate: carryRows[0]?.date ?? null, lastDate: carryRows[carryRows.length - 1]?.date ?? null, note: 'フォワードledgerはテール非カバーのため使用していない（ヒストリカルL3のみ使用）。' },
      momentumProduction: { config: PARAMS.momentumProductionConfig, backtestStartDateUsed: PARAMS.momentumBacktestStartDate, tradeCount: momentumRun.tradeCount, dailyRowCount: momentumRows.length, firstDate: momentumRows[0]?.date ?? null, lastDate: momentumRows[momentumRows.length - 1]?.date ?? null },
    },
    joinKeyAlignment: {
      note: 'pnl_vrpは`date`（YYYY-MM-DD）、OBS000032 L3は`date`（YYYY-MM-DD）、②momentumは equityCurveから導出した`date`（YYYY-MM-DD）。ISO日付文字列で3系列をjoin。',
      commonMatchedDays: joinedDates.length,
      commonDateRange: { start: joinedDates[0] ?? null, end: joinedDates[joinedDates.length - 1] ?? null },
      pnlVrpDateSetSize: pnlVrpDatesSet.size,
      missingInCarry_countBasedOnPnlVrpDates: missingInCarry,
      missingInMomentum_countBasedOnPnlVrpDates: missingInMomentum,
    },
    g1_a1prime_calmPeriodCorrelation: {
      confirmationPeriodStart: PARAMS.confirmStart,
      confirmationPeriodEnd: confirmEnd,
      n_full: confirmFiltered.length,
      n_h1: Math.floor(confirmFiltered.length / 2),
      n_h2: confirmFiltered.length - Math.floor(confirmFiltered.length / 2),
      corr_pnlVrp_032carry: { full: corr_confirm_full_vrp_carry, abs_full: Math.abs(corr_confirm_full_vrp_carry), h1: corr_confirm_h1_vrp_carry, abs_h1: Math.abs(corr_confirm_h1_vrp_carry), h2: corr_confirm_h2_vrp_carry, abs_h2: Math.abs(corr_confirm_h2_vrp_carry) },
      corr_pnlVrp_momentum: { full: corr_confirm_full_vrp_momentum, abs_full: Math.abs(corr_confirm_full_vrp_momentum), h1: corr_confirm_h1_vrp_momentum, abs_h1: Math.abs(corr_confirm_h1_vrp_momentum), h2: corr_confirm_h2_vrp_momentum, abs_h2: Math.abs(corr_confirm_h2_vrp_momentum) },
    },
    g1_a2a3prime_tailWindows: tailWindowResults,
    pnlVrpDailySeries: pnlVrpRows,
  };

  const outPath = join(RESULT_DIR, 'stage2-vrp-tail-correlation-pnl.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  const runLogPath = join(RESULT_DIR, 'stage2-vrp-run.log');
  const block = [
    '='.repeat(70),
    `=== vrp-tail-correlation-pnl.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/vrp-pipeline-accounting.ts  (先に実行・vegaNotionalPct供給元)',
    '  node --experimental-strip-types scripts/vrp-tail-correlation-pnl.ts',
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
