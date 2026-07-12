/**
 * EXP-OBS000037 Stage 0: Deribit データプローブ
 * G0-1（Deribit米国IPアクセス性）+ G0-2（DVOL履歴深度・RV自前計算 feasibility）
 * spec: research/EXP-OBS000037/00-spec-stage0.md
 *
 * 本スクリプトは判定を行わない。実測値・実レスポンスのみを記録する。
 * 対象は BTC のみ（spec §1-1・ETH取得禁止）。
 *
 * 実行環境:
 *   - ローカル実行: `node --experimental-strip-types scripts/probe-deribit-vrp-data.ts`
 *     出力: research/EXP-OBS000037/10-result/deribit-probe-local.json
 *   - GitHub Actions実行（.github/workflows/obs000037-deribit-probe.yml）:
 *     process.env.GITHUB_ACTIONS === 'true' を検知し、
 *     出力: research/EXP-OBS000037/10-result/deribit-probe-github-actions.json
 *   G0-1の合否判定材料はgithub-actions版の結果（米国IP）。localは参考記録のみ（spec §3 G0-1）。
 *
 * ページング作法（spec §3 G0-2 チェックリスト厳守）:
 *   - 終了条件は「空応答（返却0件）」または「continuationが返らない（null/undefined）」のみ。
 *   - 「返却件数 < 期待件数で終了」は使わない。
 *   - continuationが返る場合は end_timestamp = continuation として時間窓を過去方向へ前進させる
 *     （実測: get_volatility_index_data は1リクエストあたり最大1000件を返し、それ以上の範囲を
 *     要求すると result.continuation に「まだ未取得の過去側の終端タイムスタンプ」が返る）。
 *
 * APIキー・.env.local は読まない（Deribit publicエンドポイントは認証不要）。
 * 参考のみ・コピペ禁止: crypto-strategy-lab/research/EXP-OBS000001/scripts/probe-deribit-vol-data.ts
 * （独立に書き直し。ロジック・URL構成・ページング判定は本ファイルで独自実装）。
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
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
// GitHub Actionsが自動設定する標準環境変数（Secrets不要・spec §3-G0-1「環境変数・Secretsは使わない」に合致）。
const RUN_ENV: 'github-actions' | 'local' = process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local';

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
function dateRangeKeys(startKey: string, endKeyInclusive: string): string[] {
  const out: string[] = [];
  let cur = startKey;
  while (cur <= endKeyInclusive) {
    out.push(cur);
    cur = addDaysKey(cur, 1);
  }
  return out;
}

// ============================================================
// §2 固定窓（B実装官は変更しない）
// ============================================================
const WINDOWS: Record<string, { start: string; end: string; role: string }> = {
  T1: { start: '2020-02-20', end: '2020-04-30', role: '窓外であることの確認対象（DVOL導入前で非カバー想定）' },
  T2: { start: '2022-05-01', end: '2022-06-30', role: 'DVOLカバー必須窓（LUNA/UST崩壊）' },
  T3: { start: '2022-10-25', end: '2022-12-15', role: 'DVOLカバー必須窓（FTX破綻）' },
  INC: { start: '2021-01-01', end: '2021-06-30', role: 'DVOL起点探索窓' },
  calm: { start: '2021-07-01', end: '2021-12-31', role: '平穏参照窓（RV自前計算feasibility）' },
};
const DVOL_ORIGIN_SEARCH_FLOOR = '2015-01-01'; // 実測上の探索下限（Deribit自体の創業以前まで十分に遡る安全マージン）

// ============================================================
// HTTP fetch（生ステータス・本文先頭を必ず保持する）
// ============================================================
interface FetchMeta {
  status: number;
  ok: boolean;
  bodyHead: string;
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
    return { status: res.status, ok: res.ok, bodyHead: text.slice(0, 500), json };
  } catch (err) {
    return { status: 0, ok: false, bodyHead: '', json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================
// G0-1: 3エンドポイント疎通確認
// ============================================================
interface EndpointProbeResult {
  name: string;
  url: string;
  status: number;
  ok: boolean;
  hasResultField: boolean;
  bodyHead: string;
  error?: string;
}

async function probeEndpoints(): Promise<EndpointProbeResult[]> {
  const nowMs = Date.now();
  const weekAgoMs = nowMs - 7 * 86400000;
  const results: EndpointProbeResult[] = [];

  const targets: { name: string; url: string }[] = [
    {
      name: 'get_volatility_index_data(a)',
      url: `${BASE}/public/get_volatility_index_data?currency=BTC&start_timestamp=${weekAgoMs}&end_timestamp=${nowMs}&resolution=86400`,
    },
    {
      name: 'get_tradingview_chart_data(b)',
      url: `${BASE}/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp=${weekAgoMs}&end_timestamp=${nowMs}&resolution=1D`,
    },
    {
      name: 'get_order_book(c)',
      url: `${BASE}/public/get_order_book?instrument_name=BTC-PERPETUAL&depth=5`,
    },
    {
      name: 'ticker(c)',
      url: `${BASE}/public/ticker?instrument_name=BTC-PERPETUAL`,
    },
  ];

  for (const t of targets) {
    log(`  GET ${t.url}`);
    const r = await fetchWithMeta(t.url);
    const hasResultField = !!(r.json && typeof r.json === 'object' && 'result' in (r.json as Record<string, unknown>));
    results.push({
      name: t.name,
      url: t.url,
      status: r.status,
      ok: r.ok,
      hasResultField,
      bodyHead: r.bodyHead,
      error: r.error,
    });
    log(`    status=${r.status} ok=${r.ok} hasResultField=${hasResultField}${r.error ? ` error=${r.error}` : ''}`);
    await sleep(300);
  }
  return results;
}

// ============================================================
// G0-2: DVOL 履歴取得（空応答／continuationなしで終了・length<limit終了は禁止）
// ============================================================
interface DvolRow {
  date: string;
  timestampMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface DvolFetchResult {
  rows: DvolRow[];
  pageLog: string[];
  requestCount: number;
  terminationReason: string;
}

async function fetchDvolPagedBackward(currency: string, floorKey: string, ceilKeyInclusive: string): Promise<DvolFetchResult> {
  const rows: DvolRow[] = [];
  const pageLog: string[] = [];
  let endMs = keyToMs(ceilKeyInclusive) + 86400000; // ceil日を含めるため+1日
  const floorMs = keyToMs(floorKey);
  let requestCount = 0;
  const MAX_REQUESTS = 60; // 反復回数の安全上限（終了条件そのものではない。終了条件は空応答/continuationなしのみ）
  let terminationReason = 'max_requests_reached';

  while (requestCount < MAX_REQUESTS) {
    const url = `${BASE}/public/get_volatility_index_data?currency=${currency}&start_timestamp=${floorMs}&end_timestamp=${endMs}&resolution=86400`;
    const r = await fetchWithMeta(url);
    requestCount++;
    const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
    const data = (resultObj?.data as number[][] | undefined) ?? [];
    const continuation = resultObj && 'continuation' in resultObj ? (resultObj.continuation as number | null) : undefined;
    pageLog.push(`request#${requestCount} url=${url} status=${r.status} rowsReturned=${data.length} continuation=${JSON.stringify(continuation)}`);
    log(`  DVOL page#${requestCount} (${currency}): rowsReturned=${data.length} continuation=${JSON.stringify(continuation)}`);

    if (!Array.isArray(data) || data.length === 0) {
      terminationReason = 'empty_response';
      log(`  DVOL pagination終了（空応答）`);
      break;
    }
    for (const d of data) {
      rows.push({ timestampMs: d[0], date: dateKey(new Date(d[0])), open: d[1], high: d[2], low: d[3], close: d[4] });
    }
    if (continuation === null || continuation === undefined) {
      terminationReason = 'continuation_null_or_absent';
      log(`  DVOL pagination終了（continuationなし＝これ以上遡る過去データなし）`);
      break;
    }
    endMs = continuation as number;
    await sleep(300);
  }

  // 重複排除（timestampMsキー）・時系列昇順ソート
  const map = new Map<number, DvolRow>();
  for (const row of rows) map.set(row.timestampMs, row);
  const sorted = [...map.values()].sort((a, b) => a.timestampMs - b.timestampMs);
  return { rows: sorted, pageLog, requestCount, terminationReason };
}

// ============================================================
// G0-2: BTC-PERPETUAL 価格履歴（RV自前計算用）
// ⚠ 実測: get_tradingview_chart_data の resolution=1D ローソク足タイムスタンプは
//   00:00:00.000 UTC でなく 08:00:00.000 UTC にアンカーされている（起動時の実測で確認・下記ログに記録）。
//   本スクリプトは「ティック自身のISO日付文字列」を素直に date ラベルとして採用し、
//   DVOL（00:00:00 UTC アンカー）とはカレンダー日付文字列の一致のみで突合する
//   （時刻オフセットの補正・解釈は行わない＝実測事実の記録に徹する）。
// ============================================================
interface PriceRow {
  date: string;
  tickTimestampMs: number;
  close: number;
}

interface PriceFetchResult {
  rows: PriceRow[];
  status: string | null;
  rawTickHourUtc: number | null; // 実測: ティックのUTC時刻（時）。08なら08:00:00 UTCアンカー。
  source: 'deribit-tradingview' | 'binance-csv-fallback';
  requestUrl?: string;
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
  if (!Array.isArray(ticks) || ticks.length === 0 || status !== 'ok') {
    return { rows: [], status, rawTickHourUtc: null, source: 'deribit-tradingview', requestUrl: url };
  }
  const rows: PriceRow[] = ticks.map((t, i) => ({ date: dateKey(new Date(t)), tickTimestampMs: t, close: closes[i] }));
  const rawTickHourUtc = new Date(ticks[0]).getUTCHours();
  return { rows, status, rawTickHourUtc, source: 'deribit-tradingview', requestUrl: url };
}

/** Binance CSVフォールバック（Deribit価格が米国IPで取れない/薄い場合のみ使用。出典を明記して区別する） */
function fetchBinanceCsvFallback(floorKey: string, ceilKeyInclusive: string): PriceFetchResult {
  const csvPath = join(__dirname, 'data', 'btc-daily-binance-2017-2026.csv');
  if (!existsSync(csvPath)) {
    return { rows: [], status: 'csv-not-found', rawTickHourUtc: null, source: 'binance-csv-fallback' };
  }
  const lines = readFileSync(csvPath, 'utf-8').trim().split('\n').slice(1);
  const rows: PriceRow[] = [];
  for (const line of lines) {
    const parts = line.split(',');
    const date = parts[0];
    const close = parseFloat(parts[4]);
    if (date >= floorKey && date <= ceilKeyInclusive) {
      rows.push({ date, tickTimestampMs: keyToMs(date), close });
    }
  }
  return { rows, status: 'ok-from-csv', rawTickHourUtc: 0, source: 'binance-csv-fallback' };
}

