/**
 * Binance公開APIから実perp価格を含むキャリーデータを取得するスクリプト（EXP-OBS000032 G0-1）
 *
 * 背景: OBS000026 funding-carry-delta-neutral.ts は現物価格でperpを代用し、実perp価格でのベーシスリスク未モデル化。
 * 本スクリプトはBinance USDT-M perpetual の実価格（last price / mark price）を取得し、
 * ベーシス（perp - 現物）の実測を可能にする。同時にテール窓（T1/T2/T3）をカバーできるか実測。
 *
 * 取得内容:
 *   - BTCUSDT / ETHUSDT 現物日足OHLCV
 *   - BTCUSDT / ETHUSDT perp日足（last price klines）
 *   - BTCUSDT / ETHUSDT perp mark price日足
 *   - BTCUSDT / ETHUSDT Funding Rate履歴（8時間おき）
 *
 * テール窓定義（固定・§2 by spec）:
 *   T1: 2020-02-20 〜 2020-04-30（コロナ暴落）
 *   T2: 2022-05-01 〜 2022-06-30（LUNA/UST崩壊）
 *   T3: 2022-10-25 〜 2022-12-15（FTX破綻）
 *   calm: 2021-01-01 〜 2021-06-30（平時参考）
 *
 * ページングバグ再発防止:
 *   - 終了条件 = 空応答（返却0件）のみ。length < limit は禁止。
 *   - カーソル前進 = データ最新タイムスタンプ + 1 ms に正しく更新。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/fetch-binance-carry-data.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000032', '10-result');
mkdirSync(RESULT_DIR, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const executionLog: string[] = [];
const fetchLog: { [key: string]: unknown } = {};

function log(message: string): void {
  console.log(message);
  executionLog.push(`[${new Date().toISOString()}] ${message}`);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const TAIL_WINDOWS = {
  T1: { name: 'T1 (2020-03 コロナ)', start: '2020-02-20', end: '2020-04-30' },
  T2: { name: 'T2 (2022-05 LUNA)', start: '2022-05-01', end: '2022-06-30' },
  T3: { name: 'T3 (2022-11 FTX)', start: '2022-10-25', end: '2022-12-15' },
  calm: { name: 'calm (2021-01〜06)', start: '2021-01-01', end: '2021-06-30' },
};

interface DailyData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface FundingEvent {
  datetime: string;
  fundingRate: number;
}

// ページング実装：空応答まで継続・カーソル正確に前進
async function fetchDailyKlines(
  symbol: string,
  endpoint: 'spot' | 'perp_last' | 'perp_mark',
): Promise<DailyData[]> {
  const rows: DailyData[] = [];
  let cursor = Date.parse('2019-08-17T00:00:00Z'); // BTC perp funding開始前まで遡及
  const now = Date.now();
  let pageCount = 0;
  const pageSize = 1000;

  let baseUrl: string;
  if (endpoint === 'spot') {
    baseUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d`;
  } else if (endpoint === 'perp_last') {
    baseUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d`;
  } else {
    baseUrl = `https://fapi.binance.com/fapi/v1/markPriceKlines?symbol=${symbol}&interval=1d`;
  }

  log(`  ${symbol} ${endpoint}: ページング開始（カーソル=${new Date(cursor).toISOString().slice(0, 10)}）`);

  while (cursor < now) {
    const url = `${baseUrl}&startTime=${cursor}&limit=${pageSize}`;
    try {
      const data = await fetchJson(url) as unknown[][];
      if (data.length === 0) {
        log(`  ${symbol} ${endpoint}: 空応答で終了（ページ${pageCount}、カーソル=${new Date(cursor).toISOString().slice(0, 10)}）`);
        break;
      }

      for (const k of data) {
        const openTime = k[0] as number;
        const date = new Date(openTime).toISOString().slice(0, 10);
        rows.push({
          date,
          open: parseFloat(k[1] as string),
          high: parseFloat(k[2] as string),
          low: parseFloat(k[3] as string),
          close: parseFloat(k[4] as string),
          volume: parseFloat(k[5] as string),
        });
      }

      const lastOpenTime = data[data.length - 1][0] as number;
      cursor = lastOpenTime + 24 * 60 * 60 * 1000; // 次日のカーソルへ正確に前進
      pageCount++;

      log(`  ${symbol} ${endpoint}: ${rows.length}件（ページ${pageCount}、最新=${new Date(lastOpenTime).toISOString().slice(0, 10)}）`);
      await sleep(300);
    } catch (err) {
      log(`  ERROR ${symbol} ${endpoint}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  log(`  ${symbol} ${endpoint}: 計${rows.length}件取得`);
  return rows;
}

async function fetchFundingRateHistory(symbol: string): Promise<FundingEvent[]> {
  const rows: FundingEvent[] = [];
  let cursor = Date.parse('2019-08-17T00:00:00Z'); // BTC perp funding前からスタート
  const now = Date.now();
  let pageCount = 0;
  const pageSize = 1000;

  log(`  ${symbol} funding: ページング開始（カーソル=${new Date(cursor).toISOString().slice(0, 10)}）`);

  while (cursor < now) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&limit=${pageSize}`;
    try {
      const data = await fetchJson(url) as { fundingTime: number; fundingRate: string }[];
      if (data.length === 0) {
        log(`  ${symbol} funding: 空応答で終了（ページ${pageCount}、カーソル=${new Date(cursor).toISOString().slice(0, 10)}）`);
        break;
      }

      for (const f of data) {
        rows.push({
          datetime: new Date(f.fundingTime).toISOString(),
          fundingRate: parseFloat(f.fundingRate),
        });
      }

      const lastTime = data[data.length - 1].fundingTime;
      cursor = lastTime + 1; // 次の funding 時点へ前進
      pageCount++;

      log(`  ${symbol} funding: ${rows.length}件（ページ${pageCount}、最新=${new Date(lastTime).toISOString().slice(0, 10)}）`);
      await sleep(300);
    } catch (err) {
      log(`  ERROR ${symbol} funding: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  log(`  ${symbol} funding: 計${rows.length}件取得`);
  return rows;
}

// テール窓内での欠損を検出・カバー判定
function checkWindowCoverage(
  spot: DailyData[],
  perp: DailyData[],
  funding: FundingEvent[],
  windowStart: string,
  windowEnd: string,
): {
  spotCount: number;
  perpCount: number;
  fundingCount: number;
  aligns: number;
  missingDates: string[];
  basisMissingRate: number;
} {
  // ウィンドウ内の日付一覧（全UTC日付を列挙）
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  const expectedDates = new Set<string>();
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    expectedDates.add(d.toISOString().slice(0, 10));
  }

  const spotByDate = new Map(spot.map(s => [s.date, s]));
  const perpByDate = new Map(perp.map(p => [p.date, p]));
  const fundingByDate = new Map<string, FundingEvent[]>();
  funding.forEach(f => {
    const date = f.datetime.slice(0, 10);
    if (!fundingByDate.has(date)) fundingByDate.set(date, []);
    fundingByDate.get(date)!.push(f);
  });

  let aligns = 0;
  const missingDates: string[] = [];

  for (const date of expectedDates) {
    const hasSpot = spotByDate.has(date);
    const hasPerp = perpByDate.has(date);
    const hasFunding = fundingByDate.has(date);

    if (hasSpot && hasPerp && hasFunding) {
      aligns++;
    } else {
      missingDates.push(date);
    }
  }

  const basisMissingRate = expectedDates.size > 0 ? (expectedDates.size - aligns) / expectedDates.size : 0;

  return {
    spotCount: Array.from(spotByDate.keys()).filter(d => d >= windowStart && d <= windowEnd).length,
    perpCount: Array.from(perpByDate.keys()).filter(d => d >= windowStart && d <= windowEnd).length,
    fundingCount: funding.filter(f => f.datetime.slice(0, 10) >= windowStart && f.datetime.slice(0, 10) <= windowEnd).length,
    aligns,
    missingDates,
    basisMissingRate,
  };
}

// 日次ベーシス構築
function computeBassis(
  spot: DailyData[],
  perp: DailyData[],
  windowStart: string,
  windowEnd: string,
): { date: string; basis_bps: number }[] {
  const spotByDate = new Map(spot.map(s => [s.date, s]));
  const perpByDate = new Map(perp.map(p => [p.date, p]));

  const result: { date: string; basis_bps: number }[] = [];

  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10);
    const s = spotByDate.get(date);
    const p = perpByDate.get(date);
    if (s && p) {
      const basis_bps = ((p.close - s.close) / s.close) * 10000;
      result.push({ date, basis_bps });
    }
  }

  return result;
}

async function main(): Promise<void> {
  const startTime = new Date().toISOString();
  log(`=== EXP-OBS000032 G0-1: テール到達性 & ベーシス実測 ===`);
  log(`開始時刻: ${startTime}`);
  log(`Node: ${process.version}`);
  log('');

  const results = {
    timestamp: startTime,
    metadata: {
      BTC: {} as Record<string, unknown>,
      ETH: {} as Record<string, unknown>,
    },
    tail_window_coverage: {} as Record<string, unknown>,
    basis_statistics: {} as Record<string, unknown>,
  };

  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    log(`\n======== ${symbol} ========`);

    // 現物取得
    log('>>> 現物日足取得');
    const spot = await fetchDailyKlines(symbol, 'spot');

    // Perp last price
    log('>>> Perp last price日足取得');
    const perpLast = await fetchDailyKlines(symbol, 'perp_last');

    // Perp mark price
    log('>>> Perp mark price日足取得');
    const perpMark = await fetchDailyKlines(symbol, 'perp_mark');

    // 利用可能な perp 系列を判定（履歴深度で選択）
    let perpAdopted = 'last';
    let perp = perpLast;
    if (perpMark.length > perpLast.length) {
      perpAdopted = 'mark';
      perp = perpMark;
    }
    log(`  採用perp系列: ${perpAdopted} (last=${perpLast.length}件, mark=${perpMark.length}件)`);

    // Funding取得
    log('>>> Funding Rate履歴取得');
    const funding = await fetchFundingRateHistory(symbol);

    // 最古・最新足情報
    const spotOldest = spot.length > 0 ? spot[0].date : 'N/A';
    const spotNewest = spot.length > 0 ? spot[spot.length - 1].date : 'N/A';
    const perpOldest = perp.length > 0 ? perp[0].date : 'N/A';
    const perpNewest = perp.length > 0 ? perp[perp.length - 1].date : 'N/A';
    const fundingOldest = funding.length > 0 ? funding[0].datetime : 'N/A';
    const fundingNewest = funding.length > 0 ? funding[funding.length - 1].datetime : 'N/A';

    log(`\n  現物: ${spotOldest} ～ ${spotNewest} (${spot.length}件)`);
    log(`  Perp (${perpAdopted}): ${perpOldest} ～ ${perpNewest} (${perp.length}件)`);
    log(`  Funding: ${fundingOldest} ～ ${fundingNewest} (${funding.length}件)`);

    results.metadata[symbol] = {
      spot: { oldest: spotOldest, newest: spotNewest, count: spot.length },
      perp: { type: perpAdopted, oldest: perpOldest, newest: perpNewest, count: perp.length },
      funding: { oldest: fundingOldest, newest: fundingNewest, count: funding.length },
    };

    // テール窓ごとのカバー判定
    log(`\n>>> テール窓カバー判定`);
    const windowResults: Record<string, unknown> = {};

    for (const [windowKey, window] of Object.entries(TAIL_WINDOWS)) {
      const coverage = checkWindowCoverage(spot, perp, funding, window.start, window.end);
      log(
        `  ${window.name}: spot${coverage.spotCount}件, perp${coverage.perpCount}件, funding${coverage.fundingCount}件, ` +
        `align${coverage.aligns}日 (欠損率=${(coverage.basisMissingRate * 100).toFixed(1)}%)`
      );
      if (coverage.missingDates.length > 0 && coverage.missingDates.length <= 5) {
        log(`    欠損日: ${coverage.missingDates.join(', ')}`);
      }

      windowResults[windowKey] = coverage;

      // ベーシス統計
      const basisData = computeBassis(spot, perp, window.start, window.end);
      if (basisData.length > 0) {
        const basisBps = basisData.map(b => b.basis_bps);
        const mean = basisBps.reduce((a, b) => a + b, 0) / basisBps.length;
        const std = Math.sqrt(basisBps.reduce((a, b) => a + (b - mean) ** 2, 0) / basisBps.length);
        const max = Math.max(...basisBps);
        const min = Math.min(...basisBps);
        const maxAbs = Math.max(Math.abs(max), Math.abs(min));
        const dailyDelta = [];
        for (let i = 1; i < basisBps.length; i++) {
          dailyDelta.push(Math.abs(basisBps[i] - basisBps[i - 1]));
        }
        const deltaStd = dailyDelta.length > 0 ? Math.sqrt(dailyDelta.reduce((a, b) => a + b ** 2, 0) / dailyDelta.length) : 0;

        log(
          `    ベーシス: 平均=${mean.toFixed(1)}bps, 標準偏差=${std.toFixed(1)}bps, ` +
          `最大|basis|=${maxAbs.toFixed(1)}bps, 日次変化std=${deltaStd.toFixed(1)}bps`
        );

        windowResults[`${windowKey}_basis`] = {
          count: basisData.length,
          mean_bps: mean,
          std_bps: std,
          max_bps: max,
          min_bps: min,
          max_abs_bps: maxAbs,
          daily_delta_std_bps: deltaStd,
        };
      }
    }

    results.tail_window_coverage[symbol] = windowResults;

    log(`\n>>> CSV保存`);
    // 現物CSV
    const spotCsv = ['date,open,high,low,close,volume'].concat(
      spot.map(s => `${s.date},${s.open},${s.high},${s.low},${s.close},${s.volume}`),
    );
    writeFileSync(join(RESULT_DIR, `${symbol.toLowerCase()}-spot-daily.csv`), spotCsv.join('\n') + '\n');
    log(`  ${symbol.toLowerCase()}-spot-daily.csv (${spot.length}行)`);

    // Perp CSV
    const perpCsv = ['date,open,high,low,close,volume'].concat(
      perp.map(p => `${p.date},${p.open},${p.high},${p.low},${p.close},${p.volume}`),
    );
    writeFileSync(join(RESULT_DIR, `${symbol.toLowerCase()}-perp-${perpAdopted}-daily.csv`), perpCsv.join('\n') + '\n');
    log(`  ${symbol.toLowerCase()}-perp-${perpAdopted}-daily.csv (${perp.length}行)`);

    // Funding CSV
    const fundingCsv = ['datetime,funding_rate'].concat(
      funding.map(f => `${f.datetime},${f.fundingRate}`),
    );
    writeFileSync(join(RESULT_DIR, `${symbol.toLowerCase()}-funding.csv`), fundingCsv.join('\n') + '\n');
    log(`  ${symbol.toLowerCase()}-funding.csv (${funding.length}行)`);
  }

  // 結果JSON保存
  writeFileSync(join(RESULT_DIR, 'g0-1-tail-reachability.json'), JSON.stringify(results, null, 2));
  log(`\n>>> 結果JSON保存: g0-1-tail-reachability.json`);

  // 実行ログ・メタ保存
  const runLog = [
    '=== EXP-OBS000032 G0-1: テール到達性 ===',
    `Execution: ${startTime}`,
    `Node: ${process.version}`,
    'ENDPOINTS:',
    '  Spot klines: https://api.binance.com/api/v3/klines?symbol={SYMBOL}&interval=1d&startTime={CURSOR}&limit=1000',
    '  Perp last price: https://fapi.binance.com/fapi/v1/klines?symbol={SYMBOL}&interval=1d&startTime={CURSOR}&limit=1000',
    '  Perp mark price: https://fapi.binance.com/fapi/v1/markPriceKlines?symbol={SYMBOL}&interval=1d&startTime={CURSOR}&limit=1000',
    '  Funding Rate: https://fapi.binance.com/fapi/v1/fundingRate?symbol={SYMBOL}&startTime={CURSOR}&limit=1000',
    '',
    'PAGING IMPLEMENTATION:',
    '  Termination: Empty response (length === 0)',
    '  Cursor advancement: lastOpenTime + 24h (spot/perp) or lastTime + 1ms (funding)',
    '  No "length < limit" early termination',
    '',
    'TAIL WINDOWS (Fixed by Spec):',
    '  T1: 2020-02-20 〜 2020-04-30 (Corona)',
    '  T2: 2022-05-01 〜 2022-06-30 (LUNA)',
    '  T3: 2022-10-25 〜 2022-12-15 (FTX)',
    '  calm: 2021-01-01 〜 2021-06-30 (Placid)',
    '',
    'BASIS CALCULATION:',
    '  basis_bps = (perp_close - spot_close) / spot_close * 10000',
    '  Date alignment: Only same UTC date pairs counted',
    '  Missing rate: (expected_dates - aligned_dates) / expected_dates',
    '',
    'ARTIFACTS:',
    '  - g0-1-tail-reachability.json (metadata + window coverage + basis stats)',
    '  - {BTC,ETH}USDT-{spot,perp}-daily.csv (full timeseries)',
    '  - {BTC,ETH}USDT-funding.csv (8h events)',
    '',
    'EXECUTION LOG:',
    ...executionLog,
    '',
    'REPRODUCTION:',
    'node --experimental-strip-types scripts/fetch-binance-carry-data.ts',
  ];

  writeFileSync(join(RESULT_DIR, 'run-g0-1.log'), runLog.join('\n'));
  log(`\n>>> 実行ログ: run-g0-1.log`);

  log('\n=== G0-1完了 ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
