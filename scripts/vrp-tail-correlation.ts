/**
 * EXP-OBS000037 Stage 1: テール相関ゲート = 必須条件A（spec §5）
 * spec: research/EXP-OBS000037/00-spec-stage1.md §5
 *
 * 本スクリプトは判定を行わない。生数値のみを出力する（判定語禁止・spec §10）。
 * lab側スクリプトはコピペしていない（独立実装）。
 *
 * 3スリーブ日次リターンを同一UTC日付でjoinする（spec §5-1）:
 *   1. VRPスリーブ日次（OBS000037・§2のVRP系列を日次ローリングに展開・主系列=Deribit-tradingview価格由来）
 *   2. OBS000032キャリー日次（ヒストリカルL3・research/EXP-OBS000032/10-result/stage1-liquidation-daily-returns-btc-L3.json）
 *   3. ②モメンタム日次（simulatePortfolio 本番構成: horizon:10,k:30,momentumLookback:30,momentumConfidenceScale:30,initialEquity:1_000_000）
 *
 * G1-A1: 確認期間全体(2023-07-01〜末尾)で |corr(VRP,②)| と |corr(VRP,032キャリー)|（全体＋前半/後半）
 * G1-A2: T2(2022-05-01〜06-30)・T3(2022-10-25〜12-15) 各窓での corr_tail(VRP,032キャリー)・corr_tail(VRP,②)
 * G1-A3: 各テール窓で {②+032キャリー}等ボラ2スリーブ合成 vs {②+032キャリー+VRP}等ボラ3スリーブ合成の窓内最大DD比較
 *
 * 実行: node --experimental-strip-types scripts/vrp-tail-correlation.ts
 * 出力: research/EXP-OBS000037/10-result/stage1-vrp-tail-correlation.json
 */

import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';
import type { OHLCV } from '../src/types/market.ts';
import type { EquityPoint } from '../src/risk-layer/types.ts';

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
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const BASE = 'https://www.deribit.com/api/v2';

// ============================================================
// 固定パラメータ（spec §5-2・ハードコード）
// ============================================================
const PARAMS = {
  anchorDate: '2021-03-24',
  rvForwardWindowDays: 7,
  annualizationRv: Math.sqrt(365),
  confirmStart: '2023-07-01',
  tailWindows: {
    T2: { start: '2022-05-01', end: '2022-06-30', label: 'LUNA/UST崩壊' },
    T3: { start: '2022-10-25', end: '2022-12-15', label: 'FTX破綻' },
  },
  averageCorrelationThreshold_calm: 0.3, // G1-A1
  tailCorrelationThreshold: 0.6, // G1-A2（判定はC。ここでは数値のみ計算）
  momentumProductionConfig: {
    horizon: 10,
    k: 30,
    momentumLookback: 30,
    momentumConfidenceScale: 30,
    initialEquity: 1_000_000,
  },
  momentumBacktestStartDate: '2020-06-01', // T2/T3・確認期間を十分な warmup 込みでカバーするための開始日（simulatePortfolio呼び出し用。チューニング目的ではない）
};

