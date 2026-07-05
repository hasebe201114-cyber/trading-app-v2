/**
 * Bitget公開APIから1h OHLCV実データを取得・保存するスクリプト（EXP-OBS000031 Stage 1用）
 *
 * Stage 0 の G0-1-depth-summary.json はメタデータのみ。
 * Stage 1実装に必要な actual candle配列（OHLCV値）をディスク保存する。
 * 1h粒度 BTC/ETH のみ対象（Stage 1 specで1hに確定したため）。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/fetch-bitget-intraday-1h-materialize.ts
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

interface Candle {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface CandleResult {
  symbol: string;
  granularity: '1h';
  totalCandlesInRange: number;
  oldestDate: string | null;
  newestDate: string | null;
  candlesInRange: Candle[];
  error?: string;
}

async function fetchCandlesForSymbol(symbol: string): Promise<CandleResult> {
  log(`\n【${symbol} 1h】candle実体ページング開始`);

  const candlesInRange: Candle[] = [];
  let pageCount = 0;
  let oldestTs: number | null = null;
  let newestTs: number | null = null;
  let endTime: number | undefined;
  let lastOldestTs: number | null = null;

  const maxPages = 10000;
  const limit = 200;

  while (pageCount < maxPages) {
    const params = new URLSearchParams({
      symbol,
      productType: 'USDT-FUTURES',
      granularity: '1H',
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

      // Convert to Candle objects
      for (const [tsStr, o, h, l, c, vol] of candles) {
        candlesInRange.push({
          timestamp: parseInt(tsStr),
          open: o,
          high: h,
          low: l,
          close: c,
          volume: vol,
        });
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
        granularity: '1h',
        totalCandlesInRange: 0,
        oldestDate: null,
        newestDate: null,
        candlesInRange: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  log(`  計${candlesInRange.length}本取得`);

  return {
    symbol,
    granularity: '1h',
    totalCandlesInRange: candlesInRange.length,
    oldestDate: oldestTs ? new Date(oldestTs).toISOString().split('T')[0] : null,
    newestDate: newestTs ? new Date(newestTs).toISOString().split('T')[0] : null,
    candlesInRange,
  };
}

async function main(): Promise<void> {
  const startTime = new Date().toISOString();
  log(`\n=== EXP-OBS000031 Stage 1: 1h OHLCV Candle Materialization ===`);
  log(`Start: ${startTime}`);
  log(`Node: ${process.version}`);
  log(`Symbols: BTCUSDT, ETHUSDT`);
  log(`Granularity: 1h (1H)`);

  try {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const results: CandleResult[] = [];

    for (const symbol of symbols) {
      const result = await fetchCandlesForSymbol(symbol);
      results.push(result);
      if (symbol !== symbols[symbols.length - 1]) {
        await sleep(300);
      }

      // Save candles for this symbol
      if (!result.error && result.candlesInRange.length > 0) {
        const filename = `${symbol}_1h.json`;
        const filepath = join(DATA_DIR, filename);
        writeFileSync(
          filepath,
          JSON.stringify(
            {
              symbol: result.symbol,
              granularity: result.granularity,
              timestamp: startTime,
              totalCandles: result.candlesInRange.length,
              oldestDate: result.oldestDate,
              newestDate: result.newestDate,
              candles: result.candlesInRange,
            },
            null,
            2
          )
        );
        log(`  ✓ ${filename} 保存完了 (${result.candlesInRange.length}本)`);
      }
    }

    // === Summary ===
    log('\n=== 実体化集計 ===\n');
    for (const r of results) {
      if (r.error) {
        log(`${r.symbol}: ERROR - ${r.error}`);
      } else {
        log(`${r.symbol}: ${r.totalCandlesInRange}本 (${r.oldestDate} .. ${r.newestDate})`);
      }
    }

    // === Save execution summary ===
    writeFileSync(
      join(DATA_DIR, 'stage1-data-materialize.log'),
      [
        '=== EXP-OBS000031 Stage 1: 1h OHLCV Candle Materialization ===',
        `Timestamp: ${startTime}`,
        `Node: ${process.version}`,
        '',
        'TARGET SPECIFICATION:',
        '- Symbols: BTCUSDT, ETHUSDT',
        '- Granularity: 1h (1H)',
        '- Use: Stage 1 intraday-meanrev-robustness.ts / intraday-meanrev-sleeve.ts',
        '',
        'OUTPUT FILES:',
        '- BTCUSDT_1h.json (candle array)',
        '- ETHUSDT_1h.json (candle array)',
        '- stage1-data-materialize.log (this file)',
        '',
        'REPRODUCTION:',
        'node --experimental-strip-types scripts/fetch-bitget-intraday-1h-materialize.ts',
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
