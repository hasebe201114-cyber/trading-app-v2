/**
 * EXP-OBS000041 Stage 0: G0-C0（BTC回帰再現）〜G0-C4（依存性開示）
 * spec: research/EXP-OBS000041/00-spec-stage0.md §2, §3-3〜§3-7, §5-2
 *
 * 本スクリプトは判定を行わない（判定語禁止・spec §9-10）。実測値・実レスポンス・生ログのみを出力する。
 * 独立実装。`scripts/vrp-eth-reference.ts`／`scripts/vrp-prediction-unit.ts`／`scripts/vrp-pipeline-accounting.ts`／
 * labスクリプトのコードはコピペしていない（spec §9-2・§6）。定義同一性の正しさはG0-C0で証明する。
 *
 * 実行順序（spec §9-5・厳守）: `probe-deribit-instrument-inventory.ts`（G0-E1/E2）を先に実行してから本スクリプトを実行する。
 *
 * 読み取り専用の入力（書き込みは一切しない・spec §0-3-3/5）:
 *   - research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json
 *     （mainSeries.weeklyPoints の最終dateのみをG0-C0の切り詰め基準として参照）
 *
 * 本Stage0で禁止（spec §7-1・§9-10・出力しない）:
 *   選定/確認分割の集計・Sharpe(√52)・block-bootstrap・permutation・有意性検定・ETH-BTC相関・離散化サイジング。
 *   f=0.5・週次リスク予算2%・下側5%ES・母集団（テール窓含む全期間）は変更しない（感度分析としても禁止）。
 *
 * APIキー・.env.local は読まない（Deribit publicエンドポイントは認証不要）。
 *
 * 実行: node --experimental-strip-types scripts/vrp-eth-stage0-economics.ts
 * 出力: research/EXP-OBS000041/10-result/stage0-eth-vrp-series.json
 *       research/EXP-OBS000041/10-result/stage0-economics-snapshot.json
 *       research/EXP-OBS000041/10-result/stage0-economics-params.json
 *       research/EXP-OBS000041/10-result/stage0-eth-run.log
 */

