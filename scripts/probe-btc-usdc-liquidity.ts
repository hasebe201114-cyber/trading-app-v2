/**
 * EXP-OBS000041 追加調査（Stage 0の判定ゲートではない・軽量な事実確認）
 * 「BTC_USDCの流動性を確認する価値があるか、まず確認してほしい」という司令塔指示に基づき、
 * G0-E1でE1-POSITIVE相当と記録された btc_usdc 系列（ATM: strike=64000, 2026-08-07満期の
 * 実測時点例。実行時点で D5/D6 と同一ロジックにより選定し直す）の流動性の実測値のみを取得する。
 *
 * 判定語は使わない（達成/十分/流動性がある・ない 等は一切書かない）。事実・実測値のみを出力する。
 * 採否判断はC品質チームの職務。新たな合否ゲートを定義しない（A設計チームへの差し戻し対象ではない）。
 *
 * 参照（読み取り専用・上書きしない）:
 *   - research/EXP-OBS000041/10-result/stage0-instrument-inventory.json
 *     （G0-E1が選定した代表満期・ATM strikeの過去実測値との突き合わせ用。本スクリプトは
 *       D5/D6と同一ロジックで実行時点のATMを独立に選定し直し、上記ファイルとの一致/不一致を事実記録する）
 *   - research/EXP-OBS000041/10-result/stage0-economics-snapshot.json
 *     （G0-C2 c2_2_spreadSlippage に btc_usdc が含まれていないことの確認用）
 *
 * D5/D6選定ロジック（spec 00-spec-stage0.md §2 固定定義・独立実装）:
 *   D5 = 残存日数が7日以上で最も近い上場expiry
 *   D6 = |delta| ∈ [0.35, 0.65] の候補のうちindex価格に最近接のstrike。フォールバック禁止。
 *
 * research/EXP-OBS000037/ 配下へは一切書き込まない（読み取りも行わない）。
 * .env.local・APIキーは読まない（Deribit publicエンドポイントは認証不要）。
 *
 * 独立実装: scripts/probe-deribit-instrument-inventory.ts のfetch/ログ整形・ページング作法・
 * D5/D6選定の考え方のみを参考にし、ロジックはコピペせず本ファイル内で書き起こしている。
 *
 * 実行環境の制約: 本スクリプトの開発・実装環境からはDeribitに直接到達できない
 * （プロキシから403が返ることを過去に確認済み）。実データ取得はGitHub Actions
 * （.github/workflows/obs000041-btc-usdc-liquidity-oneoff.yml・workflow_dispatch）上で行う。
 *
 * 実行: node --experimental-strip-types scripts/probe-btc-usdc-liquidity.ts
 * 出力: research/EXP-OBS000041/10-result/btc-usdc-liquidity.json
 *       research/EXP-OBS000041/10-result/btc-usdc-liquidity-run.log
 */