// ============================================================
// RV自前計算（日次対数リターンの年率化標準偏差＝年率ボラ%）
// ============================================================
function computeAnnualizedRvSeries(priceRows: PriceRow[]): { date: string; rv_annualized_pct: number }[] {
  const sorted = [...priceRows].sort((a, b) => a.date.localeCompare(b.date));
  const out: { date: string; rv_annualized_pct: number }[] = [];
  // 単純化: 隣接2点間の対数リターンをそのまま「その日1点の実現ボラ推定」として使うのではなく、
  // spec が要求するのは「窓内で日次対数リターンの年率化標準偏差としてRVを計算できるか」という
  // feasibility確認のため、ここでは窓全体の日次リターン系列から1つの年率標準偏差を算出する
  // （ローリングRVの生成はStage 1のシグナル設計事項＝本Stage 0では行わない）。
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].close;
    const cur = sorted[i].close;
    if (prev > 0 && cur > 0) {
      const logRet = Math.log(cur / prev);
      out.push({ date: sorted[i].date, rv_annualized_pct: logRet }); // 一旦logRetを格納。呼び出し側で年率標準偏差に集約する
    }
  }
  return out;
}

function annualizedStdPct(logReturns: number[]): number | null {
  if (logReturns.length < 2) return null;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  const dailyStd = Math.sqrt(variance);
  return dailyStd * Math.sqrt(365) * 100;
}

