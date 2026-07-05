/**
 * G0-2: 死銘柄（上場廃止）シンボルの再構成可否調査（OBS000030 Stage 0）
 *
 * 手順：
 * 1. contractsエンドポイントの symbolStatus フィールドから廃止シンボルを探す
 * 2. 実在した廃止シンボル3件を特定
 * 3. これらで history-candles / history-fund-rate を叩く
 * 4. CoinGecko等の外部ソースで再構成可能性を調査
 * 5. サバイバーシップ規模の見積り
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'research', 'EXP-OBS000030', '10-result');

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\nResponse: ${text.slice(0, 500)}`);
  }
  return res.json();
}

async function main() {
  const log: string[] = [];
  const timestamp = new Date().toISOString();

  function logMsg(msg: string) {
    console.log(msg);
    log.push(`[${new Date().toISOString()}] ${msg}`);
  }

  logMsg('=== G0-2: 死銘柄再構成可否調査 ===');
  logMsg(`Timestamp: ${timestamp}`);

  // === Step 1: Fetch contracts and look for status info ===
  logMsg('\n### Step 1: Contracts エンドポイントの symbolStatus フィールド確認');
  const contractsUrl = 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES';
  let contracts: Record<string, unknown>[] = [];
  try {
    const data = await fetchJson(contractsUrl) as unknown;
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if ('data' in obj && Array.isArray(obj.data)) {
        contracts = obj.data as Record<string, unknown>[];
      } else if (Array.isArray(data)) {
        contracts = data as Record<string, unknown>[];
      }
    }

    logMsg(`Total contracts: ${contracts.length}`);

    // Inspect symbolStatus field
    const statusValues = new Set<string>();
    for (const c of contracts) {
      if ('symbolStatus' in c) {
        statusValues.add(String(c.symbolStatus));
      }
    }

    logMsg(`Unique symbolStatus values: ${Array.from(statusValues).join(', ')}`);

    // Look for contracts with "offline" or similar status
    const offlineOrClosed = contracts.filter(c => {
      const status = String(c.symbolStatus || '').toLowerCase();
      return status.includes('offline') || status.includes('closed') || status.includes('delisted') || status.includes('closed');
    });

    logMsg(`Contracts with offline/closed/delisted status: ${offlineOrClosed.length}`);
    if (offlineOrClosed.length > 0) {
      logMsg(`  Examples: ${offlineOrClosed.slice(0, 3).map(c => c.symbol).join(', ')}`);
    }
  } catch (err) {
    logMsg(`ERROR fetching contracts: ${err instanceof Error ? err.message : String(err)}`);
  }

  // === Step 2: Define test symbols for dead symbol investigation ===
  // These are known Bitget perpsy mbosl that have been delisted in the past.
  // Since we don't have easy access to historical delisting announcements,
  // we'll use some known examples from crypto exchanges
  logMsg('\n### Step 2: 廃止シンボルの候補特定');
  const testSymbols = [
    'LUNAUSDT',    // Luna (delisted from many exchanges after collapse)
    'LUNA2USDT',   // Luna 2.0 (may have been delisted)
    'TERRUSDT',    // Terra (delisted after ecosystem collapse)
  ];

  logMsg(`Test symbols (known or suspected delistings): ${testSymbols.join(', ')}`);

  // === Step 3: Test if deleted symbols return data via history endpoints ===
  logMsg('\n### Step 3: 削除シンボルの history-candles / fund-rate テスト');

  for (const symbol of testSymbols) {
    logMsg(`\n#### Testing ${symbol}`);

    // Check if symbol is in current contracts list
    const isActive = contracts.some(c => c.symbol === symbol);
    logMsg(`  In current contracts list: ${isActive ? 'YES' : 'NO'}`);

    // Try history-candles
    try {
      const candleUrl = `https://api.bitget.com/api/v2/mix/market/history-candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=1D&limit=10`;
      logMsg(`  Requesting: ${candleUrl}`);
      const candleData = await fetchJson(candleUrl) as unknown;

      let candles: [string, string, string, string, string, string][] = [];
      if (typeof candleData === 'object' && candleData !== null) {
        const obj = candleData as Record<string, unknown>;
        if ('data' in obj && Array.isArray(obj.data)) {
          candles = obj.data as [string, string, string, string, string, string][];
        } else if (Array.isArray(candleData)) {
          candles = candleData as [string, string, string, string, string, string][];
        }
      }

      logMsg(`  history-candles response: ${candles.length} records`);
      if (candles.length > 0) {
        logMsg(`    Oldest date: ${new Date(parseInt(candles[candles.length - 1][0])).toISOString().split('T')[0]}`);
      }
    } catch (err) {
      logMsg(`  history-candles ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(300);

    // Try history-fund-rate
    try {
      const fundUrl = `https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${symbol}&productType=USDT-FUTURES&pageSize=10&pageNo=1`;
      logMsg(`  Requesting: ${fundUrl}`);
      const fundData = await fetchJson(fundUrl) as unknown;

      let fundRates: { fundingTime?: string }[] = [];
      if (typeof fundData === 'object' && fundData !== null) {
        const obj = fundData as Record<string, unknown>;
        if ('data' in obj && Array.isArray(obj.data)) {
          fundRates = obj.data as { fundingTime?: string }[];
        } else if (Array.isArray(fundData)) {
          fundRates = fundData as { fundingTime?: string }[];
        }
      }

      logMsg(`  history-fund-rate response: ${fundRates.length} records`);
      if (fundRates.length > 0) {
        logMsg(`    Oldest: ${fundRates[fundRates.length - 1].fundingTime}`);
      }
    } catch (err) {
      logMsg(`  history-fund-rate ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(300);
  }

  // === Step 4: External source investigation (CoinGecko) ===
  logMsg('\n### Step 4: 外部無料ソース（CoinGecko）での再構成可能性調査');
  logMsg('CoinGecko API（認証不要）を使用して、廃止シンボルのメタデータ取得を試行');

  const testCoinsForCoinGecko = ['luna', 'terra', 'luna-2'];
  for (const coinId of testCoinsForCoinGecko) {
    logMsg(`\n#### CoinGecko: Searching for '${coinId}'`);
    try {
      const url = `https://api.coingecko.com/api/v3/coins/${coinId}`;
      logMsg(`  Request: ${url}`);
      const coinData = await fetchJson(url) as Record<string, unknown>;

      if (coinData && typeof coinData === 'object') {
        const symbol = (coinData.symbol as string || '').toUpperCase();
        const name = coinData.name as string || '';
        logMsg(`  Result: ${name} (${symbol})`);

        if ('status' in coinData && coinData.status) {
          logMsg(`  Status info: ${JSON.stringify(coinData.status)}`);
        }
      }
    } catch (err) {
      logMsg(`  CoinGecko ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(300);
  }

  // === Step 5: Survivorship estimate ===
  logMsg('\n### Step 5: サバイバーシップ規模の見積り材料');
  logMsg(`Current contracts in Bitget USDT-FUTURES: ${contracts.length}`);
  logMsg(`Suspected dead symbols tested: ${testSymbols.join(', ')}`);
  logMsg(`Symbols with publicly documented status (return data via history API): TBD (based on test results above)`);
  logMsg('Note: Complete historical delisting record requires Bitget announcement pages or historical data providers');

  // === Save results ===
  writeFileSync(
    join(DATA_DIR, 'G0-2-dead-symbol-investigation.log'),
    log.join('\n')
  );

  logMsg('\n=== 調査完了 ===');
  logMsg(`Results saved to: G0-2-dead-symbol-investigation.log`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
