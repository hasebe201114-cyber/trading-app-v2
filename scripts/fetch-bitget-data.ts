/**
 * Bitget公開APIからマルチユニバース用データを取得するスクリプト（OBS000030 Stage 0）
 *
 * 背景: EXP-OBS000030のデータ実現可能性スパイク。
 * Bitget USDT-perpetuals (USDT-FUTURES) の流動性上位50銘柄について、
 * 日足OHLCV・Funding履歴を取得し、履歴深度・死銘柄対応の可能性を調査する。
 *
 * 取得内容:
 *   - USDT-FUTURES全銘柄の24h USDT出来高スナップショット（取得UTC時刻記録）
 *   - 出来高上位50銘柄について：
 *     - 日足OHLCV（history-candles, granularity=1D で全期間遡及）
 *     - Funding Rate履歴（history-fund-rate で全期間遡及）
 *   - contractsエンドポイントの全フィールド（死銘柄status確認用）
 *
 * 認証不要の公開APIのみ使用（APIキー・秘密鍵は読まない）。
 * レート制限に配慮し、リクエスト間に待機を挟む。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/fetch-bitget-data.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'research', 'EXP-OBS000030', '10-result');
mkdirSync(DATA_DIR, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// === Logging / Tracking ===
const executionLog: string[] = [];
const apiMetrics = {
  tickersRequest: {} as Record<string, unknown>,
  contractsRequest: {} as Record<string, unknown>,
  historyCandles: { requestCount: 0, successCount: 0, failureCount: 0 },
  historyFundRate: { requestCount: 0, successCount: 0, failureCount: 0 },
};

function log(message: string): void {
  console.log(message);
  executionLog.push(`[${new Date().toISOString()}] ${message}`);
}

// === API Fetch with error handling ===
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\nResponse: ${text.slice(0, 500)}`);
  }
  return res.json();
}

// === G0-1: Fetch top-50 snapshot by 24h USDT volume ===
async function fetchTickerSnapshot(): Promise<{ symbol: string; usdtVolume: number; timestamp: string }[]> {
  log('=== Tickers スナップショット取得開始 ===');
  const timestamp = new Date().toISOString();
  const url = 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES';
  log(`Request URL: ${url}`);
  log(`Timestamp: ${timestamp}`);

  try {
    const data = await fetchJson(url) as unknown;
    apiMetrics.tickersRequest = { url, timestamp, responseType: typeof data };

    // Parse response - may need adjustment based on actual schema
    let tickers: { symbol?: string; usdtVolume?: number | string; quoteVolume?: number | string }[] = [];
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if ('data' in obj && Array.isArray(obj.data)) {
        tickers = obj.data as typeof tickers;
      } else if (Array.isArray(data)) {
        tickers = data as typeof tickers;
      }
    }

    log(`Total tickers received: ${tickers.length}`);

    // Normalize and sort by USDT volume (24h)
    const normalized = tickers
      .filter(t => t.symbol && (t.usdtVolume || t.quoteVolume))
      .map(t => ({
        symbol: t.symbol as string,
        usdtVolume: parseFloat((t.usdtVolume || t.quoteVolume || 0).toString()),
      }))
      .sort((a, b) => b.usdtVolume - a.usdtVolume);

    const top50 = normalized.slice(0, 50);
    log(`Top 50 tickers extracted. Top 1: ${top50[0]?.symbol} (${top50[0]?.usdtVolume})`);

    // Save snapshot
    writeFileSync(
      join(DATA_DIR, 'snapshot-tickers-top50.json'),
      JSON.stringify({ timestamp, tickers: top50 }, null, 2)
    );

    return top50.map(t => ({ ...t, timestamp }));
  } catch (err) {
    log(`ERROR fetching tickers: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// === G0-2: Fetch and inspect contracts endpoint for dead symbol status ===
async function fetchContractsList(): Promise<Record<string, unknown>[]> {
  log('=== Contracts エンドポイント取得開始（死銘柄status確認用） ===');
  const url = 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES';
  log(`Request URL: ${url}`);

  try {
    const data = await fetchJson(url) as unknown;
    apiMetrics.contractsRequest = { url, responseType: typeof data };

    let contracts: Record<string, unknown>[] = [];
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if ('data' in obj && Array.isArray(obj.data)) {
        contracts = obj.data as Record<string, unknown>[];
      } else if (Array.isArray(data)) {
        contracts = data as Record<string, unknown>[];
      }
    }

    log(`Total contracts in list: ${contracts.length}`);

    // Inspect schema (first contract + look for status fields)
    if (contracts.length > 0) {
      const sampleContract = contracts[0];
      const fields = Object.keys(sampleContract);
      log(`Contract schema (fields): ${fields.join(', ')}`);
      // Look for status-like fields
      const statusFields = fields.filter(f => f.toLowerCase().includes('status'));
      if (statusFields.length > 0) {
        log(`Status-related fields found: ${statusFields.join(', ')}`);
      }
    }

    // Save full contracts list
    writeFileSync(
      join(DATA_DIR, 'contracts-full-list.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), contracts }, null, 2)
    );

    return contracts;
  } catch (err) {
    log(`ERROR fetching contracts: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// === Fetch daily candles for a symbol ===
async function fetchHistoryCandles(
  symbol: string,
  productType: string = 'USDT-FUTURES',
  granularity: string = '1D'
): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
  const rows: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let endTime: number | undefined;
  let pageCount = 0;
  const maxPages = 1000; // Safety limit (may need many pages with limit=200)
  const pageSize = 200; // Bitget API limit: 1~200
  let lastOldestTimestamp: number | undefined;

  apiMetrics.historyCandles.requestCount++;

  while (pageCount < maxPages) {
    const params = new URLSearchParams({
      symbol,
      productType,
      granularity,
      limit: pageSize.toString(),
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
        log(`  ${symbol}: history-candles reached end (empty response at page ${pageCount})`);
        break;
      }

      for (const c of candles) {
        rows.push({
          date: new Date(parseInt(c[0])).toISOString().split('T')[0],
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5]),
        });
      }

      // FIX: Bitget returns candles in ascending order (oldest first)
      // So candles[0] is the oldest, candles[candles.length-1] is the newest
      const oldestTimestamp = parseInt(candles[0][0]);
      const newestTimestamp = parseInt(candles[candles.length - 1][0]);

      pageCount++;
      log(`  ${symbol}: candles ${rows.length}件（ページ${pageCount}: 古い側 ${new Date(oldestTimestamp).toISOString().split('T')[0]} .. 新しい側 ${new Date(newestTimestamp).toISOString().split('T')[0]}）`);

      // Check if we've stopped making progress (reaching the same oldest timestamp)
      if (lastOldestTimestamp === oldestTimestamp) {
        log(`  ${symbol}: oldest timestamp not advancing, stopping pagination`);
        break;
      }
      lastOldestTimestamp = oldestTimestamp;

      // Set endTime to oldest timestamp - 1 for the next page
      endTime = oldestTimestamp - 1;

      await sleep(200); // Rate limit consideration
    } catch (err) {
      apiMetrics.historyCandles.failureCount++;
      log(`  ERROR ${symbol}: candles fetch failed at page ${pageCount}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  apiMetrics.historyCandles.successCount++;
  return rows;
}

// === Fetch funding rate history for a symbol ===
async function fetchHistoryFundingRate(
  symbol: string,
  productType: string = 'USDT-FUTURES'
): Promise<{ datetime: string; fundingRate: number }[]> {
  const rows: { datetime: string; fundingRate: number }[] = [];
  let pageNo = 1;
  const pageSize = 100; // FIX: Bitget実上限は100（超過分は黙ってキャップされる）
  const maxPages = 100; // Safety limit

  apiMetrics.historyFundRate.requestCount++;

  while (pageNo <= maxPages) {
    const params = new URLSearchParams({
      symbol,
      productType,
      pageSize: pageSize.toString(),
      pageNo: pageNo.toString(),
    });
    const url = `https://api.bitget.com/api/v2/mix/market/history-fund-rate?${params.toString()}`;

    try {
      const data = await fetchJson(url) as unknown;
      let fundRates: { fundingTime?: string; fundingRate?: string }[] = [];

      if (typeof data === 'object' && data !== null) {
        const obj = data as Record<string, unknown>;
        if ('data' in obj && Array.isArray(obj.data)) {
          fundRates = obj.data as typeof fundRates;
        } else if (Array.isArray(data)) {
          fundRates = data as typeof fundRates;
        }
      }

      if (fundRates.length === 0) {
        log(`  ${symbol}: history-fund-rate reached end (empty response at page ${pageNo})`);
        break;
      }

      for (const f of fundRates) {
        // fundingTime may be string (ISO) or number (unix ms)
        let dtStr = f.fundingTime || '';
        if (typeof f.fundingTime === 'number') {
          dtStr = new Date(f.fundingTime).toISOString();
        }
        rows.push({
          datetime: dtStr,
          fundingRate: parseFloat(f.fundingRate || '0'),
        });
      }

      log(`  ${symbol}: funding rates ${rows.length}件（page ${pageNo}, 返却${fundRates.length}件）`);

      if (fundRates.length < pageSize) {
        log(`  ${symbol}: reached pagination end (${fundRates.length} < ${pageSize})`);
        break;
      }

      pageNo++;
      await sleep(200);
    } catch (err) {
      apiMetrics.historyFundRate.failureCount++;
      log(`  ERROR ${symbol}: funding rate fetch failed at page ${pageNo}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  apiMetrics.historyFundRate.successCount++;
  return rows;
}

// === Test dead/removed symbols (G0-2) ===
interface DeadSymbolTestResult {
  symbol: string;
  httpStatus?: number;
  apiCode?: string;
  apiMsg?: string;
  interpretation: 'nonexistent' | 'removed' | 'active';
  candlesAvailable: boolean;
  candlesCount: number;
}

async function testDeadSymbols(): Promise<DeadSymbolTestResult[]> {
  log('\n=== G0-2 死銘柄テスト（code 40034 vs 40309 の識別） ===');

  // テストシンボル: 架空（40034）と廃止済（40309）の両方を含む
  const testSymbols = [
    { symbol: 'SRMUSDT', expectedCode: 40309, label: '廃止済み（本物）' },
    { symbol: 'LUNA2USDT', expectedCode: 40034, label: '架空（Bのテスト誤り）' },
    { symbol: 'TERRUSDT', expectedCode: 40034, label: '誤綴り（Bのテスト誤り）' },
  ];

  const results: DeadSymbolTestResult[] = [];

  for (const test of testSymbols) {
    log(`  Testing ${test.symbol} (${test.label})...`);

    try {
      const params = new URLSearchParams({
        symbol: test.symbol,
        productType: 'USDT-FUTURES',
        granularity: '1D',
        limit: '200',
        endTime: '1672531199999', // 2023-01-01
      });
      const url = `https://api.bitget.com/api/v2/mix/market/history-candles?${params.toString()}`;

      const res = await fetch(url);
      const body = await res.json() as unknown;

      if (!res.ok) {
        // Error response - extract code and message
        const errorObj = body as Record<string, unknown>;
        const code = (errorObj.code ? parseInt(String(errorObj.code)) : res.status) as number;
        const msg = (errorObj.msg || errorObj.message || '') as string;

        const interpretation: 'nonexistent' | 'removed' =
          code === 40309 ? 'removed' : code === 40034 ? 'nonexistent' : 'nonexistent';

        log(`    ${test.symbol}: HTTP ${res.status} / code ${code} / msg "${msg}" -> ${interpretation}`);
        results.push({
          symbol: test.symbol,
          httpStatus: res.status,
          apiCode: String(code),
          apiMsg: msg,
          interpretation,
          candlesAvailable: false,
          candlesCount: 0,
        });
      } else {
        // Success response - check data
        let candles: unknown[] = [];
        if (typeof body === 'object' && body !== null) {
          const obj = body as Record<string, unknown>;
          if ('data' in obj && Array.isArray(obj.data)) {
            candles = obj.data;
          } else if (Array.isArray(body)) {
            candles = body as unknown[];
          }
        }

        log(`    ${test.symbol}: HTTP 200 / candles ${candles.length}件 -> active`);
        results.push({
          symbol: test.symbol,
          httpStatus: 200,
          apiCode: '00000',
          apiMsg: 'success',
          interpretation: 'active',
          candlesAvailable: candles.length > 0,
          candlesCount: candles.length,
        });
      }
    } catch (err) {
      log(`    ${test.symbol}: Exception: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        symbol: test.symbol,
        interpretation: 'nonexistent',
        candlesAvailable: false,
        candlesCount: 0,
      });
    }

    await sleep(200);
  }

  return results;
}

// === Analyze history depth for a symbol ===
interface HistoryDepthAnalysis {
  symbol: string;
  candles: {
    count: number;
    oldestDate: string | null;
    newestDate: string | null;
    coveredDays: number;
    gapDays: number;
    gapRatio: number;
  };
  fundingRate: {
    count: number;
    oldestDatetime: string | null;
    newestDatetime: string | null;
  };
  covers3YearsFrom: string; // "2022-07-05"
  covers2022FullYear: boolean;
}

function analyzeHistoryDepth(
  symbol: string,
  candles: { date: string }[],
  fundingRates: { datetime: string }[]
): HistoryDepthAnalysis {
  const sortedCandles = candles.sort((a, b) => a.date.localeCompare(b.date));
  const sortedFunding = fundingRates.sort((a, b) => a.datetime.localeCompare(b.datetime));

  const oldestCandleDate = sortedCandles.length > 0 ? sortedCandles[0].date : null;
  const newestCandleDate = sortedCandles.length > 0 ? sortedCandles[sortedCandles.length - 1].date : null;

  // Business days between oldest and newest
  let businessDays = 0;
  if (oldestCandleDate && newestCandleDate) {
    const start = new Date(oldestCandleDate);
    const end = new Date(newestCandleDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dayOfWeek = d.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) businessDays++;
    }
  }

  const missingDays = Math.max(0, businessDays - sortedCandles.length);
  const gapRatio = businessDays > 0 ? missingDays / businessDays : 0;

  const coversSince20220705 = oldestCandleDate && oldestCandleDate <= '2022-07-05';
  const covers2022 =
    sortedCandles.some(c => c.date >= '2022-01-01' && c.date <= '2022-12-31') &&
    sortedCandles.some(c => c.date >= '2022-07-01' && c.date <= '2022-07-31') &&
    sortedCandles.some(c => c.date >= '2022-12-01' && c.date <= '2022-12-31');

  return {
    symbol,
    candles: {
      count: sortedCandles.length,
      oldestDate: oldestCandleDate,
      newestDate: newestCandleDate,
      coveredDays: businessDays,
      gapDays: missingDays,
      gapRatio,
    },
    fundingRate: {
      count: sortedFunding.length,
      oldestDatetime: sortedFunding.length > 0 ? sortedFunding[0].datetime : null,
      newestDatetime: sortedFunding.length > 0 ? sortedFunding[sortedFunding.length - 1].datetime : null,
    },
    covers3YearsFrom: coversSince20220705 ? 'YES' : 'NO',
    covers2022FullYear: covers2022,
  };
}

// === Main flow ===
async function main(): Promise<void> {
  const scriptStartTime = new Date().toISOString();
  log(`\n=== EXP-OBS000030 Stage 0: Data Feasibility Spike ===`);
  log(`Script started: ${scriptStartTime}`);
  log(`Node version: ${process.version}`);

  try {
    // Step 1: Fetch top-50 ticker snapshot
    const topTickers = await fetchTickerSnapshot();
    await sleep(500);

    // Step 2: Fetch contracts list for dead symbol inspection
    const contractsList = await fetchContractsList();
    await sleep(500);

    // Step 3: Fetch history for each top-50 symbol
    log('\n=== History-candles と History-fund-rate の取得開始 ===');
    const depthAnalyses: HistoryDepthAnalysis[] = [];

    for (let i = 0; i < topTickers.length; i++) {
      const ticker = topTickers[i];
      log(`\n[${i + 1}/50] ${ticker.symbol} の履歴取得開始`);

      try {
        const candles = await fetchHistoryCandles(ticker.symbol);
        const fundingRates = await fetchHistoryFundingRate(ticker.symbol);

        const analysis = analyzeHistoryDepth(ticker.symbol, candles, fundingRates);
        depthAnalyses.push(analysis);

        // Save raw data for this symbol
        writeFileSync(
          join(DATA_DIR, `history-${ticker.symbol.toLowerCase()}.json`),
          JSON.stringify({ candles, fundingRates }, null, 2)
        );
      } catch (err) {
        log(`ERROR: ${ticker.symbol} history fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (i < topTickers.length - 1) await sleep(300);
    }

    // Step 4: Aggregate and report findings
    log('\n=== G0-1 履歴深度集計 ===');
    const tier20 = depthAnalyses.slice(0, 20);
    const tier30 = depthAnalyses.slice(0, 30);
    const tier50 = depthAnalyses.slice(0, 50);

    const countThreeYears = (tier: HistoryDepthAnalysis[]) => tier.filter(a => a.covers3YearsFrom === 'YES').length;
    const count2022Full = (tier: HistoryDepthAnalysis[]) => tier.filter(a => a.covers2022FullYear).length;

    log(`N=20: 3年ライン(2022-07-05以前)カバー=${countThreeYears(tier20)}本, 2022通年=${count2022Full(tier20)}本`);
    log(`N=30: 3年ライン(2022-07-05以前)カバー=${countThreeYears(tier30)}本, 2022通年=${count2022Full(tier30)}本`);
    log(`N=50: 3年ライン(2022-07-05以前)カバー=${countThreeYears(tier50)}本, 2022通年=${count2022Full(tier50)}本`);

    // Save depth analysis
    writeFileSync(
      join(DATA_DIR, 'G0-1-history-depth-analysis.json'),
      JSON.stringify({
        timestamp: scriptStartTime,
        analysis: depthAnalyses,
        summary: {
          N20: { threeYears: countThreeYears(tier20), fullYear2022: count2022Full(tier20) },
          N30: { threeYears: countThreeYears(tier30), fullYear2022: count2022Full(tier30) },
          N50: { threeYears: countThreeYears(tier50), fullYear2022: count2022Full(tier50) },
        },
      }, null, 2)
    );

    // Step 5: Test dead symbols (G0-2)
    await sleep(500);
    const deadSymbolTests = await testDeadSymbols();

    // Step 6: Save metrics and logs
    writeFileSync(
      join(DATA_DIR, 'api-metrics.json'),
      JSON.stringify({
        scriptStartTime,
        apiMetrics,
        contractsCount: contractsList.length,
      }, null, 2)
    );

    writeFileSync(
      join(DATA_DIR, 'G0-2-dead-symbol-test-results.json'),
      JSON.stringify({
        timestamp: scriptStartTime,
        testResults: deadSymbolTests,
      }, null, 2)
    );

    writeFileSync(
      join(DATA_DIR, 'run.log'),
      [
        '=== EXP-OBS000030 Stage 0: Data Feasibility Spike (Revised) ===',
        `Execution time: ${scriptStartTime}`,
        `Node version: ${process.version}`,
        `Git commit: (run "git rev-parse HEAD" to get this)`,
        '',
        'REVISIONS (Bug Fixes):',
        '1. history-candles: Fixed pagination termination condition from "candles.length < pageSize" to "candles.length === 0"',
        '2. history-candles: Fixed oldest timestamp detection (was candles[length-1], now candles[0] since Bitget returns in ascending order)',
        '3. history-fund-rate: Changed pageSize from 500 to 100 (actual Bitget limit)',
        '4. G0-2: Added test for error code discrimination (40034=nonexistent vs 40309=removed)',
        '',
        'Execution log:',
        ...executionLog,
        '',
        'COMMANDS TO REPRODUCE:',
        'node --experimental-strip-types scripts/fetch-bitget-data.ts',
        '',
      ].join('\n')
    );

    log('\n=== 実行完了 ===');
    log(`成果物保存先: ${DATA_DIR}`);
    log(`Files saved:`);
    log(`  - snapshot-tickers-top50.json`);
    log(`  - contracts-full-list.json`);
    log(`  - G0-1-history-depth-analysis.json`);
    log(`  - history-*.json (per symbol)`);
    log(`  - G0-2-dead-symbol-test-results.json`);
    log(`  - api-metrics.json`);
    log(`  - run.log`);
  } catch (err) {
    log(`FATAL ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
