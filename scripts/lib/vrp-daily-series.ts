/**
 * EXP-OBS000037 Stage 2: 共通ライブラリ（VRP日次系列・価格系列の取得ユーティリティ）
 *
 * 本ファイルは Stage 1 `scripts/vrp-tail-correlation.ts` の DVOL取得・価格取得・RV_forward計算・
 * 日次VRP水準系列構築ロジックを「そのまま」再利用するための共通モジュール（コードは同一・改変なし）。
 * spec §5-1「VRP_daily_t ＝ Stage 1 stage1-vrp-tail-correlation.json の日次VRP水準系列」の実体は
 * 生JSONに raw array として保存されていない（集計統計のみ保存）ため、Stage 1 と全く同一の
 * 取得・計算コード（RV窓長=7リターン＝D+1..D+8固定・√365・アンカー2021-03-24 いずれも不変）を
 * 再実行することで同一系列を得る。これは「VRP系列の再構築」（RV窓長やアンカーを新たに選び直す行為）
 * ではなく、Stage 1 で確定した定義をそのまま流用する行為である（spec §9「Stage 1
 * `vrp-tail-correlation.ts` を流用してよい」に基づく）。
 *
 * スクリプト2（vrp-tail-correlation-pnl.ts）・スクリプト3（vrp-composite-3sleeve.ts、間接的に
 * スクリプト2の出力JSON経由）から import される。
 */

export const DERIBIT_BASE = 'https://www.deribit.com/api/v2';

// ============================================================
// 日付ユーティリティ（Stage 1と同一）
// ============================================================
export function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function keyToMs(key: string): number {
  return Date.parse(`${key}T00:00:00.000Z`);
}
export function addDaysKey(key: string, n: number): string {
  return dateKey(new Date(keyToMs(key) + n * 86400000));
}
export function utcDateOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

// ============================================================
// HTTP fetch（Stage 1と同一）
// ============================================================
export interface FetchMeta {
  status: number;
  ok: boolean;
  json: unknown | null;
}
export async function fetchWithMeta(url: string): Promise<FetchMeta> {
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
export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// DVOL 取得（終了条件=空応答 or continuationなし のみ。Stage 1と同一）
// ============================================================
export interface DvolRow {
  date: string;
  timestampMs: number;
  close: number;
}
export async function fetchDvolDaily(
  currency: string,
  floorKey: string,
  ceilKeyInclusive: string,
  log: (msg: string) => void = () => {},
): Promise<{ rows: DvolRow[]; pageLog: string[] }> {
  const rows: DvolRow[] = [];
  const pageLog: string[] = [];
  let endMs = keyToMs(ceilKeyInclusive) + 86400000;
  const floorMs = keyToMs(floorKey);
  let requestCount = 0;
  const MAX_REQUESTS = 60;

  while (requestCount < MAX_REQUESTS) {
    const url = `${DERIBIT_BASE}/public/get_volatility_index_data?currency=${currency}&start_timestamp=${floorMs}&end_timestamp=${endMs}&resolution=86400`;
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
// Deribit-tradingview 価格取得（主系列。Stage 1と同一）
// ============================================================
export async function fetchDeribitPerpPriceDaily(
  instrument: string,
  floorKey: string,
  ceilKeyInclusive: string,
  log: (msg: string) => void = () => {},
): Promise<{ closeByDate: Map<string, number>; ticksReturned: number; rawTickHourUtc: number | null }> {
  const startMs = keyToMs(floorKey);
  const endMs = keyToMs(ceilKeyInclusive) + 86400000;
  const url = `${DERIBIT_BASE}/public/get_tradingview_chart_data?instrument_name=${instrument}&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=1D`;
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
// RV_forward(D,D+7d)：D+1..D+8 の8終値を使用（vrp-prediction-unit.ts / vrp-tail-correlation.ts と同一定義）
// （2026-07-12是正版 spec §2: 7リターン＝D+1..D+8の8終値。Stage 2でも不変・再構築しない）
// ============================================================
export function computeRvForward(
  dateD: string,
  closeByDate: Map<string, number>,
  targetReturnCount: number,
  annualizationRv: number,
): { rv: number | null; priceDatesUsed: string[] } {
  const priceDates: string[] = [];
  const closesUsed: number[] = [];
  const closesNeeded = targetReturnCount + 1; // 7リターン → 8終値
  for (let i = 1; i <= closesNeeded; i++) {
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
  return { rv: Math.sqrt(variance) * annualizationRv * 100, priceDatesUsed: priceDates };
}

// ============================================================
// VRP日次水準系列（毎日ローリング。Stage 1 §5-1と同一）
// ============================================================
export interface VrpDailyRow {
  date: string;
  dvol: number;
  rv_forward_pct: number;
  vrp_level: number; // その日のVRP水準（vol pt）
}
export function buildDailyVrpSeries(
  startKey: string,
  endKey: string,
  dvolByDate: Map<string, number>,
  closeByDate: Map<string, number>,
  rvForwardReturnCount: number,
  annualizationRv: number,
): VrpDailyRow[] {
  const rows: VrpDailyRow[] = [];
  let cur = startKey;
  while (cur <= endKey) {
    const dvol = dvolByDate.get(cur);
    if (dvol !== undefined) {
      const { rv } = computeRvForward(cur, closeByDate, rvForwardReturnCount, annualizationRv);
      if (rv !== null) rows.push({ date: cur, dvol, rv_forward_pct: rv, vrp_level: dvol - rv });
    }
    cur = addDaysKey(cur, 1);
  }
  return rows;
}
