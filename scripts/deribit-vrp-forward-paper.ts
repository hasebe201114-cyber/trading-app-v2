/**
 * EXP-OBS000037 Stage 2 会計更新: Deribit VRP フォワード較正ハーネス 日次冪等追記
 * spec: research/EXP-OBS000037/00-spec-stage2.md §7（フォワード較正設計）
 *
 * 【2026-07-14 Stage 2 accounting update】
 * Stage 2バックテスト（§2〜§6）通過＋Stage 2採用可（C品質チーム宣告 2026-07-13）を受け、
 * Stage 0のプレースホルダ会計（lab仮置き1.8 vol pt/週・PLACEHOLDER_CAPITAL_SCALING=1.0）を
 * spec §7-2の指示に従い§2実測コスト（C_real=2.8613 vol pt/週）＋§3 vegaNotionalPct（f=0.5=0.00020084）
 * に置換する。
 *
 * net_pnl_pct の新会計式（日次観測値・週次コホート方式）:
 *   vrp = dvol - rv_forward_7d              (フル週次VRP水準の日次観測)
 *   net_pnl_pct = (vrp - C_real) × VEGA_NOTIONAL_PCT × 100  (資本比% ≈ §4-1週次payoff)
 *
 * vrp = DVOL_t − rv_forward_7d_t はそれ自体フル週次VRP（重複コホート）の日次観測値。
 * C_realも週次フルコストをそのまま差し引く（C_real/7の日割りにしない）。
 * これにより各日のnet_pnl_pctが§4-1の r_t = vegaNotionalPct × (VRP_w − C_real) と同軸になり、
 * F判定時は go-live日から7日ごとの**非重複サンプリング**で週次系列を構築する（7日分合算しない）。
 * RUIN-1（単一週次損失基準）も単一ポジション前提と整合する。
 *
 * OBS000032の scripts/bitget-carry-forward-paper.ts を「雛形」として参照し、日付アンカー
 * （today-1）・warmup/live設計・冪等追記・ページング作法（空応答/continuationなし終了）の
 * 作法のみを流用する。コード・会計ロジックはコピペせず本ファイルで独立に書き直す。
 *
 * ⚠ このスクリプトは「1回実行すれば完成する」ものではない。日次（または定期的）に実行することで
 *   ライブ日数が1日ずつ蓄積される設計。F1〜F4の正式判定はライブ≥90暦日到達後にC正式監査で行う。
 *
 * 記録項目:
 *   date / phase / dvol / dvol_daily_change_vol_pts / dvol_spike_marker /
 *   rv_forward_7d / vrp / net_pnl_pct / sleeve_return / price_source
 *
 * 実行: node --experimental-strip-types scripts/deribit-vrp-forward-paper.ts
 * 引数なし・冪等（同一UTC日に複数回実行しても新規行の二重追記はしない）。
 * APIキー・.env.local は読まない（Deribit publicエンドポイントは認証不要）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000037', '10-result', 'forward');
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
// 固定パラメータ（spec §3 G0-4・spec本文の値でハードコード）
// ============================================================
const WARMUP_DAYS = 7; // spec: phase「warmup（最初の7日・シグナル未確定）」
const RV_FORWARD_DAYS = 7; // VRPは7日後方RVを要する（spec §3 記録項目 rv_forward_7d）
const DVOL_SPIKE_THRESHOLD_VOL_PTS = 5.0; // candidate tail marker の固定定義閾値（探索・最適化なし。単なる記録用定義）
// 【2026-07-14 Stage 2 会計更新】Stage 0プレースホルダ（1.8/1.0）をStage 2バックテスト実測値に置換
const C_REAL_WEEKLY_COST_VOL_PT = 2.8612547352068765; // §2実測コスト（C_real: 往復+ヘッジ+資金調達）
const VEGA_NOTIONAL_PCT = 0.00020083800084379173;     // §3 vegaNotionalPct（f=0.5・ES CVaR基準サイジング）

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
function todayUTCKey(): string {
  return dateKey(new Date());
}
/** 最後に完全に経過したUTC日（today-1）。当日の部分足混入を避ける設計判断（OBS000032と同型）。 */
function anchorDateKey(): string {
  return addDaysKey(todayUTCKey(), -1);
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
// HTTP fetch
// ============================================================
async function fetchJson(url: string): Promise<{ status: number; json: unknown | null; error?: string }> {
  try {
    const res = await fetch(url);
    const text = await res.text();
    let json: unknown | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ============================================================
// Deribit DVOL 取得（空応答/continuationなしで終了。length<limit終了禁止）
// ============================================================
async function fetchDvolMap(currency: string, floorKey: string, ceilKeyInclusive: string): Promise<{ map: Map<string, number>; pageLog: string[]; requestCount: number }> {
  const map = new Map<string, number>();
  const pageLog: string[] = [];
  let endMs = keyToMs(ceilKeyInclusive) + 86400000;
  const floorMs = keyToMs(floorKey);
  let requestCount = 0;
  const MAX_REQUESTS = 20; // 反復回数の安全上限（終了条件そのものではない）

  while (requestCount < MAX_REQUESTS) {
    const url = `${BASE}/public/get_volatility_index_data?currency=${currency}&start_timestamp=${floorMs}&end_timestamp=${endMs}&resolution=86400`;
    const r = await fetchJson(url);
    requestCount++;
    const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
    const data = (resultObj?.data as number[][] | undefined) ?? [];
    const continuation = resultObj && 'continuation' in resultObj ? (resultObj.continuation as number | null) : undefined;
    pageLog.push(`request#${requestCount} rowsReturned=${data.length} continuation=${JSON.stringify(continuation)}`);
    log(`  DVOL page#${requestCount}: rowsReturned=${data.length} continuation=${JSON.stringify(continuation)}`);
    if (!Array.isArray(data) || data.length === 0) {
      log('  DVOL pagination終了（空応答）');
      break;
    }
    for (const d of data) {
      map.set(dateKey(new Date(d[0])), d[4]); // close
    }
    if (continuation === null || continuation === undefined) {
      log('  DVOL pagination終了（continuationなし）');
      break;
    }
    endMs = continuation as number;
    await sleep(300);
  }
  return { map, pageLog, requestCount };
}

// ============================================================
// BTC-PERPETUAL 価格取得（RV自前計算用）
// ⚠ ticks は実測で 08:00:00 UTC アンカー（probe-deribit-vrp-data.ts と同一の実測事実）。
//   ここでもティック自身のISO日付文字列をそのままdateラベルとして採用する。
// ============================================================
async function fetchPerpPriceMap(instrument: string, floorKey: string, ceilKeyInclusive: string): Promise<{ map: Map<string, number>; status: string | null; source: 'deribit-tradingview' | 'binance-csv-fallback' }> {
  const startMs = keyToMs(floorKey);
  const endMs = keyToMs(ceilKeyInclusive) + 86400000;
  const url = `${BASE}/public/get_tradingview_chart_data?instrument_name=${instrument}&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=1D`;
  log(`  GET ${url}`);
  const r = await fetchJson(url);
  const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
  const status = (resultObj?.status as string | undefined) ?? null;
  const ticks = (resultObj?.ticks as number[] | undefined) ?? [];
  const closes = (resultObj?.close as number[] | undefined) ?? [];
  const map = new Map<string, number>();
  if (Array.isArray(ticks) && ticks.length > 0 && status === 'ok') {
    ticks.forEach((t, i) => map.set(dateKey(new Date(t)), closes[i]));
    return { map, status, source: 'deribit-tradingview' };
  }
  log('  Deribit価格取得0件のためBinance CSVフォールバックを使用');
  const csvPath = join(__dirname, 'data', 'btc-daily-binance-2017-2026.csv');
  if (existsSync(csvPath)) {
    const lines = readFileSync(csvPath, 'utf-8').trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.split(',');
      const date = parts[0];
      if (date >= floorKey && date <= ceilKeyInclusive) map.set(date, parseFloat(parts[4]));
    }
    return { map, status: 'ok-from-csv', source: 'binance-csv-fallback' };
  }
  return { map, status: 'unavailable', source: 'deribit-tradingview' };
}

// ============================================================
// RV(年率%) 7日後方計算
// ============================================================
function annualizedStdPct(logReturns: number[]): number | null {
  if (logReturns.length < 2) return null;
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

function computeRvForward7d(dateKey_: string, priceMap: Map<string, number>): number | null {
  const prices: number[] = [];
  for (let i = 0; i <= RV_FORWARD_DAYS; i++) {
    const d = addDaysKey(dateKey_, i);
    const p = priceMap.get(d);
    if (p === undefined) return null;
    prices.push(p);
  }
  const logReturns: number[] = [];
  for (let i = 1; i < prices.length; i++) logReturns.push(Math.log(prices[i] / prices[i - 1]));
  return annualizedStdPct(logReturns);
}

// ============================================================
// Ledger row
// ============================================================
interface LedgerRow {
  date: string;
  phase: 'warmup' | 'live';
  dvol: number | null;
  dvol_daily_change_vol_pts: number | null;
  dvol_spike_marker: 0 | 1;
  rv_forward_7d: number | null;
  vrp: number | null;
  net_pnl_pct: number | null;
  sleeve_return: number | null;
  price_source: 'deribit-tradingview' | 'binance-csv-fallback' | null;
}

const LEDGER_COLUMNS = [
  'date', 'phase', 'dvol', 'dvol_daily_change_vol_pts', 'dvol_spike_marker',
  'rv_forward_7d', 'vrp', 'net_pnl_pct', 'sleeve_return', 'price_source',
] as const;

function ledgerPaths(): { csv: string; json: string } {
  return { csv: join(RESULT_DIR, 'deribit-vrp-forward-ledger-btc.csv'), json: join(RESULT_DIR, 'deribit-vrp-forward-ledger-btc.json') };
}
function loadExistingLedger(): LedgerRow[] {
  const { json } = ledgerPaths();
  if (!existsSync(json)) return [];
  return JSON.parse(readFileSync(json, 'utf-8')) as LedgerRow[];
}
function writeLedger(rows: LedgerRow[]): void {
  const { csv, json } = ledgerPaths();
  const lines = [LEDGER_COLUMNS.join(','), ...rows.map(r => LEDGER_COLUMNS.map(c => {
    const v = (r as unknown as Record<string, unknown>)[c];
    return v === null || v === undefined ? '' : String(v);
  }).join(','))];
  writeFileSync(csv, lines.join('\n') + '\n');
  writeFileSync(json, JSON.stringify(rows, null, 2));
}

function computeAccounting(dvol: number | null, rv7: number | null): { vrp: number | null; netPnlPct: number | null; sleeveReturn: number | null } {
  if (dvol === null || rv7 === null) return { vrp: null, netPnlPct: null, sleeveReturn: null };
  const vrp = dvol - rv7;
  // 週次コホート方式: C_realは週次フルコストをそのまま引く（C_real/7の日割りにしない）
  // §4-1: r_t = vegaNotionalPct × (VRP_w - C_real)。F判定時は7日ごとの非重複サンプリングで週次系列を構築。
  const netVolPt = vrp - C_REAL_WEEKLY_COST_VOL_PT;
  const netPnlPct = netVolPt * VEGA_NOTIONAL_PCT * 100;
  return { vrp, netPnlPct, sleeveReturn: netPnlPct };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 Stage 2 forward calibration: Deribit VRP フォワード較正ハーネス 日次実行 ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  log(`Node version: ${process.version}`);
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim();
  } catch {
    /* ignore */
  }
  log(`Git commit: ${gitCommit}`);
  const anchor = anchorDateKey();
  log(`anchorDateKey (最終完全経過UTC日): ${anchor}`);
  log('⚠ 本実行は日次冪等追記の1回分。90日分を一括生成するものではない。');

  const existingRows = loadExistingLedger();
  const rowCountBefore = existingRows.length;
  log(`既存ledger行数: ${rowCountBefore}`);

  // Stage 2 会計マイグレーション: Stage 0プレースホルダ会計で記録された既存行を再計算
  // dvol/rv_forward_7d が揃っている行のみ。nullの行は変更なし。
  let accountingMigrateCount = 0;
  const existingRowsMigrated = existingRows.map(row => {
    if (row.dvol === null || row.rv_forward_7d === null) return row;
    const { vrp, netPnlPct, sleeveReturn } = computeAccounting(row.dvol, row.rv_forward_7d);
    accountingMigrateCount++;
    return { ...row, vrp, net_pnl_pct: netPnlPct, sleeve_return: sleeveReturn };
  });
  if (accountingMigrateCount > 0) {
    log(`Stage 2 会計マイグレーション: ${accountingMigrateCount}行を再計算（旧Stage 0プレースホルダ → §2実測コスト・§3 vegaNotionalPct）`);
  }

  let mode: 'initial' | 'append' | 'noop';
  let datesToAppend: string[] = [];
  if (existingRows.length === 0) {
    mode = 'initial';
    const liveStart = anchor;
    const warmupStart = addDaysKey(liveStart, -WARMUP_DAYS);
    datesToAppend = dateRangeKeys(warmupStart, liveStart);
    log(`初回セットアップ: warmup=${warmupStart}..${addDaysKey(liveStart, -1)}（${WARMUP_DAYS}日）, go-live=${liveStart}`);
  } else {
    const lastDate = existingRows[existingRows.length - 1].date;
    if (lastDate >= anchor) {
      mode = 'noop';
      log(`既存ledger最終日=${lastDate} は anchor=${anchor} 以上。追記対象日なし（冪等・重複追記なし）`);
    } else {
      mode = 'append';
      datesToAppend = dateRangeKeys(addDaysKey(lastDate, 1), anchor);
      log(`追記モード: 既存最終日=${lastDate}, 追記対象=${datesToAppend.join(',')}`);
    }
  }

  // フェッチ窓の決定: 新規追記日＋既存ledgerでrv_forward_7d未確定の行、双方をカバーする最小窓
  const unresolvedExisting = existingRows.filter(r => r.rv_forward_7d === null).map(r => r.date);
  const candidateMinDates = [...unresolvedExisting, ...datesToAppend];
  const minDate = candidateMinDates.length > 0 ? candidateMinDates.reduce((a, b) => (a < b ? a : b)) : anchor;
  const dvolFetchStart = addDaysKey(minDate, -1);
  const fetchEnd = anchor;
  log(`データ取得窓: ${dvolFetchStart}..${fetchEnd}（新規追記=${datesToAppend.length}日, backfill候補=${unresolvedExisting.length}日）`);

  log('\n>>> DVOL取得');
  const dvolResult = await fetchDvolMap('BTC', dvolFetchStart, fetchEnd);
  log(`  DVOL取得件数: ${dvolResult.map.size}`);

  await sleep(300);
  log('\n>>> BTC-PERPETUAL 価格取得（RV自前計算用）');
  const priceResult = await fetchPerpPriceMap('BTC-PERPETUAL', dvolFetchStart, fetchEnd);
  log(`  価格取得件数: ${priceResult.map.size} source=${priceResult.source} status=${priceResult.status}`);

  // 新規行の構築
  const newRows: LedgerRow[] = [];
  for (let i = 0; i < datesToAppend.length; i++) {
    const date = datesToAppend[i];
    const phase: 'warmup' | 'live' = mode === 'initial' ? (i === datesToAppend.length - 1 ? 'live' : 'warmup') : 'live';
    const dvol = dvolResult.map.get(date) ?? null;
    const dvolPrev = dvolResult.map.get(addDaysKey(date, -1)) ?? null;
    const dvolDailyChange = dvol !== null && dvolPrev !== null ? dvol - dvolPrev : null;
    const spikeMarker: 0 | 1 = dvolDailyChange !== null && dvolDailyChange >= DVOL_SPIKE_THRESHOLD_VOL_PTS ? 1 : 0;
    const rv7 = computeRvForward7d(date, priceResult.map);
    const { vrp, netPnlPct, sleeveReturn } = computeAccounting(dvol, rv7);
    newRows.push({
      date,
      phase,
      dvol,
      dvol_daily_change_vol_pts: dvolDailyChange,
      dvol_spike_marker: spikeMarker,
      rv_forward_7d: rv7,
      vrp,
      net_pnl_pct: netPnlPct,
      sleeve_return: sleeveReturn,
      price_source: dvol !== null ? priceResult.source : null,
    });
    log(`  ${date} [${phase}] dvol=${dvol} rv7=${rv7} vrp=${vrp} spike=${spikeMarker}`);
  }

  let allRows = [...existingRowsMigrated, ...newRows];

  // backfill: rv_forward_7d が null の既存行のうち、今回のフェッチで解決可能なものを埋める
  let backfillCount = 0;
  allRows = allRows.map(row => {
    if (row.rv_forward_7d !== null) return row;
    const rv7 = computeRvForward7d(row.date, priceResult.map);
    if (rv7 === null) return row;
    const { vrp, netPnlPct, sleeveReturn } = computeAccounting(row.dvol, rv7);
    backfillCount++;
    return { ...row, rv_forward_7d: rv7, vrp, net_pnl_pct: netPnlPct, sleeve_return: sleeveReturn };
  });

  writeLedger(allRows);
  const rowCountAfter = allRows.length;
  log(`\n>>> ledger保存: 行数 ${rowCountBefore} -> ${rowCountAfter}（新規追記=${newRows.length}, backfill件数=${backfillCount}, 会計マイグレーション=${accountingMigrateCount}行）`);

  // meta.json
  const metaPath = join(RESULT_DIR, 'deribit-vrp-forward-meta.json');
  const priorMeta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf-8')) : null;
  const runHistory: Record<string, unknown>[] = priorMeta?.runHistory ?? [];
  runHistory.push({
    runTimestampUTC: RUN_TIMESTAMP,
    anchorDateKey: anchor,
    gitCommit,
    nodeVersion: process.version,
    mode,
    newRowsAppended: newRows.length,
    backfillCount,
    rowCountBefore,
    rowCountAfter,
    dvolFetchWindow: { start: dvolFetchStart, end: fetchEnd },
    dvolRowsFetched: dvolResult.map.size,
    priceSource: priceResult.source,
    priceRowsFetched: priceResult.map.size,
  });
  const liveRows = allRows.filter(r => r.phase === 'live');
  const warmupRows = allRows.filter(r => r.phase === 'warmup');
  const meta = {
    experiment: 'EXP-OBS000037',
    stage: 'Stage 2 forward calibration',
    gate: 'F1-F4（90日蓄積後にC正式監査）',
    scriptPath: 'scripts/deribit-vrp-forward-paper.ts',
    specReference: 'research/EXP-OBS000037/00-spec-stage2.md',
    executedBy: 'B実装チーム (Quant Researcher)',
    goLiveDateUTC: mode === 'initial' ? anchor : (existingRows.find(r => r.phase === 'live')?.date ?? null),
    warmupDays: WARMUP_DAYS,
    rvForwardDays: RV_FORWARD_DAYS,
    liveDaysRequiredForGate: 90,
    currentLiveDaysCount: liveRows.length,
    currentWarmupDaysCount: warmupRows.length,
    fixedParams: {
      dvolSpikeThresholdVolPts: DVOL_SPIKE_THRESHOLD_VOL_PTS,
      cRealWeeklyCostVolPt: C_REAL_WEEKLY_COST_VOL_PT,
      vegaNotionalPct: VEGA_NOTIONAL_PCT,
      accountingNote:
        '【2026-07-14 Stage 2 会計更新・週次コホート方式】Stage 2バックテスト（§2〜§6）通過＋採用可（C品質チーム宣告 2026-07-13）を受け、' +
        'Stage 0プレースホルダ会計（1.8 vol pt/週・1:1変換）を§2実測コスト（C_real=2.8613 vol pt/週）＋§3 vegaNotionalPct（f=0.5）に置換済み。' +
        '会計式: net_pnl_pct = (vrp - C_real) × vegaNotionalPct × 100（§4-1 r_t と同軸・週次コホート方式）。' +
        'vrpはフル週次VRP水準の日次観測値（C_realも週次フルコストをそのまま差引き）。' +
        'F1/F3判定時はgo-live日から7日ごとの非重複サンプリングで週次系列を構築する（7日分合算しない）。',
    },
    endpoints: {
      dvol: `${BASE}/public/get_volatility_index_data?currency=BTC&start_timestamp={ms}&end_timestamp={ms}&resolution=86400`,
      perpPrice: `${BASE}/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp={ms}&end_timestamp={ms}&resolution=1D`,
    },
    dateAnchorDesignNote: '日次実行は「今日」でなく「最終完全経過UTC日（anchor=today-1）」を対象とする（OBS000032と同型設計）。',
    sleeveReturnJoinNote:
      'sleeve_return は日次VRPスリーブ収益（資本比%）。OBS000032フォワードledger（research/EXP-OBS000032/10-result/forward/forward-paper-ledger-btc.json）と' +
      'date（UTC日）キーで突合可能な形式（spec §8必須条件A）。テール窓・同時ドローダウンの算出・判定はStage 1で行う（本Stage 0では形式準備のみ）。',
    runHistory,
  };
  writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  log(`>>> 保存: ${metaPath}`);

  const runLogPath = join(RESULT_DIR, 'deribit-vrp-forward-run.log');
  const block = [
    '='.repeat(70),
    `=== deribit-vrp-forward-paper.ts 実行 ${RUN_TIMESTAMP} ===`,
    '⚠ 日次冪等追記型。1回の実行で90日分が完成するものではない。',
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    `anchorDateKey: ${anchor}`,
    `mode: ${mode}`,
    `rowCountBefore: ${rowCountBefore}`,
    `rowCountAfter: ${rowCountAfter}`,
    `newRowsAppended: ${newRows.length}`,
    `backfillCount: ${backfillCount}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/deribit-vrp-forward-paper.ts',
    '',
    'EXECUTION LOG:',
    ...executionLog,
    '',
  ].join('\n');
  appendFileSync(runLogPath, block);
  log(`>>> 保存: ${runLogPath}`);

  log('\n=== 実行完了 ===');
  log(`mode=${mode} newRowsAppended=${newRows.length} backfillCount=${backfillCount} rowCountBefore=${rowCountBefore} rowCountAfter=${rowCountAfter}`);
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