// ============================================================
// 日付ユーティリティ
// ============================================================
function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function keyToMs(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`);
}
function addDaysKey(key: string, n: number): string {
  return dateKey(new Date(keyToMs(key) + n * 86400000));
}
function utcDateOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

// ============================================================
// HTTP fetch
// ============================================================
interface FetchMeta {
  status: number;
  ok: boolean;
  json: unknown | null;
}
async function fetchWithMeta(url: string): Promise<FetchMeta> {
  const res = await fetch(url);
  const text = await res.text();
  let json: unknown | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, ok: res.ok, json };
}

// ============================================================
// DVOL 取得（終了条件=空応答 or continuationなし のみ）
// ============================================================
interface DvolRow {
  date: string;
  timestampMs: number;
  close: number;
}
async function fetchDvolDaily(currency: string, floorKey: string, ceilKeyInclusive: string): Promise<{ rows: DvolRow[]; pageLog: string[] }> {
  const rows: DvolRow[] = [];
  const pageLog: string[] = [];
  let endMs = keyToMs(ceilKeyInclusive) + 86400000;
  const floorMs = keyToMs(floorKey);
  let requestCount = 0;
  const MAX_REQUESTS = 60;

  while (requestCount < MAX_REQUESTS) {
    const url = `${BASE}/public/get_volatility_index_data?currency=${currency}&start_timestamp=${floorMs}&end_timestamp=${endMs}&resolution=86400`;
    const r = await fetchWithMeta(url);
    requestCount++;
    const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
    const data = (resultObj?.data as number[][] | undefined) ?? [];
    const continuation = resultObj && 'continuation' in resultObj ? (resultObj.continuation as number | null) : undefined;
    pageLog.push(`DVOL request#${requestCount} status=${r.status} rowsReturned=${data.length} continuation=${JSON.stringify(continuation)}`);
    log(`  DVOL page#${requestCount}: rowsReturned=${data.length} continuation=${JSON.stringify(continuation)}`);

    if (!Array.isArray(data) || data.length === 0) {
      pageLog.push('終了理由: empty_response');
      break;
    }
    for (const d of data) rows.push({ timestampMs: d[0], date: dateKey(new Date(d[0])), close: d[4] });
    if (continuation === null || continuation === undefined) {
      pageLog.push('終了理由: continuation_null_or_absent');
      break;
    }
    endMs = continuation as number;
    await sleep(250);
  }
  const map = new Map<number, DvolRow>();
  for (const row of rows) map.set(row.timestampMs, row);
  const sorted = [...map.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  return { rows: sorted, pageLog };
}

// ============================================================
// Deribit-tradingview 価格取得（主系列）
// ============================================================
async function fetchDeribitPerpPriceDaily(instrument: string, floorKey: string, ceilKeyInclusive: string): Promise<{ closeByDate: Map<string, number>; ticksReturned: number; rawTickHourUtc: number | null }> {
  const startMs = keyToMs(floorKey);
  const endMs = keyToMs(ceilKeyInclusive) + 86400000;
  const url = `${BASE}/public/get_tradingview_chart_data?instrument_name=${instrument}&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=1D`;
  log(`  GET ${url}`);
  const r = await fetchWithMeta(url);
  const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
  const ticks = (resultObj?.ticks as number[] | undefined) ?? [];
  const closes = (resultObj?.close as number[] | undefined) ?? [];
  const closeByDate = new Map<string, number>();
  for (let i = 0; i < ticks.length; i++) closeByDate.set(dateKey(new Date(ticks[i])), closes[i]);
  const rawTickHourUtc = ticks.length > 0 ? new Date(ticks[0]).getUTCHours() : null;
  log(`  ${instrument} price: ticks=${ticks.length} rawTickHourUtc=${rawTickHourUtc}`);
  return { closeByDate, ticksReturned: ticks.length, rawTickHourUtc };
}

// ============================================================
// RV_forward(D,D+7d)：D+1..D+7 の7終値のみ使用（vrp-prediction-unit.tsと同一定義。先読み排除）
// ============================================================
function computeRvForward(dateD: string, closeByDate: Map<string, number>, windowDays: number): { rv: number | null; priceDatesUsed: string[] } {
  const priceDates: string[] = [];
  const closesUsed: number[] = [];
  for (let i = 1; i <= windowDays; i++) {
    const d = addDaysKey(dateD, i);
    const c = closeByDate.get(d);
    if (c === undefined) return { rv: null, priceDatesUsed: priceDates };
    priceDates.push(d);
    closesUsed.push(c);
  }
  const logReturns: number[] = [];
  for (let i = 1; i < closesUsed.length; i++) {
    if (closesUsed[i - 1] <= 0 || closesUsed[i] <= 0) return { rv: null, priceDatesUsed: priceDates };
    logReturns.push(Math.log(closesUsed[i] / closesUsed[i - 1]));
  }
  if (logReturns.length < 2) return { rv: null, priceDatesUsed: priceDates };
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  return { rv: Math.sqrt(variance) * PARAMS.annualizationRv * 100, priceDatesUsed: priceDates };
}

