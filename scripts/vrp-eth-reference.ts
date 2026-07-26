/**
 * EXP-OBS000037 ETH参考値（一回限りの探索的計算・非ゲート）
 * 依頼背景: 司令塔よりBTC VRPの実運用最小資本（$44,694相当・0.1枚単位）が
 *   小口では現実的でないとの指摘を受け、「過去分の検証データを一度だけ取得・評価」を依頼された。
 *
 * ⚠ 本スクリプトはOBS000037（BTC）の一部ではない。spec §4/§8-2固定の「ETH取得禁止」は
 *   BTC実験（Stage 1/2・本番反映ライン）に対する制約であり、本スクリプトはそれとは別の
 *   新規・独立した一回限りの探索的計算として実装している（BTCのspec・出力ファイルは一切変更しない）。
 * ⚠ 本スクリプトは判定を行わない（採用/不採用の宣言はしない）。生数値のみを出力する。
 * ⚠ ライブ較正ではない。90日蓄積・F1〜F4ゲート・C品質チーム監査は対象外。
 *   1回の実行で「過去分」のみを構築し、フォワード蓄積は行わない（back-fill的に90日を
 *   偽装しない＝ledger形式やlive/warmupフラグを持たせず、探索的所見として明確に区別する）。
 *
 * 手法はBTC版（vrp-prediction-unit.ts・vrp-pipeline-accounting.ts）と同一の定義を踏襲する
 * （RV窓長D+1..D+8の8終値・7リターン・√365年率化・週次非重複サンプリング・block-bootstrap・
 *   代表満期=残存≥7日・ATM=|delta|∈[0.35,0.65]・実測コスト式）。BTCで一度是正されたRV窓長
 *   バグ（6リターン→7リターンで結論が1.7 vol pt動いた経緯）を踏まえ、同一の是正済み定義を使う。
 * lab/BTCスクリプトのコピペではなく、通貨をETHに差し替えた独立実装。
 *
 * 実行: node --experimental-strip-types scripts/vrp-eth-reference.ts
 * 出力: research/EXP-OBS000037/10-result/eth-reference-vrp.json
 *       research/EXP-OBS000037/10-result/eth-reference-run.log
 */

import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000037', '10-result');
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
// 固定パラメータ（BTC版spec §2/§3の定義をそのまま踏襲・ETH向けにチューニングしない）
// ============================================================
const PARAMS = {
  // DVOL取得開始日はETHの実際の取得可能開始日に合わせる（後段でdvolFetch.rows[0]?.dateを実測記録）。
  // アンカーは「取得できた最初のDVOL日」を動的に採用する（BTCのように2021-03-24を決め打ちしない＝
  // ETH DVOLの提供開始時期がBTCと異なる可能性があるため。実測値をmetaに記録する）。
  weeklyStepDays: 7,
  rvForwardReturnCount: 7, // D+1..D+8の8終値→7リターン（BTC是正版と同一定義）
  annualizationRv: Math.sqrt(365),
  blockLenWeeks: 4,
  bootstrapN: 5000,
  bootstrapSeed: 20260713, // BTC版のseedと区別する専用seed（別計算であることを明示）
  labWeeklyCostVolPt: 1.8, // 参考比較用（lab仮置き）
  sharpeAnnualization: Math.sqrt(52),
  minResidualDaysForRepresentativeMaturity: 7,
  atmDeltaRange: [0.35, 0.65] as [number, number],
  optionTakerCommissionRate: 0.0003,
  optionPremiumCapRate: 0.125,
  perpTakerCommissionRate: 0.0005,
  realSpreadBps: 0.0784, // BTC Stage 0実測値を暫定流用（ETH固有の実測ではない・meta.noteに明記）
  slippageBps: 0.0392,   // 同上
  hedgeRebalancesPerWeek: 7,
  cvarTailFraction: 0.05,
  weeklyRiskBudget: 0.02,
  fFraction: 0.5,
  minOrderSizeContracts: 0.1, // Deribitオプション最小発注単位（BTC同様と仮定・meta.noteに明記）
};

// ============================================================
// 日付ユーティリティ
// ============================================================
function dateKey(d: Date): string { return d.toISOString().slice(0, 10); }
function keyToMs(key: string): number { return Date.parse(`${key}T00:00:00.000Z`); }
function addDaysKey(key: string, n: number): string { return dateKey(new Date(keyToMs(key) + n * 86400000)); }

