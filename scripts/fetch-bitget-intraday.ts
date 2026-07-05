/**
 * Bitget公開APIから短時間足OHLCVを取得するスクリプト（EXP-OBS000031 Stage 0 G0-1）
 *
 * 背景: EXP-OBS000031 Stage 0のデータ実現可能性スパイク。
 * BTCUSDT / ETHUSDTについて、4h/1h/15mの各粒度でhistory-candlesをページングし、
 * 実遡及可能な最古日、総取得本数、2022年内の欠損率を実測する。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/fetch-bitget-intraday.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'research', 'EXP-OBS000031', '10-result');
mkdirSync(DATA_DIR, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const executionLog: string[] = [];

function log(message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${message}`);
  executionLog.push(`[${ts}] ${message}`);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

interface DepthResult {
  symbol: string;
  apiGranularity: string;
  displayGranularity: string;
  totalCandles: number;
  totalPages: number;
  oldestTimestamp: number | null;
  oldestDate: string | null;
  newestTimestamp: number | null;
  newestDate: string | null;
  yearsBack: number;
  candles2022: number;
  gapRatio2022: number;
  covers2022FullYear: boolean;
  error?: string;
}

async function fetchDepth(
  symbol: string,
  displayGran: string,
  apiGran: string
): Promise<DepthResult> {
  log(`\n【${symbol} ${displayGran}】ページング開始`);

  let totalCandles = 0;
  let pageCount = 0;
  let oldestTs: number | null = null;
  let newestTs: number | null = null;
  let endTime: number | undefined;
  let lastOldestTs: number | null = null;
  const allCandleTimestamps: number[] = []; // Track all candle timestamps for 2022 calculation

  const maxPages = 10000;
  const limit = 200;

  while (pageCount < maxPages) {
    const params = new URLSearchParams({
      symbol,
      productType: 'USDT-FUTURES',
      granularity: apiGran,
      limit: limit.toString(),
      ...(endTime && { endTime: endTime.toString() }),
    });
    const url = `https://api.bitget.com/api/v2/mix/market/history-candles?${params.toString()}`;

    try {
      const data = await fetchJson(url) as unknown;
      let candles: [string, string, string, string, string, string][] = [];

      if (typeof data === 'object' && data !== null) {
        const obj = data as Record<string, unknown>;
        if ('data' in obj && Array.isArray(obj.data)) {
          candles = obj.data as [string, string, string, string, string, string][];
        } else if (Array.isArray(data)) {
          candles = data as [string, string, string, string, string, string][];
        }
      }

      if (candles.length === 0) {
        log(`  ✓ ページ${pageCount}で空応答 → 終了`);
        break;
      }

      const pageOldestTs = parseInt(candles[0][0]);
      const pageNewestTs = parseInt(candles[candles.length - 1][0]);

      pageCount++;
      totalCandles += candles.length;

      // Collect all timestamps for 2022 calculation
      for (const candle of candles) {
        allCandleTimestamps.push(parseInt(candle[0]));
      }

      log(`  P${pageCount}: ${candles.length}本 (${new Date(pageOldestTs).toISOString().split('T')[0]} .. ${new Date(pageNewestTs).toISOString().split('T')[0]})`);

      if (lastOldestTs === pageOldestTs) {
        log(`  ⚠ カーソル非前進 → 終了`);
        break;
      }
      lastOldestTs = pageOldestTs;

      oldestTs = pageOldestTs;
      if (newestTs === null) newestTs = pageNewestTs;

      endTime = pageOldestTs - 1;
      await sleep(250);
    } catch (err) {
      return {
        symbol,
        apiGranularity: apiGran,
        displayGranularity: displayGran,
        totalCandles: 0,
        totalPages: 0,
        oldestTimestamp: null,
        oldestDate: null,
        newestTimestamp: null,
        newestDate: null,
        yearsBack: 0,
        candles2022: 0,
        gapRatio2022: 0,
        covers2022FullYear: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 2022カバー判定
  const year2022Start = new Date('2022-01-01T00:00:00Z').getTime();
  const year2022End = new Date('2022-12-31T23:59:59Z').getTime();
  const covers2022Start = oldestTs !== null && oldestTs <= year2022Start;
  const yearsBack = oldestTs !== null ? (Date.now() - oldestTs) / (365.25 * 24 * 60 * 60 * 1000) : 0;

  // 2022期待本数と実本数を計算
  const expected2022 =
    displayGran === '4h' ? 2190 :
    displayGran === '1h' ? 8760 :
    displayGran === '15m' ? 35040 : 0;

  // Count actual candles in 2022 range from collected timestamps
  const candles2022Count = allCandleTimestamps.filter(ts => ts >= year2022Start && ts <= year2022End).length;
  const gapRatio2022Value = expected2022 > 0 ? (expected2022 - candles2022Count) / expected2022 : 0;

  log(`  2022年: 期待本数 ${expected2022}本, 実本数 ${candles2022Count}本, 欠損率 ${(gapRatio2022Value * 100).toFixed(2)}%`);

  return {
    symbol,
    apiGranularity: apiGran,
    displayGranularity: displayGran,
    totalCandles,
    totalPages: pageCount,
    oldestTimestamp: oldestTs,
    oldestDate: oldestTs ? new Date(oldestTs).toISOString().split('T')[0] : null,
    newestTimestamp: newestTs,
    newestDate: newestTs ? new Date(newestTs).toISOString().split('T')[0] : null,
    yearsBack,
    candles2022: candles2022Count,
    gapRatio2022: gapRatio2022Value,
    covers2022FullYear: covers2022Start && gapRatio2022Value < 0.05, // <5% gap ratio
  };
}

async function main(): Promise<void> {
  const startTime = new Date().toISOString();
  log(`\n=== EXP-OBS000031 Stage 0 G0-1: Short-term OHLCV Depth ===`);
  log(`Start: ${startTime}`);
  log(`Node: ${process.version}`);
  log(`Symbols: BTCUSDT, ETHUSDT`);
  log(`Granularities: 4h (4H), 1h (1H), 15m (15m)`);

  try {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const granularities = [
      { display: '4h', api: '4H' },
      { display: '1h', api: '1H' },
      { display: '15m', api: '15m' },
    ];

    const results: DepthResult[] = [];

    for (const symbol of symbols) {
      for (const gran of granularities) {
        const result = await fetchDepth(symbol, gran.display, gran.api);
        results.push(result);
        if (symbol !== symbols[symbols.length - 1] || gran !== granularities[granularities.length - 1]) {
          await sleep(300);
        }
      }
    }

    // === Output Summary ===
    log('\n=== G0-1 履歴深度集計表 ===\n');
    log('| 銘柄 | 粒度 | 最古足日付 | 総本数 | 遡及年数 | 2022通年カバー |');
    log('|---|---|---|---|---|---|');

    for (const r of results) {
      if (r.error) {
        log(`| ${r.symbol} | ${r.displayGranularity} | ERROR | - | - | - |`);
      } else {
        const coverStr = r.covers2022FullYear ? '✓ YES' : '✗ NO';
        log(`| ${r.symbol} | ${r.displayGranularity} | ${r.oldestDate} | ${r.totalCandles} | ${r.yearsBack.toFixed(2)}y | ${coverStr} |`);
      }
    }

    // === Save JSON ===
    writeFileSync(
      join(DATA_DIR, 'G0-1-depth-summary.json'),
      JSON.stringify({
        timestamp: startTime,
        baseline_date: '2026-07-05',
        results,
      }, null, 2)
    );

    // === Save run log ===
    writeFileSync(
      join(DATA_DIR, 'run.log'),
      [
        '=== EXP-OBS000031 Stage 0 G0-1: Short-term OHLCV Depth ===',
        `Timestamp: ${startTime}`,
        `Node: ${process.version}`,
        '',
        'PAGING COMPLIANCE (OBS000030 Bug Fixes):',
        '1. Termination: empty response (candles.length === 0)',
        '2. Cursor: min(timestamp) from ascending-order data (candles[0])',
        '3. Page size: actual response length (200 per request, observed)',
        '',
        'TARGET SPECIFICATION:',
        '- Symbols: BTCUSDT, ETHUSDT',
        '- Granularities: 4h, 1h, 15m',
        '- Baseline: 2026-07-05',
        '- 2022 Coverage Criteria: oldest_date <= 2022-01-01',
        '',
        'OUTPUT FILES:',
        '- G0-1-depth-summary.json (metadata)',
        '- run.log (this file)',
        '',
        'REPRODUCTION:',
        'node --experimental-strip-types scripts/fetch-bitget-intraday.ts',
        '',
        'EXECUTION LOG:',
        ...executionLog,
      ].join('\n')
    );

    log('\n=== 実行完了 ===');
    log(`保存先: ${DATA_DIR}`);
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled:', err);
  process.exit(1);
});