// ============================================================
// get_historical_volatility（参考・長期RV取得不可の確認）
// ============================================================
async function probeHistoricalVolatility(currency: string): Promise<{ url: string; status: number; count: number; oldest: string | null; newest: string | null; bodyHead: string }> {
  const url = `${BASE}/public/get_historical_volatility?currency=${currency}`;
  log(`  GET ${url}`);
  const r = await fetchWithMeta(url);
  const resultArr = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as number[][] | undefined : undefined;
  const data = Array.isArray(resultArr) ? resultArr : [];
  return {
    url,
    status: r.status,
    count: data.length,
    oldest: data.length > 0 ? new Date(data[0][0]).toISOString() : null,
    newest: data.length > 0 ? new Date(data[data.length - 1][0]).toISOString() : null,
    bodyHead: r.bodyHead,
  };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 Stage 0: Deribit データプローブ（G0-1 + G0-2） ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  log(`実行環境判定: RUN_ENV=${RUN_ENV}（process.env.GITHUB_ACTIONS=${process.env.GITHUB_ACTIONS ?? 'undefined'}）`);
  log(`Node version: ${process.version}`);
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim();
  } catch {
    /* ignore */
  }
  log(`Git commit: ${gitCommit}`);

  // ---------------- G0-1 ----------------
  log('\n>>> G0-1: エンドポイント疎通確認（3系統）');
  const endpointResults = await probeEndpoints();

  // ---------------- G0-2-1: DVOL実起点特定（過去方向ページング） ----------------
  log('\n>>> G0-2-1: DVOL実起点特定（過去方向ページング。フロア=' + DVOL_ORIGIN_SEARCH_FLOOR + '）');
  const todayKey = dateKey(new Date());
  const dvolOriginSearch = await fetchDvolPagedBackward('BTC', DVOL_ORIGIN_SEARCH_FLOOR, todayKey);
  const dvolOriginTimestamp = dvolOriginSearch.rows.length > 0 ? dvolOriginSearch.rows[0].timestampMs : null;
  log(`  DVOL実起点候補（最古足）: ${dvolOriginTimestamp !== null ? new Date(dvolOriginTimestamp).toISOString() : 'データなし'}（総取得件数=${dvolOriginSearch.rows.length}, リクエスト回数=${dvolOriginSearch.requestCount}, 終了理由=${dvolOriginSearch.terminationReason}）`);

  // ---------------- G0-2-2: 各固定窓のDVOLカバレッジ ----------------
  log('\n>>> G0-2-2: 固定窓ごとのDVOLカバレッジ実測（T1/T2/T3/INC/calm）');
  const windowDvolResults: Record<string, unknown> = {};
  const windowPriceResults: Record<string, unknown> = {};
  const windowVrpResults: Record<string, unknown> = {};

  for (const [key, w] of Object.entries(WINDOWS)) {
    log(`\n  --- 窓 ${key} (${w.start}〜${w.end}) ---`);
    const expectedDates = dateRangeKeys(w.start, w.end);

    // DVOL
    const dvolFetch = await fetchDvolPagedBackward('BTC', w.start, w.end);
    const dvolDateSet = new Set(dvolFetch.rows.map(r => r.date));
    const dvolMissingDates = expectedDates.filter(d => !dvolDateSet.has(d));
    const dvolCount = expectedDates.filter(d => dvolDateSet.has(d)).length;
    const dvolMissingRate = expectedDates.length > 0 ? dvolMissingDates.length / expectedDates.length : null;
    log(`  DVOL: 期待日数=${expectedDates.length} 実測本数=${dvolCount} 欠損本数=${dvolMissingDates.length} 欠損率=${dvolMissingRate !== null ? (dvolMissingRate * 100).toFixed(2) : 'N/A'}%`);
    windowDvolResults[key] = {
      windowStart: w.start,
      windowEnd: w.end,
      role: w.role,
      expectedDays: expectedDates.length,
      actualDaysWithData: dvolCount,
      missingDaysCount: dvolMissingDates.length,
      missingRate: dvolMissingRate,
      missingDates: dvolMissingDates,
      requestCount: dvolFetch.requestCount,
      terminationReason: dvolFetch.terminationReason,
      rawRowCount: dvolFetch.rows.length,
    };

    // RV自前計算 feasibility（Deribit価格→フォールバックBinance CSV）
    let priceResult = await fetchDeribitPerpPriceDaily('BTC-PERPETUAL', addDaysKey(w.start, -2), w.end);
    let priceSourceUsed: 'deribit-tradingview' | 'binance-csv-fallback' = 'deribit-tradingview';
    if (priceResult.rows.length === 0) {
      log(`  Deribit価格取得0件のためBinance CSVフォールバックを使用`);
      priceResult = fetchBinanceCsvFallback(addDaysKey(w.start, -2), w.end);
      priceSourceUsed = 'binance-csv-fallback';
    }
    const priceDateSet = new Set(priceResult.rows.map(r => r.date));
    const priceMissingDates = expectedDates.filter(d => !priceDateSet.has(d));
    log(`  価格(RV用, source=${priceSourceUsed}): 取得本数=${priceResult.rows.length} 窓内欠損本数=${priceMissingDates.length} rawTickHourUtc=${priceResult.rawTickHourUtc}`);

    const logReturnRows = computeAnnualizedRvSeries(priceResult.rows).filter(r => r.date >= w.start && r.date <= w.end);
    const windowAnnualizedStd = annualizedStdPct(logReturnRows.map(r => r.rv_annualized_pct));
    windowPriceResults[key] = {
      windowStart: w.start,
      windowEnd: w.end,
      source: priceSourceUsed,
      rawTickHourUtc: priceResult.rawTickHourUtc,
      requestUrl: priceResult.requestUrl ?? null,
      priceRowsFetched: priceResult.rows.length,
      windowExpectedDays: expectedDates.length,
      windowMissingDaysCount: priceMissingDates.length,
      dailyLogReturnCountInWindow: logReturnRows.length,
      windowAnnualizedRvPct: windowAnnualizedStd,
    };

    // VRP_t = DVOL_t - RV_t 構築可能日数（同一UTC日付での突合。RVは窓全体1点でなく日次対応は行わない旨明記）
    // ⚠ ここでいう「構築可能日数」は「DVOL日次値が存在する日数」×「窓内でRV(年率標準偏差)が算出できたか」の
    //   組み合わせ可否の実測であり、日次ローリングRVの構築（Stage1シグナル設計）は行わない。
    const vrpConstructibleDaysCount = windowAnnualizedStd !== null ? dvolCount : 0;
    windowVrpResults[key] = {
      dvolAvailableDaysInWindow: dvolCount,
      windowRvComputed: windowAnnualizedStd !== null,
      vrpConstructibleDaysCount,
      note: 'vrpConstructibleDaysCount = DVOLが存在する日数（窓内でRV年率標準偏差が算出できた場合のみ非ゼロ）。日次ローリングVRP系列の構築はStage 1の職務。',
    };
    log(`  VRP構築可否: dvolAvailableDays=${dvolCount} windowRvComputed=${windowAnnualizedStd !== null} vrpConstructibleDaysCount=${vrpConstructibleDaysCount}`);

    await sleep(200);
  }

  // ---------------- G0-2-3: get_historical_volatility（参考） ----------------
  log('\n>>> G0-2-3: get_historical_volatility 返却範囲の実測（参考・長期RV取得不可の確認）');
  const histVol = await probeHistoricalVolatility('BTC');
  log(`  status=${histVol.status} count=${histVol.count} oldest=${histVol.oldest} newest=${histVol.newest}`);

  // ---------------- 出力 ----------------
  const output = {
    experiment: 'EXP-OBS000037',
    stage: 'Stage 0',
    scriptPath: 'scripts/probe-deribit-vrp-data.ts',
    specReference: 'research/EXP-OBS000037/00-spec-stage0.md',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    runEnv: RUN_ENV,
    githubActionsEnvVarRaw: process.env.GITHUB_ACTIONS ?? null,
    gitCommit,
    nodeVersion: process.version,
    scope: { assets: ['BTC'], note: 'ETH取得禁止（spec §1-1固定）' },
    endpoints: {
      base: BASE,
      get_volatility_index_data: `${BASE}/public/get_volatility_index_data?currency=BTC&start_timestamp={ms}&end_timestamp={ms}&resolution=86400`,
      get_tradingview_chart_data: `${BASE}/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp={ms}&end_timestamp={ms}&resolution=1D`,
      get_order_book: `${BASE}/public/get_order_book?instrument_name=BTC-PERPETUAL&depth=5`,
      ticker: `${BASE}/public/ticker?instrument_name=BTC-PERPETUAL`,
      get_historical_volatility: `${BASE}/public/get_historical_volatility?currency=BTC`,
    },
    g0_1_endpoint_access: {
      note: `本実行の環境=${RUN_ENV}。G0-1の合否判定材料はgithub-actions版の結果（spec §3 G0-1）。`,
      results: endpointResults,
    },
    g0_2_dvol_origin: {
      searchFloorKey: DVOL_ORIGIN_SEARCH_FLOOR,
      searchCeilKey: todayKey,
      oldestTimestampFound: dvolOriginTimestamp,
      oldestTimestampFoundIso: dvolOriginTimestamp !== null ? new Date(dvolOriginTimestamp).toISOString() : null,
      totalRowsFetched: dvolOriginSearch.rows.length,
      requestCount: dvolOriginSearch.requestCount,
      terminationReason: dvolOriginSearch.terminationReason,
      pageLog: dvolOriginSearch.pageLog,
      observedMaxRowsPerRequest: Math.max(0, ...dvolOriginSearch.pageLog.map(l => {
        const m = l.match(/rowsReturned=(\d+)/);
        return m ? parseInt(m[1], 10) : 0;
      })),
    },
    g0_2_window_dvol_coverage: windowDvolResults,
    g0_2_window_rv_feasibility: windowPriceResults,
    g0_2_window_vrp_constructibility: windowVrpResults,
    g0_2_get_historical_volatility: histVol,
    priceTickTimezoneNote:
      'get_tradingview_chart_data の resolution=1D ローソク足タイムスタンプは実測で 08:00:00.000 UTC アンカー（00:00:00.000 UTC ではない）。' +
      '本スクリプトはティック自身のISO日付文字列をそのままdateラベルとして採用し、DVOL(00:00:00 UTCアンカー)とはカレンダー日付文字列一致のみで突合している（時刻オフセット補正は行っていない）。',
    pagingPolicyNote:
      '終了条件は「空応答（返却0件）」または「continuationがnull/undefined」のみ。「返却件数<期待件数で終了」は使用していない。',
  };

  const outPath = join(RESULT_DIR, `deribit-probe-${RUN_ENV}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  // run.log 追記
  const runLogPath = join(RESULT_DIR, 'probe-deribit-vrp-data-run.log');
  const block = [
    '='.repeat(70),
    `=== probe-deribit-vrp-data.ts 実行 ${RUN_TIMESTAMP} (env=${RUN_ENV}) ===`,
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/probe-deribit-vrp-data.ts',
    '',
    'EXECUTION LOG:',
    ...executionLog,
    '',
  ].join('\n');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(runLogPath, block);
  log(`>>> 保存: ${runLogPath}`);

  log('\n=== 実行完了 ===');
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