async function fetchWithMeta(url: string): Promise<{ status: number; json: unknown | null; error?: string }> {
  try {
    const res = await fetch(url);
    const text = await res.text();
    let json: unknown | null = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================
// DVOL(ETH) 日次取得（BTC版と同一のページング作法: 空応答/continuationなしのみで終了）
// ============================================================
interface DvolRow { date: string; timestampMs: number; close: number }
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
    if (!Array.isArray(data) || data.length === 0) { pageLog.push('終了理由: empty_response'); break; }
    for (const d of data) rows.push({ timestampMs: d[0], date: dateKey(new Date(d[0])), close: d[4] });
    if (continuation === null || continuation === undefined) { pageLog.push('終了理由: continuation_null_or_absent'); break; }
    endMs = continuation as number;
    await sleep(250);
  }
  const map = new Map<number, DvolRow>();
  for (const row of rows) map.set(row.timestampMs, row);
  const sorted = [...map.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  return { rows: sorted, pageLog };
}

// ============================================================
// ETH-PERPETUAL 日次価格取得
// ============================================================
async function fetchPerpPriceDaily(instrument: string, floorKey: string, ceilKeyInclusive: string): Promise<{ closeByDate: Map<string, number>; requestUrl: string; status: string | null; ticksReturned: number }> {
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
  return { closeByDate, requestUrl: url, status, ticksReturned: ticks.length };
}

// ============================================================
// RV_forward: D+1..D+8の8終値→7リターン→年率化std(ddof=1)（BTC是正版と同一定義）
// ============================================================
function computeRvForward(dateD: string, closeByDate: Map<string, number>, targetReturnCount: number): { rv: number | null; priceDatesUsed: string[] } {
  const priceDates: string[] = [];
  const closes: number[] = [];
  const need = targetReturnCount + 1;
  for (let i = 1; i <= need; i++) {
    const d = addDaysKey(dateD, i);
    const c = closeByDate.get(d);
    if (c === undefined) return { rv: null, priceDatesUsed: priceDates };
    priceDates.push(d);
    closes.push(c);
  }
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] <= 0 || closes[i] <= 0) return { rv: null, priceDatesUsed: priceDates };
    logReturns.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (logReturns.length < 2) return { rv: null, priceDatesUsed: priceDates };
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  return { rv: Math.sqrt(variance) * PARAMS.annualizationRv * 100, priceDatesUsed: priceDates };
}

interface WeeklyPoint { date: string; dvol: number; rv_forward_pct: number | null; vrp: number | null; lookaheadCheckPassed: boolean }
function buildWeeklySeries(anchorDate: string, dvolByDate: Map<string, number>, closeByDate: Map<string, number>): WeeklyPoint[] {
  const points: WeeklyPoint[] = [];
  let cur = anchorDate;
  const dvolDates = [...dvolByDate.keys()].sort();
  const lastDvolDate = dvolDates[dvolDates.length - 1];
  while (cur <= lastDvolDate) {
    const dvol = dvolByDate.get(cur);
    if (dvol !== undefined) {
      const rv = computeRvForward(cur, closeByDate, PARAMS.rvForwardReturnCount);
      points.push({
        date: cur, dvol, rv_forward_pct: rv.rv, vrp: rv.rv !== null ? dvol - rv.rv : null,
        lookaheadCheckPassed: rv.priceDatesUsed.every(d => d > cur),
      });
    }
    cur = addDaysKey(cur, PARAMS.weeklyStepDays);
  }
  return points;
}

// ============================================================
// block-bootstrap（BTC版と同一アルゴリズム・専用seed）
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
function blockBootstrapPValue(series: number[], blockLenWeeks: number, N: number, seed: number) {
  const n = series.length;
  if (n === 0) return { n: 0, observedMean: NaN, pValue: NaN, maxAbsResampledMean: NaN };
  const observedMean = series.reduce((a, b) => a + b, 0) / n;
  const centered = series.map(v => v - observedMean);
  const rng = mulberry32(seed);
  let countGE = 0;
  let maxAbsResampledMean = 0;
  const maxStart = Math.max(0, n - blockLenWeeks);
  for (let iter = 0; iter < N; iter++) {
    const resample: number[] = [];
    while (resample.length < n) {
      const start = Math.floor(rng() * (maxStart + 1));
      for (let j = 0; j < blockLenWeeks && resample.length < n; j++) resample.push(centered[Math.min(start + j, n - 1)]);
    }
    const resampledMean = resample.reduce((a, b) => a + b, 0) / n;
    maxAbsResampledMean = Math.max(maxAbsResampledMean, Math.abs(resampledMean));
    if (resampledMean >= observedMean) countGE++;
  }
  return { n, observedMean, pValue: countGE / N, maxAbsResampledMean };
}