// ============================================================
// VRPスリーブ日次（毎日ローリング。週次サンプリングでなく全日で構築＝spec §5-1）
// ============================================================
interface VrpDailyRow {
  date: string;
  dvol: number;
  rv_forward_pct: number;
  vrp_level: number; // その日のVRP水準（vol pt）
}
function buildDailyVrpSeries(startKey: string, endKey: string, dvolByDate: Map<string, number>, closeByDate: Map<string, number>): VrpDailyRow[] {
  const rows: VrpDailyRow[] = [];
  let cur = startKey;
  while (cur <= endKey) {
    const dvol = dvolByDate.get(cur);
    if (dvol !== undefined) {
      const { rv } = computeRvForward(cur, closeByDate, PARAMS.rvForwardWindowDays);
      if (rv !== null) rows.push({ date: cur, dvol, rv_forward_pct: rv, vrp_level: dvol - rv });
    }
    cur = addDaysKey(cur, 1);
  }
  return rows;
}

/**
 * VRP「日次スリーブ収益」への変換（spec §5-1「日次DVOL−日次forward7d RV＝日次スリーブ収益」）。
 * VRP水準系列そのものの日次変化ではなく、各日のVRP水準を「その日にVRPスリーブが得る収益の代理」として扱う
 * （spec原文どおりVRP_t自体を日次系列としてそのまま用いる。差分は取らない）。
 */
function vrpLevelSeriesToReturnRows(rows: VrpDailyRow[]): { date: string; value: number }[] {
  return rows.map(r => ({ date: r.date, value: r.vrp_level }));
}

// ============================================================
// OBS000032キャリー日次（ヒストリカルL3）読み込み
// ============================================================
function loadCarryL3(): { date: string; value: number }[] {
  const raw = JSON.parse(readFileSync(join(OBS032_RESULT_DIR, 'stage1-liquidation-daily-returns-btc-L3.json'), 'utf-8'));
  return (raw.data as { date: string; pnl_bps: number }[]).map(d => ({ date: d.date, value: d.pnl_bps }));
}

// ============================================================
// ②モメンタム日次（simulatePortfolio 本番構成）
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
// 統計ユーティリティ
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

// ============================================================
// 日付整列（join）ユーティリティ
// ============================================================
function toMap(rows: { date: string; value: number }[]): Map<string, number> {
  return new Map(rows.map(r => [r.date, r.value]));
}
function joinByDate(maps: Map<string, number>[]): { dates: string[]; series: number[][] } {
  const commonDates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort();
  const series = maps.map(m => commonDates.map(d => m.get(d)!));
  return { dates: commonDates, series };
}
function filterRange(dates: string[], series: number[], start: string, end: string): { dates: string[]; values: number[] } {
  const idx = dates.map((d, i) => ({ d, i })).filter(x => x.d >= start && x.d <= end);
  return { dates: idx.map(x => x.d), values: idx.map(x => series[x.i]) };
}

// ============================================================
// スリーブ内・窓内標準化（自窓stdで規格化）
// ============================================================
function normalizeByOwnWindowStd(values: number[]): { normalized: number[]; windowStd: number } {
  const std = stdPopulation(values);
  const normalized = std > 0 ? values.map(v => v / std) : values.map(() => 0);
  return { normalized, windowStd: std };
}

