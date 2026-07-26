/**
 * EXP-OBS000041 Stage 0: G0-E1（最優先・単独分岐ゲート）＋ G0-E2（満期短縮・開示のみ）
 * spec: research/EXP-OBS000041/00-spec-stage0.md §3-1, §3-2, §5-1
 *
 * 本スクリプトは判定を行わない（判定語禁止・spec §9-10）。実測値・実レスポンス・生ログのみを出力する。
 * E1-POSITIVE/PARTIAL/NEGATIVE/INCONCLUSIVE の分類当てはめはしない（C品質チームの職務）。
 *
 * 独立実装。`scripts/vrp-eth-reference.ts`／`scripts/vrp-pipeline-accounting.ts`／
 * `scripts/vrp-prediction-unit.ts`／labスクリプトのコードはコピペしていない（spec §9-2・§6）。
 * Deribitページング作法（空応答/continuation終了のみ）・fetch/ログ整形の「作法」のみ既存実装を参考にした。
 *
 * 実行順序（spec §9-5・厳守）: 本スクリプトを最初に実行し、生データを報告してから
 * vrp-eth-stage0-economics.ts（G0-C0〜C5）を実行する。
 *
 * 読み取り専用の入力（書き込みは一切しない・spec §0-3-3/5）:
 *   - research/EXP-OBS000037/10-result/stage2-vrp-pipeline-accounting.json
 *     （§3-1 step6・G0-E2で「BTCのvegaNotionalPct」として使用する cvarSizing.vegaNotionalPct_f05_main のみ参照）
 *
 * APIキー・.env.local は読まない（Deribit publicエンドポイントは認証不要）。
 *
 * 実行: node --experimental-strip-types scripts/probe-deribit-instrument-inventory.ts
 * 出力: research/EXP-OBS000041/10-result/stage0-instrument-inventory.json
 *       research/EXP-OBS000041/10-result/stage0-instrument-inventory-run.log
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
// 固定パラメータ（回す前に固定・spec §2/§3-1/§3-2）
// ============================================================
const PARAMS = {
  minResidualDaysForRepresentativeMaturity: 7,
  atmDeltaRange: [0.35, 0.65] as [number, number],
  physicalSanityToleranceAbs: 0.20,
  e1PositiveRatioThreshold: 1 / 3,
  maturityBands: [
    { label: '[7,10)', lo: 7, hi: 10 },
    { label: '[10,14)', lo: 10, hi: 14 },
    { label: '[14,21)', lo: 14, hi: 21 },
    { label: '[21,35)', lo: 21, hi: 35 },
    { label: '>=35', lo: 35, hi: Infinity },
  ],
  optionInstrumentFields: [
    'instrument_name', 'kind', 'instrument_type', 'base_currency', 'quote_currency',
    'settlement_currency', 'counter_currency', 'price_index', 'contract_size',
    'min_trade_amount', 'tick_size', 'taker_commission', 'maker_commission',
    'expiration_timestamp', 'strike', 'option_type', 'is_active',
  ] as const,
  requestSleepMs: 180,
};

// ============================================================
// HTTP fetch（生ステータス保持）
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
function apiErrorOf(r: FetchMeta): string | undefined {
  const top = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>) : undefined;
  return top?.error ? JSON.stringify(top.error) : undefined;
}

// ============================================================
// 1. get_currencies（全通貨コード実測列挙）
// ============================================================
interface CurrencyRow { currency: string; [key: string]: unknown }
async function fetchCurrencies(): Promise<{ url: string; status: number; rows: CurrencyRow[]; rawError?: string }> {
  const url = `${BASE}/public/get_currencies`;
  const r = await fetchWithMeta(url);
  const rows = (apiResult(r) as CurrencyRow[] | undefined) ?? [];
  return { url, status: r.status, rows, rawError: apiErrorOf(r) };
}

// ============================================================
// 2. get_instruments（currency別・kind別）
// ============================================================
interface RawOptionRecord { [key: string]: unknown }
async function fetchInstruments(currency: string, kind: 'option' | 'future'): Promise<{ url: string; status: number; rows: RawOptionRecord[]; apiError?: string }> {
  const url = `${BASE}/public/get_instruments?currency=${currency}&kind=${kind}&expired=false`;
  const r = await fetchWithMeta(url);
  const rows = (apiResult(r) as RawOptionRecord[] | undefined) ?? [];
  return { url, status: r.status, rows, apiError: apiErrorOf(r) };
}

// フィールドをそのまま記録・非存在は「API非配信」と明記（spec §3-1 step3）
interface NormalizedOption {
  instrument_name: unknown; kind: unknown; instrument_type: unknown; base_currency: unknown;
  quote_currency: unknown; settlement_currency: unknown; counter_currency: unknown; price_index: unknown;
  contract_size: unknown; min_trade_amount: unknown; tick_size: unknown; taker_commission: unknown;
  maker_commission: unknown; expiration_timestamp: unknown; strike: unknown; option_type: unknown; is_active: unknown;
}
function normalizeOption(raw: RawOptionRecord): NormalizedOption {
  const out: Record<string, unknown> = {};
  for (const f of PARAMS.optionInstrumentFields) {
    out[f] = Object.prototype.hasOwnProperty.call(raw, f) ? raw[f] : 'API非配信';
  }
  return out as unknown as NormalizedOption;
}

// ============================================================
// 3. BTC/ETH原資産判定（spec §3-1 step4・回す前に固定）
// ============================================================
function isBtcOrigin(o: NormalizedOption): boolean {
  const pi = typeof o.price_index === 'string' ? o.price_index.toLowerCase() : '';
  return pi.startsWith('btc') || o.base_currency === 'BTC';
}
function isEthOrigin(o: NormalizedOption): boolean {
  const pi = typeof o.price_index === 'string' ? o.price_index.toLowerCase() : '';
  return pi.startsWith('eth') || o.base_currency === 'ETH';
}

interface SeriesKey { price_index: unknown; settlement_currency: unknown; contract_size: unknown; min_trade_amount: unknown }
function seriesKeyOf(o: NormalizedOption): SeriesKey {
  return { price_index: o.price_index, settlement_currency: o.settlement_currency, contract_size: o.contract_size, min_trade_amount: o.min_trade_amount };
}
function seriesKeyString(k: SeriesKey): string {
  return `${String(k.price_index)}|${String(k.settlement_currency)}|${String(k.contract_size)}|${String(k.min_trade_amount)}`;
}

interface Series {
  key: SeriesKey;
  keyString: string;
  currency: string;
  instruments: NormalizedOption[];
}
function groupIntoSeries(options: { currency: string; opt: NormalizedOption }[]): Series[] {
  const map = new Map<string, Series>();
  for (const { currency, opt } of options) {
    const key = seriesKeyOf(opt);
    const ks = seriesKeyString(key);
    if (!map.has(ks)) map.set(ks, { key, keyString: ks, currency, instruments: [] });
    map.get(ks)!.instruments.push(opt);
  }
  return [...map.values()];
}

// ============================================================
// 4. ticker取得
// ============================================================
interface TickerGreeks { delta: unknown; gamma: unknown; vega: unknown; theta: unknown }
interface TickerSnapshot {
  instrumentName: string; indexPrice: number; markPrice: number; bestBid: number; bestAsk: number;
  greeks: TickerGreeks; openInterest: unknown; volume: unknown; volumeUsd: unknown;
}
interface TickerDiag { instrumentName: string; httpStatus: number; hasResult: boolean; hasGreeks: boolean; apiError?: string; fetchError?: string }
async function fetchTicker(instrumentName: string): Promise<{ ticker: TickerSnapshot | null; diag: TickerDiag }> {
  const url = `${BASE}/public/ticker?instrument_name=${instrumentName}`;
  const r = await fetchWithMeta(url);
  const resultObj = apiResult(r) as Record<string, unknown> | undefined;
  const apiError = apiErrorOf(r);
  if (!resultObj) return { ticker: null, diag: { instrumentName, httpStatus: r.status, hasResult: false, hasGreeks: false, apiError, fetchError: r.error } };
  const greeks = resultObj.greeks as Record<string, unknown> | undefined;
  if (!greeks) return { ticker: null, diag: { instrumentName, httpStatus: r.status, hasResult: true, hasGreeks: false, apiError } };
  const stats = resultObj.stats as Record<string, unknown> | undefined;
  return {
    ticker: {
      instrumentName,
      indexPrice: resultObj.index_price as number,
      markPrice: resultObj.mark_price as number,
      bestBid: resultObj.best_bid_price as number,
      bestAsk: resultObj.best_ask_price as number,
      greeks: { delta: greeks.delta, gamma: greeks.gamma, vega: greeks.vega, theta: greeks.theta },
      openInterest: resultObj.open_interest ?? 'API非配信',
      volume: stats?.volume ?? 'API非配信',
      volumeUsd: stats?.volume_usd ?? 'API非配信',
    },
    diag: { instrumentName, httpStatus: r.status, hasResult: true, hasGreeks: true, apiError },
  };
}

// ============================================================
// 5. 代表満期選定（D5・spec §3-1 step5・残存>=7日で最近接）
// ============================================================
interface ExpiryResidual { expiryTimestamp: number; residualDays: number }
function listExpiriesWithResidual(instruments: NormalizedOption[], nowMs: number): ExpiryResidual[] {
  const expiries = [...new Set(instruments.map(i => i.expiration_timestamp as number).filter(e => typeof e === 'number'))];
  return expiries.map(e => ({ expiryTimestamp: e, residualDays: (e - nowMs) / 86400000 })).sort((a, b) => a.expiryTimestamp - b.expiryTimestamp);
}
function pickRepresentativeExpiry(instruments: NormalizedOption[], nowMs: number, minDays: number): ExpiryResidual | null {
  const list = listExpiriesWithResidual(instruments, nowMs);
  const eligible = list.filter(x => x.residualDays >= minDays).sort((a, b) => a.residualDays - b.residualDays);
  return eligible.length > 0 ? eligible[0] : null;
}

// ============================================================
// 6. ATM選定（D6・フォールバック禁止・spec §2-2/§3-1 step5）
// ============================================================
interface AtmSelectionResult {
  method: 'deltaRange' | 'unavailable';
  strike: number | null;
  indexPriceAtSelection: number | null;
  call: TickerSnapshot | null;
  put: TickerSnapshot | null;
  candidateLog: { strike: number; delta: unknown; instrumentName: string }[];
  diagLog: TickerDiag[];
  unavailableReason?: string;
}
async function selectAtmAtExpiry(instruments: NormalizedOption[], expiryTimestamp: number, deltaRange: [number, number]): Promise<AtmSelectionResult> {
  const calls = instruments.filter(i => i.expiration_timestamp === expiryTimestamp && i.option_type === 'call');
  const putByStrike = new Map<number, NormalizedOption>();
  for (const i of instruments) {
    if (i.expiration_timestamp === expiryTimestamp && i.option_type === 'put') putByStrike.set(i.strike as number, i);
  }
  const candidateLog: { strike: number; delta: unknown; instrumentName: string }[] = [];
  const diagLog: TickerDiag[] = [];
  const candidates: { strike: number; delta: number; indexPrice: number; ticker: TickerSnapshot }[] = [];
  for (const c of calls) {
    const name = c.instrument_name as string;
    const { ticker: t, diag } = await fetchTicker(name);
    await sleep(PARAMS.requestSleepMs);
    diagLog.push(diag);
    if (!t) continue;
    const deltaVal = typeof t.greeks.delta === 'number' ? t.greeks.delta : NaN;
    candidateLog.push({ strike: c.strike as number, delta: t.greeks.delta, instrumentName: name });
    if (!Number.isNaN(deltaVal) && deltaVal >= deltaRange[0] && deltaVal <= deltaRange[1]) {
      candidates.push({ strike: c.strike as number, delta: deltaVal, indexPrice: t.indexPrice, ticker: t });
    }
  }
  if (candidates.length === 0) {
    return { method: 'unavailable', strike: null, indexPriceAtSelection: null, call: null, put: null, candidateLog, diagLog, unavailableReason: `代表満期${new Date(expiryTimestamp).toISOString()}にdelta∈[${deltaRange[0]},${deltaRange[1]}]の候補が0件（フォールバック未使用・spec §2-2）` };
  }
  candidates.sort((a, b) => Math.abs(a.strike - a.indexPrice) - Math.abs(b.strike - b.indexPrice));
  const best = candidates[0];
  const putOpt = putByStrike.get(best.strike);
  if (!putOpt) {
    return { method: 'unavailable', strike: best.strike, indexPriceAtSelection: best.indexPrice, call: best.ticker, put: null, candidateLog, diagLog, unavailableReason: `strike=${best.strike}に対応するputインストゥルメントが見つからない` };
  }
  const { ticker: putTicker, diag: putDiag } = await fetchTicker(putOpt.instrument_name as string);
  await sleep(PARAMS.requestSleepMs);
  diagLog.push(putDiag);
  if (!putTicker) {
    return { method: 'unavailable', strike: best.strike, indexPriceAtSelection: best.indexPrice, call: best.ticker, put: null, candidateLog, diagLog, unavailableReason: `put ticker取得失敗: ${putOpt.instrument_name}` };
  }
  return { method: 'deltaRange', strike: best.strike, indexPriceAtSelection: best.indexPrice, call: best.ticker, put: putTicker, candidateLog, diagLog };
}

function vegaNum(t: TickerSnapshot | null): number {
  if (!t) return NaN;
  return typeof t.greeks.vega === 'number' ? t.greeks.vega : NaN;
}

// ============================================================
// C_options（D7〜D9・候補系列ごとに資産固有の実測値で算出・開示のみ）
// ============================================================
function buildOptionsCostForCandidate(
  call: TickerSnapshot, put: TickerSnapshot, callTaker: unknown, putTaker: unknown, indexPrice: number,
): { costUsdTotal: number; vegaTotalUsdPerVolPt: number; costVolPt: number; detail: Record<string, unknown> } {
  const callTakerRate = typeof callTaker === 'number' ? callTaker : NaN;
  const putTakerRate = typeof putTaker === 'number' ? putTaker : NaN;
  const callPremiumUsd = call.markPrice * indexPrice;
  const putPremiumUsd = put.markPrice * indexPrice;
  const callFeeUsd = Number.isNaN(callTakerRate) ? NaN : Math.min(callTakerRate * indexPrice, 0.125 * callPremiumUsd);
  const putFeeUsd = Number.isNaN(putTakerRate) ? NaN : Math.min(putTakerRate * indexPrice, 0.125 * putPremiumUsd);
  const callHalfSpreadUsd = 0.5 * (call.bestAsk - call.bestBid) * indexPrice;
  const putHalfSpreadUsd = 0.5 * (put.bestAsk - put.bestBid) * indexPrice;
  const perRoundCostUsd = (callFeeUsd + callHalfSpreadUsd) + (putFeeUsd + putHalfSpreadUsd);
  const costUsdTotal = perRoundCostUsd * 2;
  const vegaTotalUsdPerVolPt = vegaNum(call) + vegaNum(put);
  const costVolPt = costUsdTotal / vegaTotalUsdPerVolPt;
  return {
    costUsdTotal, vegaTotalUsdPerVolPt, costVolPt,
    detail: { callPremiumUsd, putPremiumUsd, callFeeUsd, putFeeUsd, callHalfSpreadUsd, putHalfSpreadUsd, perRoundCostUsd, callTakerRate, putTakerRate },
  };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000041 Stage 0: probe-deribit-instrument-inventory.ts (G0-E1 + G0-E2) ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  let gitCommit = 'unknown';
  try { gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim(); } catch { /* ignore */ }
  log(`Git commit: ${gitCommit} / Node ${process.version}`);

  const nowMs = Date.now();

  // ---- 0. 読み取り専用参照: OBS000037 Stage2確定 vegaNotionalPct(f=0.5) ----
  const stage2Path = join(__dirname, '..', 'research', 'EXP-OBS000037', '10-result', 'stage2-vrp-pipeline-accounting.json');
  let btcVegaNotionalPctF05: number | null = null;
  let btcVegaNotionalPctSourceNote = '';
  if (existsSync(stage2Path)) {
    const stage2 = JSON.parse(readFileSync(stage2Path, 'utf-8'));
    btcVegaNotionalPctF05 = stage2?.cvarSizing?.vegaNotionalPct_f05_main ?? null;
    btcVegaNotionalPctSourceNote = `research/EXP-OBS000037/10-result/stage2-vrp-pipeline-accounting.json#cvarSizing.vegaNotionalPct_f05_main（読み取り専用・OBS000037側は一切変更していない）runTimestampUTC=${stage2?.runTimestampUTC}`;
  } else {
    btcVegaNotionalPctSourceNote = 'stage2-vrp-pipeline-accounting.json が見つからず vegaNotionalPct(BTC) を参照できなかった（事実記録）';
  }
  log(`BTC vegaNotionalPct(f=0.5)参照値: ${btcVegaNotionalPctF05} (${btcVegaNotionalPctSourceNote})`);

  // ---- 1. get_currencies ----
  log('\n>>> 1. get_currencies（全通貨コード実測列挙）');
  const currencies = await fetchCurrencies();
  log(`  status=${currencies.status} count=${currencies.rows.length} codes=${currencies.rows.map(r => r.currency).join(',')}`);
  await sleep(PARAMS.requestSleepMs);

  // currency=any プローブ
  log('\n>>> 1b. get_instruments?currency=any プローブ（受理されるか実測）');
  const anyProbe = await fetchInstruments('any', 'option');
  log(`  status=${anyProbe.status} rowsReturned=${anyProbe.rows.length} apiError=${anyProbe.apiError ?? 'none'}`);
  await sleep(PARAMS.requestSleepMs);

  // ---- 2. 各通貨 get_instruments(option/future) ----
  log('\n>>> 2. 通貨別 get_instruments(kind=option/future) 全件取得');
  const perCurrency: { currency: string; option: { url: string; status: number; count: number; apiError?: string }; future: { url: string; status: number; count: number; apiError?: string; instrumentNames: string[] } }[] = [];
  const allNormalizedOptions: { currency: string; opt: NormalizedOption }[] = [];
  const rawFutureByCurrency = new Map<string, RawOptionRecord[]>();

  for (const c of currencies.rows) {
    const code = c.currency;
    if (typeof code !== 'string') continue;
    const optionResp = await fetchInstruments(code, 'option');
    await sleep(PARAMS.requestSleepMs);
    const futureResp = await fetchInstruments(code, 'future');
    await sleep(PARAMS.requestSleepMs);
    for (const raw of optionResp.rows) allNormalizedOptions.push({ currency: code, opt: normalizeOption(raw) });
    rawFutureByCurrency.set(code, futureResp.rows);
    perCurrency.push({
      currency: code,
      option: { url: optionResp.url, status: optionResp.status, count: optionResp.rows.length, apiError: optionResp.apiError },
      future: { url: futureResp.url, status: futureResp.status, count: futureResp.rows.length, apiError: futureResp.apiError, instrumentNames: futureResp.rows.map(f => f.instrument_name as string) },
    });
    log(`  ${code}: option=${optionResp.status}/${optionResp.rows.length}件 future=${futureResp.status}/${futureResp.rows.length}件`);
  }

  // ---- 3. BTC/ETH原資産分類 ----
  log('\n>>> 3. BTC/ETH原資産分類（price_indexがbtc/eth始まり または base_currency一致）');
  const btcOptions = allNormalizedOptions.filter(x => isBtcOrigin(x.opt));
  const ethOptions = allNormalizedOptions.filter(x => isEthOrigin(x.opt));
  const otherOptions = allNormalizedOptions.filter(x => !isBtcOrigin(x.opt) && !isEthOrigin(x.opt));
  log(`  BTC原資産option件数=${btcOptions.length} / ETH原資産option件数=${ethOptions.length} / その他=${otherOptions.length}`);

  const btcSeries = groupIntoSeries(btcOptions);
  const ethSeries = groupIntoSeries(ethOptions);
  log(`  BTC原資産系列数=${btcSeries.length}`);
  for (const s of btcSeries) log(`    series[${s.keyString}] currency=${s.currency} instruments=${s.instruments.length}`);
  log(`  ETH原資産系列数=${ethSeries.length}`);
  for (const s of ethSeries) log(`    series[${s.keyString}] currency=${s.currency} instruments=${s.instruments.length}`);

  // ---- 4. BTC標準系列・ETH標準系列の同定（回す前に固定した規則） ----
  // BTC標準: price_index==='btc_usd' かつ settlement_currency==='BTC' かつ contract_size===1（Deribit公式BTC標準オプション仕様）
  // ETH標準: price_index==='eth_usd' かつ settlement_currency==='ETH' かつ contract_size===1（同上ETH仕様）
  const btcStandard = btcSeries.find(s => s.key.price_index === 'btc_usd' && s.key.settlement_currency === 'BTC' && s.key.contract_size === 1) ?? null;
  const ethStandard = ethSeries.find(s => s.key.price_index === 'eth_usd' && s.key.settlement_currency === 'ETH' && s.key.contract_size === 1) ?? null;
  log(`\n>>> 4. 標準系列の同定（規則: price_index='btc_usd'/'eth_usd' かつ settlement_currency='BTC'/'ETH' かつ contract_size=1）`);
  log(`  BTC標準系列: ${btcStandard ? btcStandard.keyString : '該当なし（事実記録）'}`);
  log(`  ETH標準系列: ${ethStandard ? ethStandard.keyString : '該当なし（事実記録）'}`);

  // ---- 5. 各BTC原資産系列の V_min 実測（代表満期・ATM・vega・単位導出・物理サニティ） ----
  log('\n>>> 5. 各BTC原資産系列: 代表満期・ATM選定・V_min実測');
  interface SeriesVMinResult {
    seriesKeyString: string; seriesKey: SeriesKey; currency: string; instrumentCount: number;
    representativeMaturity: { expiryIso: string; residualDays: number } | null;
    atm: AtmSelectionResult;
    vMinUsdPerVolPt: number | null;
    unitDerivation: Record<string, unknown>;
    economics: Record<string, unknown> | null;
  }
  const seriesResults: SeriesVMinResult[] = [];
  for (const s of btcSeries) {
    const rep = pickRepresentativeExpiry(s.instruments, nowMs, PARAMS.minResidualDaysForRepresentativeMaturity);
    if (!rep) {
      seriesResults.push({
        seriesKeyString: s.keyString, seriesKey: s.key, currency: s.currency, instrumentCount: s.instruments.length,
        representativeMaturity: null,
        atm: { method: 'unavailable', strike: null, indexPriceAtSelection: null, call: null, put: null, candidateLog: [], diagLog: [], unavailableReason: '残存日数>=7日の上場expiryが存在しない' },
        vMinUsdPerVolPt: null, unitDerivation: {}, economics: null,
      });
      log(`  series[${s.keyString}]: 代表満期なし（残存>=7日の上場expiryなし）`);
      continue;
    }
    const atm = await selectAtmAtExpiry(s.instruments, rep.expiryTimestamp, PARAMS.atmDeltaRange);
    const contractSize = typeof s.key.contract_size === 'number' ? s.key.contract_size : NaN;
    const minTradeAmount = typeof s.key.min_trade_amount === 'number' ? s.key.min_trade_amount : NaN;
    let vMin: number | null = null;
    let economics: Record<string, unknown> | null = null;
    if (atm.method === 'deltaRange' && atm.call && atm.put) {
      const combinedVega = vegaNum(atm.call) + vegaNum(atm.put);
      vMin = Number.isNaN(minTradeAmount) ? null : combinedVega * minTradeAmount;
      const callInst = s.instruments.find(i => i.instrument_name === atm.call!.instrumentName);
      const putInst = s.instruments.find(i => i.instrument_name === atm.put!.instrumentName);
      const costCalc = buildOptionsCostForCandidate(atm.call, atm.put, callInst?.taker_commission, putInst?.taker_commission, atm.indexPriceAtSelection as number);
      let requiredCapitalFullUsd: number | null = null;
      let requiredCapitalMinLotUsd: number | null = null;
      if (btcVegaNotionalPctF05 !== null && vMin !== null) {
        requiredCapitalFullUsd = combinedVega / btcVegaNotionalPctF05;
        requiredCapitalMinLotUsd = vMin / btcVegaNotionalPctF05;
      }
      economics = {
        note: 'BTC原資産系列であるためVRP系列・|CVaR|はBTC標準と同一という前提のもと、必要資本はBTC標準のvegaNotionalPct(f=0.5・OBS000037 Stage2確定値・読み取り専用参照)を用いて算出（spec §3-1 step6）。開示のみ・採否判定には使わない。',
        vegaNotionalPctSource: btcVegaNotionalPctSourceNote,
        vegaNotionalPctUsed: btcVegaNotionalPctF05,
        C_options_volpt: costCalc.costVolPt,
        C_options_detail: costCalc.detail,
        requiredCapitalFullStraddleUsd: requiredCapitalFullUsd,
        requiredCapitalMinLotUsd: requiredCapitalMinLotUsd,
        liquidity: {
          call: { bestBid: atm.call.bestBid, bestAsk: atm.call.bestAsk, openInterest: atm.call.openInterest, volume: atm.call.volume, volumeUsd: atm.call.volumeUsd },
          put: { bestBid: atm.put.bestBid, bestAsk: atm.put.bestAsk, openInterest: atm.put.openInterest, volume: atm.put.volume, volumeUsd: atm.put.volumeUsd },
        },
      };
    }
    seriesResults.push({
      seriesKeyString: s.keyString, seriesKey: s.key, currency: s.currency, instrumentCount: s.instruments.length,
      representativeMaturity: { expiryIso: new Date(rep.expiryTimestamp).toISOString(), residualDays: rep.residualDays },
      atm,
      vMinUsdPerVolPt: vMin,
      unitDerivation: {
        contract_size: s.key.contract_size,
        min_trade_amount: s.key.min_trade_amount,
        settlement_currency: s.key.settlement_currency,
        formula: 'V_min = (ticker.greeks.vega[call] + ticker.greeks.vega[put]) × min_trade_amount',
        note: 'ticker.greeks.vegaはDeribit公式ticker応答(https://docs.deribit.com/#public-ticker)のgreeksフィールドであり、1コントラクトあたり1.0 vol pt当たりのUSD建て評価額として linear/reversed(inverse) いずれのinstrument_typeでも同一単位系で返る前提を置く。min_trade_amountは1オーダーあたりの最小コントラクト数。この前提はA設計官が定めた物理サニティ（§3-1 step5・|実測vega比/(名目比×√残存比)−1|<=0.20）で交差検証し、逸脱時は独自補正せず不確定として記録する（physicalSanityフィールド参照）。',
      },
      economics,
    });
    log(`  series[${s.keyString}]: rep.expiry=${new Date(rep.expiryTimestamp).toISOString()} residualDays=${rep.residualDays.toFixed(4)} atm.method=${atm.method} V_min=${vMin}`);
  }

  // ---- 6. 物理サニティ（候補 vs BTC標準） ----
  log('\n>>> 6. 物理サニティ（候補系列 vs BTC標準系列）');
  const btcStandardResult = btcStandard ? seriesResults.find(r => r.seriesKeyString === btcStandard.keyString) ?? null : null;
  interface PhysicalSanity { seriesKeyString: string; nominalRatio: number | null; residualRatio: number | null; expectedRatio: number | null; actualVMinRatio: number | null; diffAbs: number | null; exceedsThreshold: boolean | null; note: string }
  const physicalSanityResults: PhysicalSanity[] = [];
  if (btcStandardResult && btcStandardResult.vMinUsdPerVolPt !== null && btcStandardResult.representativeMaturity && btcStandardResult.atm.indexPriceAtSelection !== null) {
    const stdContractSize = typeof btcStandardResult.seriesKey.contract_size === 'number' ? btcStandardResult.seriesKey.contract_size : NaN;
    const stdMinTradeAmount = typeof btcStandardResult.seriesKey.min_trade_amount === 'number' ? btcStandardResult.seriesKey.min_trade_amount : NaN;
    const stdNominal = stdContractSize * stdMinTradeAmount * (btcStandardResult.atm.indexPriceAtSelection as number);
    const stdResidual = btcStandardResult.representativeMaturity.residualDays;
    for (const r of seriesResults) {
      if (r.seriesKeyString === btcStandardResult.seriesKeyString) continue;
      if (r.vMinUsdPerVolPt === null || !r.representativeMaturity || r.atm.indexPriceAtSelection === null) {
        physicalSanityResults.push({ seriesKeyString: r.seriesKeyString, nominalRatio: null, residualRatio: null, expectedRatio: null, actualVMinRatio: null, diffAbs: null, exceedsThreshold: null, note: 'V_minまたは残存日数が算出不能のため物理サニティ算出不可（事実記録）' });
        continue;
      }
      const candContractSize = typeof r.seriesKey.contract_size === 'number' ? r.seriesKey.contract_size : NaN;
      const candMinTradeAmount = typeof r.seriesKey.min_trade_amount === 'number' ? r.seriesKey.min_trade_amount : NaN;
      const candNominal = candContractSize * candMinTradeAmount * (r.atm.indexPriceAtSelection as number);
      const nominalRatio = candNominal / stdNominal;
      const residualRatio = r.representativeMaturity.residualDays / stdResidual;
      const expectedRatio = nominalRatio * Math.sqrt(residualRatio);
      const actualVMinRatio = r.vMinUsdPerVolPt / btcStandardResult.vMinUsdPerVolPt;
      const diffAbs = Math.abs(actualVMinRatio / expectedRatio - 1);
      physicalSanityResults.push({
        seriesKeyString: r.seriesKeyString, nominalRatio, residualRatio, expectedRatio, actualVMinRatio, diffAbs,
        exceedsThreshold: diffAbs > PARAMS.physicalSanityToleranceAbs,
        note: '|(V_min(cand)/V_min(btc標準))/(名目比×√残存日数比)−1| <= 0.20（spec §3-1 step5固定閾値）。超過時は単位換算誤りの可能性として事実記録のみ（独自補正はしない）。',
      });
      log(`  physicalSanity[${r.seriesKeyString}]: nominalRatio=${nominalRatio.toFixed(6)} residualRatio=${residualRatio.toFixed(6)} expectedRatio=${expectedRatio.toFixed(6)} actualVMinRatio=${actualVMinRatio.toFixed(6)} diffAbs=${diffAbs.toFixed(6)}`);
    }
  } else {
    log('  BTC標準系列のV_minが算出できなかったため物理サニティは算出不可（事実記録）');
  }

  // ---- 7. V_minのBTC標準比（分類材料・分類当てはめ自体はしない） ----
  const vMinRatios = seriesResults.map(r => ({
    seriesKeyString: r.seriesKeyString,
    vMinUsdPerVolPt: r.vMinUsdPerVolPt,
    vMinRatioToBtcStandard: (btcStandardResult && btcStandardResult.vMinUsdPerVolPt !== null && r.vMinUsdPerVolPt !== null)
      ? r.vMinUsdPerVolPt / btcStandardResult.vMinUsdPerVolPt : null,
    e1PositiveThresholdRatio: PARAMS.e1PositiveRatioThreshold,
  }));

  // ---- 8. G0-E2: 満期短縮の開示（BTC標準系列・ETH標準系列・5残存日数帯） ----
  log('\n>>> 8. G0-E2: 満期短縮開示（BTC標準系列・ETH標準系列 × 残存日数帯5区分）');
  interface BandResult {
    bandLabel: string; expiriesInBand: string[]; shortestExpiryIso: string | null; residualDaysAtSelection: number | null;
    atm: AtmSelectionResult | null; vegaTotalUsdPerVolPt: number | null; vMinUsdPerVolPt: number | null;
    requiredCapitalFullStraddleUsd: number | null; requiredCapitalMinLotUsd: number | null; note: string;
  }
  async function computeMaturityBands(instruments: NormalizedOption[], minTradeAmount: number): Promise<BandResult[]> {
    const expiries = listExpiriesWithResidual(instruments, nowMs);
    const results: BandResult[] = [];
    for (const band of PARAMS.maturityBands) {
      const inBand = expiries.filter(e => e.residualDays >= band.lo && e.residualDays < band.hi);
      if (inBand.length === 0) {
        results.push({ bandLabel: band.label, expiriesInBand: [], shortestExpiryIso: null, residualDaysAtSelection: null, atm: null, vegaTotalUsdPerVolPt: null, vMinUsdPerVolPt: null, requiredCapitalFullStraddleUsd: null, requiredCapitalMinLotUsd: null, note: '該当expiryなし' });
        continue;
      }
      const shortest = inBand.sort((a, b) => a.residualDays - b.residualDays)[0];
      const atm = await selectAtmAtExpiry(instruments, shortest.expiryTimestamp, PARAMS.atmDeltaRange);
      let vegaTotal: number | null = null;
      let vMin: number | null = null;
      let reqFull: number | null = null;
      let reqMin: number | null = null;
      if (atm.method === 'deltaRange' && atm.call && atm.put) {
        vegaTotal = vegaNum(atm.call) + vegaNum(atm.put);
        vMin = vegaTotal * minTradeAmount;
        if (btcVegaNotionalPctF05 !== null) {
          reqFull = vegaTotal / btcVegaNotionalPctF05;
          reqMin = vMin / btcVegaNotionalPctF05;
        }
      }
      results.push({
        bandLabel: band.label, expiriesInBand: inBand.map(e => new Date(e.expiryTimestamp).toISOString()),
        shortestExpiryIso: new Date(shortest.expiryTimestamp).toISOString(), residualDaysAtSelection: shortest.residualDays,
        atm, vegaTotalUsdPerVolPt: vegaTotal, vMinUsdPerVolPt: vMin,
        requiredCapitalFullStraddleUsd: reqFull, requiredCapitalMinLotUsd: reqMin,
        note: atm.method === 'deltaRange' ? 'ATM成立（フォールバック未使用）' : `ATM不成立: ${atm.unavailableReason}`,
      });
      log(`  band[${band.label}]: shortestExpiry=${new Date(shortest.expiryTimestamp).toISOString()} residualDays=${shortest.residualDays.toFixed(4)} atm.method=${atm.method} vMin=${vMin}`);
    }
    return results;
  }

  let btcE2Bands: BandResult[] | null = null;
  let ethE2Bands: BandResult[] | null = null;
  if (btcStandard) {
    log('  --- BTC標準系列 ---');
    const minTradeAmount = typeof btcStandard.key.min_trade_amount === 'number' ? btcStandard.key.min_trade_amount : NaN;
    btcE2Bands = await computeMaturityBands(btcStandard.instruments, minTradeAmount);
  } else {
    log('  BTC標準系列が同定できなかったためG0-E2(BTC)は算出不可（事実記録）');
  }
  if (ethStandard) {
    log('  --- ETH標準系列 ---');
    const minTradeAmount = typeof ethStandard.key.min_trade_amount === 'number' ? ethStandard.key.min_trade_amount : NaN;
    ethE2Bands = await computeMaturityBands(ethStandard.instruments, minTradeAmount);
  } else {
    log('  ETH標準系列が同定できなかったためG0-E2(ETH)は算出不可（事実記録）');
  }

  // ---- 9. 未列挙通貨（エラー/レート制限）チェック ----
  const failedCurrencies = perCurrency.filter(p => p.option.status !== 200 || p.future.status !== 200);

  // ---- 出力 ----
  const output = {
    experiment: 'EXP-OBS000041',
    stage: 'Stage 0',
    gate: 'G0-E1 + G0-E2',
    scriptPath: 'scripts/probe-deribit-instrument-inventory.ts',
    specReference: 'research/EXP-OBS000041/00-spec-stage0.md §3-1, §3-2',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    params: PARAMS,
    readOnlyInputs: {
      btcVegaNotionalPctF05_source: btcVegaNotionalPctSourceNote,
      btcVegaNotionalPctF05_value: btcVegaNotionalPctF05,
      note: 'research/EXP-OBS000037/配下は読み取り専用でのみ参照。書き込みは一切行っていない（spec §0-3-5）。',
    },
    getCurrenciesRaw: { url: currencies.url, status: currencies.status, rows: currencies.rows, rawError: currencies.rawError },
    currencyAnyProbe: { url: anyProbe.url, status: anyProbe.status, rowsReturned: anyProbe.rows.length, apiError: anyProbe.apiError, note: 'currency=anyが受理されるか実測のみ。分類・列挙には通貨別の個別取得結果(perCurrencyInstruments)を正とする。' },
    perCurrencyInstruments: perCurrency,
    unlistedOrFailedCurrencies: failedCurrencies,
    fieldPresenceNote: `以下のフィールドをそのまま記録: ${PARAMS.optionInstrumentFields.join(', ')}。フィールドがAPI応答に存在しない場合は文字列"API非配信"を記録（推測で埋めない・spec §3-1 step3）。`,
    classification: {
      btcOriginOptionCount: btcOptions.length,
      ethOriginOptionCount: ethOptions.length,
      otherOptionCount: otherOptions.length,
      btcOriginSeries: btcSeries.map(s => ({ keyString: s.keyString, key: s.key, currency: s.currency, instrumentCount: s.instruments.length, sampleInstrumentNames: s.instruments.slice(0, 5).map(i => i.instrument_name) })),
      ethOriginSeries: ethSeries.map(s => ({ keyString: s.keyString, key: s.key, currency: s.currency, instrumentCount: s.instruments.length, sampleInstrumentNames: s.instruments.slice(0, 5).map(i => i.instrument_name) })),
      allBtcOriginOptionInstruments: btcOptions.map(x => ({ currency: x.currency, ...x.opt })),
      allEthOriginOptionInstruments: ethOptions.map(x => ({ currency: x.currency, ...x.opt })),
    },
    standardSeriesSelection: {
      rule: "BTC標準: price_index==='btc_usd' かつ settlement_currency==='BTC' かつ contract_size===1。ETH標準: price_index==='eth_usd' かつ settlement_currency==='ETH' かつ contract_size===1（回す前に固定・Deribit公式標準オプション仕様に基づく）。",
      btcStandard: btcStandard ? { keyString: btcStandard.keyString, key: btcStandard.key, currency: btcStandard.currency, instrumentCount: btcStandard.instruments.length } : null,
      ethStandard: ethStandard ? { keyString: ethStandard.keyString, key: ethStandard.key, currency: ethStandard.currency, instrumentCount: ethStandard.instruments.length } : null,
      note: 'このV_min(btc標準)は本スクリプト実行内で同一手続きにより実測した値であり、G0-C1（vrp-eth-stage0-economics.ts）の同時点スナップショットとは別実行である。実行順序制約（spec §9-5・E1を最初に実行）により、E1classificationのV_min(btc標準)は本スクリプト内自己完結の実測値を用いる。乖離があり得る旨をここに明記する。',
    },
    vMinBySeries: seriesResults,
    physicalSanity: physicalSanityResults,
    vMinRatiosToBtcStandard: vMinRatios,
    g0e2_maturityBands: {
      btc: btcE2Bands,
      eth: ethE2Bands,
      representativeMaturityRuleNote: 'D5（代表満期規則=残存>=7日で最近接）は本G0-E2開示のいかなる結果によっても変更しない（spec §3-2固定規則）。本表は開示のみで主要な必要資本の算出には使用しない。',
      vegaNotionalPctUsed: { value: btcVegaNotionalPctF05, source: btcVegaNotionalPctSourceNote },
    },
    meta: {
      pagingPolicyNote: 'get_instruments/ticker/get_currenciesはいずれも単発リクエスト（continuation方式のページングを持たない・Deribit public APIの仕様）。DVOLページングはvrp-eth-stage0-economics.tsで実施し、そちらで空応答/continuation終了のみのポリシーを適用する。',
      requestSleepMs: PARAMS.requestSleepMs,
      limitationNote: '本スクリプトはE1/E2で必要な現時点スナップショットのみを扱う（過去のvega/spread/流動性は取得不可）。',
    },
  };

  const outPath = join(RESULT_DIR, 'stage0-instrument-inventory.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  const runLogPath = join(RESULT_DIR, 'stage0-instrument-inventory-run.log');
  appendFileSync(runLogPath, [
    '='.repeat(70),
    `=== probe-deribit-instrument-inventory.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`, `Node version: ${process.version}`, '',
    'REPRODUCTION COMMAND:', '  node --experimental-strip-types scripts/probe-deribit-instrument-inventory.ts', '',
    'EXECUTION LOG:', ...executionLog, '',
  ].join('\n'));
  log(`>>> 保存: ${runLogPath}`);
  log('\n=== 実行完了（G0-E1 + G0-E2・判定なし・生データのみ） ===');
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