// ============================================================
// ATM ストラドル選定（ETH・BTC版vrp-pipeline-accounting.tsと同一ロジック・通貨のみ差替え）
// ============================================================
interface OptionInstrument { instrument_name: string; expiration_timestamp: number; strike: number; option_type: 'call' | 'put' }
async function fetchOptionInstruments(currency: string): Promise<OptionInstrument[]> {
  const url = `${BASE}/public/get_instruments?currency=${currency}&kind=option&expired=false`;
  const r = await fetchWithMeta(url);
  const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result : undefined;
  return (resultObj as OptionInstrument[] | undefined) ?? [];
}
interface TickerGreeks { delta: number; gamma: number; vega: number; theta: number }
interface TickerSnapshot { instrumentName: string; indexPrice: number; markPrice: number; bestBid: number; bestAsk: number; greeks: TickerGreeks }
async function fetchTicker(instrumentName: string): Promise<TickerSnapshot | null> {
  const url = `${BASE}/public/ticker?instrument_name=${instrumentName}`;
  const r = await fetchWithMeta(url);
  const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
  if (!resultObj) return null;
  const greeks = resultObj.greeks as Record<string, number> | undefined;
  if (!greeks) return null;
  return {
    instrumentName, indexPrice: resultObj.index_price as number, markPrice: resultObj.mark_price as number,
    bestBid: resultObj.best_bid_price as number, bestAsk: resultObj.best_ask_price as number,
    greeks: { delta: greeks.delta, gamma: greeks.gamma, vega: greeks.vega, theta: greeks.theta },
  };
}
function instrumentNameFor(currency: string, expiryMs: number, strike: number, cp: 'C' | 'P'): string {
  const dt = new Date(expiryMs);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][dt.getUTCMonth()];
  const yy = String(dt.getUTCFullYear()).slice(2);
  return `${currency}-${dd}${mon}${yy}-${strike}-${cp}`;
}
async function selectRepresentativeMaturityAndAtm(currency: string, nowMs: number) {
  const instruments = await fetchOptionInstruments(currency);
  log(`  ${currency} option instruments fetched: count=${instruments.length}`);
  const expiries = [...new Set(instruments.map(i => i.expiration_timestamp))].sort((a, b) => a - b);
  const residuals = expiries.map(e => ({ e, days: (e - nowMs) / 86400000 }));
  const chosen = residuals.find(r => r.days >= PARAMS.minResidualDaysForRepresentativeMaturity);
  if (!chosen) throw new Error(`${currency}: 代表満期（残存>=7日）が見つからない`);
  const expiryTimestamp = chosen.e;
  const callStrikes = instruments.filter(i => i.expiration_timestamp === expiryTimestamp && i.option_type === 'call').map(i => i.strike).sort((a, b) => a - b);
  log(`  代表満期選定: expiry=${new Date(expiryTimestamp).toISOString()} residualDays=${chosen.days.toFixed(4)} candidateStrikes=${callStrikes.length}`);

  const candidates: { strike: number; delta: number; indexPrice: number; ticker: TickerSnapshot }[] = [];
  const candidateLog: { strike: number; delta: number; instrumentName: string }[] = [];
  for (const strike of callStrikes) {
    const instrumentName = instrumentNameFor(currency, expiryTimestamp, strike, 'C');
    const t = await fetchTicker(instrumentName);
    await sleep(150);
    if (!t) continue;
    candidateLog.push({ strike, delta: t.greeks.delta, instrumentName });
    if (t.greeks.delta >= PARAMS.atmDeltaRange[0] && t.greeks.delta <= PARAMS.atmDeltaRange[1]) {
      candidates.push({ strike, delta: t.greeks.delta, indexPrice: t.indexPrice, ticker: t });
    }
  }
  if (candidates.length === 0) throw new Error(`${currency}: ATM候補（|delta|∈[0.35,0.65]）が見つからない`);
  candidates.sort((a, b) => Math.abs(a.strike - a.indexPrice) - Math.abs(b.strike - b.indexPrice));
  const best = candidates[0];
  log(`  ATM選定: strike=${best.strike} delta=${best.delta} indexPrice=${best.indexPrice}`);
  const putInstrumentName = instrumentNameFor(currency, expiryTimestamp, best.strike, 'P');
  const putTicker = await fetchTicker(putInstrumentName);
  if (!putTicker) throw new Error(`put ticker取得失敗: ${putInstrumentName}`);
  return { expiryTimestamp, residualDays: chosen.days, strike: best.strike, indexPriceAtSelection: best.indexPrice, callTicker: best.ticker, putTicker, candidateLog };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 ETH参考値（一回限り・非ゲート・探索的） ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  let gitCommit = 'unknown';
  try { gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim(); } catch { /* ignore */ }
  log(`Git commit: ${gitCommit} / Node ${process.version}`);

  const todayKey = dateKey(new Date());
  const nowMs = Date.now();

  // ---- DVOL(ETH) 取得: 開始日は決め打ちせず取得できた最古日を採用 ----
  log('\n>>> DVOL ETH 日次取得（取得可能な最古日〜末尾）');
  // ETH DVOLの提供開始時期は事前に判明していないため、BTCと同じ2021-03-24を起点候補にし、
  // 実際に返ってきた最古行の日付を正式なアンカーとして扱う（決め打ちしない）。
  const PROBE_FLOOR = '2019-01-01';
  const dvolFetch = await fetchDvolDaily('ETH', PROBE_FLOOR, todayKey);
  if (dvolFetch.rows.length === 0) throw new Error('ETH DVOL: 1件も取得できなかった（データ提供なしの可能性）');
  const dvolByDate = new Map(dvolFetch.rows.map(r => [r.date, r.close]));
  const anchorDate = dvolFetch.rows[0].date;
  log(`  DVOL総取得件数=${dvolFetch.rows.length} 実測アンカー(最古)=${anchorDate} 最新=${dvolFetch.rows[dvolFetch.rows.length - 1].date}`);

  // ---- ETH-PERPETUAL 価格取得 ----
  log('\n>>> ETH-PERPETUAL 日次価格取得');
  const price = await fetchPerpPriceDaily('ETH-PERPETUAL', anchorDate, todayKey);
  log(`  ticksReturned=${price.ticksReturned} status=${price.status}`);

  // ---- 週次VRP系列構築 ----
  log('\n>>> 週次VRP系列構築');
  const weekly = buildWeeklySeries(anchorDate, dvolByDate, price.closeByDate);
  const settled = weekly.filter(p => p.vrp !== null);
  log(`  週次候補点数=${weekly.length} VRP構築可能点数=${settled.length}`);

  const lookaheadViolations = settled.filter(p => !p.lookaheadCheckPassed).length;
  log(`  先読み排除自己点検: 違反件数=${lookaheadViolations}`);

  // ---- 期間統計（全期間のみ。選定/確認分割はBTC specの日付をそのまま転用しない=ETH固有の分割は未設計のため全期間集計に留める） ----
  const vrpSeries = settled.map(p => p.vrp as number);
  const bootstrap = blockBootstrapPValue(vrpSeries, PARAMS.blockLenWeeks, PARAMS.bootstrapN, PARAMS.bootstrapSeed);
  const meanVrp = vrpSeries.length > 0 ? vrpSeries.reduce((a, b) => a + b, 0) / vrpSeries.length : NaN;
  const positiveWeeks = vrpSeries.filter(v => v > 0).length;
  log(`\n>>> 全期間統計: n=${settled.length} meanVRP=${meanVrp.toFixed(4)} p=${bootstrap.pValue} positiveWeekRatio=${((positiveWeeks / settled.length) * 100).toFixed(1)}%`);

  // 年別集計
  const byYear = new Map<string, number[]>();
  for (const p of settled) {
    const y = p.date.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(p.vrp as number);
  }
  const yearlyStats = [...byYear.entries()].sort().map(([year, arr]) => ({
    year, n: arr.length,
    meanVrp: arr.reduce((a, b) => a + b, 0) / arr.length,
    positiveWeekRatioPct: (arr.filter(v => v > 0).length / arr.length) * 100,
  }));

  // lab仮置きコスト後の簡易パイプライン（BTCとの比較用のみ・判定なし）
  const netPayoffsLabCost = vrpSeries.map(v => v - PARAMS.labWeeklyCostVolPt);
  const meanNetLabCost = netPayoffsLabCost.reduce((a, b) => a + b, 0) / netPayoffsLabCost.length;
  const stdNetLabCost = Math.sqrt(netPayoffsLabCost.reduce((a, b) => a + (b - meanNetLabCost) ** 2, 0) / (netPayoffsLabCost.length - 1));
  const sharpeLabCost = (meanNetLabCost / stdNetLabCost) * PARAMS.sharpeAnnualization;

  // ---- ATM ストラドル経済性スナップショット（実測・粒度検証の本丸） ----
  log('\n>>> ETH ATM ストラドル経済性スナップショット（ライブ取得）');
  const atm = await selectRepresentativeMaturityAndAtm('ETH', nowMs);
  const call = atm.callTicker, put = atm.putTicker;
  const callPremiumUsd = call.markPrice * atm.indexPriceAtSelection;
  const putPremiumUsd = put.markPrice * atm.indexPriceAtSelection;
  const callFeeUsd = Math.min(PARAMS.optionTakerCommissionRate * atm.indexPriceAtSelection, PARAMS.optionPremiumCapRate * callPremiumUsd);
  const putFeeUsd = Math.min(PARAMS.optionTakerCommissionRate * atm.indexPriceAtSelection, PARAMS.optionPremiumCapRate * putPremiumUsd);
  const callHalfSpreadUsd = 0.5 * (call.bestAsk - call.bestBid) * atm.indexPriceAtSelection;
  const putHalfSpreadUsd = 0.5 * (put.bestAsk - put.bestBid) * atm.indexPriceAtSelection;
  const perRoundCostUsd = (callFeeUsd + callHalfSpreadUsd) + (putFeeUsd + putHalfSpreadUsd);
  const C_options_usdTotal = perRoundCostUsd * 2; // entry+exit
  const vegaTotalUsdPerVolPt = call.greeks.vega + put.greeks.vega;
  const C_options_volpt = C_options_usdTotal / vegaTotalUsdPerVolPt;
  // C_hedgeはgamma簡易推定（BTC版と同様の近似・厳密な日次リバランスシムではない＝参考値の限界としてnoteに明記）
  const perpHedgeCostRate = PARAMS.perpTakerCommissionRate + PARAMS.realSpreadBps / 10000 + PARAMS.slippageBps / 10000;
  const gammaTotal = call.greeks.gamma + put.greeks.gamma;
  log(`  vega(2脚合計)=${vegaTotalUsdPerVolPt.toFixed(4)} USD/vol pt / premium(2脚合計)=${(callPremiumUsd + putPremiumUsd).toFixed(2)} USD / C_options=${C_options_volpt.toFixed(4)} vol pt`);

  // 必要資本（BTC specと同一のCVaRベース定式・ETH自身の週次ネット分布から算出）
  const netPayoffsForCvar = vrpSeries.map(v => v - C_options_volpt).sort((a, b) => a - b);
  const tailCount = Math.max(1, Math.round(netPayoffsForCvar.length * PARAMS.cvarTailFraction));
  const tailSlice = netPayoffsForCvar.slice(0, tailCount);
  const esValueVolPt = tailSlice.reduce((a, b) => a + b, 0) / tailSlice.length; // 下側5%平均（符号そのまま・通常負）
  const absCvarVolPt = Math.abs(esValueVolPt);
  const vegaNotionalPct = PARAMS.fFraction * (PARAMS.weeklyRiskBudget / absCvarVolPt);
  const requiredCapitalFullStraddleUsd = vegaTotalUsdPerVolPt / vegaNotionalPct;
  const requiredCapitalMinOrderUsd = (vegaTotalUsdPerVolPt * PARAMS.minOrderSizeContracts) / vegaNotionalPct;
  log(`  CVaR(下側5%平均)=${absCvarVolPt.toFixed(4)} vol pt → vegaNotionalPct=${(vegaNotionalPct * 100).toFixed(6)}% → 必要資本(フル1組)=$${requiredCapitalFullStraddleUsd.toFixed(0)} / 必要資本(最小${PARAMS.minOrderSizeContracts}枚)=$${requiredCapitalMinOrderUsd.toFixed(0)}`);

  const output = {
    experiment: 'EXP-OBS000037-ETH-REFERENCE',
    positioning: '一回限りの探索的参考値。OBS000037（BTC）本番実験のリスコープ外・非ゲート・C品質チーム監査対象外。' +
      '90日フォワード較正は行っていない（ライブ蓄積なし）。採用/不採用の判定はしない。',
    scriptPath: 'scripts/vrp-eth-reference.ts',
    executedBy: 'B実装チーム (Quant Researcher) — 司令塔直接依頼による一回限りの探索的実行',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    params: PARAMS,
    dataSources: {
      dvol: {
        currency: 'ETH',
        endpoint: `${BASE}/public/get_volatility_index_data?currency=ETH&resolution=86400`,
        totalRows: dvolFetch.rows.length,
        anchorDate_firstAvailable: anchorDate,
        lastDate: dvolFetch.rows[dvolFetch.rows.length - 1].date,
        note: 'アンカー日はETH DVOLの実際の取得可能開始日（決め打ちではなく実測）。BTCの2021-03-24とは異なる場合がある。',
      },
      priceSeries: { instrument: 'ETH-PERPETUAL', source: 'deribit-tradingview', ticksReturned: price.ticksReturned, status: price.status },
    },
    lookaheadSelfCheck: { violations: lookaheadViolations, note: '違反件数0が期待値（BTC版と同一の自己点検）' },
    weeklySeries: weekly,
    fullPeriodStats: { n: settled.length, meanVrp, bootstrapPValue: bootstrap.pValue, maxAbsResampledMean: bootstrap.maxAbsResampledMean, positiveWeekRatioPct: (positiveWeeks / settled.length) * 100 },
    yearlyStats,
    labCostComparison: {
      note: 'lab仮置き1.8 vol pt/週控除後（BTC版との比較可能性のためのみ算出・実測コストは下記atmEconomicsSnapshotのC_options_volptを使用すべき）',
      meanWeeklyNetPayoff: meanNetLabCost, stdWeeklyNetPayoff: stdNetLabCost, sharpeAnnualizedSqrt52: sharpeLabCost,
    },
    atmEconomicsSnapshot: {
      note: '現時点(runTimestampUTC)の1スナップショット。過去のvega/premiumは取得不可のため全期間には適用していない（BTC版と同一の限界）。' +
        'C_hedgeはgamma簡易推定のみ（日次リバランスの厳密シミュレーションではない）。realSpreadBps/slippageBpsはBTC Stage 0実測値を暫定使用（ETH実測ではない）。',
      selectedExpiryIso: new Date(atm.expiryTimestamp).toISOString(),
      residualDaysAtSelection: atm.residualDays,
      selectedStrike: atm.strike,
      indexPriceAtSelection: atm.indexPriceAtSelection,
      call: { instrumentName: call.instrumentName, markPrice: call.markPrice, bestBid: call.bestBid, bestAsk: call.bestAsk, greeks: call.greeks },
      put: { instrumentName: put.instrumentName, markPrice: put.markPrice, bestBid: put.bestBid, bestAsk: put.bestAsk, greeks: put.greeks },
      vegaTotalUsdPerVolPt,
      premiumTotalUsd: callPremiumUsd + putPremiumUsd,
      C_options_volpt,
      C_options_detail: { callPremiumUsd, putPremiumUsd, callFeeUsd, putFeeUsd, callHalfSpreadUsd, putHalfSpreadUsd, perRoundCostUsd },
      perpHedgeCostRateFraction: perpHedgeCostRate,
      gammaTotal,
      cvarSizing: {
        absCvarVolPt, tailCount, populationN: netPayoffsForCvar.length,
        weeklyRiskBudget: PARAMS.weeklyRiskBudget, fFraction: PARAMS.fFraction,
        vegaNotionalPct,
      },
      requiredCapitalUsd: {
        fullStraddle1Lot: requiredCapitalFullStraddleUsd,
        minOrderSize: requiredCapitalMinOrderUsd,
        minOrderSizeContracts: PARAMS.minOrderSizeContracts,
      },
    },
    btcComparisonNote: 'BTC本番値（stage2-vrp-pipeline-accounting.json）: vega≈89.76 USD/vol pt, 必要資本(最小0.1枚)≈$44,694。' +
      '本ファイルのETH実測値と直接比較できる（プロキシ推定ではなく両方とも実測スナップショット）。',
  };

  const outPath = join(RESULT_DIR, 'eth-reference-vrp.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  const runLogPath = join(RESULT_DIR, 'eth-reference-run.log');
  appendFileSync(runLogPath, [
    '='.repeat(70),
    `=== vrp-eth-reference.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`, `Node version: ${process.version}`, '',
    'REPRODUCTION COMMAND:', '  node --experimental-strip-types scripts/vrp-eth-reference.ts', '',
    'EXECUTION LOG:', ...executionLog, '',
  ].join('\n'));
  log(`>>> 保存: ${runLogPath}`);
  log('\n=== 実行完了（一回限り・非ゲート） ===');
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