import { writeFileSync, mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000041', '10-result');
mkdirSync(RESULT_DIR, { recursive: true });

const RUN_TIMESTAMP = new Date().toISOString();
const execLog: string[] = [];
function log(msg: string): void {
  console.log(msg);
  execLog.push(`[${new Date().toISOString()}] ${msg}`);
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const BASE = 'https://www.deribit.com/api/v2';

// ============================================================
// 固定パラメータ（回す前に固定。specの判定閾値は変更しない・新規に増やさない）
// ============================================================
const PARAMS = {
  minResidualDaysForRepresentativeMaturity: 7, // D5
  atmDeltaRange: [0.35, 0.65] as [number, number], // D6
  orderBookDepth: 20, // 依頼事項1で明示された深度
  lastTradesCount: 50, // 依頼事項3で明示された件数
  lastTradesIncludeOld: true, // get_last_trades_by_instrumentはinclude_old未指定だと直近数日分しか
  // 返さない仕様のため、最終取引時刻を正しく記録する目的でtrueを付与する（Deribit公式ドキュメント
  // https://docs.deribit.com/#public-get_last_trades_by_instrument 参照。取得できるエンドポイント名・
  // パラメータは実URLとしてすべて出力に記録する）。
  requestSleepMs: 150, // 依頼事項2「BTC版の作法＝150ms程度」を踏襲
};

// ============================================================
// HTTP fetch（生ステータス保持）
// ============================================================
interface FetchOutcome { status: number; json: unknown | null; error?: string }
async function callDeribit(url: string): Promise<FetchOutcome> {
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
function resultOf(o: FetchOutcome): unknown | undefined {
  return o.json && typeof o.json === 'object' ? (o.json as Record<string, unknown>).result : undefined;
}
function errorOf(o: FetchOutcome): string | undefined {
  const top = o.json && typeof o.json === 'object' ? (o.json as Record<string, unknown>) : undefined;
  return top?.error ? JSON.stringify(top.error) : undefined;
}

// ============================================================
// get_instruments（系列抽出用）
// ============================================================
interface RawInstrument { [key: string]: unknown }
async function getOptionInstruments(currency: string): Promise<{ url: string; status: number; rows: RawInstrument[]; apiError?: string }> {
  const url = `${BASE}/public/get_instruments?currency=${currency}&kind=option&expired=false`;
  const r = await callDeribit(url);
  const rows = (resultOf(r) as RawInstrument[] | undefined) ?? [];
  return { url, status: r.status, rows, apiError: errorOf(r) };
}

interface SeriesInstrument {
  instrument_name: string;
  option_type: 'call' | 'put' | string;
  strike: number;
  expiration_timestamp: number;
  price_index: string;
  base_currency: string;
  settlement_currency: string;
  quote_currency: string;
  instrument_type: string;
  contract_size: number;
  min_trade_amount: number;
  is_active: boolean;
}
function asSeriesInstrument(raw: RawInstrument): SeriesInstrument {
  return {
    instrument_name: String(raw.instrument_name),
    option_type: raw.option_type as string,
    strike: raw.strike as number,
    expiration_timestamp: raw.expiration_timestamp as number,
    price_index: String(raw.price_index ?? ''),
    base_currency: String(raw.base_currency ?? ''),
    settlement_currency: String(raw.settlement_currency ?? ''),
    quote_currency: String(raw.quote_currency ?? ''),
    instrument_type: String(raw.instrument_type ?? ''),
    contract_size: raw.contract_size as number,
    min_trade_amount: raw.min_trade_amount as number,
    is_active: Boolean(raw.is_active),
  };
}

// ============================================================
// ticker
// ============================================================
interface TickerSnapshot {
  instrumentName: string;
  indexPrice: number | 'API非配信';
  markPrice: number | 'API非配信';
  bestBidPrice: number | 'API非配信';
  bestAskPrice: number | 'API非配信';
  bestBidAmount: number | 'API非配信';
  bestAskAmount: number | 'API非配信';
  delta: number | 'API非配信';
  gamma: number | 'API非配信';
  vega: number | 'API非配信';
  theta: number | 'API非配信';
  openInterest: number | 'API非配信';
  volume: number | 'API非配信';
  volumeUsd: number | 'API非配信';
}
interface TickerDiag { instrumentName: string; url: string; httpStatus: number; hasResult: boolean; hasGreeks: boolean; apiError?: string; fetchError?: string }
async function getTicker(instrumentName: string): Promise<{ ticker: TickerSnapshot | null; diag: TickerDiag }> {
  const url = `${BASE}/public/ticker?instrument_name=${instrumentName}`;
  const r = await callDeribit(url);
  const apiError = errorOf(r);
  const res = resultOf(r) as Record<string, unknown> | undefined;
  if (!res) {
    return { ticker: null, diag: { instrumentName, url, httpStatus: r.status, hasResult: false, hasGreeks: false, apiError, fetchError: r.error } };
  }
  const greeks = res.greeks as Record<string, unknown> | undefined;
  const stats = res.stats as Record<string, unknown> | undefined;
  const ticker: TickerSnapshot = {
    instrumentName,
    indexPrice: typeof res.index_price === 'number' ? res.index_price : 'API非配信',
    markPrice: typeof res.mark_price === 'number' ? res.mark_price : 'API非配信',
    bestBidPrice: typeof res.best_bid_price === 'number' ? res.best_bid_price : 'API非配信',
    bestAskPrice: typeof res.best_ask_price === 'number' ? res.best_ask_price : 'API非配信',
    bestBidAmount: typeof res.best_bid_amount === 'number' ? res.best_bid_amount : 'API非配信',
    bestAskAmount: typeof res.best_ask_amount === 'number' ? res.best_ask_amount : 'API非配信',
    delta: greeks && typeof greeks.delta === 'number' ? greeks.delta : 'API非配信',
    gamma: greeks && typeof greeks.gamma === 'number' ? greeks.gamma : 'API非配信',
    vega: greeks && typeof greeks.vega === 'number' ? greeks.vega : 'API非配信',
    theta: greeks && typeof greeks.theta === 'number' ? greeks.theta : 'API非配信',
    openInterest: typeof res.open_interest === 'number' ? res.open_interest : 'API非配信',
    volume: stats && typeof stats.volume === 'number' ? stats.volume : 'API非配信',
    volumeUsd: stats && typeof stats.volume_usd === 'number' ? stats.volume_usd : 'API非配信',
  };
  return { ticker, diag: { instrumentName, url, httpStatus: r.status, hasResult: true, hasGreeks: Boolean(greeks), apiError } };
}

// ============================================================
// D5: 代表満期選定（残存>=7日で最近接）
// ============================================================
function pickRepresentativeExpiry(instruments: SeriesInstrument[], nowMs: number, minDays: number): { expiryTimestamp: number; residualDays: number } | null {
  const expiries = [...new Set(instruments.map(i => i.expiration_timestamp))];
  const withResidual = expiries.map(e => ({ expiryTimestamp: e, residualDays: (e - nowMs) / 86400000 }));
  const eligible = withResidual.filter(x => x.residualDays >= minDays).sort((a, b) => a.residualDays - b.residualDays);
  return eligible.length > 0 ? eligible[0] : null;
}

// ============================================================
// D6: ATM選定（|delta|∈[0.35,0.65]・index最近接strike・フォールバック禁止）
// ============================================================
interface AtmResolution {
  method: 'deltaRange' | 'unavailable';
  strike: number | null;
  indexPriceAtSelection: number | null;
  callTicker: TickerSnapshot | null;
  putTicker: TickerSnapshot | null;
  candidateLog: { strike: number; delta: number | 'API非配信'; instrumentName: string }[];
  diagLog: TickerDiag[];
  unavailableReason?: string;
}
async function resolveAtmStraddle(instruments: SeriesInstrument[], expiryTimestamp: number, deltaRange: [number, number]): Promise<AtmResolution> {
  const calls = instruments.filter(i => i.expiration_timestamp === expiryTimestamp && i.option_type === 'call');
  const puts = instruments.filter(i => i.expiration_timestamp === expiryTimestamp && i.option_type === 'put');
  const putByStrike = new Map<number, SeriesInstrument>(puts.map(p => [p.strike, p]));

  const candidateLog: { strike: number; delta: number | 'API非配信'; instrumentName: string }[] = [];
  const diagLog: TickerDiag[] = [];
  const inBand: { strike: number; delta: number; indexPrice: number; ticker: TickerSnapshot }[] = [];

  for (const c of calls) {
    const { ticker, diag } = await getTicker(c.instrument_name);
    await sleep(PARAMS.requestSleepMs);
    diagLog.push(diag);
    if (!ticker) continue;
    candidateLog.push({ strike: c.strike, delta: ticker.delta, instrumentName: c.instrument_name });
    if (typeof ticker.delta === 'number' && typeof ticker.indexPrice === 'number' && ticker.delta >= deltaRange[0] && ticker.delta <= deltaRange[1]) {
      inBand.push({ strike: c.strike, delta: ticker.delta, indexPrice: ticker.indexPrice, ticker });
    }
  }

  if (inBand.length === 0) {
    return {
      method: 'unavailable', strike: null, indexPriceAtSelection: null, callTicker: null, putTicker: null,
      candidateLog, diagLog,
      unavailableReason: `代表満期${new Date(expiryTimestamp).toISOString()}にdelta∈[${deltaRange[0]},${deltaRange[1]}]の候補が0件（フォールバック未使用）`,
    };
  }
  inBand.sort((a, b) => Math.abs(a.strike - a.indexPrice) - Math.abs(b.strike - b.indexPrice));
  const chosen = inBand[0];
  const putInstrument = putByStrike.get(chosen.strike);
  if (!putInstrument) {
    return {
      method: 'unavailable', strike: chosen.strike, indexPriceAtSelection: chosen.indexPrice, callTicker: chosen.ticker, putTicker: null,
      candidateLog, diagLog, unavailableReason: `strike=${chosen.strike}に対応するput instrumentが見つからない`,
    };
  }
  const { ticker: putTicker, diag: putDiag } = await getTicker(putInstrument.instrument_name);
  await sleep(PARAMS.requestSleepMs);
  diagLog.push(putDiag);
  if (!putTicker) {
    return {
      method: 'unavailable', strike: chosen.strike, indexPriceAtSelection: chosen.indexPrice, callTicker: chosen.ticker, putTicker: null,
      candidateLog, diagLog, unavailableReason: `put ticker取得失敗: ${putInstrument.instrument_name}`,
    };
  }
  return { method: 'deltaRange', strike: chosen.strike, indexPriceAtSelection: chosen.indexPrice, callTicker: chosen.ticker, putTicker, candidateLog, diagLog };
}

// ============================================================
// get_order_book
// ============================================================
interface OrderBookLevel { price: number; amount: number }
interface OrderBookSnapshot {
  instrumentName: string;
  url: string;
  httpStatus: number;
  indexPrice: number | 'API非配信';
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  apiError?: string;
}
async function getOrderBook(instrumentName: string, depth: number): Promise<OrderBookSnapshot> {
  const url = `${BASE}/public/get_order_book?instrument_name=${instrumentName}&depth=${depth}`;
  const r = await callDeribit(url);
  const res = resultOf(r) as Record<string, unknown> | undefined;
  const apiError = errorOf(r);
  const toLevels = (raw: unknown): OrderBookLevel[] => {
    if (!Array.isArray(raw)) return [];
    return raw.map(row => Array.isArray(row) && row.length >= 2 ? { price: Number(row[0]), amount: Number(row[1]) } : { price: NaN, amount: NaN });
  };
  return {
    instrumentName, url, httpStatus: r.status,
    indexPrice: res && typeof res.index_price === 'number' ? res.index_price : 'API非配信',
    bids: toLevels(res?.bids), asks: toLevels(res?.asks), apiError,
  };
}
function cumulativeNotional(levels: OrderBookLevel[]): number {
  return levels.reduce((sum, l) => sum + (Number.isFinite(l.price) && Number.isFinite(l.amount) ? l.price * l.amount : 0), 0);
}

// ============================================================
// get_last_trades_by_instrument
// ============================================================
interface LastTrade { [key: string]: unknown }
interface LastTradesResult { url: string; httpStatus: number; trades: LastTrade[]; apiError?: string; lastTradeTimestampUTC: string | null }
async function getLastTrades(instrumentName: string, count: number, includeOld: boolean): Promise<LastTradesResult> {
  const url = `${BASE}/public/get_last_trades_by_instrument?instrument_name=${instrumentName}&count=${count}&include_old=${includeOld}`;
  const r = await callDeribit(url);
  const apiError = errorOf(r);
  const res = resultOf(r) as Record<string, unknown> | undefined;
  const trades = (res?.trades as LastTrade[] | undefined) ?? [];
  let lastTs: string | null = null;
  if (trades.length > 0) {
    const maxTs = Math.max(...trades.map(t => typeof t.timestamp === 'number' ? t.timestamp : 0));
    if (maxTs > 0) lastTs = new Date(maxTs).toISOString();
  }
  return { url, httpStatus: r.status, trades, apiError, lastTradeTimestampUTC: lastTs };
}

// ============================================================
// USD換算名目（factual・解釈なし）
// ============================================================
function notionalUsdFor(quoteCurrency: string, price: number | 'API非配信', amount: number | 'API非配信', indexPriceUsd: number | 'API非配信'): number | null {
  if (typeof price !== 'number' || typeof amount !== 'number') return null;
  if (quoteCurrency === 'USDC' || quoteCurrency === 'USD') return price * amount;
  if (typeof indexPriceUsd === 'number') return price * amount * indexPriceUsd;
  return null;
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000041 追加調査: probe-btc-usdc-liquidity.ts ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  let gitCommit = 'unknown';
  try { gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim(); } catch { /* ignore */ }
  log(`Git commit: ${gitCommit} / Node ${process.version}`);

  const nowMs = Date.now();

  // ---- 読み取り専用参照（既存Stage0成果物・上書きしない） ----
  const inventoryPath = join(RESULT_DIR, 'stage0-instrument-inventory.json');
  const economicsSnapshotPath = join(RESULT_DIR, 'stage0-economics-snapshot.json');
  let priorInventoryAtm: unknown = null;
  if (existsSync(inventoryPath)) {
    try {
      const prior = JSON.parse(readFileSync(inventoryPath, 'utf-8'));
      priorInventoryAtm = (prior?.vMinBySeries ?? []).map((s: Record<string, unknown>) => ({
        seriesKeyString: s.seriesKeyString,
        representativeMaturity: s.representativeMaturity,
        atm: s.atm && typeof s.atm === 'object' ? { strike: (s.atm as Record<string, unknown>).strike, method: (s.atm as Record<string, unknown>).method } : null,
      }));
    } catch { /* 読み取り失敗は事実として記録 */ }
  }
  let c2SpreadHasBtcUsdc: boolean | 'file-not-found' = 'file-not-found';
  if (existsSync(economicsSnapshotPath)) {
    try {
      const snap = JSON.parse(readFileSync(economicsSnapshotPath, 'utf-8'));
      const spreadKeys = Object.keys(snap?.g0c2_cRealConstruction?.c2_2_spreadSlippage ?? {});
      c2SpreadHasBtcUsdc = spreadKeys.some(k => k.toLowerCase().includes('usdc'));
      log(`stage0-economics-snapshot.json の c2_2_spreadSlippage キー: ${spreadKeys.join(',')} / btcUsdc含有=${c2SpreadHasBtcUsdc}`);
    } catch { /* 読み取り失敗は事実として記録 */ }
  }

  // ---- 1. get_instruments（fresh） ----
  log('\n>>> 1. get_instruments(currency=USDC / currency=BTC, kind=option, expired=false)');
  const usdcInstrumentsResp = await getOptionInstruments('USDC');
  await sleep(PARAMS.requestSleepMs);
  const btcInstrumentsResp = await getOptionInstruments('BTC');
  await sleep(PARAMS.requestSleepMs);
  log(`  USDC: status=${usdcInstrumentsResp.status} count=${usdcInstrumentsResp.rows.length}`);
  log(`  BTC: status=${btcInstrumentsResp.status} count=${btcInstrumentsResp.rows.length}`);

  const allUsdc = usdcInstrumentsResp.rows.map(asSeriesInstrument);
  const allBtc = btcInstrumentsResp.rows.map(asSeriesInstrument);

  const btcUsdcSeries = allUsdc.filter(i => i.price_index === 'btc_usdc' && i.base_currency === 'BTC' && i.settlement_currency === 'USDC');
  const btcStandardSeries = allBtc.filter(i => i.price_index === 'btc_usd' && i.settlement_currency === 'BTC' && i.contract_size === 1);
  log(`  btc_usdc系列 instrumentCount=${btcUsdcSeries.length} / btc_usd標準系列 instrumentCount=${btcStandardSeries.length}`);

  // ---- 2. D5/D6: 代表満期・ATM選定（両系列） ----
  log('\n>>> 2. D5/D6 代表満期・ATM選定（btc_usdc / btc_usd標準）');
  const usdcRepExpiry = pickRepresentativeExpiry(btcUsdcSeries, nowMs, PARAMS.minResidualDaysForRepresentativeMaturity);
  const stdRepExpiry = pickRepresentativeExpiry(btcStandardSeries, nowMs, PARAMS.minResidualDaysForRepresentativeMaturity);
  log(`  btc_usdc 代表満期: ${usdcRepExpiry ? new Date(usdcRepExpiry.expiryTimestamp).toISOString() + ` (残存${usdcRepExpiry.residualDays.toFixed(4)}日)` : '該当なし'}`);
  log(`  btc_usd標準 代表満期: ${stdRepExpiry ? new Date(stdRepExpiry.expiryTimestamp).toISOString() + ` (残存${stdRepExpiry.residualDays.toFixed(4)}日)` : '該当なし'}`);

  const usdcAtm = usdcRepExpiry
    ? await resolveAtmStraddle(btcUsdcSeries, usdcRepExpiry.expiryTimestamp, PARAMS.atmDeltaRange)
    : { method: 'unavailable' as const, strike: null, indexPriceAtSelection: null, callTicker: null, putTicker: null, candidateLog: [], diagLog: [], unavailableReason: '残存>=7日の上場expiryが存在しない' };
  const stdAtm = stdRepExpiry
    ? await resolveAtmStraddle(btcStandardSeries, stdRepExpiry.expiryTimestamp, PARAMS.atmDeltaRange)
    : { method: 'unavailable' as const, strike: null, indexPriceAtSelection: null, callTicker: null, putTicker: null, candidateLog: [], diagLog: [], unavailableReason: '残存>=7日の上場expiryが存在しない' };
  log(`  btc_usdc ATM: method=${usdcAtm.method} strike=${usdcAtm.strike}`);
  log(`  btc_usd標準 ATM: method=${stdAtm.method} strike=${stdAtm.strike}`);

  const usdcCallName = usdcAtm.callTicker?.instrumentName ?? null;
  const usdcPutName = usdcAtm.putTicker?.instrumentName ?? null;
  const stdCallName = stdAtm.callTicker?.instrumentName ?? null;
  const stdPutName = stdAtm.putTicker?.instrumentName ?? null;

  // ---- 依頼事項1: 板の厚み（depth=20） ----
  log(`\n>>> 3. 板の厚み get_order_book depth=${PARAMS.orderBookDepth}`);
  const orderBooks: Record<string, OrderBookSnapshot | null> = {};
  for (const [label, name] of [['btcUsdcCall', usdcCallName], ['btcUsdcPut', usdcPutName], ['btcStandardCall', stdCallName], ['btcStandardPut', stdPutName]] as const) {
    if (!name) { orderBooks[label] = null; continue; }
    orderBooks[label] = await getOrderBook(name, PARAMS.orderBookDepth);
    await sleep(PARAMS.requestSleepMs);
    log(`  ${label}(${name}): httpStatus=${orderBooks[label]?.httpStatus} bidsLevels=${orderBooks[label]?.bids.length} asksLevels=${orderBooks[label]?.asks.length}`);
  }

  // ---- 依頼事項2: 全ストライク・全満期の建玉分布（btc_usdc系列全体） ----
  log(`\n>>> 4. btc_usdc系列 全${btcUsdcSeries.length}instrumentのticker取得（openInterest/volume/best板数量）`);
  const tickerCache = new Map<string, TickerSnapshot>();
  if (usdcAtm.callTicker) tickerCache.set(usdcAtm.callTicker.instrumentName, usdcAtm.callTicker);
  if (usdcAtm.putTicker) tickerCache.set(usdcAtm.putTicker.instrumentName, usdcAtm.putTicker);

  interface DistributionRow {
    instrumentName: string; expiryIso: string; residualDaysAtFetch: number; strike: number; optionType: string;
    openInterest: number | 'API非配信'; volume: number | 'API非配信'; volumeUsd: number | 'API非配信';
    bestBidAmount: number | 'API非配信'; bestAskAmount: number | 'API非配信'; bestBidPrice: number | 'API非配信'; bestAskPrice: number | 'API非配信';
    httpStatus: number; apiError?: string;
  }
  const distributionRows: DistributionRow[] = [];
  let fetchedCount = 0;
  let reusedFromCache = 0;
  for (const inst of btcUsdcSeries) {
    let t = tickerCache.get(inst.instrument_name) ?? null;
    let diagHttpStatus = 200;
    let apiError: string | undefined;
    if (t) {
      reusedFromCache += 1;
    } else {
      const { ticker, diag } = await getTicker(inst.instrument_name);
      await sleep(PARAMS.requestSleepMs);
      fetchedCount += 1;
      diagHttpStatus = diag.httpStatus;
      apiError = diag.apiError ?? diag.fetchError;
      t = ticker;
      if (t) tickerCache.set(inst.instrument_name, t);
    }
    distributionRows.push({
      instrumentName: inst.instrument_name,
      expiryIso: new Date(inst.expiration_timestamp).toISOString(),
      residualDaysAtFetch: (inst.expiration_timestamp - nowMs) / 86400000,
      strike: inst.strike,
      optionType: inst.option_type,
      openInterest: t?.openInterest ?? 'API非配信',
      volume: t?.volume ?? 'API非配信',
      volumeUsd: t?.volumeUsd ?? 'API非配信',
      bestBidAmount: t?.bestBidAmount ?? 'API非配信',
      bestAskAmount: t?.bestAskAmount ?? 'API非配信',
      bestBidPrice: t?.bestBidPrice ?? 'API非配信',
      bestAskPrice: t?.bestAskPrice ?? 'API非配信',
      httpStatus: diagHttpStatus,
      apiError,
    });
  }
  distributionRows.sort((a, b) => (a.expiryIso < b.expiryIso ? -1 : a.expiryIso > b.expiryIso ? 1 : a.strike - b.strike));
  log(`  取得完了: 新規fetch=${fetchedCount}件 / ATM選定時のキャッシュ再利用=${reusedFromCache}件 / 合計=${distributionRows.length}件`);

  // 満期別ロールアップ（純粋な集計・解釈なし）
  interface MaturityRollup { expiryIso: string; instrumentCount: number; sumOpenInterest: number; sumVolume: number; sumVolumeUsd: number; instrumentsWithPositiveOI: number; instrumentsWithPositiveVolume: number }
  const rollupMap = new Map<string, MaturityRollup>();
  for (const row of distributionRows) {
    if (!rollupMap.has(row.expiryIso)) {
      rollupMap.set(row.expiryIso, { expiryIso: row.expiryIso, instrumentCount: 0, sumOpenInterest: 0, sumVolume: 0, sumVolumeUsd: 0, instrumentsWithPositiveOI: 0, instrumentsWithPositiveVolume: 0 });
    }
    const r = rollupMap.get(row.expiryIso)!;
    r.instrumentCount += 1;
    if (typeof row.openInterest === 'number') { r.sumOpenInterest += row.openInterest; if (row.openInterest > 0) r.instrumentsWithPositiveOI += 1; }
    if (typeof row.volume === 'number') { r.sumVolume += row.volume; if (row.volume > 0) r.instrumentsWithPositiveVolume += 1; }
    if (typeof row.volumeUsd === 'number') r.sumVolumeUsd += row.volumeUsd;
  }
  const byMaturitySummary = [...rollupMap.values()].sort((a, b) => (a.expiryIso < b.expiryIso ? -1 : 1));
  log(`  満期数=${byMaturitySummary.length}`);

  // ---- 依頼事項3: 直近の約定履歴（ATM call/put・両系列） ----
  log(`\n>>> 5. get_last_trades_by_instrument (count=${PARAMS.lastTradesCount}, include_old=${PARAMS.lastTradesIncludeOld})`);
  const lastTrades: Record<string, LastTradesResult | null> = {};
  for (const [label, name] of [['btcUsdcCall', usdcCallName], ['btcUsdcPut', usdcPutName], ['btcStandardCall', stdCallName], ['btcStandardPut', stdPutName]] as const) {
    if (!name) { lastTrades[label] = null; continue; }
    lastTrades[label] = await getLastTrades(name, PARAMS.lastTradesCount, PARAMS.lastTradesIncludeOld);
    await sleep(PARAMS.requestSleepMs);
    log(`  ${label}(${name}): httpStatus=${lastTrades[label]?.httpStatus} tradesReturned=${lastTrades[label]?.trades.length} lastTradeUTC=${lastTrades[label]?.lastTradeTimestampUTC}`);
  }

  // ---- 依頼事項4: スプレッドの実態・約定可能名目の目安 ----
  log('\n>>> 6. スプレッド実測・約定可能名目の目安（ベスト価格・板全体累積）');
  interface SpreadRow {
    instrumentName: string | null;
    bestBidPrice: number | 'API非配信' | null; bestAskPrice: number | 'API非配信' | null;
    halfSpread: number | null; halfSpreadUsd: number | null;
    bestLevelBidNotionalUsd: number | null; bestLevelAskNotionalUsd: number | null;
    fullDepthBidNotionalUsd: number | null; fullDepthAskNotionalUsd: number | null;
    depthLevelsUsed: { bids: number; asks: number };
  }
  function buildSpreadRow(ticker: TickerSnapshot | null, book: OrderBookSnapshot | null, quoteCurrency: string): SpreadRow {
    if (!ticker) return { instrumentName: null, bestBidPrice: null, bestAskPrice: null, halfSpread: null, halfSpreadUsd: null, bestLevelBidNotionalUsd: null, bestLevelAskNotionalUsd: null, fullDepthBidNotionalUsd: null, fullDepthAskNotionalUsd: null, depthLevelsUsed: { bids: 0, asks: 0 } };
    const bid = ticker.bestBidPrice; const ask = ticker.bestAskPrice;
    const half = typeof bid === 'number' && typeof ask === 'number' ? 0.5 * (ask - bid) : null;
    const indexPrice = ticker.indexPrice;
    const halfSpreadUsd = half !== null ? notionalUsdFor(quoteCurrency, half, 1, indexPrice) : null;
    const bestLevelBidNotionalUsd = notionalUsdFor(quoteCurrency, bid, ticker.bestBidAmount, indexPrice);
    const bestLevelAskNotionalUsd = notionalUsdFor(quoteCurrency, ask, ticker.bestAskAmount, indexPrice);
    let fullDepthBidNotionalUsd: number | null = null;
    let fullDepthAskNotionalUsd: number | null = null;
    let bidsLevels = 0; let asksLevels = 0;
    if (book) {
      const bidUnits = cumulativeNotional(book.bids);
      const askUnits = cumulativeNotional(book.asks);
      fullDepthBidNotionalUsd = notionalUsdFor(quoteCurrency, bidUnits, 1, indexPrice);
      fullDepthAskNotionalUsd = notionalUsdFor(quoteCurrency, askUnits, 1, indexPrice);
      bidsLevels = book.bids.length; asksLevels = book.asks.length;
    }
    return {
      instrumentName: ticker.instrumentName, bestBidPrice: bid, bestAskPrice: ask, halfSpread: half, halfSpreadUsd,
      bestLevelBidNotionalUsd, bestLevelAskNotionalUsd, fullDepthBidNotionalUsd, fullDepthAskNotionalUsd,
      depthLevelsUsed: { bids: bidsLevels, asks: asksLevels },
    };
  }
  const spreadAndNotional = {
    btcUsdc: {
      call: buildSpreadRow(usdcAtm.callTicker, orderBooks.btcUsdcCall, 'USDC'),
      put: buildSpreadRow(usdcAtm.putTicker, orderBooks.btcUsdcPut, 'USDC'),
    },
    btcStandard: {
      call: buildSpreadRow(stdAtm.callTicker, orderBooks.btcStandardCall, 'BTC'),
      put: buildSpreadRow(stdAtm.putTicker, orderBooks.btcStandardPut, 'BTC'),
    },
    note: `既存G0-C2（stage0-economics-snapshot.json の g0c2_cRealConstruction.c2_2_spreadSlippage）には 'btc'・'eth' のみが含まれ 'btcUsdc' は含まれていないことを読み取り専用で確認した（btcUsdcキー含有=${c2SpreadHasBtcUsdc}）。ゆえに本ファイルでbtc_usdcのスプレッドを独立に実測した。`,
  };

  // ---- ATM選定結果とstage0-instrument-inventory.jsonの過去実測との突き合わせ（事実記録のみ） ----
  const crossCheckNote = priorInventoryAtm
    ? `stage0-instrument-inventory.json の過去実測ATMと本実行時点のATMを突き合わせた（読み取り専用参照・上書きなし）: ${JSON.stringify(priorInventoryAtm)}`
    : 'stage0-instrument-inventory.json が存在しないか読み取れなかったため突き合わせ不可（事実記録）';

  // ---- 出力 ----
  const output = {
    experiment: 'EXP-OBS000041',
    purpose: 'BTC_USDCの流動性の追加事実確認（司令塔指示・2026-07-26。G0-E1の新規判定ゲートではない。判定語なし・事実と実測値のみ）',
    scriptPath: 'scripts/probe-btc-usdc-liquidity.ts',
    relatedSpec: 'research/EXP-OBS000041/00-spec-stage0.md（G0-E1・D5/D6の固定定義を流用。本ファイル自体はG0-E1の合否基準を変更しない）',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    params: PARAMS,
    readOnlyReferenceChecks: {
      priorInventoryAtmCrossCheckNote: crossCheckNote,
      c2SpreadSlippageContainsBtcUsdc: c2SpreadHasBtcUsdc,
    },
    instrumentListing: {
      usdcCurrencyInstruments: { url: usdcInstrumentsResp.url, status: usdcInstrumentsResp.status, totalRowsReturned: usdcInstrumentsResp.rows.length, btcUsdcSeriesCount: btcUsdcSeries.length, apiError: usdcInstrumentsResp.apiError },
      btcCurrencyInstruments: { url: btcInstrumentsResp.url, status: btcInstrumentsResp.status, totalRowsReturned: btcInstrumentsResp.rows.length, btcStandardSeriesCount: btcStandardSeries.length, apiError: btcInstrumentsResp.apiError },
    },
    atmSelection: {
      btcUsdc: {
        representativeMaturity: usdcRepExpiry ? { expiryIso: new Date(usdcRepExpiry.expiryTimestamp).toISOString(), residualDays: usdcRepExpiry.residualDays } : null,
        method: usdcAtm.method, strike: usdcAtm.strike, indexPriceAtSelection: usdcAtm.indexPriceAtSelection,
        callInstrumentName: usdcCallName, putInstrumentName: usdcPutName,
        callTicker: usdcAtm.callTicker, putTicker: usdcAtm.putTicker,
        candidateLog: usdcAtm.candidateLog, diagLog: usdcAtm.diagLog, unavailableReason: usdcAtm.unavailableReason ?? null,
      },
      btcStandard: {
        representativeMaturity: stdRepExpiry ? { expiryIso: new Date(stdRepExpiry.expiryTimestamp).toISOString(), residualDays: stdRepExpiry.residualDays } : null,
        method: stdAtm.method, strike: stdAtm.strike, indexPriceAtSelection: stdAtm.indexPriceAtSelection,
        callInstrumentName: stdCallName, putInstrumentName: stdPutName,
        callTicker: stdAtm.callTicker, putTicker: stdAtm.putTicker,
        candidateLog: stdAtm.candidateLog, diagLog: stdAtm.diagLog, unavailableReason: stdAtm.unavailableReason ?? null,
      },
    },
    orderBookDepth: {
      depthRequested: PARAMS.orderBookDepth,
      btcUsdc: { call: orderBooks.btcUsdcCall, put: orderBooks.btcUsdcPut },
      btcStandard: { call: orderBooks.btcStandardCall, put: orderBooks.btcStandardPut },
    },
    openInterestDistribution: {
      seriesKeyString: 'btc_usdc|USDC|1|0.01',
      instrumentCount: btcUsdcSeries.length,
      newlyFetchedTickerCount: fetchedCount,
      reusedFromAtmSelectionCacheCount: reusedFromCache,
      rows: distributionRows,
      byMaturitySummary,
    },
    lastTrades: {
      endpointNote: `public/get_last_trades_by_instrument（Deribit公式ドキュメント https://docs.deribit.com/#public-get_last_trades_by_instrument に記載のエンドポイント）。count=${PARAMS.lastTradesCount}, include_old=${PARAMS.lastTradesIncludeOld} を使用（デフォルトのinclude_old=falseだと直近数日分しか返らないため、最終取引時刻を確認する目的でtrueを付与）。`,
      btcUsdc: { call: lastTrades.btcUsdcCall, put: lastTrades.btcUsdcPut },
      btcStandard: { call: lastTrades.btcStandardCall, put: lastTrades.btcStandardPut },
    },
    spreadAndExecutableNotional: spreadAndNotional,
    meta: {
      requestSleepMs: PARAMS.requestSleepMs,
      totalDeribitRequestsApprox: 2 /* get_instruments */ + usdcAtm.diagLog.length + stdAtm.diagLog.length + 4 /* order books */ + fetchedCount + 4 /* last trades */,
      limitationNote: '本ファイルは現時点スナップショットのみを扱う（過去の板・OI・約定履歴は取得不可）。判定語（達成/十分/流動性がある・ない等）は使用していない。採否判断はC品質チームの職務。',
      localExecutionConstraintNote: '本スクリプトの実装・構文チェックはローカル（プロキシ経由でDeribitに直接到達不可）で行った。実データ取得はGitHub Actions（.github/workflows/obs000041-btc-usdc-liquidity-oneoff.yml・workflow_dispatch）上で実行する必要がある。',
    },
  };

  const outPath = join(RESULT_DIR, 'btc-usdc-liquidity.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  const runLogPath = join(RESULT_DIR, 'btc-usdc-liquidity-run.log');
  appendFileSync(runLogPath, [
    '='.repeat(70),
    `=== probe-btc-usdc-liquidity.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`, `Node version: ${process.version}`, '',
    'REPRODUCTION COMMAND:', '  node --experimental-strip-types scripts/probe-btc-usdc-liquidity.ts', '',
    'EXECUTION LOG:', ...execLog, '',
  ].join('\n'));
  log(`>>> 保存: ${runLogPath}`);
  log('\n=== 実行完了（判定なし・事実と実測値のみ） ===');
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
