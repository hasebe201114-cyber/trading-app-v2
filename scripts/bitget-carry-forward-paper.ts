/**
 * EXP-OBS000032 フォワード較正フェーズ（Bitgetペーパートレード ≥90日・F1〜F4）
 * spec: research/EXP-OBS000032/00-spec-forward-calibration.md
 *
 * 実資金・実発注は一切行わない（ペーパートレード）。Bitget公開API（認証不要）から
 * 日次で現物/perp last/perp mark/fundingを取得し、Stage 1で採用したW=7シグナル・
 * 3倍レバレッジ・凍結w*（BTC3.629/ETH3.789）のデルタニュートラル仮想ポジションを
 * Stage 1バグF/G根治版・方式I会計（carry-liquidation-sim.tsと同一ロジック）で日次評価する。
 *
 * ⚠ このスクリプトは「1回実行すれば90日分完成する」ものではない。
 *   「毎日（または定期的に）実行することでライブデータが1日ずつ蓄積される」設計。
 *   初回実行＝warmup back-fill(≤30日)+go-live確定。F1〜F4評価はgo-live以降のライブ≥90暦日のみ。
 *
 * 実行:
 *   node --experimental-strip-types scripts/bitget-carry-forward-paper.ts
 *
 * 引数なし・冪等（同一UTC日に複数回実行しても二重追記しない）。
 * APIキー・.env.local は読まない（公開APIのみ）。
 *
 * F2イベントペア（forward-f2-event-pairs-{btc,eth}.{csv,json}）は増分マージ方式（差し戻し是正
 * 20-review-f2-recheck.md 対応）。毎回のフェッチ窓（go-live起点〜Bitget90日制限で頭打ち）で取得した
 * ペアを、既存永続化ファイルと event_hour_utc キーでユニーク結合してから書き出す。全上書きはしない
 * ＝day90到達時にF2ゲート算出の母集団が消えることはない。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
// FORWARD_PAPER_TEST_RESULT_DIR: 自己確認・単体テスト専用の出力先上書き（絶対パス）。
// 未設定時は常に本番の research/EXP-OBS000032/10-result/forward を使う（デフォルト挙動は不変）。
// 本番実行でこの環境変数を設定してはならない。
const RESULT_DIR = process.env.FORWARD_PAPER_TEST_RESULT_DIR
  ? process.env.FORWARD_PAPER_TEST_RESULT_DIR
  : join(__dirname, '..', 'research', 'EXP-OBS000032', '10-result', 'forward');
mkdirSync(RESULT_DIR, { recursive: true });

const RUN_TIMESTAMP = new Date().toISOString();
const executionLog: string[] = [];
function log(msg: string): void {
  console.log(msg);
  executionLog.push(`[${new Date().toISOString()}] ${msg}`);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// §0-3 固定パラメータ（spec本文の値でハードコード。フォワードで一切変更しない）
// ============================================================
const LEVERAGE = 3;
const IMR = 1 / LEVERAGE; // 0.3333...
const MMR = 0.005; // 業界標準の仮置き（Bitget API非配信・「Bitget API取得」ではない）
const ANNUAL_CAPITAL_COST_RATE = 0.04;
const W_STAR: Record<'BTC' | 'ETH', number> = { BTC: 3.629, ETH: 3.789 };
const COSTS: Record<'BTC' | 'ETH', { reversalFourLegBps: number; perLegBps: number }> = {
  BTC: { reversalFourLegBps: 24.064, perLegBps: 6.016 },
  ETH: { reversalFourLegBps: 24.224, perLegBps: 6.056 },
};
const SMA_WINDOW = 7;

// バックテスト参照値（Stage 1確定・出典明記。フォワードで再算出しない）
const BACKTEST_REFERENCE: Record<'BTC' | 'ETH', {
  calmMeanDailyNetCarryBps: number;
  fullMeanDailyNetCarryBps: number;
  t1BasisDailyDeltaStdBps: number;
  calmBasisDailyDeltaStdBps: number;
  g02SignAgreementPct: number;
}> = {
  BTC: {
    calmMeanDailyNetCarryBps: 11.624505211935004, // stage1-net-expectation-btc.json periodSummaries[calm]
    fullMeanDailyNetCarryBps: 1.5856405525996293, // stage1-net-expectation-btc.json periodSummaries[FULL]
    t1BasisDailyDeltaStdBps: 12.137769741412779, // g0-1-tail-reachability.json BTCUSDT.T1_basis.daily_delta_std_bps
    calmBasisDailyDeltaStdBps: 5.0751820750473895, // g0-1-tail-reachability.json BTCUSDT.calm_basis.daily_delta_std_bps
    g02SignAgreementPct: 64.68, // g0-2-exchange-representativeness.json BTCUSDT sign_agreement_pct
  },
  ETH: {
    calmMeanDailyNetCarryBps: 14.397660815926988,
    fullMeanDailyNetCarryBps: 2.367896700535934,
    t1BasisDailyDeltaStdBps: 19.466313052751875,
    calmBasisDailyDeltaStdBps: 8.696701924612116,
    g02SignAgreementPct: 71.75,
  },
};

const BOOTSTRAP_CONFIG = { blockLengthDays: 7, resamplingCount: 5000, seed: 20260705, percentile: 10 };
const PROJECTION_TARGET_DAYS = 90;
const F2_SIGN_AGREEMENT_THRESHOLD_PCT = 80;
const F2_ROLLING_ALERT_THRESHOLD_PCT = 70;
const F2_ROLLING_WINDOW_PAIRS = 30;
const CARRY_NEGATIVE_STREAK_ALERT_DAYS = 10;
const DATA_GAP_ALERT_CONSECUTIVE_DAYS = 2;
const WARMUP_DAYS = 30;
const LIVE_DAYS_REQUIRED = 90;
// Bitget無料API history-fund-rateの実務上の遡及可能日数上限（差し戻し是正 20-review-f2-recheck.md §3 (b)で明記の制約）。
// F2イベントペア再構築窓（フェッチ窓拡張）の下限に用いる。増分マージ（writeF2EventPairs）と併用することで
// 「毎回この日数分しか遡らない」ことによる欠落を、既存永続化ファイルとのマージで補う設計。
const BITGET_FUNDING_HISTORY_LIMIT_DAYS = 90;

const CALM_WINDOW = { start: '2021-01-01', end: '2021-06-30' };

// ============================================================
// 日付ユーティリティ（UTC暦日のみ）
// ============================================================
function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function keyToDate(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}
function addDays(key: string, n: number): string {
  return dateKey(new Date(keyToDate(key).getTime() + n * 86400000));
}
function todayUTCKey(): string {
  return dateKey(new Date());
}
/** 最後に完全に経過したUTC日（=今日ではなく昨日）。当日の途中経過candleを使わないための設計判断。 */
function anchorDateKey(): string {
  return addDays(todayUTCKey(), -1);
}
function dateRange(startKey: string, endKeyInclusive: string): string[] {
  const out: string[] = [];
  let cur = startKey;
  while (cur <= endKeyInclusive) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// ============================================================
// Bitget / Binance 公開API fetch
// ============================================================
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\n${text.slice(0, 300)}`);
  }
  return res.json();
}

interface DailyCandle { date: string; close: number; }

/** Bitget spot 日足終値（1Dutc・単発リクエスト。limitで十分な日数を確保） */
async function fetchBitgetSpotDaily(symbol: string, limit: number): Promise<DailyCandle[]> {
  const url = `https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=1Dutc&limit=${limit}`;
  log(`  GET ${url}`);
  const data = await fetchJson(url) as { code?: string; data?: string[][] };
  const rows = Array.isArray(data.data) ? data.data : [];
  log(`  spot candles received: ${rows.length}件`);
  return rows.map(r => ({ date: dateKey(new Date(parseInt(r[0], 10))), close: parseFloat(r[4]) }));
}

/** Bitget perp last 日足終値（mix history-candles・1Dutc） */
async function fetchBitgetPerpLastDaily(symbol: string, limit: number): Promise<DailyCandle[]> {
  const url = `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1Dutc&limit=${limit}`;
  log(`  GET ${url}`);
  const data = await fetchJson(url) as { code?: string; data?: string[][] };
  const rows = Array.isArray(data.data) ? data.data : [];
  log(`  perp last candles received: ${rows.length}件`);
  return rows.map(r => ({ date: dateKey(new Date(parseInt(r[0], 10))), close: parseFloat(r[4]) }));
}

/** Bitget perp mark 日足終値（mix history-mark-candles・1Dutc）。取得失敗時は空配列を返しlast代用にフォールバック */
async function fetchBitgetPerpMarkDaily(symbol: string, limit: number): Promise<{ rows: DailyCandle[]; available: boolean; error?: string }> {
  const url = `https://api.bitget.com/api/v2/mix/market/history-mark-candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1Dutc&limit=${limit}`;
  log(`  GET ${url}`);
  try {
    const data = await fetchJson(url) as { code?: string; data?: string[][] };
    const rows = Array.isArray(data.data) ? data.data : [];
    log(`  perp mark candles received: ${rows.length}件`);
    if (rows.length === 0) return { rows: [], available: false, error: 'empty data array' };
    return { rows: rows.map(r => ({ date: dateKey(new Date(parseInt(r[0], 10))), close: parseFloat(r[4]) })), available: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  ERROR mark candles: ${msg}`);
    return { rows: [], available: false, error: msg };
  }
}

interface FundingEvent { timestampMs: number; date: string; rate: number; }

/**
 * Bitget history-fund-rate ページング取得。
 * ⚠ ページングバグ非再発: 空応答(0件)で終了する。`length < pageSize` を終了条件に使わない。
 * カーソル前進・返却件数を生ログに残す。
 */
async function fetchBitgetFundingHistoryUntil(symbol: string, untilDateInclusive: string): Promise<FundingEvent[]> {
  const rows: FundingEvent[] = [];
  let pageNo = 1;
  const pageSize = 100;
  const maxPages = 10; // 100件/page * 10 = 1000件 ≈ 333日分。warmup(30日)+SMA seed(7日)+バッファに十分
  let oldestSeenMs = Infinity;
  let cursorAdvanced = true;

  while (pageNo <= maxPages && cursorAdvanced) {
    const url = `https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${symbol}&productType=USDT-FUTURES&pageSize=${pageSize}&pageNo=${pageNo}`;
    const data = await fetchJson(url) as { code?: string; data?: { fundingTime?: string; fundingRate?: string }[] };
    const items = Array.isArray(data.data) ? data.data : [];
    log(`  Bitget funding ${symbol}: page${pageNo} 返却${items.length}件`);
    if (items.length === 0) {
      log(`  Bitget funding ${symbol}: page${pageNo} 空応答で終了（cursorカーソル前進チェック無効化条件）`);
      break;
    }
    let pageOldestMs = Infinity;
    for (const it of items) {
      const ms = parseInt(it.fundingTime || '0', 10);
      const rate = parseFloat(it.fundingRate || '0');
      rows.push({ timestampMs: ms, date: dateKey(new Date(ms)), rate });
      if (ms < pageOldestMs) pageOldestMs = ms;
    }
    cursorAdvanced = pageOldestMs < oldestSeenMs;
    oldestSeenMs = Math.min(oldestSeenMs, pageOldestMs);
    log(`  Bitget funding ${symbol}: page${pageNo} oldest=${new Date(pageOldestMs).toISOString()} cursorAdvanced=${cursorAdvanced}`);
    const oldestDateStr = dateKey(new Date(oldestSeenMs));
    if (oldestDateStr <= untilDateInclusive) {
      log(`  Bitget funding ${symbol}: 目標窓(${untilDateInclusive})をカバー。取得終了`);
      break;
    }
    pageNo++;
    await sleep(250);
  }
  return rows;
}

/** Bitget current-fund-rate（診断用スナップショットのみ。ledger会計には使わない＝§理由はrun.log/metaに明記） */
async function fetchBitgetCurrentFundRate(symbol: string): Promise<Record<string, unknown> | null> {
  try {
    const url = `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=USDT-FUTURES`;
    const data = await fetchJson(url) as { data?: unknown[] };
    return Array.isArray(data.data) && data.data.length > 0 ? (data.data[0] as Record<string, unknown>) : null;
  } catch (err) {
    log(`  WARNING current-fund-rate取得失敗 ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Binance funding history（F2用同時取得。認証不要）
 * ⚠ GitHub Actions（米国IP）では fapi.binance.com が 451 を返す。
 *   BINANCE_PROXY_URL / BINANCE_PROXY_TOKEN が設定されている場合は、東京リージョンの
 *   Cloud Functionsプロキシ（functions/index.js の binanceFundingProxy）経由でfundingRateを
 *   中継取得する（地理ブロック回避）。未設定時（ローカル実行等）は従来通り直接fapi.binance.comを叩く。
 *   それでも451/403が出た場合はグレースフルスキップ→空配列を返す（F2イベントペアの既存永続化ファイルは保持）。
 *   それ以外のHTTPエラーは通常通りthrowする。
 */
async function fetchBinanceFundingHistory(symbol: string, startTimeMs: number, endTimeMs: number): Promise<FundingEvent[]> {
  const proxyUrl = process.env.BINANCE_PROXY_URL;
  const proxyToken = process.env.BINANCE_PROXY_TOKEN;
  const params = `symbol=${symbol}&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=1000`;
  const url = proxyUrl ? `${proxyUrl}?${params}` : `https://fapi.binance.com/fapi/v1/fundingRate?${params}`;
  log(`  GET ${url}${proxyUrl ? ' (via binanceFundingProxy)' : ''}`);
  try {
    const res = await fetch(url, proxyUrl && proxyToken ? { headers: { 'x-proxy-token': proxyToken } } : undefined);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} for ${url}\n${text.slice(0, 300)}`);
    }
    const data = await res.json() as { fundingTime: number; fundingRate: string }[];
    log(`  Binance funding ${symbol}: ${data.length}件`);
    return data.map(d => ({ timestampMs: d.fundingTime, date: dateKey(new Date(d.fundingTime)), rate: parseFloat(d.fundingRate) }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('HTTP 451') || msg.includes('HTTP 403')) {
      log(`  ⚠ WARN Binance funding ${symbol}: ジオブロック（${msg.split('\n')[0]}）— F2イベントペア取得スキップ（既存ファイル保持）`);
      return [];
    }
    throw err;
  }
}

// ============================================================
// データ集約
// ============================================================
interface AssetMarketData {
  spot: Map<string, number>;
  perpLast: Map<string, number>;
  perpMark: Map<string, number>;
  markAvailable: boolean;
  markError?: string;
  fundingBitgetDailyBps: Map<string, number>;
  fundingBitgetEvents: FundingEvent[];
  fundingBinanceDailyBps: Map<string, number>;
  fundingBinanceEvents: FundingEvent[];
  currentFundRateSnapshot: Record<string, unknown> | null;
}

function sumDailyBps(events: FundingEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of events) {
    m.set(e.date, (m.get(e.date) || 0) + e.rate * 10000);
  }
  return m;
}

async function fetchAssetMarketData(symbol: string, windowStartKey: string, windowEndKey: string): Promise<AssetMarketData> {
  const candleLimit = 200; // 1Dutc・単発で十分な日数（>windowの日数）を確保
  const spotRows = await fetchBitgetSpotDaily(symbol, candleLimit);
  await sleep(300);
  const perpLastRows = await fetchBitgetPerpLastDaily(symbol, candleLimit);
  await sleep(300);
  const markResult = await fetchBitgetPerpMarkDaily(symbol, candleLimit);
  await sleep(300);
  const bitgetFunding = await fetchBitgetFundingHistoryUntil(symbol, windowStartKey);
  await sleep(300);
  const binanceStartMs = keyToDate(windowStartKey).getTime();
  const binanceEndMs = keyToDate(windowEndKey).getTime() + 86400000;
  const binanceFunding = await fetchBinanceFundingHistory(symbol, binanceStartMs, binanceEndMs);
  await sleep(300);
  const currentFundRateSnapshot = await fetchBitgetCurrentFundRate(symbol);

  const spot = new Map(spotRows.map(r => [r.date, r.close]));
  const perpLast = new Map(perpLastRows.map(r => [r.date, r.close]));
  const perpMark = new Map(markResult.rows.map(r => [r.date, r.close]));

  return {
    spot,
    perpLast,
    perpMark,
    markAvailable: markResult.available,
    markError: markResult.error,
    fundingBitgetDailyBps: sumDailyBps(bitgetFunding),
    fundingBitgetEvents: bitgetFunding,
    fundingBinanceDailyBps: sumDailyBps(binanceFunding),
    fundingBinanceEvents: binanceFunding,
    currentFundRateSnapshot,
  };
}

// ============================================================
// 会計（Stage 1 carry-liquidation-sim.ts 方式I会計を踏襲。新会計を発明しない）
// ============================================================
interface LedgerRow {
  date_utc: string;
  phase: 'warmup' | 'live';
  spot_close: number | null;
  perp_last: number | null;
  perp_mark: number | null;
  mark_source: 'mark' | 'last-substitute';
  basis_bps: number | null;
  funding_rate_daily_bps: number;
  sma7_funding_bps: number;
  signal_pos: number;
  reversal_flag: 0 | 1;
  perp_short_mtm_bps: number;
  funding_flow_bps: number;
  spot_leg_pnl_bps: number;
  reversal_cost_bps: number;
  capital_cost_bps: number;
  reconstruction_cost_bps: number;
  daily_net_pnl_bps: number;
  cumulative_net_pnl_bps: number;
  margin_ratio: number;
  imr: number;
  mmr: number;
  liquidation_flag: 0 | 1;
  margin_call_flag: 0 | 1;
  sleeve_daily_return_pct: number;
  sleeve_cumulative_return_pct: number;
  binance_funding_daily_bps: number;
  // 1=一致, 0=不一致, null=当日データ無し。
  // ⚠ この列は spec §3-1 が定義する「日次ledger」フォーマット（1行=1UTC日）上の日次合算(Bitget/Binance funding_daily_bps)
  // ベースの参考値であり、F2ゲート（spec §4-F2）の算出には使わない。F2ゲートの唯一の算出元は
  // 8hイベント単位で全ペアを永続化した forward-f2-event-pairs-{asset}.{csv,json}（pairEventsForSignCheck）。
  f2_pair_sign_match: number | null;
  data_gap_flag: 0 | 1;
}

interface RunningState {
  marginBps: number;
  cumulativeNetPnlBps: number;
  cumulativeSleevePct: number;
  prevSignal: number | null;
  prevSpotClose: number | null;
  prevPerpLastClose: number | null;
  prevPerpMarkClose: number | null;
}

function computeSma7FundingBps(dates: string[], idx: number, fundingMap: Map<string, number>): { sma: number; missing: number } {
  let sum = 0;
  let missing = 0;
  for (let k = 1; k <= SMA_WINDOW; k++) {
    const d = addDays(dates[idx], -k);
    const v = fundingMap.get(d);
    if (v === undefined) missing++;
    else sum += v;
  }
  return { sma: sum / SMA_WINDOW, missing };
}

function processDay(
  assetCode: 'BTC' | 'ETH',
  date: string,
  phase: 'warmup' | 'live',
  data: AssetMarketData,
  state: RunningState,
  allDatesForSma: string[],
  smaIdx: number,
): LedgerRow {
  const costs = COSTS[assetCode];
  const wStar = W_STAR[assetCode];
  const dailyCapitalCostBps = (ANNUAL_CAPITAL_COST_RATE / LEVERAGE / 365) * 10000;

  const spotClose = data.spot.get(date) ?? null;
  const perpLastClose = data.perpLast.get(date) ?? null;
  const perpMarkAvailableForDay = data.markAvailable && data.perpMark.has(date);
  const perpMarkClose = perpMarkAvailableForDay ? (data.perpMark.get(date) as number) : perpLastClose;
  const markSource: 'mark' | 'last-substitute' = perpMarkAvailableForDay ? 'mark' : 'last-substitute';

  const fundingDailyBps = data.fundingBitgetDailyBps.get(date) ?? 0;
  const binanceFundingDailyBps = data.fundingBinanceDailyBps.get(date) ?? 0;

  const dataGap = spotClose === null || perpLastClose === null || perpMarkClose === null || !data.fundingBitgetDailyBps.has(date);

  const { sma: sma7 } = computeSma7FundingBps(allDatesForSma, smaIdx, data.fundingBitgetDailyBps);
  const rawSignal = sma7 > 0 ? 1 : sma7 < 0 ? -1 : 0;
  const pos = rawSignal === -1 ? -1 : 1;

  const basisBps = spotClose !== null && perpLastClose !== null ? ((perpLastClose - spotClose) / spotClose) * 10000 : null;

  let spotReturn = 0;
  let perpMarkReturn = 0;
  if (spotClose !== null && state.prevSpotClose !== null && state.prevSpotClose !== 0) {
    spotReturn = spotClose / state.prevSpotClose - 1;
  }
  if (perpMarkClose !== null && state.prevPerpMarkClose !== null && state.prevPerpMarkClose !== 0) {
    perpMarkReturn = perpMarkClose / state.prevPerpMarkClose - 1;
  }

  const spotLegPnlBps = pos * spotReturn * 10000;
  const perpShortMtmBaseBps = -(perpMarkReturn * 10000);
  const perpLegMtmBps = pos * perpShortMtmBaseBps;
  const fundingFlowBps = pos * fundingDailyBps;

  let reversalCostBps = 0;
  if (state.prevSignal !== null && state.prevSignal !== rawSignal && state.prevSignal !== 0 && rawSignal !== 0) {
    reversalCostBps = costs.reversalFourLegBps;
  }
  const reversalFlag: 0 | 1 = reversalCostBps > 0 ? 1 : 0;

  const marginDeltaBps = perpLegMtmBps + fundingFlowBps;
  const provisionalMarginBps = state.marginBps + marginDeltaBps;
  const flooredMarginBps = Math.max(0, provisionalMarginBps);
  const actualPerpContributionBps = flooredMarginBps - state.marginBps;
  let marginBpsAfterFloor = flooredMarginBps;

  let dailyNetPnlBps = spotLegPnlBps + actualPerpContributionBps - reversalCostBps - dailyCapitalCostBps;

  const marginRatio = marginBpsAfterFloor / 10000;
  let liquidationFlag: 0 | 1 = 0;
  let reconstructionCostBps = 0;
  if (marginBpsAfterFloor < MMR * 10000) {
    liquidationFlag = 1;
    reconstructionCostBps = costs.reversalFourLegBps;
    dailyNetPnlBps -= reconstructionCostBps;
    marginBpsAfterFloor = IMR * 10000; // 再構築でIMRへリセット（次日への繰越）
  }
  const marginCallFlag: 0 | 1 = liquidationFlag; // 方式I分離証拠金では清算と同時（spec §3-1 定義）

  const cumulativeNetPnlBps = state.cumulativeNetPnlBps + dailyNetPnlBps;
  const sleeveDailyReturnPct = (dailyNetPnlBps / 10000) * wStar * 100;
  const cumulativeSleevePct = state.cumulativeSleevePct + sleeveDailyReturnPct;

  // ⚠ 日次合算ベースの参考値（spec §3-1 日次ledgerフォーマット用の列）。F2ゲート判定には使わない
  // （F2ゲートは8hイベント単位で全ペアを永続化した forward-f2-event-pairs-{asset}.{csv,json} を唯一の算出元とする）。
  const f2PairSignMatch = fundingDailyBps === 0 && binanceFundingDailyBps === 0
    ? null
    : Math.sign(fundingDailyBps) === Math.sign(binanceFundingDailyBps) ? 1 : 0;

  const row: LedgerRow = {
    date_utc: date,
    phase,
    spot_close: spotClose,
    perp_last: perpLastClose,
    perp_mark: perpMarkClose,
    mark_source: markSource,
    basis_bps: basisBps,
    funding_rate_daily_bps: fundingDailyBps,
    sma7_funding_bps: sma7,
    signal_pos: pos,
    reversal_flag: reversalFlag,
    perp_short_mtm_bps: perpLegMtmBps,
    funding_flow_bps: fundingFlowBps,
    spot_leg_pnl_bps: spotLegPnlBps,
    reversal_cost_bps: reversalCostBps,
    capital_cost_bps: dailyCapitalCostBps,
    reconstruction_cost_bps: reconstructionCostBps,
    daily_net_pnl_bps: dailyNetPnlBps,
    cumulative_net_pnl_bps: cumulativeNetPnlBps,
    margin_ratio: marginRatio,
    imr: IMR,
    mmr: MMR,
    liquidation_flag: liquidationFlag,
    margin_call_flag: marginCallFlag,
    sleeve_daily_return_pct: sleeveDailyReturnPct,
    sleeve_cumulative_return_pct: cumulativeSleevePct,
    binance_funding_daily_bps: binanceFundingDailyBps,
    f2_pair_sign_match: f2PairSignMatch,
    data_gap_flag: dataGap ? 1 : 0,
  };

  // 状態更新（次日へ繰越）
  state.marginBps = marginBpsAfterFloor;
  state.cumulativeNetPnlBps = cumulativeNetPnlBps;
  state.cumulativeSleevePct = cumulativeSleevePct;
  state.prevSignal = rawSignal;
  if (spotClose !== null) state.prevSpotClose = spotClose;
  if (perpLastClose !== null) state.prevPerpLastClose = perpLastClose;
  if (perpMarkClose !== null) state.prevPerpMarkClose = perpMarkClose;

  return row;
}

// ============================================================
// CSV I/O
// ============================================================
const LEDGER_COLUMNS = [
  'date_utc', 'phase', 'spot_close', 'perp_last', 'perp_mark', 'mark_source',
  'basis_bps', 'funding_rate_daily_bps', 'sma7_funding_bps', 'signal_pos', 'reversal_flag',
  'perp_short_mtm_bps', 'funding_flow_bps', 'spot_leg_pnl_bps', 'reversal_cost_bps',
  'capital_cost_bps', 'reconstruction_cost_bps', 'daily_net_pnl_bps', 'cumulative_net_pnl_bps',
  'margin_ratio', 'imr', 'mmr', 'liquidation_flag', 'margin_call_flag',
  'sleeve_daily_return_pct', 'sleeve_cumulative_return_pct',
  'binance_funding_daily_bps', 'f2_pair_sign_match', 'data_gap_flag',
] as const;

function rowToCsvLine(row: LedgerRow): string {
  return LEDGER_COLUMNS.map(col => {
    const v = (row as unknown as Record<string, unknown>)[col];
    if (v === null || v === undefined) return '';
    return String(v);
  }).join(',');
}

function ledgerPaths(assetLower: string): { csv: string; json: string } {
  return {
    csv: join(RESULT_DIR, `forward-paper-ledger-${assetLower}.csv`),
    json: join(RESULT_DIR, `forward-paper-ledger-${assetLower}.json`),
  };
}

function loadExistingLedger(assetLower: string): LedgerRow[] {
  const { json } = ledgerPaths(assetLower);
  if (!existsSync(json)) return [];
  const content = readFileSync(json, 'utf-8');
  return JSON.parse(content) as LedgerRow[];
}

function writeLedger(assetLower: string, rows: LedgerRow[]): void {
  const { csv, json } = ledgerPaths(assetLower);
  const lines = [LEDGER_COLUMNS.join(','), ...rows.map(rowToCsvLine)];
  writeFileSync(csv, lines.join('\n') + '\n');
  writeFileSync(json, JSON.stringify(rows, null, 2));
}

// ============================================================
// Block-bootstrap（F1b用。spec §4 F1b: ブロック長7・N=5000・seed=20260705・第10パーセンタイル）
// ============================================================
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadCalmDailySeries(assetLower: string): number[] {
  const p = join(__dirname, '..', 'research', 'EXP-OBS000032', '10-result', `stage1-carry-daily-returns-${assetLower}.json`);
  const content = JSON.parse(readFileSync(p, 'utf-8')) as { data: { date: string; pnl_bps: number }[] };
  return content.data.filter(d => d.date >= CALM_WINDOW.start && d.date <= CALM_WINDOW.end).map(d => d.pnl_bps);
}

function blockBootstrapLowerBound(
  calmSeries: number[],
  targetLength: number,
): { lowerBoundBps: number | null; note: string } {
  if (targetLength < 1 || calmSeries.length === 0) {
    return { lowerBoundBps: null, note: 'targetLength(ライブ日数)が0、または calm系列が空のため算出不可' };
  }
  const { blockLengthDays, resamplingCount, seed, percentile } = BOOTSTRAP_CONFIG;
  const rng = mulberry32(seed);
  const n = calmSeries.length;
  const effectiveBlockLen = Math.min(blockLengthDays, n);
  const maxStart = Math.max(0, n - effectiveBlockLen);
  const means: number[] = [];
  for (let iter = 0; iter < resamplingCount; iter++) {
    const resample: number[] = [];
    while (resample.length < targetLength) {
      const start = maxStart > 0 ? Math.floor(rng() * (maxStart + 1)) : 0;
      const block = calmSeries.slice(start, start + effectiveBlockLen);
      resample.push(...block);
    }
    const trimmed = resample.slice(0, targetLength);
    const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    means.push(mean);
  }
  means.sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((percentile / 100) * resamplingCount) - 1);
  return {
    lowerBoundBps: means[idx],
    note: `block-bootstrap: calm系列n=${n}日, blockLen=${effectiveBlockLen}, N=${resamplingCount}, seed=${seed}, targetLength(=ライブ日数)=${targetLength}, 第${percentile}パーセンタイル`,
  };
}

// ============================================================
// 90日予測収益試算（projection90d）
// 同じcalm系列・同じblock-bootstrapパラメータでtargetLength=90固定で回し、
// P10/P50/P90累積キャリーbpsと年率換算を返す。ライブday30未満は試験値。
// ============================================================
interface Projection90dResult {
  basedOnLiveDays: number;
  reliabilityNote: string;
  p10_cumBps: number | null;
  p50_cumBps: number | null;
  p90_cumBps: number | null;
  p50_annualReturnPct: number | null;
  vsBacktestFullPeriodPct: number | null;
  bootstrapNote: string;
}

function computeProjection90d(
  calmSeries: number[],
  liveDaysCount: number,
  wStar: number,
  fullMeanDailyNetCarryBps: number,
): Projection90dResult {
  if (calmSeries.length === 0) {
    const note = 'calm系列が空のため算出不可';
    return { basedOnLiveDays: liveDaysCount, reliabilityNote: note, p10_cumBps: null, p50_cumBps: null, p90_cumBps: null, p50_annualReturnPct: null, vsBacktestFullPeriodPct: null, bootstrapNote: note };
  }

  const { blockLengthDays, resamplingCount, seed } = BOOTSTRAP_CONFIG;
  const rng = mulberry32(seed);
  const n = calmSeries.length;
  const effectiveBlockLen = Math.min(blockLengthDays, n);
  const maxStart = Math.max(0, n - effectiveBlockLen);

  const dailyMeans: number[] = [];
  for (let iter = 0; iter < resamplingCount; iter++) {
    const resample: number[] = [];
    while (resample.length < PROJECTION_TARGET_DAYS) {
      const start = maxStart > 0 ? Math.floor(rng() * (maxStart + 1)) : 0;
      const block = calmSeries.slice(start, start + effectiveBlockLen);
      resample.push(...block);
    }
    const trimmed = resample.slice(0, PROJECTION_TARGET_DAYS);
    dailyMeans.push(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);
  }
  dailyMeans.sort((a, b) => a - b);

  const p10Mean = dailyMeans[Math.max(0, Math.ceil(0.10 * resamplingCount) - 1)];
  const p50Mean = dailyMeans[Math.max(0, Math.ceil(0.50 * resamplingCount) - 1)];
  const p90Mean = dailyMeans[Math.max(0, Math.ceil(0.90 * resamplingCount) - 1)];

  const reliabilityNote = liveDaysCount < 30
    ? `day${liveDaysCount}は試験値・day30以降で信頼度向上`
    : liveDaysCount < 60
    ? `day${liveDaysCount}（中程度信頼度・day60以降でさらに向上）`
    : `day${liveDaysCount}（高信頼度帯）`;

  return {
    basedOnLiveDays: liveDaysCount,
    reliabilityNote,
    p10_cumBps: parseFloat((p10Mean * PROJECTION_TARGET_DAYS).toFixed(1)),
    p50_cumBps: parseFloat((p50Mean * PROJECTION_TARGET_DAYS).toFixed(1)),
    p90_cumBps: parseFloat((p90Mean * PROJECTION_TARGET_DAYS).toFixed(1)),
    p50_annualReturnPct: parseFloat(((p50Mean / 10000) * wStar * 100 * 365).toFixed(1)),
    vsBacktestFullPeriodPct: fullMeanDailyNetCarryBps !== 0
      ? parseFloat(((p50Mean / fullMeanDailyNetCarryBps) * 100).toFixed(0))
      : null,
    bootstrapNote: `block-bootstrap: calm系列n=${n}日, blockLen=${effectiveBlockLen}, N=${resamplingCount}, seed=${seed}, targetLength=${PROJECTION_TARGET_DAYS}日, P10/P50/P90`,
  };
}

// ============================================================
// F1〜F4 暫定計算・中間チェックポイント（真偽値のみ・判定語なし）
// ============================================================
function computeInterimMetricsForAsset(assetCode: 'BTC' | 'ETH', assetLower: string, rows: LedgerRow[], eventPairsAllLive: F2EventPair[]) {
  const liveRows = rows.filter(r => r.phase === 'live');
  const ref = BACKTEST_REFERENCE[assetCode];

  // --- F1 ---
  const liveDailyPnl = liveRows.map(r => r.daily_net_pnl_bps);
  const cumulativeLivePnlBps = liveDailyPnl.reduce((a, b) => a + b, 0);
  const liveDailyMeanBps = liveDailyPnl.length > 0 ? cumulativeLivePnlBps / liveDailyPnl.length : null;
  const calmSeries = loadCalmDailySeries(assetLower);
  const bootstrap = blockBootstrapLowerBound(calmSeries, liveRows.length);
  const projection90d = computeProjection90d(calmSeries, liveRows.length, W_STAR[assetCode], ref.fullMeanDailyNetCarryBps);
  const f1 = {
    liveDaysCount: liveRows.length,
    sufficientSampleFor90dGate: liveRows.length >= LIVE_DAYS_REQUIRED,
    cumulativeLivePnlBps,
    f1a_cumulativePositive: liveRows.length > 0 ? cumulativeLivePnlBps > 0 : null,
    liveDailyMeanBps,
    f1bLowerBoundBps: bootstrap.lowerBoundBps,
    f1bBootstrapNote: bootstrap.note,
    f1b_liveMeanGteLowerBound: liveDailyMeanBps !== null && bootstrap.lowerBoundBps !== null
      ? liveDailyMeanBps >= bootstrap.lowerBoundBps
      : null,
    backtestReference: { calmMeanDailyNetCarryBps: ref.calmMeanDailyNetCarryBps, fullMeanDailyNetCarryBps: ref.fullMeanDailyNetCarryBps },
    note: 'F1a/F1bともにliveDaysCount<90の間は試験値（формула動作確認用）。90日到達後にforward-f1f4-verdict-inputs.jsonへ正式出力。',
  };

  // --- F2（8hイベント単位ベース：Bitget⇔Binanceのfunding符号一致率。spec §4 粒度統一） ---
  // eventPairsAllLive: writeF2EventPairsの増分マージ後の戻り値（ライブ全期間・event_hour_utcで重複排除済み）。
  // 差し戻し是正（20-review-f2-recheck.md）: 従来は当該実行のフェッチ窓分（eventPairsRecent）のみを渡していたため、
  // day90到達時にF2の母集団が消える欠陥があった。現在は永続化ファイルとマージ済みの全ライブペアを渡す。
  const f2PairsEvent = eventPairsAllLive; // 8h イベント単位の全ライブペア
  const f2MatchCountEvent = f2PairsEvent.filter(p => p.match === 1).length;
  const f2AgreementPctEvent = f2PairsEvent.length > 0 ? (f2MatchCountEvent / f2PairsEvent.length) * 100 : null;
  const f2 = {
    liveDaysCount: liveRows.length,
    eventPairsCount: f2PairsEvent.length,
    eventSignAgreementPct: f2AgreementPctEvent,
    f2_gte80pct: f2AgreementPctEvent !== null ? f2AgreementPctEvent >= F2_SIGN_AGREEMENT_THRESHOLD_PCT : null,
    g02BaselineReferencePct: ref.g02SignAgreementPct,
    note: '8hイベント単位(Bitget vs Binance funding符号)の一致率。spec §4-F2「粒度をG0-2と統一」。算出元の全ペア生データは forward-f2-event-pairs-{asset}.{csv,json}（8hイベント単位全ペア）に永続化。日次ledgerの f2_pair_sign_match 列（日次合算）はF2ゲート算出には使わない参考値。ライブ日数<90は試験値。ローリング警告(70%以下)は中間チェックポイント側(§6)に別掲。',
  };

  // --- F3 ---
  const liquidationCount = liveRows.filter(r => r.liquidation_flag === 1).length;
  const marginCallCount = liveRows.filter(r => r.margin_call_flag === 1).length;
  const f3 = {
    liveDaysCount: liveRows.length,
    liquidationCount,
    marginCallCount,
    f3_zeroLiquidationAndMarginCall: liveRows.length > 0 ? (liquidationCount === 0 && marginCallCount === 0) : null,
    note: 'ライブ日数<90は試験値。清算・追証は発生時点で即警告（§6）も別途発火。',
  };

  // --- F4 ---
  const liveBasis = liveRows.filter(r => r.basis_bps !== null).map(r => r.basis_bps as number);
  let liveBasisDailyDeltaStdBps: number | null = null;
  if (liveBasis.length >= 2) {
    const deltas = [];
    for (let i = 1; i < liveBasis.length; i++) deltas.push(Math.abs(liveBasis[i] - liveBasis[i - 1]));
    liveBasisDailyDeltaStdBps = Math.sqrt(deltas.reduce((a, b) => a + b * b, 0) / deltas.length);
  }
  const f4 = {
    liveDaysCount: liveRows.length,
    liveBasisDailyDeltaStdBps,
    t1ThresholdBps: ref.t1BasisDailyDeltaStdBps,
    f4_lteT1Threshold: liveBasisDailyDeltaStdBps !== null ? liveBasisDailyDeltaStdBps <= ref.t1BasisDailyDeltaStdBps : null,
    calmReferenceBps: ref.calmBasisDailyDeltaStdBps,
    note: 'RMS(|Δbasis_bps|)方式（g0-1-tail-reachability.jsonと同一算式）。ライブ日数<90は試験値。basis_bpsはperp_last基準（バックテスト参照値との算式整合のため。mark基準ではない）。',
  };

  return { f1, f2, f3, f4, projection90d };
}

interface Checkpoints {
  immediateLiquidationOrMarginCall: { triggered: boolean; dates: string[] };
  signAgreementRolling30: { pairsAvailable: number; agreementPct: number | null; below70: boolean | null };
  carryPersistentNegative: { cumulativeNegative: boolean; last10AllNegative: boolean | null; triggered: boolean };
  basisSpikeExceedsT1: { rolling30DeltaStdBps: number | null; exceeds: boolean | null };
  dataGapConsecutive: { maxConsecutiveGapDays: number; triggered: boolean };
}

function computeCheckpoints(assetCode: 'BTC' | 'ETH', rows: LedgerRow[], eventPairsAllLive: F2EventPair[]): Checkpoints {
  const ref = BACKTEST_REFERENCE[assetCode];

  const liqDates = rows.filter(r => r.liquidation_flag === 1 || r.margin_call_flag === 1).map(r => r.date_utc);

  // eventPairsAllLive はライブ全期間・重複排除済み（差し戻し是正後）。直近30ペアのローリングは
  // 「本当に直近のイベント」を指すようになる（従来は当該実行のフェッチ窓のみだったため実質フェッチ窓全体だった）。
  // C-2是正：最小サンプルガード（pairsAvailable≥30で無いと スプリアスalert 防止）
  const recentPairs = eventPairsAllLive.slice(-F2_ROLLING_WINDOW_PAIRS);
  const agreementPct = recentPairs.length >= F2_ROLLING_WINDOW_PAIRS ? (recentPairs.filter(p => p.match === 1).length / recentPairs.length) * 100 : null;

  // C-3是正：キャリー持続マイナス判定をライブ限定累積に修正（warmup混入排除）
  const liveRows = rows.filter(r => r.phase === 'live');
  const liveOnlyCumulative = liveRows.reduce((sum, r) => sum + r.daily_net_pnl_bps, 0);
  const cumulativeNegative = liveOnlyCumulative < 0;
  const last10 = liveRows.slice(-CARRY_NEGATIVE_STREAK_ALERT_DAYS);
  const last10AllNegative = last10.length === CARRY_NEGATIVE_STREAK_ALERT_DAYS ? last10.every(r => r.daily_net_pnl_bps < 0) : null;

  const last30 = rows.slice(-30).filter(r => r.basis_bps !== null).map(r => r.basis_bps as number);
  let rolling30DeltaStdBps: number | null = null;
  if (last30.length >= 2) {
    const deltas = [];
    for (let i = 1; i < last30.length; i++) deltas.push(Math.abs(last30[i] - last30[i - 1]));
    rolling30DeltaStdBps = Math.sqrt(deltas.reduce((a, b) => a + b * b, 0) / deltas.length);
  }

  let maxConsecutiveGap = 0;
  let cur = 0;
  for (const r of rows) {
    if (r.data_gap_flag === 1) { cur++; maxConsecutiveGap = Math.max(maxConsecutiveGap, cur); }
    else cur = 0;
  }

  return {
    immediateLiquidationOrMarginCall: { triggered: liqDates.length > 0, dates: liqDates },
    signAgreementRolling30: { pairsAvailable: recentPairs.length, agreementPct, below70: agreementPct !== null ? agreementPct < F2_ROLLING_ALERT_THRESHOLD_PCT : null },
    carryPersistentNegative: { cumulativeNegative, last10AllNegative, triggered: cumulativeNegative && last10AllNegative === true },
    basisSpikeExceedsT1: { rolling30DeltaStdBps, exceeds: rolling30DeltaStdBps !== null ? rolling30DeltaStdBps > ref.t1BasisDailyDeltaStdBps : null },
    dataGapConsecutive: { maxConsecutiveGapDays: maxConsecutiveGap, triggered: maxConsecutiveGap >= DATA_GAP_ALERT_CONSECUTIVE_DAYS },
  };
}

/**
 * F2用の8hイベント単位ペア（spec §4-F2「粒度をG0-2と統一」＝日次合算ではなく8hイベント（3イベント/日）を
 * 1対1でペア化）。Bitget⇔Binance funding を時単位キーでペア化し、符号一致率・相関等（F2の全指標）の
 * 唯一の算出元とする。このペアは `forward-f2-event-pairs-{btc,eth}.{csv,json}` に「8hイベント単位全ペア」の
 * 生データとして永続化する（spec §3が定義する日次ledgerとは別ファイル＝粒度が異なるため統一しない。
 * 日次ledgerの `f2_pair_sign_match` 列は§3-1が定義する日次合算の参考値に過ぎず、F2ゲート算出には使わない）。
 *
 * ⚠ この関数が返すのは「当該実行のフェッチ窓」に含まれるペアのみ（liveStartDate以降・windowStart以降の交差）。
 * ライブ全期間の母集団ではない。ライブ全期間の母集団は writeF2EventPairs の増分マージ後の戻り値を参照すること
 * （差し戻し是正: 20-review-f2-recheck.md）。
 */
interface F2EventPair {
  event_hour_utc: string;
  date_utc: string;
  bitget_funding_rate: number;
  binance_funding_rate: number;
  match: 0 | 1;
}

function pairEventsForSignCheck(bitgetEvents: FundingEvent[], binanceEvents: FundingEvent[], liveStartDate: string): F2EventPair[] {
  const bitgetByHour = new Map<string, number>();
  for (const e of bitgetEvents) {
    if (e.date < liveStartDate) continue;
    bitgetByHour.set(new Date(e.timestampMs).toISOString().slice(0, 13), e.rate);
  }
  const pairs: F2EventPair[] = [];
  const sortedBinance = [...binanceEvents].filter(e => e.date >= liveStartDate).sort((a, b) => a.timestampMs - b.timestampMs);
  for (const b of sortedBinance) {
    const key = new Date(b.timestampMs).toISOString().slice(0, 13);
    if (bitgetByHour.has(key)) {
      const bg = bitgetByHour.get(key) as number;
      pairs.push({
        event_hour_utc: key,
        date_utc: b.date,
        bitget_funding_rate: bg,
        binance_funding_rate: b.rate,
        match: Math.sign(b.rate) === Math.sign(bg) ? 1 : 0,
      });
    }
  }
  return pairs;
}

// ============================================================
// F2イベントペアI/O（8hイベント単位全ペアの永続化）
//
// ⚠ 差し戻し是正（20-review-f2-recheck.md）: 従来は毎回 writeFileSync による全上書き（既存ファイルの
// readFileSync 箇所が存在しない）だったため、日次実行のたびにフェッチ窓（append≈8日/noop=1日）分だけが
// 残り、それ以前のライブ日のイベントペアが恒久的に消えていた（day90到達時にF2の母集団が存在しない致命的欠陥）。
// 是正: 書き込み前に既存の forward-f2-event-pairs-{asset}.json を読み込み、新規取得ペアと
// event_hour_utc をユニークキーにMapで結合（重複排除）してから書き出す「増分マージ」方式に変更。
// これによりフェッチ窓が狭くても、過去に一度でも永続化されたイベントペアはファイルから消えない。
// appendMode フラグは是正の意図を呼び出し側で明示するためのもの。本番運用では常に true（増分マージ）を渡す。
// ============================================================
const F2_EVENT_PAIR_COLUMNS = ['event_hour_utc', 'date_utc', 'bitget_funding_rate', 'binance_funding_rate', 'match'] as const;

function f2EventPairsPaths(assetLower: string): { csv: string; json: string } {
  return {
    csv: join(RESULT_DIR, `forward-f2-event-pairs-${assetLower}.csv`),
    json: join(RESULT_DIR, `forward-f2-event-pairs-${assetLower}.json`),
  };
}

/** 既存の永続化ファイル（あれば）を読み込む。存在しない/壊れている場合は空配列（＝初回実行として扱う）。 */
function loadExistingF2EventPairs(assetLower: string): F2EventPair[] {
  const { json } = f2EventPairsPaths(assetLower);
  if (!existsSync(json)) return [];
  try {
    const content = readFileSync(json, 'utf-8');
    const parsed = JSON.parse(content) as F2EventPair[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log(`  WARNING: 既存F2イベントペアファイル読込失敗（${json}）: ${err instanceof Error ? err.message : String(err)}。空配列として扱う（既存データはこの実行では失われないよう、後続のマージ処理には影響しないことに注意）`);
    return [];
  }
}

/**
 * event_hour_utc をユニークキーに既存ペアと新規ペアをマージ（重複排除）。
 * 同一キーが両方に存在する場合は新規取得側（incoming）の値を優先する
 * （Bitget側の値が事後訂正された場合に追随するため。通常は同一値のはず）。
 * 結果は event_hour_utc 昇順にソートして返す。
 */
function mergeF2EventPairs(existing: F2EventPair[], incoming: F2EventPair[]): F2EventPair[] {
  const map = new Map<string, F2EventPair>();
  for (const p of existing) map.set(p.event_hour_utc, p);
  for (const p of incoming) map.set(p.event_hour_utc, p);
  return [...map.values()].sort((a, b) => a.event_hour_utc.localeCompare(b.event_hour_utc));
}

/**
 * F2イベントペアの永続化。appendMode=true（本番運用は常にtrue固定）で既存ファイルを読み込み、
 * event_hour_utc でユニーク結合した増分マージ結果を書き出す。appendMode=false は単体テスト等での
 * 上書き比較用のみに使う（本番コードパスからは呼ばない）。
 * 戻り値はマージ後の全ペア＝F2ゲート算出に使う母集団（ライブ全期間・重複排除済み）。
 */
function writeF2EventPairs(assetLower: string, newPairs: F2EventPair[], appendMode: boolean): F2EventPair[] {
  const { csv, json } = f2EventPairsPaths(assetLower);
  const existing = appendMode ? loadExistingF2EventPairs(assetLower) : [];
  const merged = appendMode ? mergeF2EventPairs(existing, newPairs) : newPairs;
  const lines = [F2_EVENT_PAIR_COLUMNS.join(','), ...merged.map(p => F2_EVENT_PAIR_COLUMNS.map(col => String((p as unknown as Record<string, unknown>)[col])).join(','))];
  writeFileSync(csv, lines.join('\n') + '\n');
  writeFileSync(json, JSON.stringify(merged, null, 2));
  return merged;
}

// ============================================================
// 資産単位のメイン処理
// ============================================================
interface AssetProcessResult {
  assetCode: 'BTC' | 'ETH';
  mode: 'initial' | 'append' | 'noop';
  rows: LedgerRow[];
  newRowsCount: number;
  liveStartDate: string | null;
  eventPairsRecent: F2EventPair[];
  marketData: AssetMarketData;
  windowStart: string;
  windowEnd: string;
}

async function processAsset(assetCode: 'BTC' | 'ETH'): Promise<AssetProcessResult> {
  const assetLower = assetCode.toLowerCase();
  const symbol = `${assetCode}USDT`;

  log(`\n======== ${assetCode} (${symbol}) ========`);

  const anchor = anchorDateKey();
  const existingRows = loadExistingLedger(assetLower);
  let mode: 'initial' | 'append' | 'noop';
  let datesToProcess: string[] = [];
  let windowStart: string;
  const windowEnd = anchor;

  if (existingRows.length === 0) {
    mode = 'initial';
    const liveStart = anchor;
    const warmupStart = addDays(liveStart, -WARMUP_DAYS);
    datesToProcess = dateRange(warmupStart, liveStart);
    windowStart = addDays(warmupStart, -SMA_WINDOW - 1);
    log(`初回セットアップ: warmup=${warmupStart}..${addDays(liveStart, -1)}（${WARMUP_DAYS}日）, go-live=${liveStart}`);
  } else {
    const lastDate = existingRows[existingRows.length - 1].date_utc;
    // 差し戻し是正（フェッチ窓拡張・推奨事項）: F2イベントペアの再構築窓は go-live 起点まで遡る。
    // ただし Bitget無料APIのfunding history実務上の遡及上限（≈90日）で頭打ちにする。
    // 増分マージ（writeF2EventPairs）と併用することで、この窓に入らない過去分は既存永続化ファイル側で担保される。
    const liveStartExisting = existingRows.find(r => r.phase === 'live')?.date_utc ?? lastDate;
    const backfillFloorKey = addDays(anchor, -(BITGET_FUNDING_HISTORY_LIMIT_DAYS - 1));
    const f2WindowStart = liveStartExisting > backfillFloorKey ? liveStartExisting : backfillFloorKey;

    if (lastDate >= anchor) {
      mode = 'noop';
      // 差し戻し是正: noopモードでも「直近1日」に窓を縮退させない（従来のバグ）。
      // go-live起点（Bitget90日制限で頭打ち）まで遡ってF2イベントペアを再取得し、増分マージで永続化する。
      windowStart = f2WindowStart;
      log(`既存ledger最終日=${lastDate} は anchor=${anchor} 以上。追記対象日なし（冪等・重複追記なし）。F2イベントペア再取得窓=${windowStart}..${windowEnd}（noopでも縮退させず増分マージで永続化）`);
    } else {
      mode = 'append';
      datesToProcess = dateRange(addDays(lastDate, 1), anchor);
      const ledgerWindowStart = addDays(datesToProcess[0], -SMA_WINDOW - 1);
      // ledger算出に必要な最小窓（SMA7+バッファ）と、F2再構築窓（go-live起点/Bitget90日制限）のうち、
      // より過去まで遡る方（日付として小さい方）を採用してフェッチする。
      windowStart = ledgerWindowStart < f2WindowStart ? ledgerWindowStart : f2WindowStart;
      log(`追記モード: 既存最終日=${lastDate}, 追記対象=${datesToProcess.join(',')}, フェッチ窓=${windowStart}..${windowEnd}（ledger最小窓=${ledgerWindowStart} / F2再構築窓=${f2WindowStart} のうちより過去まで遡る方）`);
    }
  }

  const marketData = await fetchAssetMarketData(symbol, windowStart, windowEnd);

  if (mode === 'noop') {
    const liveStartDate = existingRows.find(r => r.phase === 'live')?.date_utc ?? null;
    const eventPairsRecent = pairEventsForSignCheck(marketData.fundingBitgetEvents, marketData.fundingBinanceEvents, liveStartDate ?? anchor);
    return { assetCode, mode, rows: existingRows, newRowsCount: 0, liveStartDate, eventPairsRecent, marketData, windowStart, windowEnd };
  }

  const state: RunningState = mode === 'initial'
    ? {
        marginBps: IMR * 10000,
        cumulativeNetPnlBps: 0,
        cumulativeSleevePct: 0,
        prevSignal: null,
        prevSpotClose: marketData.spot.get(addDays(datesToProcess[0], -1)) ?? null,
        prevPerpLastClose: marketData.perpLast.get(addDays(datesToProcess[0], -1)) ?? null,
        prevPerpMarkClose: (marketData.markAvailable ? marketData.perpMark.get(addDays(datesToProcess[0], -1)) : marketData.perpLast.get(addDays(datesToProcess[0], -1))) ?? null,
      }
    : (() => {
        const last = existingRows[existingRows.length - 1];
        return {
          marginBps: last.liquidation_flag === 1 ? IMR * 10000 : last.margin_ratio * 10000,
          cumulativeNetPnlBps: last.cumulative_net_pnl_bps,
          cumulativeSleevePct: last.sleeve_cumulative_return_pct,
          prevSignal: last.signal_pos,
          prevSpotClose: last.spot_close,
          prevPerpLastClose: last.perp_last,
          prevPerpMarkClose: last.perp_mark,
        };
      })();

  const newRows: LedgerRow[] = [];
  for (let i = 0; i < datesToProcess.length; i++) {
    const date = datesToProcess[i];
    const phase: 'warmup' | 'live' = mode === 'initial' ? (i === datesToProcess.length - 1 ? 'live' : 'warmup') : 'live';
    const row = processDay(assetCode, date, phase, marketData, state, datesToProcess, i);
    newRows.push(row);
    log(`  ${date} [${phase}] signal=${row.signal_pos} pnl=${row.daily_net_pnl_bps.toFixed(3)}bps cum=${row.cumulative_net_pnl_bps.toFixed(3)}bps margin=${row.margin_ratio.toFixed(4)} liq=${row.liquidation_flag} gap=${row.data_gap_flag}`);
  }

  const allRows = [...existingRows, ...newRows];
  writeLedger(assetLower, allRows);

  const liveStartDate = allRows.find(r => r.phase === 'live')?.date_utc ?? null;
  const eventPairsRecent = pairEventsForSignCheck(marketData.fundingBitgetEvents, marketData.fundingBinanceEvents, liveStartDate ?? anchor);

  return { assetCode, mode, rows: allRows, newRowsCount: newRows.length, liveStartDate, eventPairsRecent, marketData, windowStart, windowEnd };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000032 フォワード較正フェーズ Bitgetペーパートレード 日次実行 ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  log(`Node version: ${process.version}`);
  let gitCommit = 'unknown';
  try { gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim(); } catch { /* ignore */ }
  log(`Git commit: ${gitCommit}`);
  log(`anchorDateKey (最終完全経過UTC日・go-live/追記日として使用): ${anchorDateKey()}`);
  log('⚠ 本実行は「日次冪等追記」の1回分。90日分を一括生成するものではない。');

  const results: AssetProcessResult[] = [];
  for (const assetCode of ['BTC', 'ETH'] as const) {
    const r = await processAsset(assetCode);
    results.push(r);
  }

  // === forward-meta.json ===
  const metaPath = join(RESULT_DIR, 'forward-meta.json');
  const priorMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : null;
  const runHistory: Record<string, unknown>[] = priorMeta?.runHistory ?? [];
  runHistory.push({
    runTimestampUTC: RUN_TIMESTAMP,
    anchorDateKey: anchorDateKey(),
    gitCommit,
    nodeVersion: process.version,
    perAsset: Object.fromEntries(results.map(r => [r.assetCode, {
      mode: r.mode,
      newRowsCount: r.newRowsCount,
      markAvailable: r.marketData.markAvailable,
      markError: r.marketData.markError ?? null,
      fetchWindow: { start: r.windowStart, end: r.windowEnd },
    }])),
  });

  const goLiveDates = Object.fromEntries(results.map(r => [r.assetCode, r.liveStartDate]));
  const meta = {
    experiment: 'EXP-OBS000032',
    phase: 'フォワード較正フェーズ（Bitgetペーパートレード）',
    specReference: 'research/EXP-OBS000032/00-spec-forward-calibration.md',
    executedBy: 'B検証実装官 (Quant Researcher)',
    goLiveDateUTC: goLiveDates,
    warmupBackfillDays: WARMUP_DAYS,
    liveDaysRequiredForGate: LIVE_DAYS_REQUIRED,
    currentLiveDaysCount: Object.fromEntries(results.map(r => [r.assetCode, r.rows.filter(x => x.phase === 'live').length])),
    wStar: W_STAR,
    fixedParams: {
      leverage: LEVERAGE,
      imr: IMR,
      mmr: MMR,
      mmrNote: '業界標準の仮置き（Bitget API非配信・「Bitget API取得」ではない）',
      annualCapitalCostRate: ANNUAL_CAPITAL_COST_RATE,
      smaWindowDays: SMA_WINDOW,
      perLegCostBps: { BTC: COSTS.BTC.perLegBps, ETH: COSTS.ETH.perLegBps },
      reversalFourLegCostBps: { BTC: COSTS.BTC.reversalFourLegBps, ETH: COSTS.ETH.reversalFourLegBps },
      accountingModel: 'Stage 1 carry-liquidation-sim.ts 方式I（分離証拠金・清算損二重計上なし・現物益毎日連続計上・perp floor(0)頭打ち）をそのまま踏襲。新会計を発明していない。',
    },
    backtestReferenceValues: BACKTEST_REFERENCE,
    bootstrapConfig: BOOTSTRAP_CONFIG,
    endpoints: {
      bitgetSpotDaily: 'https://api.bitget.com/api/v2/spot/market/candles?symbol={symbol}&granularity=1Dutc&limit={n}',
      bitgetPerpLastDaily: 'https://api.bitget.com/api/v2/mix/market/history-candles?symbol={symbol}&productType=USDT-FUTURES&granularity=1Dutc&limit={n}',
      bitgetPerpMarkDaily: 'https://api.bitget.com/api/v2/mix/market/history-mark-candles?symbol={symbol}&productType=USDT-FUTURES&granularity=1Dutc&limit={n}',
      bitgetFundingHistory: 'https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol={symbol}&productType=USDT-FUTURES&pageSize=100&pageNo={n}（空応答で終了。length<pageSizeを終了条件に使わない）',
      bitgetCurrentFundRate: 'https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol={symbol}&productType=USDT-FUTURES（診断用スナップショットのみ。ledger会計には使わない。理由: 本スクリプトはanchor=最終完全経過UTC日のみを処理するため、その日のfunding 3イベントは常にhistory-fund-rateで確定済み。よってcurrent-fund-rate（当日未確定分）はledger会計上不要。§2-2の「funding（当日/次回）」要件は診断ログでカバーする設計判断）',
      binanceFunding: 'https://fapi.binance.com/fapi/v1/fundingRate?symbol={symbol}&startTime={ms}&endTime={ms}&limit=1000',
      binanceFundingViaProxy: process.env.BINANCE_PROXY_URL ? true : false,
    },
    dateAnchorDesignNote: '日次実行は「今日」でなく「最終完全経過UTC日（anchor=today-1）」を対象とする。理由：Bitget日足candle(1Dutc)は当日分が実行時刻までの部分足になり得るため、完結済みの前日分のみを確定値として記録し先読み/部分値混入を避ける設計判断。',
    markAvailability: Object.fromEntries(results.map(r => [r.assetCode, { available: r.marketData.markAvailable, error: r.marketData.markError ?? null }])),
    ledgerGranularityNote: '日次ledger（forward-paper-ledger-{asset}.csv/json）は spec §3-1 のとおり1行=1UTC日（会計・清算判定用）。F2ゲート（spec §4-F2、8hイベント単位でBitget/Binanceを1対1ペア化）は日次ledgerの f2_pair_sign_match 列（日次合算の参考値）ではなく、forward-f2-event-pairs-{asset}.csv/json（8hイベント単位・全ペア）を唯一の算出元とする。両ファイルは粒度が異なる別スキーマであり意図的に統一しない。差し戻し是正（20-review-f2-recheck.md）: forward-f2-event-pairs-{asset}は各回のフェッチ窓（go-live起点/Bitget90日制限のいずれか新しい方まで拡張）で取得したペアを、既存永続化ファイルとevent_hour_utcキーで増分マージ（重複排除）してから書き出す方式に変更。フェッチ窓が狭い実行があっても、既存ファイル側の過去ペアは消えない。',
    runHistory,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  log(`\n>>> forward-meta.json 保存`);

  // === forward-interim-metrics.json ===
  const interimPath = join(RESULT_DIR, 'forward-interim-metrics.json');
  const perAssetMetrics: Record<string, unknown> = {};
  const perAssetCheckpoints: Record<string, Checkpoints> = {};
  const F2_APPEND_MODE = true; // 差し戻し是正: 常に増分マージ（全上書きは使わない）
  for (const r of results) {
    const assetLower = r.assetCode.toLowerCase();
    // 差し戻し是正: まず増分マージで永続化し、その戻り値（ライブ全期間・重複排除済みの母集団）を
    // F1〜F4の暫定メトリクス・チェックポイント計算に使う。従来の r.eventPairsRecent（今回フェッチ窓のみ）
    // を直接メトリクス計算に渡さない＝day90到達時に母集団が消える／偽陽性を通す経路を断つ。
    const eventPairsAllLive = writeF2EventPairs(assetLower, r.eventPairsRecent, F2_APPEND_MODE);
    perAssetMetrics[r.assetCode] = computeInterimMetricsForAsset(r.assetCode, assetLower, r.rows, eventPairsAllLive);
    perAssetCheckpoints[r.assetCode] = computeCheckpoints(r.assetCode, r.rows, eventPairsAllLive);
    log(`>>> forward-f2-event-pairs-${assetLower}.{csv,json} 保存（増分マージ後 全ペアn=${eventPairsAllLive.length}／今回フェッチ分n=${r.eventPairsRecent.length}）`);
  }
  const anyAlert = Object.values(perAssetCheckpoints).some(cp =>
    cp.immediateLiquidationOrMarginCall.triggered ||
    cp.signAgreementRolling30.below70 === true ||
    cp.carryPersistentNegative.triggered ||
    cp.basisSpikeExceedsT1.exceeds === true ||
    cp.dataGapConsecutive.triggered
  );

  const liveDaysBothAssets = results.map(r => r.rows.filter(x => x.phase === 'live').length);
  const minLiveDays = Math.min(...liveDaysBothAssets);
  // 30/60日マイルストーン（到達時点のスナップショットを記録。以後は上書きしない）
  let existingInterim: Record<string, unknown> = {};
  if (existsSync(interimPath)) {
    try { existingInterim = JSON.parse(readFileSync(interimPath, 'utf-8')); } catch { /* ignore */ }
  }
  const existingMilestones = (existingInterim.milestoneSnapshots as Record<string, unknown>) ?? {};
  const newMilestones: Record<string, unknown> = { ...existingMilestones };
  for (const m of [30, 60]) {
    if (minLiveDays >= m && !newMilestones[`day${m}`]) {
      newMilestones[`day${m}`] = { reachedAtRunTimestamp: RUN_TIMESTAMP, metrics: perAssetMetrics, checkpoints: perAssetCheckpoints };
    }
  }

  const interim = {
    generatedAtUTC: RUN_TIMESTAMP,
    liveDaysCount: Object.fromEntries(results.map(r => [r.assetCode, r.rows.filter(x => x.phase === 'live').length])),
    warmupDaysCount: Object.fromEntries(results.map(r => [r.assetCode, r.rows.filter(x => x.phase === 'warmup').length])),
    note: 'F1〜F4は判定語を使わず実測値と閾値の真偽値のみ。ライブ日数<90の間はすべて試験値（計算式の動作確認）であり、正式なゲート判定入力ではない。採否判定はC懐疑検証官が行う。',
    f1234: perAssetMetrics,
    projection90d: Object.fromEntries(results.map(r => {
      const m = perAssetMetrics[r.assetCode] as { projection90d: Projection90dResult };
      return [r.assetCode, m.projection90d];
    })),
    overall_allFourBothAssets: (() => {
      const vals = (['BTC', 'ETH'] as const).map(a => {
        const m = perAssetMetrics[a] as { f1: { f1a_cumulativePositive: boolean | null; f1b_liveMeanGteLowerBound: boolean | null }; f2: { f2_gte80pct: boolean | null }; f3: { f3_zeroLiquidationAndMarginCall: boolean | null }; f4: { f4_lteT1Threshold: boolean | null } };
        return [m.f1.f1a_cumulativePositive, m.f1.f1b_liveMeanGteLowerBound, m.f2.f2_gte80pct, m.f3.f3_zeroLiquidationAndMarginCall, m.f4.f4_lteT1Threshold];
      }).flat();
      if (vals.some(v => v === null)) return null; // サンプル不足で判定不能
      return vals.every(v => v === true);
    })(),
    checkpoints: perAssetCheckpoints,
    alertActive: anyAlert,
    milestoneSnapshots: newMilestones,
  };
  writeFileSync(interimPath, JSON.stringify(interim, null, 2));
  log(`>>> forward-interim-metrics.json 保存（alertActive=${anyAlert}）`);

  // === forward-alerts.log（追記型） ===
  const alertsPath = join(RESULT_DIR, 'forward-alerts.log');
  const alertLines: string[] = [];
  for (const [assetCode, cp] of Object.entries(perAssetCheckpoints)) {
    if (cp.immediateLiquidationOrMarginCall.triggered) alertLines.push(`[${RUN_TIMESTAMP}] ${assetCode} ALERT liquidation_or_margin_call dates=${cp.immediateLiquidationOrMarginCall.dates.join(',')}`);
    if (cp.signAgreementRolling30.below70 === true) alertLines.push(`[${RUN_TIMESTAMP}] ${assetCode} ALERT sign_agreement_rolling30_below70 rate=${cp.signAgreementRolling30.agreementPct}`);
    if (cp.carryPersistentNegative.triggered) alertLines.push(`[${RUN_TIMESTAMP}] ${assetCode} ALERT carry_persistent_negative`);
    if (cp.basisSpikeExceedsT1.exceeds === true) alertLines.push(`[${RUN_TIMESTAMP}] ${assetCode} ALERT basis_spike_exceeds_t1 std=${cp.basisSpikeExceedsT1.rolling30DeltaStdBps}`);
    if (cp.dataGapConsecutive.triggered) alertLines.push(`[${RUN_TIMESTAMP}] ${assetCode} ALERT data_gap_consecutive days=${cp.dataGapConsecutive.maxConsecutiveGapDays}`);
  }
  if (alertLines.length === 0) alertLines.push(`[${RUN_TIMESTAMP}] no alerts triggered this run`);
  appendFileSync(alertsPath, alertLines.join('\n') + '\n');
  log(`>>> forward-alerts.log 追記（${alertLines.length}行）`);

  // === forward-run.log（追記型） ===
  const runLogPath = join(RESULT_DIR, 'forward-run.log');
  const runLogBlock = [
    '='.repeat(70),
    `=== EXP-OBS000032 フォワード較正 実行 ${RUN_TIMESTAMP} ===`,
    '⚠ このスクリプトは日次冪等追記型。1回の実行で90日分が完成するものではない。',
    '毎日（または定期的に）実行することでライブデータが1日ずつ蓄積される。',
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    `anchorDateKey: ${anchorDateKey()}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/bitget-carry-forward-paper.ts',
    '',
    'EXECUTION LOG:',
    ...executionLog,
    '',
  ].join('\n');
  appendFileSync(runLogPath, runLogBlock);
  log(`>>> forward-run.log 追記`);

  log('\n=== 実行完了 ===');
  for (const r of results) {
    log(`${r.assetCode}: mode=${r.mode} newRows=${r.newRowsCount} totalRows=${r.rows.length} liveRows=${r.rows.filter(x => x.phase === 'live').length}`);
  }
}

// 直接実行時のみ main() を起動する（`node --experimental-strip-types scripts/bitget-carry-forward-paper.ts`）。
// これにより、増分マージ関数（loadExistingF2EventPairs/mergeF2EventPairs/writeF2EventPairs）を
// 自己確認テストハーネスから安全にimportできる（import時にネットワークアクセスや本番ファイル書き込みが
// 走らない）。実運用の起動条件（直接実行）は変えない。
const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : true;
if (isDirectRun) {
  main().catch(err => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
}

export type { F2EventPair };
export { loadExistingF2EventPairs, mergeF2EventPairs, writeF2EventPairs };
