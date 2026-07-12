/**
 * EXP-OBS000037 Stage 1: 予測単位 = VRP検定の lab 独立再現（必須条件B）
 * spec: research/EXP-OBS000037/00-spec-stage1.md §2, §3, §6
 *
 * 本スクリプトは判定を行わない。生数値のみを出力する（判定語禁止・spec §10）。
 * lab側スクリプト（crypto-strategy-lab/research/EXP-OBS000001/scripts/vrp-prediction-unit.ts）は
 * コピペしていない。独立に書き直したロジック（fetch/paging/bootstrap/RV計算いずれも本ファイル固有実装）。
 * Stage 0 の `probe-deribit-vrp-data.ts` のページング作法（空応答/continuation終了のみ）を流用。
 *
 * VRP定義（spec §2・ハードコード・チューニング禁止）:
 *   VRP_t = DVOL_t（日D・00:00 UTC close） − RV_forward(t, t+7d)
 *   RV_forward: 日D+1〜D+7の終値のみを使用（Dの当日足・過去足は混ぜない＝先読み排除自己点検 spec §6-3）。
 *     close(D+1)〜close(D+7) の 7 本の終値から隣接対数リターン 6 本を計算し、年率化標準偏差(ddof=1)×√365。
 *     （spec §2 原文「窓＝tの翌営業日から7本の日次リターン（すなわちD+1..D+7の終値から計算）」と
 *      spec §6-3「RV_forwardは必ず日Dより後(D+1以降)の価格のみを使う」を両立させる読み方を採用。
 *      Dの終値を混ぜると§6-3の自己点検に抵触するため、D+1..D+7の7終値のみを使用し6本のリターンを得る。
 *      この解釈をmetaに明記し、C品質チームが独立に検証できるようにする＝判定はしない。）
 * 週次非重複サンプリング（spec §2）: アンカー2021-03-24、7暦日ステップ。
 * 年率化係数（spec §2）: √365。ddof=1（標本標準偏差）。
 *
 * block-bootstrap（spec §3-1・ハードコード）: ブロック長=4週間サンプル・N=5000・seed=20260712・
 *   平均0中心化リサンプリング。固定集合の単純シャッフル（平均不変=OBS030/031 power0バグ）は使わない
 *   （リサンプリングが平均を動かせることを max|Δmean| で自己点検・生ログに記録）。
 *
 * lab仮置きコスト（spec §3-2）: 1.8 vol pt/週（往復1.5＋ヘッジ0.3）。週次ネットpayoff=(VRP_t−1.8)。
 *
 * UTCアラインメント（spec §6）: 主系列=Deribit-tradingview（08:00 UTCアンカー）由来RV。
 *   副系列=Binance CSV（00:00 UTCアンカー）由来RV。判定はR1〜R6とも主系列で行う（Cの仕事）。
 *   本スクリプトは両系列を並置出力する。
 *
 * APIキー・.env.local は読まない（Deribit publicエンドポイントは認証不要）。ETH取得禁止。
 *
 * 実行: node --experimental-strip-types scripts/vrp-prediction-unit.ts
 * 出力: research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json
 */

import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000037', '10-result');
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
// 固定パラメータ（spec本文の値でハードコード・可変にしない・グリッド探索禁止）
// ============================================================
const PARAMS = {
  anchorDate: '2021-03-24',
  weeklyStepDays: 7,
  rvForwardWindowDays: 7, // D+1..D+7 の7終値使用（6リターン）
  annualizationRv: Math.sqrt(365),
  selectionStart: '2021-03-24',
  selectionEnd: '2023-06-30',
  confirmStart: '2023-07-01',
  blockLenWeeks: 4,
  bootstrapN: 5000,
  bootstrapSeed: 20260712,
  labWeeklyCostVolPt: 1.8,
  sharpeAnnualization: Math.sqrt(52),
};

// ============================================================
// 日付ユーティリティ（UTC暦日のみ）
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