import { writeFileSync, mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000041', '10-result');
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
// 固定パラメータ（spec §2・回す前に固定・可変化/資産別作り分け禁止）
// ============================================================
const PARAMS = {
  anchorDateBtc: '2021-03-24',
  weeklyStepDays: 7,
  rvForwardReturnCount: 7, // D+1..D+8の8終値→7リターン
  annualizationRv: Math.sqrt(365),
  minResidualDaysForRepresentativeMaturity: 7,
  atmDeltaRange: [0.35, 0.65] as [number, number],
  optionPremiumCapRate: 0.125,
  hedgeRebalancesPerWeek: 7,
  cvarTailFraction: 0.05, // 下側5%ES
  weeklyRiskBudget: 0.02, // 資本2%
  fFraction_main: 0.5,
  fFraction_reference: 1.0,
  slippageNotionalUsdPrimary: 100000,
  slippageNotionalUsdReference: 10000,
  orderBookDepth: 50,
  tailWindows: {
    T2: { start: '2022-05-01', end: '2022-06-30', label: 'LUNA/UST崩壊' },
    T3: { start: '2022-10-25', end: '2022-12-15', label: 'FTX破綻' },
  },
  officialFeePageUrl: 'https://www.deribit.com/kb/fees',
  requestSleepMs: 180,
  c1SamenessMaxMinutes: 30,
};

// ============================================================
// 日付ユーティリティ（UTC暦日のみ・独立実装）
// ============================================================
function dateKey(d: Date): string { return d.toISOString().slice(0, 10); }
function keyToMs(key: string): number { return Date.parse(`${key}T00:00:00.000Z`); }
function addDaysKey(key: string, n: number): string { return dateKey(new Date(keyToMs(key) + n * 86400000)); }
function daysBetween(a: string, b: string): number { return (keyToMs(b) - keyToMs(a)) / 86400000; }

// ============================================================
// HTTP fetch
// ============================================================
interface FetchMeta { status: number; json: unknown | null; error?: string }
async function fetchWithMeta(url: string): Promise<FetchMeta> {
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
function apiResult(r: FetchMeta): unknown | undefined {
  return r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result : undefined;
}

// ============================================================
// DVOL 日次取得（終了条件=空応答 or continuationなし のみ。length<limit終了は禁止・spec §9-8）
// ============================================================
interface DvolRow { date: string; timestampMs: number; close: number }
async function fetchDvolDaily(currency: string, floorKey: string, ceilKeyInclusive: string): Promise<{ rows: DvolRow[]; pageLog: string[] }> {
  const rows: DvolRow[] = [];
  const pageLog: string[] = [];
  let endMs = keyToMs(ceilKeyInclusive) + 86400000;
  const floorMs = keyToMs(floorKey);
  let requestCount = 0;
  const MAX_REQUESTS = 80;
  while (requestCount < MAX_REQUESTS) {
    const url = `${BASE}/public/get_volatility_index_data?currency=${currency}&start_timestamp=${floorMs}&end_timestamp=${endMs}&resolution=86400`;
    const r = await fetchWithMeta(url);
    requestCount++;
    const resultObj = apiResult(r) as Record<string, unknown> | undefined;
    const data = (resultObj?.data as number[][] | undefined) ?? [];
    const continuation = resultObj && 'continuation' in resultObj ? (resultObj.continuation as number | null) : undefined;
    pageLog.push(`DVOL(${currency}) request#${requestCount} status=${r.status} rowsReturned=${data.length} continuation=${JSON.stringify(continuation)}`);
    log(`  DVOL(${currency}) page#${requestCount}: rowsReturned=${data.length} continuation=${JSON.stringify(continuation)}`);
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
// Deribit-tradingview 日次価格取得（D4）
// ============================================================
async function fetchPerpPriceDaily(instrument: string, floorKey: string, ceilKeyInclusive: string): Promise<{ closeByDate: Map<string, number>; requestUrl: string; status: string | null; ticksReturned: number; rawTickHourUtc: number | null }> {
  const startMs = keyToMs(floorKey);
  const endMs = keyToMs(ceilKeyInclusive) + 86400000;
  const url = `${BASE}/public/get_tradingview_chart_data?instrument_name=${instrument}&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=1D`;
  log(`  GET ${url}`);
  const r = await fetchWithMeta(url);
  const resultObj = apiResult(r) as Record<string, unknown> | undefined;
  const status = (resultObj?.status as string | undefined) ?? null;
  const ticks = (resultObj?.ticks as number[] | undefined) ?? [];
  const closes = (resultObj?.close as number[] | undefined) ?? [];
  log(`  ${instrument} price: status=${status} ticks=${ticks.length}`);
  const closeByDate = new Map<string, number>();
  for (let i = 0; i < ticks.length; i++) closeByDate.set(dateKey(new Date(ticks[i])), closes[i]);
  const rawTickHourUtc = ticks.length > 0 ? new Date(ticks[0]).getUTCHours() : null;
  return { closeByDate, requestUrl: url, status, ticksReturned: ticks.length, rawTickHourUtc };
}

// ============================================================
// RV_forward(D,D+7d)：D+1..D+8 の8終値→7リターン→年率化std(ddof=1)（D1・是正済み定義・ハードコード）
// ============================================================
function computeRvForward(dateD: string, closeByDate: Map<string, number>): { rv: number | null; priceDatesUsed: string[] } {
  const priceDates: string[] = [];
  const closes: number[] = [];
  const need = PARAMS.rvForwardReturnCount + 1;
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

// ============================================================
// 週次VRP系列構築（D2・D3・非重複7日・指定アンカー）
// ============================================================
interface WeeklyPoint { date: string; dvol: number; rv_forward_pct: number | null; vrp: number | null; priceDatesUsed: string[]; lookaheadCheckPassed: boolean }
function buildWeeklySeries(anchorDate: string, dvolByDate: Map<string, number>, closeByDate: Map<string, number>): WeeklyPoint[] {
  const points: WeeklyPoint[] = [];
  let cur = anchorDate;
  const dvolDates = [...dvolByDate.keys()].sort();
  if (dvolDates.length === 0) return points;
  const lastDvolDate = dvolDates[dvolDates.length - 1];
  while (cur <= lastDvolDate) {
    const dvol = dvolByDate.get(cur);
    if (dvol !== undefined) {
      const rv = computeRvForward(cur, closeByDate);
      points.push({
        date: cur, dvol, rv_forward_pct: rv.rv, vrp: rv.rv !== null ? dvol - rv.rv : null,
        priceDatesUsed: rv.priceDatesUsed, lookaheadCheckPassed: rv.priceDatesUsed.every(d => d > cur),
      });
    }
    cur = addDaysKey(cur, PARAMS.weeklyStepDays);
  }
  return points;
}

// ============================================================
// 日次VRP水準系列（Stage 1相関測定用の永続化のみ・Stage0では相関計算しない・独立実装）
// ============================================================
interface DailyVrpRow { date: string; dvol: number; rv_forward_pct: number; vrp_level: number }
function buildDailyVrpSeries(dvolByDate: Map<string, number>, closeByDate: Map<string, number>): DailyVrpRow[] {
  const dvolDates = [...dvolByDate.keys()].sort();
  const rows: DailyVrpRow[] = [];
  for (const d of dvolDates) {
    const dvol = dvolByDate.get(d);
    if (dvol === undefined) continue;
    const rv = computeRvForward(d, closeByDate);
    if (rv.rv !== null) rows.push({ date: d, dvol, rv_forward_pct: rv.rv, vrp_level: dvol - rv.rv });
  }
  return rows;
}

// ============================================================
// 統計ユーティリティ
// ============================================================
function mean(arr: number[]): number { return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN; }
function stdSample(arr: number[]): number {
  if (arr.length < 2) return NaN;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}
function computeCvarEs(netPayoffs: number[], tailFraction: number): { esValue: number; absCvar: number; tailCount: number; populationN: number } {
  const sorted = [...netPayoffs].sort((a, b) => a - b);
  const tailCount = Math.max(1, Math.round(sorted.length * tailFraction));
  const tailValues = sorted.slice(0, tailCount);
  const esValue = mean(tailValues);
  return { esValue, absCvar: Math.abs(esValue), tailCount, populationN: sorted.length };
}

// ============================================================
// get_instruments（option/future）
// ============================================================
interface RawInstrument { [key: string]: unknown }
async function fetchInstruments(currency: string, kind: 'option' | 'future'): Promise<{ url: string; status: number; rows: RawInstrument[] }> {
  const url = `${BASE}/public/get_instruments?currency=${currency}&kind=${kind}&expired=false`;
  const r = await fetchWithMeta(url);
  const rows = (apiResult(r) as RawInstrument[] | undefined) ?? [];
  return { url, status: r.status, rows };
}

// ============================================================
// ticker / order book
// ============================================================
interface TickerGreeks { delta: number; gamma: number; vega: number; theta: number }
interface TickerSnapshot { instrumentName: string; indexPrice: number; markPrice: number; bestBid: number; bestAsk: number; greeks: TickerGreeks; openInterest: unknown; snapshotUtc: string }
interface TickerDiag { instrumentName: string; httpStatus: number; hasResult: boolean; hasGreeks: boolean; apiError?: string }
async function fetchTicker(instrumentName: string): Promise<{ ticker: TickerSnapshot | null; diag: TickerDiag }> {
  const url = `${BASE}/public/ticker?instrument_name=${instrumentName}`;
  const r = await fetchWithMeta(url);
  const resultObj = apiResult(r) as Record<string, unknown> | undefined;
  const apiError = r.json && typeof r.json === 'object' && (r.json as Record<string, unknown>).error ? JSON.stringify((r.json as Record<string, unknown>).error) : undefined;
  if (!resultObj) return { ticker: null, diag: { instrumentName, httpStatus: r.status, hasResult: false, hasGreeks: false, apiError } };
  const greeks = resultObj.greeks as Record<string, number> | undefined;
  if (!greeks) return { ticker: null, diag: { instrumentName, httpStatus: r.status, hasResult: true, hasGreeks: false, apiError } };
  return {
    ticker: {
      instrumentName, indexPrice: resultObj.index_price as number, markPrice: resultObj.mark_price as number,
      bestBid: resultObj.best_bid_price as number, bestAsk: resultObj.best_ask_price as number,
      greeks: { delta: greeks.delta, gamma: greeks.gamma, vega: greeks.vega, theta: greeks.theta },
      openInterest: resultObj.open_interest ?? 'API非配信',
      snapshotUtc: new Date().toISOString(),
    },
    diag: { instrumentName, httpStatus: r.status, hasResult: true, hasGreeks: true, apiError },
  };
}
interface OrderBookLevel { price: number; size: number }
interface OrderBookSnapshot { instrumentName: string; requestUrl: string; status: number; bids: OrderBookLevel[]; asks: OrderBookLevel[]; bestBid: number | null; bestAsk: number | null; midPrice: number | null; spreadBps: number | null; snapshotUtc: string }
async function fetchOrderBook(instrumentName: string, depth: number): Promise<OrderBookSnapshot> {
  const url = `${BASE}/public/get_order_book?instrument_name=${instrumentName}&depth=${depth}`;
  const r = await fetchWithMeta(url);
  const resultObj = apiResult(r) as Record<string, unknown> | undefined;
  const bidsRaw = (resultObj?.bids as number[][] | undefined) ?? [];
  const asksRaw = (resultObj?.asks as number[][] | undefined) ?? [];
  const bids = bidsRaw.map(b => ({ price: b[0], size: b[1] }));
  const asks = asksRaw.map(a => ({ price: a[0], size: a[1] }));
  const bestBid = bids.length > 0 ? bids[0].price : null;
  const bestAsk = asks.length > 0 ? asks[0].price : null;
  const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadBps = bestBid !== null && bestAsk !== null && midPrice !== null && midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : null;
  return { instrumentName, requestUrl: url, status: r.status, bids, asks, bestBid, bestAsk, midPrice, spreadBps, snapshotUtc: new Date().toISOString() };
}
function estimateSlippageBps(levels: OrderBookLevel[], notionalUsd: number, midPrice: number): { filledNotionalUsd: number; avgFillPrice: number | null; slippageBps: number | null } {
  let remaining = notionalUsd;
  let filled = 0;
  let costSum = 0;
  for (const lvl of levels) {
    if (remaining <= 0) break;
    const levelNotionalUsd = lvl.price * lvl.size;
    const take = Math.min(remaining, levelNotionalUsd);
    costSum += lvl.price * take;
    filled += take;
    remaining -= take;
  }
  if (filled === 0) return { filledNotionalUsd: 0, avgFillPrice: null, slippageBps: null };
  const avgFillPrice = costSum / filled;
  const slippageBps = midPrice > 0 ? ((avgFillPrice - midPrice) / midPrice) * 10000 : null;
  return { filledNotionalUsd: filled, avgFillPrice, slippageBps };
}

// ============================================================
// 代表満期・ATM選定（D5・D6・フォールバック禁止）
// ============================================================
interface ExpiryResidual { expiryTimestamp: number; residualDays: number }
function pickRepresentativeExpiry(instruments: RawInstrument[], nowMs: number): ExpiryResidual | null {
  const expiries = [...new Set(instruments.map(i => i.expiration_timestamp as number))];
  const list = expiries.map(e => ({ expiryTimestamp: e, residualDays: (e - nowMs) / 86400000 })).filter(x => x.residualDays >= PARAMS.minResidualDaysForRepresentativeMaturity).sort((a, b) => a.residualDays - b.residualDays);
  return list.length > 0 ? list[0] : null;
}
interface AtmResult {
  method: 'deltaRange' | 'unavailable';
  strike: number | null; indexPriceAtSelection: number | null;
  call: TickerSnapshot | null; put: TickerSnapshot | null;
  callInstrument: RawInstrument | null; putInstrument: RawInstrument | null;
  candidateLog: { strike: number; delta: unknown; instrumentName: string }[]; diagLog: TickerDiag[];
  unavailableReason?: string;
}
async function selectAtm(instruments: RawInstrument[], expiryTimestamp: number): Promise<AtmResult> {
  const calls = instruments.filter(i => i.expiration_timestamp === expiryTimestamp && i.option_type === 'call');
  const putByStrike = new Map<number, RawInstrument>();
  for (const i of instruments) if (i.expiration_timestamp === expiryTimestamp && i.option_type === 'put') putByStrike.set(i.strike as number, i);
  const candidateLog: { strike: number; delta: unknown; instrumentName: string }[] = [];
  const diagLog: TickerDiag[] = [];
  const candidates: { strike: number; delta: number; indexPrice: number; ticker: TickerSnapshot; inst: RawInstrument }[] = [];
  for (const c of calls) {
    const name = c.instrument_name as string;
    const { ticker: t, diag } = await fetchTicker(name);
    await sleep(PARAMS.requestSleepMs);
    diagLog.push(diag);
    if (!t) continue;
    candidateLog.push({ strike: c.strike as number, delta: t.greeks.delta, instrumentName: name });
    if (t.greeks.delta >= PARAMS.atmDeltaRange[0] && t.greeks.delta <= PARAMS.atmDeltaRange[1]) {
      candidates.push({ strike: c.strike as number, delta: t.greeks.delta, indexPrice: t.indexPrice, ticker: t, inst: c });
    }
  }
  if (candidates.length === 0) {
    return { method: 'unavailable', strike: null, indexPriceAtSelection: null, call: null, put: null, callInstrument: null, putInstrument: null, candidateLog, diagLog, unavailableReason: `代表満期${new Date(expiryTimestamp).toISOString()}にdelta∈[${PARAMS.atmDeltaRange[0]},${PARAMS.atmDeltaRange[1]}]の候補が0件（フォールバック未使用・spec §2-2）` };
  }
  candidates.sort((a, b) => Math.abs(a.strike - a.indexPrice) - Math.abs(b.strike - b.indexPrice));
  const best = candidates[0];
  const putInst = putByStrike.get(best.strike);
  if (!putInst) {
    return { method: 'unavailable', strike: best.strike, indexPriceAtSelection: best.indexPrice, call: best.ticker, put: null, callInstrument: best.inst, putInstrument: null, candidateLog, diagLog, unavailableReason: `strike=${best.strike}に対応するputインストゥルメントが見つからない` };
  }
  const { ticker: putTicker, diag: putDiag } = await fetchTicker(putInst.instrument_name as string);
  await sleep(PARAMS.requestSleepMs);
  diagLog.push(putDiag);
  if (!putTicker) {
    return { method: 'unavailable', strike: best.strike, indexPriceAtSelection: best.indexPrice, call: best.ticker, put: null, callInstrument: best.inst, putInstrument: putInst, candidateLog, diagLog, unavailableReason: `put ticker取得失敗: ${putInst.instrument_name}` };
  }
  return { method: 'deltaRange', strike: best.strike, indexPriceAtSelection: best.indexPrice, call: best.ticker, put: putTicker, callInstrument: best.inst, putInstrument: putInst, candidateLog, diagLog };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000041 Stage 0: vrp-eth-stage0-economics.ts (G0-C0〜C4) ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  let gitCommit = 'unknown';
  try { gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim(); } catch { /* ignore */ }
  log(`Git commit: ${gitCommit} / Node ${process.version}`);

  const todayKey = dateKey(new Date());
  const nowMs = Date.now();

  // ---- 0. 読み取り専用参照: OBS000037 Stage1 mainSeries.weeklyPoints 最終date（G0-C0切り詰め基準） ----
  const stage1Path = join(__dirname, '..', 'research', 'EXP-OBS000037', '10-result', 'stage1-vrp-prediction-unit.json');
  if (!existsSync(stage1Path)) throw new Error(`読み取り専用入力が見つからない: ${stage1Path}（G0-C0を算出できない・A設計官へ差し戻し）`);
  const stage1 = JSON.parse(readFileSync(stage1Path, 'utf-8'));
  const stage1WeeklyPoints = stage1.mainSeries.weeklyPoints as { date: string; vrp: number | null }[];
  const stage1LastDate = stage1WeeklyPoints[stage1WeeklyPoints.length - 1].date;
  const stage1NonNullPoints = stage1WeeklyPoints.filter(p => p.vrp !== null);
  const stage1LastNonNullDate = stage1NonNullPoints[stage1NonNullPoints.length - 1].date;
  const stage1RunTimestamp = stage1.runTimestampUTC;
  log(`\n>>> 0. 読み取り専用参照: ${stage1Path}`);
  log(`  Stage1 runTimestampUTC=${stage1RunTimestamp} mainSeries.weeklyPoints件数=${stage1WeeklyPoints.length} 最終date(生配列)=${stage1LastDate} 最終date(vrp非null)=${stage1LastNonNullDate}`);
  log(`  注記: Stage1配列の最終要素(${stage1LastDate})はStage1実行時点(${stage1RunTimestamp})でRV_forwardに必要な未来価格が未確定だったため vrp=null（構造的境界点であり、本スクリプトの実行時点が十分後であれば同一日付でも非nullが得られ得る）。C0の主比較は vrp非null の最終date(${stage1LastNonNullDate})基準で行い、生配列最終dateでの切り詰め結果も参考として併記する。`);

  // ---- 1. DVOL・価格 日次取得（BTC・ETH） ----
  log('\n>>> 1. DVOL(BTC) 日次取得');
  const dvolBtc = await fetchDvolDaily('BTC', PARAMS.anchorDateBtc, todayKey);
  const dvolByDateBtc = new Map(dvolBtc.rows.map(r => [r.date, r.close]));
  log(`  総取得件数=${dvolBtc.rows.length} 最古=${dvolBtc.rows[0]?.date} 最新=${dvolBtc.rows[dvolBtc.rows.length - 1]?.date}`);

  log('\n>>> 1b. DVOL(ETH) 日次取得（実起点探索のため2019-01-01floorから）');
  const dvolEth = await fetchDvolDaily('ETH', '2019-01-01', todayKey);
  const dvolByDateEth = new Map(dvolEth.rows.map(r => [r.date, r.close]));
  const ethDvolEarliestDate = dvolEth.rows[0]?.date ?? null;
  log(`  総取得件数=${dvolEth.rows.length} 実測最古=${ethDvolEarliestDate} 最新=${dvolEth.rows[dvolEth.rows.length - 1]?.date}`);

  log('\n>>> 1c. BTC-PERPETUAL / ETH-PERPETUAL 日次価格取得');
  const priceBtc = await fetchPerpPriceDaily('BTC-PERPETUAL', PARAMS.anchorDateBtc, todayKey);
  const priceEth = await fetchPerpPriceDaily('ETH-PERPETUAL', ethDvolEarliestDate ?? PARAMS.anchorDateBtc, todayKey);

  // ---- 2. ETH主系列アンカー決定（spec §2-1・回す前に固定した規則） ----
  let ethMainAnchor = PARAMS.anchorDateBtc;
  if (ethDvolEarliestDate !== null && ethDvolEarliestDate > PARAMS.anchorDateBtc) {
    let cand = PARAMS.anchorDateBtc;
    while (cand < ethDvolEarliestDate) cand = addDaysKey(cand, PARAMS.weeklyStepDays);
    ethMainAnchor = cand;
  }
  const ethAnchorPhaseDaysDiff = daysBetween(PARAMS.anchorDateBtc, ethMainAnchor);
  log(`\n>>> 2. ETH主系列アンカー決定: BTCアンカー=${PARAMS.anchorDateBtc} ETH実起点=${ethDvolEarliestDate} → 採用アンカー=${ethMainAnchor}（BTCアンカーとの日数差=${ethAnchorPhaseDaysDiff}, 7の倍数=${ethAnchorPhaseDaysDiff % 7 === 0}）`);

  // ---- 3. 週次VRP主系列構築（BTC・ETH） ----
  log('\n>>> 3. 週次VRP主系列構築（BTC: アンカー2021-03-24 / ETH: アンカー' + ethMainAnchor + '）');
  const btcMainWeeklyFull = buildWeeklySeries(PARAMS.anchorDateBtc, dvolByDateBtc, priceBtc.closeByDate);
  const ethMainWeeklyFull = buildWeeklySeries(ethMainAnchor, dvolByDateEth, priceEth.closeByDate);
  log(`  BTC主系列: 週次候補点数=${btcMainWeeklyFull.length} VRP構築可能=${btcMainWeeklyFull.filter(p => p.vrp !== null).length}`);
  log(`  ETH主系列: 週次候補点数=${ethMainWeeklyFull.length} VRP構築可能=${ethMainWeeklyFull.filter(p => p.vrp !== null).length}`);

  // ETH参考系列（開示のみ・判定に使わない・ETH DVOL実起点アンカー）
  const ethReferenceAnchor = ethDvolEarliestDate ?? PARAMS.anchorDateBtc;
  const ethReferenceWeekly = buildWeeklySeries(ethReferenceAnchor, dvolByDateEth, priceEth.closeByDate);
  log(`  ETH参考系列（実起点アンカー=${ethReferenceAnchor}・判定不使用）: 週次候補点数=${ethReferenceWeekly.length} VRP構築可能=${ethReferenceWeekly.filter(p => p.vrp !== null).length}`);

  // ---- 4. 先読み排除自己点検（BTC・ETH双方） ----
  const btcLookaheadViolations = btcMainWeeklyFull.filter(p => p.vrp !== null && !p.lookaheadCheckPassed).length;
  const ethLookaheadViolations = ethMainWeeklyFull.filter(p => p.vrp !== null && !p.lookaheadCheckPassed).length;
  log(`\n>>> 4. 先読み排除自己点検: BTC違反件数=${btcLookaheadViolations} ETH違反件数=${ethLookaheadViolations}`);

  // ---- 5. G0-C0: BTC回帰再現（Stage1最終dateに切り詰め） ----
  log('\n>>> 5. G0-C0: BTC回帰再現（Stage1 mainSeries.weeklyPointsの最終dateに切り詰め）');
  // 主比較: vrp非nullの最終date基準（Stage1/Stage2確定値 n=276・mean=+12.564168 は、この基準で得られた
  // 集合の統計値であり、生配列の最終要素[vrp=null]を含めた場合は時間経過で非null化しうるため一致しない
  // 恐れがある。本スクリプトはこの点を透明にするため両方の切り詰め結果を出力する）。
  const btcTruncatedNonNullBasis = btcMainWeeklyFull.filter(p => p.date <= stage1LastNonNullDate);
  const btcTruncatedNonNull = btcTruncatedNonNullBasis.filter(p => p.vrp !== null);
  const c0_n = btcTruncatedNonNull.length;
  const c0_meanVrp = mean(btcTruncatedNonNull.map(p => p.vrp as number));
  const c0_expectedMeanVrp = 12.564168;
  const c0_absDiff = Math.abs(c0_meanVrp - c0_expectedMeanVrp);
  const myDates = btcTruncatedNonNullBasis.map(p => p.date);
  const stage1Dates = stage1NonNullPoints.map(p => p.date);
  const dateMismatch: { index: number; mine: string | null; stage1: string | null }[] = [];
  const maxLen = Math.max(myDates.length, stage1Dates.length);
  for (let i = 0; i < maxLen; i++) {
    if (myDates[i] !== stage1Dates[i]) dateMismatch.push({ index: i, mine: myDates[i] ?? null, stage1: stage1Dates[i] ?? null });
  }
  log(`  C0-1(n): mine=${c0_n} expected=276`);
  log(`  C0-2(平均VRP): mine=${c0_meanVrp.toFixed(6)} expected=${c0_expectedMeanVrp} absDiff=${c0_absDiff.toFixed(8)}`);
  log(`  C0-3(日付列一致): mine件数=${myDates.length} stage1件数=${stage1Dates.length} 不一致件数=${dateMismatch.length}`);

  // 参考: 生配列の最終date(vrp=nullを含みうる)に切り詰めた場合の変異（disclosure only）
  const btcTruncatedRawBasis = btcMainWeeklyFull.filter(p => p.date <= stage1LastDate);
  const btcTruncatedRawNonNull = btcTruncatedRawBasis.filter(p => p.vrp !== null);
  const c0_rawVariant = {
    note: 'Stage1 mainSeries.weeklyPointsの生配列最終date（vrp=nullを含みうる）にそのまま切り詰めた場合の参考値。主比較(C0-1〜C0-3)には使用しない。',
    truncationDate: stage1LastDate,
    n: btcTruncatedRawNonNull.length,
    meanVrp: mean(btcTruncatedRawNonNull.map(p => p.vrp as number)),
    dateListLength: btcTruncatedRawBasis.length,
    stage1RawDateListLength: stage1WeeklyPoints.length,
  };
  log(`  参考(生配列最終date切り詰め): n=${c0_rawVariant.n} meanVrp=${c0_rawVariant.meanVrp}`);
  log(`  C0-4(先読み違反): BTC=${btcLookaheadViolations} ETH=${ethLookaheadViolations}`);

  // ---- 6. G0-C1: BTC/ETH同時点スナップショット（1実行内・BTC→ETHの順・連続取得） ----
  log('\n>>> 6. G0-C1: BTC→ETH 同時点スナップショット（連続取得・各取得UTC時刻を個別記録）');
  const btcSnapshotStartUTC = new Date().toISOString();
  const instrumentsBtcOption = await fetchInstruments('BTC', 'option');
  await sleep(PARAMS.requestSleepMs);
  const instrumentsBtcFuture = await fetchInstruments('BTC', 'future');
  await sleep(PARAMS.requestSleepMs);
  const btcRepExpiry = pickRepresentativeExpiry(instrumentsBtcOption.rows, nowMs);
  if (!btcRepExpiry) throw new Error('BTC: 代表満期（残存>=7日）が見つからない');
  const btcAtm = await selectAtm(instrumentsBtcOption.rows, btcRepExpiry.expiryTimestamp);
  log(`  BTC ATM選定: method=${btcAtm.method} strike=${btcAtm.strike} residualDays=${btcRepExpiry.residualDays.toFixed(4)}`);
  const btcPerpTicker = await fetchTicker('BTC-PERPETUAL');
  await sleep(PARAMS.requestSleepMs);
  const btcPerpOrderBook = await fetchOrderBook('BTC-PERPETUAL', PARAMS.orderBookDepth);
  const btcSnapshotEndUTC = new Date().toISOString();
  log(`  BTC取得完了: ${btcSnapshotEndUTC}`);

  const ethSnapshotStartUTC = new Date().toISOString();
  const instrumentsEthOption = await fetchInstruments('ETH', 'option');
  await sleep(PARAMS.requestSleepMs);
  const instrumentsEthFuture = await fetchInstruments('ETH', 'future');
  await sleep(PARAMS.requestSleepMs);
  const ethRepExpiry = pickRepresentativeExpiry(instrumentsEthOption.rows, nowMs);
  if (!ethRepExpiry) throw new Error('ETH: 代表満期（残存>=7日）が見つからない');
  const ethAtm = await selectAtm(instrumentsEthOption.rows, ethRepExpiry.expiryTimestamp);
  log(`  ETH ATM選定: method=${ethAtm.method} strike=${ethAtm.strike} residualDays=${ethRepExpiry.residualDays.toFixed(4)}`);
  const ethPerpTicker = await fetchTicker('ETH-PERPETUAL');
  await sleep(PARAMS.requestSleepMs);
  const ethPerpOrderBook = await fetchOrderBook('ETH-PERPETUAL', PARAMS.orderBookDepth);
  const ethSnapshotEndUTC = new Date().toISOString();
  log(`  ETH取得開始: ${ethSnapshotStartUTC} / ETH取得完了: ${ethSnapshotEndUTC}`);

  const c1DiffMinutes = (Date.parse(ethSnapshotStartUTC) - Date.parse(btcSnapshotEndUTC)) / 60000;
  const c1SameUtcDay = btcSnapshotEndUTC.slice(0, 10) === ethSnapshotStartUTC.slice(0, 10);
  log(`  C1-2(同時性): BTC完了=${btcSnapshotEndUTC} ETH開始=${ethSnapshotStartUTC} 差分=${c1DiffMinutes.toFixed(4)}分 同一UTC日=${c1SameUtcDay}`);
  const c1ResidualRatio = btcAtm.method === 'deltaRange' && ethAtm.method === 'deltaRange' ? ethRepExpiry.residualDays / btcRepExpiry.residualDays : null;
  log(`  C1-4(残存日数不揃い): BTC residualDays=${btcRepExpiry.residualDays.toFixed(4)} ETH residualDays=${ethRepExpiry.residualDays.toFixed(4)} ratio=${c1ResidualRatio} sqrtRatio=${c1ResidualRatio !== null ? Math.sqrt(c1ResidualRatio) : null}`);

  if (btcAtm.method !== 'deltaRange' || ethAtm.method !== 'deltaRange') {
    log(`  ⚠ フォールバック不使用の正規選定が成立しなかった（BTC=${btcAtm.method} ETH=${ethAtm.method}）。以降のC2〜C4は算出可能な範囲のみ実施し、事実を記録する。`);
  }

  // ---- 7. G0-C2: C_real完全構築（BTC・ETH並置・資産別実測） ----
  log('\n>>> 7. G0-C2: C_real構築（C_options + C_hedge・資産別実測）');
  const officialFeePageProbe = await (async () => {
    try {
      const res = await fetch(PARAMS.officialFeePageUrl);
      const text = await res.text();
      return { url: PARAMS.officialFeePageUrl, status: res.status, bodyLength: text.length, fetchSucceeded: res.ok };
    } catch (err) {
      return { url: PARAMS.officialFeePageUrl, status: 0, bodyLength: 0, fetchSucceeded: false, error: err instanceof Error ? err.message : String(err) };
    }
  })();
  log(`  公式手数料表到達確認: status=${officialFeePageProbe.status} fetchSucceeded=${officialFeePageProbe.fetchSucceeded}`);

  function buildOptionsCost(atm: AtmResult): { costUsdTotal: number; vegaTotalUsdPerVolPt: number; costVolPt: number; detail: Record<string, unknown> } | null {
    if (atm.method !== 'deltaRange' || !atm.call || !atm.put || !atm.callInstrument || !atm.putInstrument || atm.indexPriceAtSelection === null) return null;
    const indexPrice = atm.indexPriceAtSelection;
    const callTakerRate = atm.callInstrument.taker_commission as number | undefined;
    const putTakerRate = atm.putInstrument.taker_commission as number | undefined;
    const callPremiumUsd = atm.call.markPrice * indexPrice;
    const putPremiumUsd = atm.put.markPrice * indexPrice;
    const callFeeUsd = typeof callTakerRate === 'number' ? Math.min(callTakerRate * indexPrice, PARAMS.optionPremiumCapRate * callPremiumUsd) : NaN;
    const putFeeUsd = typeof putTakerRate === 'number' ? Math.min(putTakerRate * indexPrice, PARAMS.optionPremiumCapRate * putPremiumUsd) : NaN;
    const callHalfSpreadUsd = 0.5 * (atm.call.bestAsk - atm.call.bestBid) * indexPrice;
    const putHalfSpreadUsd = 0.5 * (atm.put.bestAsk - atm.put.bestBid) * indexPrice;
    const perRoundCostUsd = (callFeeUsd + callHalfSpreadUsd) + (putFeeUsd + putHalfSpreadUsd);
    const costUsdTotal = perRoundCostUsd * 2;
    const vegaTotalUsdPerVolPt = atm.call.greeks.vega + atm.put.greeks.vega;
    const costVolPt = costUsdTotal / vegaTotalUsdPerVolPt;
    return {
      costUsdTotal, vegaTotalUsdPerVolPt, costVolPt,
      detail: {
        callPremiumUsd, putPremiumUsd, callFeeUsd, putFeeUsd, callHalfSpreadUsd, putHalfSpreadUsd, perRoundCostUsd,
        callTakerCommissionRate: callTakerRate ?? 'API非配信', putTakerCommissionRate: putTakerRate ?? 'API非配信',
        callMakerCommissionRate: atm.callInstrument.maker_commission ?? 'API非配信', putMakerCommissionRate: atm.putInstrument.maker_commission ?? 'API非配信',
        callMinTradeAmount: atm.callInstrument.min_trade_amount ?? 'API非配信', putMinTradeAmount: atm.putInstrument.min_trade_amount ?? 'API非配信',
        callContractSize: atm.callInstrument.contract_size ?? 'API非配信',
        note: 'C_options = [(手数料+半スプレッド)×(call+put)] × 2ラウンド(entry+exit) の合計USD ÷ (call vega + put vega)。手数料率は資産別に get_instruments から実測（spec D7・BTCの0.0003流用禁止）。',
      },
    };
  }
  const btcOptionsCost = buildOptionsCost(btcAtm);
  const ethOptionsCost = buildOptionsCost(ethAtm);
  log(`  BTC C_options=${btcOptionsCost?.costVolPt} vol pt/週 ETH C_options=${ethOptionsCost?.costVolPt} vol pt/週`);

  function perpCommission(futureRows: RawInstrument[], instrumentName: string): { taker: unknown; maker: unknown } {
    const f = futureRows.find(x => x.instrument_name === instrumentName);
    return { taker: f?.taker_commission ?? 'API非配信', maker: f?.maker_commission ?? 'API非配信' };
  }
  const btcPerpCommission = perpCommission(instrumentsBtcFuture.rows, 'BTC-PERPETUAL');
  const ethPerpCommission = perpCommission(instrumentsEthFuture.rows, 'ETH-PERPETUAL');

  const btcSlippagePrimary = btcPerpOrderBook.midPrice !== null ? estimateSlippageBps(btcPerpOrderBook.asks, PARAMS.slippageNotionalUsdPrimary, btcPerpOrderBook.midPrice) : null;
  const btcSlippageReference = btcPerpOrderBook.midPrice !== null ? estimateSlippageBps(btcPerpOrderBook.asks, PARAMS.slippageNotionalUsdReference, btcPerpOrderBook.midPrice) : null;
  const ethSlippagePrimary = ethPerpOrderBook.midPrice !== null ? estimateSlippageBps(ethPerpOrderBook.asks, PARAMS.slippageNotionalUsdPrimary, ethPerpOrderBook.midPrice) : null;
  const ethSlippageReference = ethPerpOrderBook.midPrice !== null ? estimateSlippageBps(ethPerpOrderBook.asks, PARAMS.slippageNotionalUsdReference, ethPerpOrderBook.midPrice) : null;
  log(`  BTC perpスプレッド=${btcPerpOrderBook.spreadBps}bps スリッページ($100k)=${btcSlippagePrimary?.slippageBps}bps`);
  log(`  ETH perpスプレッド=${ethPerpOrderBook.spreadBps}bps スリッページ($100k)=${ethSlippagePrimary?.slippageBps}bps`);

  async function buildHedgeCost(weeklyDates: string[], closeByDate: Map<string, number>, gammaTotal: number, vegaTotalUsdPerVolPt: number, hedgeCostRateFraction: number) {
    const perWeek: { date: string; hedgeUsd: number; costVolPt: number }[] = [];
    let skipped = 0;
    for (const d of weeklyDates) {
      const dayCloses: number[] = [];
      let ok = true;
      for (let i = 0; i <= PARAMS.hedgeRebalancesPerWeek; i++) {
        const dk = addDaysKey(d, i);
        const c = closeByDate.get(dk);
        if (c === undefined) { ok = false; break; }
        dayCloses.push(c);
      }
      if (!ok || dayCloses.length !== PARAMS.hedgeRebalancesPerWeek + 1) { skipped++; continue; }
      let weeklyHedgeUsd = 0;
      for (let k = 1; k < dayCloses.length; k++) {
        const deltaS = dayCloses[k] - dayCloses[k - 1];
        const deltaDelta = gammaTotal * deltaS;
        const hedgeNotionalUsd = Math.abs(deltaDelta) * dayCloses[k];
        weeklyHedgeUsd += hedgeNotionalUsd * hedgeCostRateFraction;
      }
      perWeek.push({ date: d, hedgeUsd: weeklyHedgeUsd, costVolPt: weeklyHedgeUsd / vegaTotalUsdPerVolPt });
    }
    const costs = perWeek.map(p => p.costVolPt);
    return { meanCostVolPt: mean(costs), stdCostVolPt: stdSample(costs), minCostVolPt: costs.length > 0 ? Math.min(...costs) : NaN, maxCostVolPt: costs.length > 0 ? Math.max(...costs) : NaN, validWeeks: perWeek.length, skippedWeeks: skipped, perWeek };
  }

  const btcHedgeRateFraction = (typeof btcPerpCommission.taker === 'number' ? btcPerpCommission.taker : NaN) + (btcPerpOrderBook.spreadBps ?? NaN) / 20000 + (btcSlippagePrimary?.slippageBps ?? NaN) / 10000;
  const ethHedgeRateFraction = (typeof ethPerpCommission.taker === 'number' ? ethPerpCommission.taker : NaN) + (ethPerpOrderBook.spreadBps ?? NaN) / 20000 + (ethSlippagePrimary?.slippageBps ?? NaN) / 10000;
  // 半スプレッド(bps/2)+スリッページ(bps)+テイカー手数料(率) を合算比率化（D11）
  log(`  BTC hedgeCostRateFraction=${btcHedgeRateFraction} ETH hedgeCostRateFraction=${ethHedgeRateFraction}`);

  const btcGammaTotal = btcAtm.method === 'deltaRange' && btcAtm.call && btcAtm.put ? btcAtm.call.greeks.gamma + btcAtm.put.greeks.gamma : NaN;
  const ethGammaTotal = ethAtm.method === 'deltaRange' && ethAtm.call && ethAtm.put ? ethAtm.call.greeks.gamma + ethAtm.put.greeks.gamma : NaN;
  const btcWeeklyDatesForHedge = btcMainWeeklyFull.filter(p => p.vrp !== null).map(p => p.date);
  const ethWeeklyDatesForHedge = ethMainWeeklyFull.filter(p => p.vrp !== null).map(p => p.date);

  const btcHedgeCost = btcOptionsCost ? await buildHedgeCost(btcWeeklyDatesForHedge, priceBtc.closeByDate, btcGammaTotal, btcOptionsCost.vegaTotalUsdPerVolPt, btcHedgeRateFraction) : null;
  const ethHedgeCost = ethOptionsCost ? await buildHedgeCost(ethWeeklyDatesForHedge, priceEth.closeByDate, ethGammaTotal, ethOptionsCost.vegaTotalUsdPerVolPt, ethHedgeRateFraction) : null;
  log(`  BTC C_hedge mean=${btcHedgeCost?.meanCostVolPt} validWeeks=${btcHedgeCost?.validWeeks} skipped=${btcHedgeCost?.skippedWeeks}`);
  log(`  ETH C_hedge mean=${ethHedgeCost?.meanCostVolPt} validWeeks=${ethHedgeCost?.validWeeks} skipped=${ethHedgeCost?.skippedWeeks}`);

  const btcCReal = btcOptionsCost && btcHedgeCost ? btcOptionsCost.costVolPt + btcHedgeCost.meanCostVolPt : null;
  const ethCReal = ethOptionsCost && ethHedgeCost ? ethOptionsCost.costVolPt + ethHedgeCost.meanCostVolPt : null;
  const labPlaceholderVolPtPerWeek = 1.8;
  log(`  BTC C_real=${btcCReal} ETH C_real=${ethCReal}（lab仮置き=${labPlaceholderVolPtPerWeek}）`);

  // ---- 8. G0-C3: CVaR・サイジング・必要資本・テール1単位あたりプレミアム ----
  log('\n>>> 8. G0-C3: CVaR・サイジング・必要資本（f=0.5固定・下側5%ES・全期間母集団）');
  function buildC3(weeklyFull: WeeklyPoint[], cReal: number | null, optionsCost: ReturnType<typeof buildOptionsCost>, minTradeAmountCall: unknown, minTradeAmountPut: unknown) {
    if (cReal === null || !optionsCost) return null;
    const vrpSeries = weeklyFull.filter(p => p.vrp !== null).map(p => p.vrp as number);
    const netPayoff = vrpSeries.map(v => v - cReal);
    const cvar = computeCvarEs(netPayoff, PARAMS.cvarTailFraction);
    const vegaNotionalPctF05 = PARAMS.fFraction_main * (PARAMS.weeklyRiskBudget / cvar.absCvar);
    const vegaNotionalPctF10 = PARAMS.fFraction_reference * (PARAMS.weeklyRiskBudget / cvar.absCvar);
    const minLotQty = typeof minTradeAmountCall === 'number' && typeof minTradeAmountPut === 'number' ? Math.max(minTradeAmountCall, minTradeAmountPut) : null;
    const requiredCapitalFullUsd = optionsCost.vegaTotalUsdPerVolPt / vegaNotionalPctF05;
    const requiredCapitalMinLotUsd = minLotQty !== null ? (optionsCost.vegaTotalUsdPerVolPt * minLotQty) / vegaNotionalPctF05 : null;
    const meanVrpFull = mean(vrpSeries);
    const tailUnitPremium = (meanVrpFull - cReal) / cvar.absCvar;
    return {
      populationN: cvar.populationN, tailCount: cvar.tailCount, esValue_volpt: cvar.esValue, absCvar_volpt: cvar.absCvar,
      vegaNotionalPct_f05_main: vegaNotionalPctF05, vegaNotionalPct_f10_reference: vegaNotionalPctF10,
      minLotQtyUsed: minLotQty, requiredCapitalFullStraddleUsd: requiredCapitalFullUsd, requiredCapitalMinLotUsd: requiredCapitalMinLotUsd,
      meanVrp_fullPeriod_volpt: meanVrpFull, tailUnitPremium_disclosureOnly: tailUnitPremium,
      descriptiveStatsOnly: { n: vrpSeries.length, meanVrp: meanVrpFull, stdVrp: stdSample(vrpSeries), positiveWeekRatioPct: (vrpSeries.filter(v => v > 0).length / vrpSeries.length) * 100 },
    };
  }
  const btcC3 = buildC3(btcMainWeeklyFull, btcCReal, btcOptionsCost, btcAtm.callInstrument?.min_trade_amount, btcAtm.putInstrument?.min_trade_amount);
  const ethC3 = buildC3(ethMainWeeklyFull, ethCReal, ethOptionsCost, ethAtm.callInstrument?.min_trade_amount, ethAtm.putInstrument?.min_trade_amount);
  log(`  BTC |CVaR|=${btcC3?.absCvar_volpt} vegaNotionalPct(f0.5)=${btcC3?.vegaNotionalPct_f05_main} 必要資本(最小ロット)=$${btcC3?.requiredCapitalMinLotUsd}`);
  log(`  ETH |CVaR|=${ethC3?.absCvar_volpt} vegaNotionalPct(f0.5)=${ethC3?.vegaNotionalPct_f05_main} 必要資本(最小ロット)=$${ethC3?.requiredCapitalMinLotUsd}`);

  // ---- 9. G0-C4: 依存性開示 ----
  log('\n>>> 9. G0-C4: スナップショット依存性の開示');
  let c4Decomposition: Record<string, unknown> | null = null;
  if (btcAtm.method === 'deltaRange' && ethAtm.method === 'deltaRange' && btcOptionsCost && ethOptionsCost && btcAtm.indexPriceAtSelection && ethAtm.indexPriceAtSelection) {
    const actualVegaRatio = ethOptionsCost.vegaTotalUsdPerVolPt / btcOptionsCost.vegaTotalUsdPerVolPt;
    const indexRatio = ethAtm.indexPriceAtSelection / btcAtm.indexPriceAtSelection;
    const residualRatio = ethRepExpiry.residualDays / btcRepExpiry.residualDays;
    const theoreticalRatio = indexRatio * Math.sqrt(residualRatio);
    const residualAttributedToIv = actualVegaRatio - theoreticalRatio;
    c4Decomposition = { actualVegaRatio, indexRatio, residualDaysRatio: residualRatio, theoreticalRatio, residualAttributedToOther: residualAttributedToIv };
    log(`  C4-1: actualVegaRatio=${actualVegaRatio} theoreticalRatio(index×√residual)=${theoreticalRatio} residual=${residualAttributedToIv}`);
  } else {
    log('  C4-1: BTC/ETHいずれかのATMが正規選定できなかったため比率分解は算出不可（事実記録）');
  }

  // C4-2: ETH-PERP/BTC-PERP 日次終値比の歴史的レンジ
  const commonDates = [...priceBtc.closeByDate.keys()].filter(d => priceEth.closeByDate.has(d) && d >= PARAMS.anchorDateBtc).sort();
  const ratios = commonDates.map(d => (priceEth.closeByDate.get(d) as number) / (priceBtc.closeByDate.get(d) as number)).sort((a, b) => a - b);
  const priceRatioStats = ratios.length > 0 ? {
    n: ratios.length, min: ratios[0], p5: quantile(ratios, 0.05), median: quantile(ratios, 0.5), p95: quantile(ratios, 0.95), max: ratios[ratios.length - 1],
    dateRange: { start: commonDates[0], end: commonDates[commonDates.length - 1] },
  } : null;
  log(`  C4-2: 価格比サンプル数=${priceRatioStats?.n} min=${priceRatioStats?.min} p5=${priceRatioStats?.p5} median=${priceRatioStats?.median} p95=${priceRatioStats?.p95} max=${priceRatioStats?.max}`);

  let requiredCapitalRatioRange: Record<string, unknown> | null = null;
  if (c4Decomposition && priceRatioStats && btcC3 && ethC3) {
    const residualRatio = c4Decomposition.residualDaysRatio as number;
    const residualOther = c4Decomposition.residualAttributedToOther as number;
    const capitalRatioAt = (priceRatioQuantile: number) => {
      const vegaRatioAtQuantile = priceRatioQuantile * Math.sqrt(residualRatio) + residualOther; // 理論比+観測残差を保持したまま指数比のみ差し替え（新規モデル推定ではない・算術のみ）
      const capitalRatio = vegaRatioAtQuantile * (btcC3.vegaNotionalPct_f05_main / ethC3.vegaNotionalPct_f05_main);
      return { priceRatioQuantile, vegaRatioAtQuantile, requiredCapitalRatio_ethOverBtc: capitalRatio };
    };
    requiredCapitalRatioRange = {
      method: '必要資本比(ETH/BTC) = vegaRatio(価格比クォンタイル×√残存比+観測残差) × (BTC vegaNotionalPct(f0.5) / ETH vegaNotionalPct(f0.5))。' +
        '√残存比・観測残差(相対IV等)・両資産のvegaNotionalPctは現時点スナップショット値に固定し、価格比のみ歴史的分位に差し替える算術（新規のモデル推定はしない・spec §3-7 C4-2）。',
      atMin: capitalRatioAt(priceRatioStats.min), atP5: capitalRatioAt(priceRatioStats.p5), atMedian: capitalRatioAt(priceRatioStats.median),
      atP95: capitalRatioAt(priceRatioStats.p95), atMax: capitalRatioAt(priceRatioStats.max),
      atCurrentSnapshot: capitalRatioAt(c4Decomposition.indexRatio as number),
    };
  }

  const c4Limitations = [
    '現時点(runTimestampUTC)のvega/gamma/spread/流動性スナップショットを、必要資本の算出に用いている。過去時点のvega・過去のスプレッドはDeribit APIから取得不可（事実）。',
    '必要資本比は定数ではなく、ETH/BTC価格比・相対IV・残存日数の関数である（C4-1/C4-2参照）。',
    '本スクリプトを再実行すると異なる代表満期/strike/greeksが選ばれる可能性があり、その場合C2〜C4の数値も変動する（VRP系列自体の定義・CVaR/f/母集団の定義は不変）。',
  ];

  // ---- 10. 日次VRP水準系列（永続化のみ・相関は計算しない） ----
  log('\n>>> 10. 日次VRP水準系列構築（BTC・ETH・Stage1相関測定用の永続化のみ）');
  const btcDailyVrp = buildDailyVrpSeries(dvolByDateBtc, priceBtc.closeByDate);
  const ethDailyVrp = buildDailyVrpSeries(dvolByDateEth, priceEth.closeByDate);
  log(`  BTC日次VRP件数=${btcDailyVrp.length}（${btcDailyVrp[0]?.date}〜${btcDailyVrp[btcDailyVrp.length - 1]?.date}）`);
  log(`  ETH日次VRP件数=${ethDailyVrp.length}（${ethDailyVrp[0]?.date}〜${ethDailyVrp[ethDailyVrp.length - 1]?.date}）`);

  // ============================================================
  // 出力1: stage0-eth-vrp-series.json
  // ============================================================
  const seriesOutput = {
    experiment: 'EXP-OBS000041',
    stage: 'Stage 0',
    gate: 'G0-C0 + 系列永続化',
    scriptPath: 'scripts/vrp-eth-stage0-economics.ts',
    specReference: 'research/EXP-OBS000041/00-spec-stage0.md §2, §3-3, §5-2',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    params: PARAMS,
    readOnlyInputs: { stage1PredictionUnitPath: 'research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json', stage1RunTimestampUTC: stage1RunTimestamp, stage1LastDate, note: '読み取り専用参照のみ・書き込みなし（spec §0-3-5）' },
    dataSources: {
      dvolBtc: { totalRows: dvolBtc.rows.length, firstDate: dvolBtc.rows[0]?.date ?? null, lastDate: dvolBtc.rows[dvolBtc.rows.length - 1]?.date ?? null, pageLog: dvolBtc.pageLog },
      dvolEth: { totalRows: dvolEth.rows.length, firstDate_measured: ethDvolEarliestDate, lastDate: dvolEth.rows[dvolEth.rows.length - 1]?.date ?? null, pageLog: dvolEth.pageLog },
      priceBtc: { instrument: 'BTC-PERPETUAL', requestUrl: priceBtc.requestUrl, ticksReturned: priceBtc.ticksReturned, rawTickHourUtc: priceBtc.rawTickHourUtc, status: priceBtc.status },
      priceEth: { instrument: 'ETH-PERPETUAL', requestUrl: priceEth.requestUrl, ticksReturned: priceEth.ticksReturned, rawTickHourUtc: priceEth.rawTickHourUtc, status: priceEth.status },
      pagingPolicyNote: '終了条件は空応答またはcontinuation null/undefinedのみ。「返却件数<limit終了」は使用していない（spec §9-8）。',
    },
    anchorDecision: {
      btcAnchor: PARAMS.anchorDateBtc,
      ethDvolEarliestMeasured: ethDvolEarliestDate,
      ethMainSeriesAnchor: ethMainAnchor,
      ethMainSeriesAnchorRule: 'ETH DVOL実起点が2021-03-24より後の場合、2021-03-24と同位相(日数差が7の倍数)となる最初の日付を採用（spec §2-1・回す前に固定）。',
      ethAnchorPhaseDaysDiff: ethAnchorPhaseDaysDiff,
      ethReferenceSeriesAnchor_disclosureOnly: ethReferenceAnchor,
      note: 'ETH参考系列（実起点アンカー）は開示のみで判定に使用しない（spec §2-1）。判定に使うのは主系列（アンカー' + ethMainAnchor + '）のみ。',
    },
    lookaheadSelfCheck: { btcViolations: btcLookaheadViolations, ethViolations: ethLookaheadViolations, note: '各週次点のRV_forward計算に使用した価格日付が全て対象日より後であることの自己点検。違反件数0が期待値。' },
    g0c0_btcRegressionReproduction: {
      truncationRule: `Stage1 mainSeries.weeklyPoints のうちvrpが非nullの最終date(${stage1LastNonNullDate})以前に切り詰め（主比較）。生配列自体の最終date(${stage1LastDate})はStage1実行時点でRV_forward計算に必要な未来価格が未確定でありvrp=nullだった境界点のため、主比較の基準には用いない（本スクリプト実行時点が十分後の場合、生配列最終dateでの再計算では非null化しうるため。参考値をc0_rawLastDateVariantDisclosureOnlyに併記）。`,
      c0_1_n: { mine: c0_n, expected: 276, match: c0_n === 276 },
      c0_2_meanVrp: { mine: c0_meanVrp, expected: c0_expectedMeanVrp, absDiff: c0_absDiff, thresholdAbs: 1.0e-4 },
      c0_3_dateListMatch: { mineCount: myDates.length, stage1Count: stage1Dates.length, mismatchCount: dateMismatch.length, mismatches: dateMismatch },
      c0_4_lookaheadViolations: { btc: btcLookaheadViolations, eth: ethLookaheadViolations },
      c0_rawLastDateVariantDisclosureOnly: c0_rawVariant,
    },
    btcMainSeries: { label: 'BTC週次VRP主系列（本Stage0で独立再構築・アンカー2021-03-24）', weeklyPoints: btcMainWeeklyFull, descriptiveStatsOnly: btcC3?.descriptiveStatsOnly ?? null },
    ethMainSeries: { label: `ETH週次VRP主系列（アンカー${ethMainAnchor}・BTCと同位相・判定に使用）`, weeklyPoints: ethMainWeeklyFull, descriptiveStatsOnly: ethC3?.descriptiveStatsOnly ?? null },
    ethReferenceSeries_disclosureOnly: { label: `ETH週次VRP参考系列（アンカー${ethReferenceAnchor}=ETH DVOL実起点・判定不使用）`, weeklyPoints: ethReferenceWeekly },
    dailyVrpLevelSeries: {
      note: 'Stage1(必須条件A・ETH-BTC相関)の入力として永続化のみ。`date`(UTC・YYYY-MM-DD)をユニークキーとし、research/EXP-OBS000037/10-result/stage1-vrp-tail-correlation.jsonと同一日付表記でjoin可能。Stage0では相関を計算しない（spec §8-1）。',
      btc: btcDailyVrp,
      eth: ethDailyVrp,
    },
    stage0ScopeRestrictionNote: '選定/確認分割の集計・Sharpe(√52)・block-bootstrap・permutation・有意性検定・ETH-BTC相関・離散化サイジングはいずれも出力していない（spec §7-1・§9-10）。',
  };
  const seriesPath = join(RESULT_DIR, 'stage0-eth-vrp-series.json');
  writeFileSync(seriesPath, JSON.stringify(seriesOutput, null, 2));
  log(`\n>>> 保存: ${seriesPath}`);

  // ============================================================
  // 出力2: stage0-economics-snapshot.json
  // ============================================================
  const snapshotOutput = {
    experiment: 'EXP-OBS000041',
    stage: 'Stage 0',
    gate: 'G0-C1 + G0-C2 + G0-C3 + G0-C4',
    scriptPath: 'scripts/vrp-eth-stage0-economics.ts',
    specReference: 'research/EXP-OBS000041/00-spec-stage0.md §3-4〜§3-7, §5-2',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    params: PARAMS,
    g0c1_sameTimeSnapshot: {
      runIdentifier: RUN_TIMESTAMP,
      btc: {
        snapshotStartUTC: btcSnapshotStartUTC, snapshotEndUTC: btcSnapshotEndUTC,
        selectionMethod: btcAtm.method, unavailableReason: btcAtm.unavailableReason ?? null,
        selectedExpiryIso: btcRepExpiry ? new Date(btcRepExpiry.expiryTimestamp).toISOString() : null,
        residualDays: btcRepExpiry?.residualDays ?? null,
        selectedStrike: btcAtm.strike, indexPriceAtSelection: btcAtm.indexPriceAtSelection,
        call: btcAtm.call, put: btcAtm.put,
        candidateLog: btcAtm.candidateLog, diagLog: btcAtm.diagLog,
        perpTicker: btcPerpTicker.ticker, perpOrderBook: btcPerpOrderBook,
      },
      eth: {
        snapshotStartUTC: ethSnapshotStartUTC, snapshotEndUTC: ethSnapshotEndUTC,
        selectionMethod: ethAtm.method, unavailableReason: ethAtm.unavailableReason ?? null,
        selectedExpiryIso: ethRepExpiry ? new Date(ethRepExpiry.expiryTimestamp).toISOString() : null,
        residualDays: ethRepExpiry?.residualDays ?? null,
        selectedStrike: ethAtm.strike, indexPriceAtSelection: ethAtm.indexPriceAtSelection,
        call: ethAtm.call, put: ethAtm.put,
        candidateLog: ethAtm.candidateLog, diagLog: ethAtm.diagLog,
        perpTicker: ethPerpTicker.ticker, perpOrderBook: ethPerpOrderBook,
      },
      c1_2_sameness: { diffMinutes: c1DiffMinutes, sameUtcDay: c1SameUtcDay, thresholdMinutes: PARAMS.c1SamenessMaxMinutes },
      c1_3_fallbackUsedCount: (btcAtm.method === 'unavailable' ? 1 : 0) + (ethAtm.method === 'unavailable' ? 1 : 0),
      c1_4_residualDaysComparison: { btcResidualDays: btcRepExpiry?.residualDays ?? null, ethResidualDays: ethRepExpiry?.residualDays ?? null, ratio: c1ResidualRatio, sqrtRatio: c1ResidualRatio !== null ? Math.sqrt(c1ResidualRatio) : null },
    },
    g0c2_cRealConstruction: {
      officialFeePageProbe,
      c2_1_commissionRates: {
        btc: { optionCall: btcOptionsCost?.detail, perp: btcPerpCommission },
        eth: { optionCall: ethOptionsCost?.detail, perp: ethPerpCommission },
        note: 'ETHの手数料率はBTC値を流用せず get_instruments から資産別に実測（spec D7・§9-7）。',
      },
      c2_2_spreadSlippage: {
        btc: { optionSpread: { callBidAsk: btcAtm.call ? [btcAtm.call.bestBid, btcAtm.call.bestAsk] : null, putBidAsk: btcAtm.put ? [btcAtm.put.bestBid, btcAtm.put.bestAsk] : null }, perpSpreadBps: btcPerpOrderBook.spreadBps, slippagePrimary100k: btcSlippagePrimary, slippageReference10k: btcSlippageReference },
        eth: { optionSpread: { callBidAsk: ethAtm.call ? [ethAtm.call.bestBid, ethAtm.call.bestAsk] : null, putBidAsk: ethAtm.put ? [ethAtm.put.bestBid, ethAtm.put.bestAsk] : null }, perpSpreadBps: ethPerpOrderBook.spreadBps, slippagePrimary100k: ethSlippagePrimary, slippageReference10k: ethSlippageReference },
      },
      c2_3_hedgeCost: { btc: btcHedgeCost, eth: ethHedgeCost, hedgeRebalancesPerWeek: PARAMS.hedgeRebalancesPerWeek },
      c2_4_costRealTable: {
        btc: { C_options_volpt: btcOptionsCost?.costVolPt ?? null, C_hedge_volpt_mean: btcHedgeCost?.meanCostVolPt ?? null, C_real_volpt: btcCReal },
        eth: { C_options_volpt: ethOptionsCost?.costVolPt ?? null, C_hedge_volpt_mean: ethHedgeCost?.meanCostVolPt ?? null, C_real_volpt: ethCReal },
        labPlaceholderVolPtPerWeek,
      },
    },
    g0c3_cvarSizingCapital: {
      btc: btcC3, eth: ethC3,
      note: '§3-6 C3-5: 単一比率のみの報告禁止。C3-1〜C3-4全項目をセットで出力している。テール1単位あたりプレミアム(C3-4)は開示のみ・採否に使わない（spec §0-4・D17）。',
    },
    g0c4_dependencyDisclosure: {
      c4_1_vegaRatioDecomposition: c4Decomposition,
      c4_2_priceRatioHistoricalRange: priceRatioStats,
      c4_2_requiredCapitalRatioRange: requiredCapitalRatioRange,
      c4_3_limitations: c4Limitations,
    },
    scopeConstraintNote: 'f=0.5固定・週次リスク予算2.0%固定・下側5%ES固定・母集団=主系列全期間(テール窓含む)固定。感度分析としても他の値は出力していない（spec §0-4）。',
  };
  const snapshotPath = join(RESULT_DIR, 'stage0-economics-snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify(snapshotOutput, null, 2));
  log(`>>> 保存: ${snapshotPath}`);

  // ============================================================
  // 出力3: stage0-economics-params.json
  // ============================================================
  const paramsPath = join(RESULT_DIR, 'stage0-economics-params.json');
  writeFileSync(paramsPath, JSON.stringify(PARAMS, null, 2));
  log(`>>> 保存: ${paramsPath}`);

  // ============================================================
  // 出力4: run.log
  // ============================================================
  const runLogPath = join(RESULT_DIR, 'stage0-eth-run.log');
  appendFileSync(runLogPath, [
    '='.repeat(70),
    `=== vrp-eth-stage0-economics.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`, `Node version: ${process.version}`, '',
    'REPRODUCTION COMMAND:', '  node --experimental-strip-types scripts/vrp-eth-stage0-economics.ts',
    '  ⚠ 代表満期・ATM選定・vega/gamma/spread/流動性は実行時点のDeribitライブスナップショット依存。',
    '  再実行すると異なる満期/strike/greeksを選ぶ可能性があり、C2〜C4以降の数値も変わる（VRP系列の定義・CVaR/f/母集団の定義は不変）。', '',
    'EXECUTION LOG:', ...executionLog, '',
  ].join('\n'));
  log(`>>> 保存: ${runLogPath}`);

  log('\n=== 実行完了（G0-C0〜C4・判定なし・生データのみ） ===');
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