interface DdResult {
  cumulativeReturn: number;
  maxDrawdown: number; // 絶対値（正規化単位・累積和のpeak-to-trough）
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
    if (cum >= peak) {
      peak = cum;
      curPeakDate = dates[i];
    }
    const dd = peak - cum;
    if (dd > maxDD) {
      maxDD = dd;
      peakDate = curPeakDate;
      troughDate = dates[i];
    }
  }
  return { cumulativeReturn: cum, maxDrawdown: maxDD, ddPeakDate: peakDate, ddTroughDate: troughDate };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 Stage 1: vrp-tail-correlation.ts ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim();
  } catch {
    /* ignore */
  }
  log(`Git commit: ${gitCommit}`);
  log(`Node version: ${process.version}`);

  const todayKey = dateKey(new Date());

  // ---- 1. VRPスリーブ日次構築 ----
  log('\n>>> DVOL BTC 日次取得');
  const dvolFetch = await fetchDvolDaily('BTC', PARAMS.anchorDate, todayKey);
  const dvolByDate = new Map(dvolFetch.rows.map(r => [r.date, r.close]));
  log(`  DVOL総取得件数=${dvolFetch.rows.length}`);

  log('\n>>> 主系列価格取得（Deribit-tradingview BTC-PERPETUAL）');
  const mainPrice = await fetchDeribitPerpPriceDaily('BTC-PERPETUAL', PARAMS.anchorDate, todayKey);

  log('\n>>> VRPスリーブ日次系列構築（毎日ローリング・spec §5-1）');
  // RV_forwardがD+7まで要るため、DVOL最終日の7日前までが構築可能上限
  const dvolLastDate = dvolFetch.rows[dvolFetch.rows.length - 1]?.date ?? todayKey;
  const vrpDailyRows = buildDailyVrpSeries(PARAMS.anchorDate, dvolLastDate, dvolByDate, mainPrice.closeByDate);
  log(`  VRP日次構築可能日数=${vrpDailyRows.length}（期間 ${vrpDailyRows[0]?.date}〜${vrpDailyRows[vrpDailyRows.length - 1]?.date}）`);
  const vrpSleeveRows = vrpLevelSeriesToReturnRows(vrpDailyRows);

  // ---- 2. OBS000032キャリー日次（ヒストリカルL3） ----
  log('\n>>> OBS000032キャリー日次（ヒストリカルL3）読み込み');
  const carryRows = loadCarryL3();
  log(`  キャリーL3行数=${carryRows.length}（期間 ${carryRows[0]?.date}〜${carryRows[carryRows.length - 1]?.date}）`);

  // ---- 3. ②モメンタム日次（simulatePortfolio本番構成） ----
  log('\n>>> ②モメンタム日次（simulatePortfolio本番構成）');
  const btcCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
  const momentumRun = runMomentumProduction(btcCandles, PARAMS.momentumBacktestStartDate);
  log(`  ②: trades=${momentumRun.tradeCount} equityCurvePoints=${momentumRun.equityCurve.length}`);
  const momentumRows = equityCurveToDailyReturns(momentumRun.equityCurve);
  log(`  ②日次リターン行数=${momentumRows.length}（期間 ${momentumRows[0]?.date}〜${momentumRows[momentumRows.length - 1]?.date}）`);

  // ---- 突合（3系列の日付join） ----
  const vrpMap = toMap(vrpSleeveRows);
  const carryMap = toMap(carryRows);
  const momentumMap = toMap(momentumRows);

  const { dates: joinedDates, series: joinedSeries } = joinByDate([vrpMap, carryMap, momentumMap]);
  const [vrpJoined, carryJoined, momentumJoined] = joinedSeries;
  log(`\n>>> 3系列共通突合日数=${joinedDates.length}（${joinedDates[0]}〜${joinedDates[joinedDates.length - 1]}）`);

  // 片側欠損の記録（VRP日付集合を基準に、carry/momentumそれぞれの欠損数）
  const vrpDatesSet = new Set(vrpSleeveRows.map(r => r.date));
  const missingInCarry = [...vrpDatesSet].filter(d => !carryMap.has(d)).length;
  const missingInMomentum = [...vrpDatesSet].filter(d => !momentumMap.has(d)).length;
  log(`  VRP日付基準の片側欠損: carry非突合=${missingInCarry} momentum非突合=${missingInMomentum}`);

  // ---- G1-A1: 確認期間全体の平時相関 ----
  log('\n>>> G1-A1: 確認期間の平時相関');
  const confirmEnd = joinedDates[joinedDates.length - 1];
  const confirmFiltered = joinedDates.map((d, i) => ({ d, vrp: vrpJoined[i], carry: carryJoined[i], mom: momentumJoined[i] })).filter(x => x.d >= PARAMS.confirmStart && x.d <= confirmEnd);
  const confirmDates = confirmFiltered.map(x => x.d);
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
  log(`  |corr(VRP,032キャリー)| full=${Math.abs(corr_confirm_full_vrp_carry).toFixed(4)} h1=${Math.abs(corr_confirm_h1_vrp_carry).toFixed(4)} h2=${Math.abs(corr_confirm_h2_vrp_carry).toFixed(4)}`);
  log(`  |corr(VRP,②)|        full=${Math.abs(corr_confirm_full_vrp_momentum).toFixed(4)} h1=${Math.abs(corr_confirm_h1_vrp_momentum).toFixed(4)} h2=${Math.abs(corr_confirm_h2_vrp_momentum).toFixed(4)}`);

  // ---- G1-A2 & G1-A3: テール窓別 ----
  log('\n>>> G1-A2/G1-A3: テール窓別相関・同時DD');
  const tailWindowResults: Record<string, unknown> = {};

  for (const [key, w] of Object.entries(PARAMS.tailWindows)) {
    const windowRows = joinedDates
      .map((d, i) => ({ d, vrp: vrpJoined[i], carry: carryJoined[i], mom: momentumJoined[i] }))
      .filter(x => x.d >= w.start && x.d <= w.end);
    const wDates = windowRows.map(x => x.d);
    const wVrp = windowRows.map(x => x.vrp);
    const wCarry = windowRows.map(x => x.carry);
    const wMom = windowRows.map(x => x.mom);

    const corr_tail_vrp_carry = correlation(wVrp, wCarry);
    const corr_tail_vrp_momentum = correlation(wVrp, wMom);

    // 突合できなかった日数（窓の暦日数 vs 突合できた日数）
    const expectedCalendarDays = Math.round((keyToMs(w.end) - keyToMs(w.start)) / 86400000) + 1;
    const unmatchedDays = expectedCalendarDays - windowRows.length;

    // 自窓stdで規格化
    const { normalized: vrpNorm, windowStd: vrpStd } = normalizeByOwnWindowStd(wVrp);
    const { normalized: carryNorm, windowStd: carryStd } = normalizeByOwnWindowStd(wCarry);
    const { normalized: momNorm, windowStd: momStd } = normalizeByOwnWindowStd(wMom);

    const vrpDD = computeCumulativeDD(wDates, vrpNorm);
    const carryDD = computeCumulativeDD(wDates, carryNorm);
    const momDD = computeCumulativeDD(wDates, momNorm);

    // 2スリーブ合成（②+032キャリー、等ボラ=各1/2規格化後の和）
    const composite2 = wDates.map((_, i) => 0.5 * momNorm[i] + 0.5 * carryNorm[i]);
    const composite2DD = computeCumulativeDD(wDates, composite2);

    // 3スリーブ合成（②+032キャリー+VRP、等ボラ=各1/3規格化後の和。VRPを1/3ウェイトで加える＝spec §5-2 G1-A3）
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
        corr_tail_vrp_032carry: corr_tail_vrp_carry,
        abs_corr_tail_vrp_032carry: Math.abs(corr_tail_vrp_carry),
        corr_tail_vrp_momentum: corr_tail_vrp_momentum,
        abs_corr_tail_vrp_momentum: Math.abs(corr_tail_vrp_momentum),
      },
      individualSleeves_windowNormalized: {
        vrp: { windowStd_rawUnits: vrpStd, cumulativeReturn_normalizedUnits: vrpDD.cumulativeReturn, maxDrawdown_normalizedUnits: vrpDD.maxDrawdown, ddPeakDate: vrpDD.ddPeakDate, ddTroughDate: vrpDD.ddTroughDate },
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
      composite3Sleeve_momentumPlus032carryPlusVrp_equalVol: {
        formula: '(1/3) * momentum_normalized + (1/3) * obs032carry_normalized + (1/3) * vrp_normalized（VRPを1/3ウェイトで追加）',
        cumulativeReturn_normalizedUnits: composite3DD.cumulativeReturn,
        maxDrawdown_normalizedUnits: composite3DD.maxDrawdown,
        ddPeakDate: composite3DD.ddPeakDate,
        ddTroughDate: composite3DD.ddTroughDate,
      },
      maxDrawdownDiff_composite3MinusComposite2_normalizedUnits: composite3DD.maxDrawdown - composite2DD.maxDrawdown,
    };
    log(`  ${key}(${w.start}〜${w.end}): matched=${windowRows.length}/${expectedCalendarDays} corr(VRP,032carry)=${corr_tail_vrp_carry.toFixed(4)} corr(VRP,②)=${corr_tail_vrp_momentum.toFixed(4)} DD2sleeve=${composite2DD.maxDrawdown.toFixed(4)} DD3sleeve=${composite3DD.maxDrawdown.toFixed(4)}`);
  }

  const output = {
    experiment: 'EXP-OBS000037',
    stage: 'Stage 1',
    scriptPath: 'scripts/vrp-tail-correlation.ts',
    specReference: 'research/EXP-OBS000037/00-spec-stage1.md §5',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    scope: { assets: ['BTC'], note: 'ETH取得禁止（spec §4固定）' },
    params: PARAMS,
    dataSources: {
      dvol: { totalRows: dvolFetch.rows.length, pageLog: dvolFetch.pageLog, pagingPolicyNote: '終了条件は空応答またはcontinuation null/undefinedのみ。' },
      mainPriceSeries: { source: 'deribit-tradingview', ticksReturned: mainPrice.ticksReturned, rawTickHourUtc: mainPrice.rawTickHourUtc },
      vrpDailyConstructibleRange: { start: vrpDailyRows[0]?.date ?? null, end: vrpDailyRows[vrpDailyRows.length - 1]?.date ?? null, count: vrpDailyRows.length },
      carryL3: { path: 'research/EXP-OBS000032/10-result/stage1-liquidation-daily-returns-btc-L3.json', rowCount: carryRows.length, firstDate: carryRows[0]?.date ?? null, lastDate: carryRows[carryRows.length - 1]?.date ?? null, note: 'フォワードledgerはテール非カバーのため使用していない（ヒストリカルL3のみ使用）。' },
      momentumProduction: { config: PARAMS.momentumProductionConfig, backtestStartDateUsed: PARAMS.momentumBacktestStartDate, tradeCount: momentumRun.tradeCount, dailyRowCount: momentumRows.length, firstDate: momentumRows[0]?.date ?? null, lastDate: momentumRows[momentumRows.length - 1]?.date ?? null },
    },
    joinKeyAlignment: {
      note: 'VRPスリーブは`date`（YYYY-MM-DD）、OBS000032 L3は`date`（YYYY-MM-DD）、②momentumは equityCurveから導出した`date`（YYYY-MM-DD）。ISO日付文字列で3系列をjoin。',
      commonMatchedDays: joinedDates.length,
      commonDateRange: { start: joinedDates[0] ?? null, end: joinedDates[joinedDates.length - 1] ?? null },
      vrpDateSetSize: vrpDatesSet.size,
      missingInCarry_countBasedOnVrpDates: missingInCarry,
      missingInMomentum_countBasedOnVrpDates: missingInMomentum,
    },
    g1_a1_calmPeriodCorrelation: {
      confirmationPeriodStart: PARAMS.confirmStart,
      confirmationPeriodEnd: confirmEnd,
      n_full: confirmFiltered.length,
      n_h1: Math.floor(confirmFiltered.length / 2),
      n_h2: confirmFiltered.length - Math.floor(confirmFiltered.length / 2),
      corr_vrp_032carry: { full: corr_confirm_full_vrp_carry, abs_full: Math.abs(corr_confirm_full_vrp_carry), h1: corr_confirm_h1_vrp_carry, abs_h1: Math.abs(corr_confirm_h1_vrp_carry), h2: corr_confirm_h2_vrp_carry, abs_h2: Math.abs(corr_confirm_h2_vrp_carry) },
      corr_vrp_momentum: { full: corr_confirm_full_vrp_momentum, abs_full: Math.abs(corr_confirm_full_vrp_momentum), h1: corr_confirm_h1_vrp_momentum, abs_h1: Math.abs(corr_confirm_h1_vrp_momentum), h2: corr_confirm_h2_vrp_momentum, abs_h2: Math.abs(corr_confirm_h2_vrp_momentum) },
    },
    g1_a2_a3_tailWindows: tailWindowResults,
  };

  const outPath = join(RESULT_DIR, 'stage1-vrp-tail-correlation.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  const paramsPath = join(RESULT_DIR, 'stage1-vrp-tail-correlation-params.json');
  writeFileSync(paramsPath, JSON.stringify(PARAMS, null, 2));
  log(`>>> 保存: ${paramsPath}`);

  const runLogPath = join(RESULT_DIR, 'stage1-vrp-run.log');
  const block = [
    '='.repeat(70),
    `=== vrp-tail-correlation.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/vrp-tail-correlation.ts',
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