// ============================================================
// HTTP fetch（生ステータス保持）
// ============================================================
interface FetchMeta {
  status: number;
  ok: boolean;
  json: unknown | null;
  error?: string;
}
async function fetchWithMeta(url: string): Promise<FetchMeta> {
  try {
    const res = await fetch(url);
    const text = await res.text();
    let json: unknown | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, ok: res.ok, json };
  } catch (err) {
    return { status: 0, ok: false, json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================
// DVOL 日次取得（終了条件=空応答 or continuationなし のみ。length<limit終了は禁止）
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
  const MAX_REQUESTS = 60; // 安全上限（終了条件そのものではない）

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
// Deribit-tradingview 価格取得（主系列・08:00 UTC アンカー実測）
// ============================================================
interface PriceFetchResult {
  closeByDate: Map<string, number>;
  requestUrl: string;
  status: string | null;
  rawTickHourUtc: number | null;
  ticksReturned: number;
}
async function fetchDeribitPerpPriceDaily(instrument: string, floorKey: string, ceilKeyInclusive: string): Promise<PriceFetchResult> {
  const startMs = keyToMs(floorKey);
  const endMs = keyToMs(ceilKeyInclusive) + 86400000;
  const url = `${BASE}/public/get_tradingview_chart_data?instrument_name=${instrument}&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=1D`;
  log(`  GET ${url}`);
  const r = await fetchWithMeta(url);
  const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
  const status = (resultObj?.status as string | undefined) ?? null;
  const ticks = (resultObj?.ticks as number[] | undefined) ?? [];
  const closes = (resultObj?.close as number[] | undefined) ?? [];
  log(`  ${instrument} price: status=${status} ticks=${ticks.length}`);
  const closeByDate = new Map<string, number>();
  for (let i = 0; i < ticks.length; i++) closeByDate.set(dateKey(new Date(ticks[i])), closes[i]);
  const rawTickHourUtc = ticks.length > 0 ? new Date(ticks[0]).getUTCHours() : null;
  return { closeByDate, requestUrl: url, status, rawTickHourUtc, ticksReturned: ticks.length };
}

// ============================================================
// Binance CSV 価格取得（副系列・00:00 UTC アンカー既存データ）
// ============================================================
function loadBinanceCsvCloseByDate(csvPath: string): { closeByDate: Map<string, number>; rowCount: number; firstDate: string | null; lastDate: string | null } {
  const lines = readFileSync(csvPath, 'utf-8').trim().split('\n').slice(1);
  const closeByDate = new Map<string, number>();
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  for (const line of lines) {
    const parts = line.split(',');
    const date = parts[0];
    const close = parseFloat(parts[4]);
    if (!date || Number.isNaN(close)) continue;
    closeByDate.set(date, close);
    if (firstDate === null) firstDate = date;
    lastDate = date;
  }
  return { closeByDate, rowCount: closeByDate.size, firstDate, lastDate };
}

// ============================================================
// RV_forward(D, D+7d)：D+1..D+7 の7終値のみ使用（先読み排除）。6本の対数リターンの年率化std(ddof=1)。
// ============================================================
interface RvForwardResult {
  rv_annualized_pct: number | null;
  priceDatesUsed: string[];
  returnCount: number;
}
function computeRvForward(dateD: string, closeByDate: Map<string, number>, windowDays: number): RvForwardResult {
  const priceDates: string[] = [];
  const closesUsed: number[] = [];
  for (let i = 1; i <= windowDays; i++) {
    const d = addDaysKey(dateD, i);
    const c = closeByDate.get(d);
    if (c === undefined) return { rv_annualized_pct: null, priceDatesUsed: priceDates, returnCount: 0 };
    priceDates.push(d);
    closesUsed.push(c);
  }
  const logReturns: number[] = [];
  for (let i = 1; i < closesUsed.length; i++) {
    if (closesUsed[i - 1] <= 0 || closesUsed[i] <= 0) return { rv_annualized_pct: null, priceDatesUsed: priceDates, returnCount: 0 };
    logReturns.push(Math.log(closesUsed[i] / closesUsed[i - 1]));
  }
  if (logReturns.length < 2) return { rv_annualized_pct: null, priceDatesUsed: priceDates, returnCount: logReturns.length };
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1); // ddof=1
  const std = Math.sqrt(variance);
  return { rv_annualized_pct: std * PARAMS.annualizationRv * 100, priceDatesUsed: priceDates, returnCount: logReturns.length };
}

// ============================================================
// 週次VRP系列の構築（アンカー2021-03-24・7日ステップ・非重複）
// ============================================================
interface WeeklyPoint {
  date: string;
  dvol: number;
  rv_forward_pct: number | null;
  vrp: number | null;
  priceDatesUsed: string[];
  lookaheadCheckPassed: boolean; // priceDatesUsedが全てdateより後であることの自己点検
}
function buildWeeklySeries(
  anchorDate: string,
  stepDays: number,
  dvolByDate: Map<string, number>,
  closeByDate: Map<string, number>,
  windowDays: number,
): WeeklyPoint[] {
  const points: WeeklyPoint[] = [];
  let cur = anchorDate;
  const dvolDates = [...dvolByDate.keys()].sort();
  const lastDvolDate = dvolDates[dvolDates.length - 1];
  while (cur <= lastDvolDate) {
    const dvol = dvolByDate.get(cur);
    if (dvol !== undefined) {
      const rv = computeRvForward(cur, closeByDate, windowDays);
      const lookaheadCheckPassed = rv.priceDatesUsed.every(d => d > cur);
      points.push({
        date: cur,
        dvol,
        rv_forward_pct: rv.rv_annualized_pct,
        vrp: rv.rv_annualized_pct !== null ? dvol - rv.rv_annualized_pct : null,
        priceDatesUsed: rv.priceDatesUsed,
        lookaheadCheckPassed,
      });
    }
    cur = addDaysKey(cur, stepDays);
  }
  return points;
}

// ============================================================
// block-bootstrap（平均0中心化・移動ブロック・power0非再発の自己点検つき）
// 独立実装（mulberry32系の決定的擬似乱数）。lab / OBS032スクリプトのコードはコピペしない。
// ============================================================
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BootstrapResult {
  n: number;
  observedMean: number;
  pValue: number;
  maxAbsResampledMean: number; // power0自己点検: 中心化リサンプルの平均がどれだけ動くか
  blockLenWeeks: number;
  bootstrapN: number;
  seed: number;
}
function blockBootstrapPValue(series: number[], blockLenWeeks: number, N: number, seed: number): BootstrapResult {
  const n = series.length;
  if (n === 0) return { n: 0, observedMean: NaN, pValue: NaN, maxAbsResampledMean: NaN, blockLenWeeks, bootstrapN: N, seed };
  const observedMean = series.reduce((a, b) => a + b, 0) / n;
  const centered = series.map(v => v - observedMean); // 平均0中心化
  const rng = mulberry32(seed);
  let countGE = 0;
  let maxAbsResampledMean = 0;
  const maxStart = Math.max(0, n - blockLenWeeks);
  for (let iter = 0; iter < N; iter++) {
    const resample: number[] = [];
    while (resample.length < n) {
      const start = Math.floor(rng() * (maxStart + 1));
      for (let j = 0; j < blockLenWeeks && resample.length < n; j++) {
        resample.push(centered[Math.min(start + j, n - 1)]);
      }
    }
    const resampledMean = resample.reduce((a, b) => a + b, 0) / n;
    maxAbsResampledMean = Math.max(maxAbsResampledMean, Math.abs(resampledMean));
    if (resampledMean >= observedMean) countGE++;
  }
  return { n, observedMean, pValue: countGE / N, maxAbsResampledMean, blockLenWeeks, bootstrapN: N, seed };
}

// ============================================================
// 期間別集計（全期間・選定・確認）
// ============================================================
interface PeriodStat {
  period: string;
  start: string;
  end: string;
  n: number;
  meanVrp: number;
  bootstrap: BootstrapResult;
}
function statsForPeriod(points: WeeklyPoint[], period: string, start: string, end: string | null): PeriodStat {
  const filtered = points.filter(p => p.vrp !== null && p.date >= start && (end === null || p.date <= end));
  const vrpSeries = filtered.map(p => p.vrp as number);
  const bootstrap = blockBootstrapPValue(vrpSeries, PARAMS.blockLenWeeks, PARAMS.bootstrapN, PARAMS.bootstrapSeed);
  const meanVrp = vrpSeries.length > 0 ? vrpSeries.reduce((a, b) => a + b, 0) / vrpSeries.length : NaN;
  return { period, start, end: end ?? (filtered.length > 0 ? filtered[filtered.length - 1].date : ''), n: filtered.length, meanVrp, bootstrap };
}

// ============================================================
// パイプライン（lab仮置きコスト後・R5/R6）
// ============================================================
interface PipelineStat {
  n: number;
  meanWeeklyNetPayoff: number;
  stdWeeklyNetPayoff: number;
  sharpeAnnualizedSqrt52: number;
  cumulativePayoffSeries: { date: string; cumPayoff: number }[];
  maxDrawdown_volPt: number;
  maxDrawdown_pctOfPeak: number | null;
  ddPeakDate: string | null;
  ddTroughDate: string | null;
}
function pipelineStats(points: WeeklyPoint[]): PipelineStat {
  const filtered = points.filter(p => p.vrp !== null);
  const netPayoffs = filtered.map(p => (p.vrp as number) - PARAMS.labWeeklyCostVolPt);
  const n = netPayoffs.length;
  const mean = n > 0 ? netPayoffs.reduce((a, b) => a + b, 0) / n : NaN;
  const variance = n > 1 ? netPayoffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : NaN;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * PARAMS.sharpeAnnualization : NaN;

  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  let maxDDPct: number | null = null;
  let peakDate: string | null = null;
  let troughDate: string | null = null;
  let curPeakDate: string | null = null;
  const cumSeries: { date: string; cumPayoff: number }[] = [];
  for (let i = 0; i < filtered.length; i++) {
    cum += netPayoffs[i];
    cumSeries.push({ date: filtered[i].date, cumPayoff: cum });
    if (cum >= peak) {
      peak = cum;
      curPeakDate = filtered[i].date;
    }
    const dd = peak - cum;
    if (dd > maxDD) {
      maxDD = dd;
      peakDate = curPeakDate;
      troughDate = filtered[i].date;
      maxDDPct = peak > 0 ? (dd / peak) * 100 : null;
    }
  }

  return {
    n,
    meanWeeklyNetPayoff: mean,
    stdWeeklyNetPayoff: std,
    sharpeAnnualizedSqrt52: sharpe,
    cumulativePayoffSeries: cumSeries,
    maxDrawdown_volPt: maxDD,
    maxDrawdown_pctOfPeak: maxDDPct,
    ddPeakDate: peakDate,
    ddTroughDate: troughDate,
  };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 Stage 1: vrp-prediction-unit.ts ===');
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

  // ---- DVOL取得 ----
  log('\n>>> DVOL BTC 日次取得（アンカー2021-03-24〜末尾）');
  const dvolFetch = await fetchDvolDaily('BTC', PARAMS.anchorDate, todayKey);
  const dvolByDate = new Map(dvolFetch.rows.map(r => [r.date, r.close]));
  log(`  DVOL総取得件数=${dvolFetch.rows.length} 最古=${dvolFetch.rows[0]?.date} 最新=${dvolFetch.rows[dvolFetch.rows.length - 1]?.date}`);

  // ---- 主系列価格取得（Deribit-tradingview・08:00 UTC実測） ----
  log('\n>>> 主系列価格取得（Deribit-tradingview BTC-PERPETUAL）');
  const mainPrice = await fetchDeribitPerpPriceDaily('BTC-PERPETUAL', PARAMS.anchorDate, todayKey);
  log(`  主系列: ticksReturned=${mainPrice.ticksReturned} rawTickHourUtc=${mainPrice.rawTickHourUtc} status=${mainPrice.status}`);

  // ---- 副系列価格取得（Binance CSV・00:00 UTC） ----
  log('\n>>> 副系列価格取得（Binance CSV btc-daily-binance-2017-2026.csv）');
  const csvPath = join(DATA_DIR, 'btc-daily-binance-2017-2026.csv');
  const secondaryPrice = loadBinanceCsvCloseByDate(csvPath);
  log(`  副系列: rowCount=${secondaryPrice.rowCount} firstDate=${secondaryPrice.firstDate} lastDate=${secondaryPrice.lastDate}`);

  // ---- 週次VRP系列構築（主・副） ----
  log('\n>>> 週次VRP系列構築（主系列）');
  const mainWeekly = buildWeeklySeries(PARAMS.anchorDate, PARAMS.weeklyStepDays, dvolByDate, mainPrice.closeByDate, PARAMS.rvForwardWindowDays);
  log(`  主系列: 週次候補点数=${mainWeekly.length} VRP構築可能点数=${mainWeekly.filter(p => p.vrp !== null).length}`);

  log('\n>>> 週次VRP系列構築（副系列）');
  const secondaryWeekly = buildWeeklySeries(PARAMS.anchorDate, PARAMS.weeklyStepDays, dvolByDate, secondaryPrice.closeByDate, PARAMS.rvForwardWindowDays);
  log(`  副系列: 週次候補点数=${secondaryWeekly.length} VRP構築可能点数=${secondaryWeekly.filter(p => p.vrp !== null).length}`);

  // ---- 先読み排除の自己点検 ----
  const mainLookaheadViolations = mainWeekly.filter(p => p.vrp !== null && !p.lookaheadCheckPassed);
  const secondaryLookaheadViolations = secondaryWeekly.filter(p => p.vrp !== null && !p.lookaheadCheckPassed);
  log(`\n>>> 先読み排除自己点検: 主系列違反件数=${mainLookaheadViolations.length} 副系列違反件数=${secondaryLookaheadViolations.length}`);

  // ---- R1〜R4: 期間別統計（主・副） ----
  function periodStatsForSeries(points: WeeklyPoint[]) {
    return {
      full: statsForPeriod(points, 'full', PARAMS.anchorDate, null),
      selection: statsForPeriod(points, 'selection', PARAMS.selectionStart, PARAMS.selectionEnd),
      confirmation: statsForPeriod(points, 'confirmation', PARAMS.confirmStart, null),
    };
  }
  log('\n>>> R1〜R4: 期間別統計計算（主系列）');
  const mainPeriodStats = periodStatsForSeries(mainWeekly);
  log(`  full: n=${mainPeriodStats.full.n} mean=${mainPeriodStats.full.meanVrp.toFixed(4)} p=${mainPeriodStats.full.bootstrap.pValue} max|Δmean|=${mainPeriodStats.full.bootstrap.maxAbsResampledMean.toFixed(4)}`);
  log(`  selection: n=${mainPeriodStats.selection.n} mean=${mainPeriodStats.selection.meanVrp.toFixed(4)} p=${mainPeriodStats.selection.bootstrap.pValue}`);
  log(`  confirmation: n=${mainPeriodStats.confirmation.n} mean=${mainPeriodStats.confirmation.meanVrp.toFixed(4)} p=${mainPeriodStats.confirmation.bootstrap.pValue}`);

  log('\n>>> R1〜R4: 期間別統計計算（副系列）');
  const secondaryPeriodStats = periodStatsForSeries(secondaryWeekly);
  log(`  full: n=${secondaryPeriodStats.full.n} mean=${secondaryPeriodStats.full.meanVrp.toFixed(4)} p=${secondaryPeriodStats.full.bootstrap.pValue}`);
  log(`  selection: n=${secondaryPeriodStats.selection.n} mean=${secondaryPeriodStats.selection.meanVrp.toFixed(4)} p=${secondaryPeriodStats.selection.bootstrap.pValue}`);
  log(`  confirmation: n=${secondaryPeriodStats.confirmation.n} mean=${secondaryPeriodStats.confirmation.meanVrp.toFixed(4)} p=${secondaryPeriodStats.confirmation.bootstrap.pValue}`);

  // ---- R5〜R6: パイプライン統計（主・副） ----
  log('\n>>> R5〜R6: パイプライン統計（lab仮置きコスト1.8 vol pt/週）');
  const mainPipeline = pipelineStats(mainWeekly);
  const secondaryPipeline = pipelineStats(secondaryWeekly);
  log(`  主系列: n=${mainPipeline.n} meanNet=${mainPipeline.meanWeeklyNetPayoff.toFixed(4)} sharpe(√52)=${mainPipeline.sharpeAnnualizedSqrt52.toFixed(4)} maxDD_volPt=${mainPipeline.maxDrawdown_volPt.toFixed(4)} maxDD_pct=${mainPipeline.maxDrawdown_pctOfPeak?.toFixed(4)}`);
  log(`  副系列: n=${secondaryPipeline.n} meanNet=${secondaryPipeline.meanWeeklyNetPayoff.toFixed(4)} sharpe(√52)=${secondaryPipeline.sharpeAnnualizedSqrt52.toFixed(4)} maxDD_volPt=${secondaryPipeline.maxDrawdown_volPt.toFixed(4)} maxDD_pct=${secondaryPipeline.maxDrawdown_pctOfPeak?.toFixed(4)}`);

  // ---- 主副差分（条件D・情報開示） ----
  const mainVsSecondaryDiff = {
    fullPeriodMeanVrpDiff: mainPeriodStats.full.meanVrp - secondaryPeriodStats.full.meanVrp,
    fullPeriodPValueDiff: mainPeriodStats.full.bootstrap.pValue - secondaryPeriodStats.full.bootstrap.pValue,
    sharpeDiff: mainPipeline.sharpeAnnualizedSqrt52 - secondaryPipeline.sharpeAnnualizedSqrt52,
    maxDDVolPtDiff: mainPipeline.maxDrawdown_volPt - secondaryPipeline.maxDrawdown_volPt,
  };

  const output = {
    experiment: 'EXP-OBS000037',
    stage: 'Stage 1',
    scriptPath: 'scripts/vrp-prediction-unit.ts',
    specReference: 'research/EXP-OBS000037/00-spec-stage1.md',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    scope: { assets: ['BTC'], note: 'ETH取得禁止（spec §4固定）' },
    params: PARAMS,
    methodologyNote: {
      rvForwardDefinition:
        'RV_forward(D,D+7d)はD+1..D+7の7終値のみを使用し6本の隣接対数リターンの年率化標準偏差(ddof=1)×√365で算出。' +
        'Dの当日終値は使用しない（spec §6-3「D+1以降の価格のみ」の自己点検を優先し、spec §2「7本の日次リターン」の記述は' +
        'D+1..D+7の7終値使用と解釈）。',
      vrpDefinition: 'VRP_t = DVOL_t(日D・00:00 UTC close) − RV_forward(t,t+7d)。',
      weeklySampling: `アンカー${PARAMS.anchorDate}から${PARAMS.weeklyStepDays}暦日ステップの非重複週次サンプル。系列は最後にRV_forwardが構築可能な週次点で打ち切り。`,
    },
    dataSources: {
      dvol: {
        endpoint: `${BASE}/public/get_volatility_index_data?currency=BTC&resolution=86400`,
        totalRows: dvolFetch.rows.length,
        firstDate: dvolFetch.rows[0]?.date ?? null,
        lastDate: dvolFetch.rows[dvolFetch.rows.length - 1]?.date ?? null,
        pageLog: dvolFetch.pageLog,
        pagingPolicyNote: '終了条件は空応答またはcontinuation null/undefinedのみ。「返却件数<limit終了」は使用していない。',
      },
      mainPriceSeries: {
        source: 'deribit-tradingview',
        instrument: 'BTC-PERPETUAL',
        requestUrl: mainPrice.requestUrl,
        ticksReturned: mainPrice.ticksReturned,
        rawTickHourUtc: mainPrice.rawTickHourUtc,
        status: mainPrice.status,
      },
      secondaryPriceSeries: {
        source: 'binance-csv',
        csvPath: 'scripts/data/btc-daily-binance-2017-2026.csv',
        rowCount: secondaryPrice.rowCount,
        firstDate: secondaryPrice.firstDate,
        lastDate: secondaryPrice.lastDate,
      },
    },
    lookaheadSelfCheck: {
      mainSeriesViolations: mainLookaheadViolations.length,
      secondarySeriesViolations: secondaryLookaheadViolations.length,
      note: '各週次点のRV_forward計算に使用した価格日付(priceDatesUsed)が全てその週次点の日付より後(D+1以降)であることを確認。違反件数0が期待値。',
    },
    mainSeries: {
      label: 'Deribit-tradingview(08:00 UTC) 由来RV — R1〜R6の判定に使う系列（spec §6-1）',
      weeklyPoints: mainWeekly,
      periodStats: mainPeriodStats,
      pipelineStats: mainPipeline,
    },
    secondarySeries: {
      label: 'Binance CSV(00:00 UTC) 由来RV — ロバストネス副系列（spec §6-2・情報開示のみ）',
      weeklyPoints: secondaryWeekly,
      periodStats: secondaryPeriodStats,
      pipelineStats: secondaryPipeline,
    },
    mainVsSecondaryDiff,
    labReferenceValues_notReproductionJudgment: {
      note: '以下はspec §1のlab結論の引用（本スクリプトはこれらとの当てはめ判定=R1〜R6の合否は行わない。判定はC品質チーム）。',
      meanVrp_fullPeriod_volPt: 10.91,
      bootstrapP_fullPeriod: 0,
      n_weeks: 275,
      meanVrp_selection_volPt: 15.07,
      meanVrp_confirmation_volPt: 7.79,
      sharpeAnnualized_labCost: 2.94,
      maxDrawdown_pct: 9.7,
    },
  };

  const outPath = join(RESULT_DIR, 'stage1-vrp-prediction-unit.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  // params.json（バージョン管理用）
  const paramsPath = join(RESULT_DIR, 'stage1-vrp-prediction-unit-params.json');
  writeFileSync(paramsPath, JSON.stringify(PARAMS, null, 2));
  log(`>>> 保存: ${paramsPath}`);

  // run.log 追記
  const runLogPath = join(RESULT_DIR, 'stage1-vrp-run.log');
  const block = [
    '='.repeat(70),
    `=== vrp-prediction-unit.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/vrp-prediction-unit.ts',
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
