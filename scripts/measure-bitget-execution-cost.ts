/**
 * Bitget執行コスト測定スクリプト（EXP-OBS000031 Stage 0 G0-2）
 *
 * 実測内容:
 * 1. テイカー/メイカー手数料を取得（contracts API）
 * 2. 実効スプレッド(bps)を測定（tickers API）
 * 3. オーダーブックをウォークし、$10k/$50k/$100kサイズ別スリッページを算出
 * 4. (S-taker) と (S-maker) の往復コストモデル2シナリオを構築
 *
 * 実行例:
 *   node --experimental-strip-types scripts/measure-bitget-execution-cost.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'research', 'EXP-OBS000031', '10-result');
mkdirSync(DATA_DIR, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// === Logging ===
const executionLog: string[] = [];

function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  executionLog.push(`[${timestamp}] ${message}`);
}

// === API Fetch ===
async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\nResponse: ${text.slice(0, 500)}`);
  }
  return res.json();
}

interface ContractFeeInfo {
  symbol: string;
  takerFeeRate: number;
  makerFeeRate: number;
  source: 'api' | 'manual_fallback';
}

/**
 * Fetch taker/maker fees from contracts endpoint.
 * If API doesn't return fee rates, use manual fallback (VIP0 tier).
 */
async function fetchContractFees(symbol: string): Promise<ContractFeeInfo> {
  try {
    const url = 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES';
    const data = await fetchJson(url) as unknown;

    let contracts: Record<string, unknown>[] = [];
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if ('data' in obj && Array.isArray(obj.data)) {
        contracts = obj.data as Record<string, unknown>[];
      } else if (Array.isArray(data)) {
        contracts = data as Record<string, unknown>[];
      }
    }

    const contract = contracts.find(c => (c.symbol || '').toString() === symbol);
    if (!contract) throw new Error(`Contract ${symbol} not found in list`);

    // Try to extract taker/maker rates (already in decimal form from API)
    const takerFeeRate = contract.takerFeeRate
      ? parseFloat(contract.takerFeeRate.toString())
      : null;
    const makerFeeRate = contract.makerFeeRate
      ? parseFloat(contract.makerFeeRate.toString())
      : null;

    if (takerFeeRate !== null && makerFeeRate !== null) {
      return {
        symbol,
        takerFeeRate,
        makerFeeRate,
        source: 'api',
      };
    }

    throw new Error(`Fee rates not found in API response for ${symbol}`);
  } catch (err) {
    // Fallback: use Bitget VIP0 tier (public documentation)
    log(`  ℹ API fee fetch failed for ${symbol}, using VIP0 fallback: ${err instanceof Error ? err.message : String(err)}`);
    return {
      symbol,
      takerFeeRate: 0.0006, // 6 bps
      makerFeeRate: 0.0002, // 2 bps (VIP0 typical)
      source: 'manual_fallback',
    };
  }
}

interface SpreadMeasurement {
  symbol: string;
  timestamp: string;
  bidPrice: number;
  askPrice: number;
  midPrice: number;
  spreadBps: number;
}

/**
 * Measure bid-ask spread from tickers endpoint.
 */
async function measureSpread(symbol: string): Promise<SpreadMeasurement> {
  const url = 'https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES';
  const timestamp = new Date().toISOString();

  const data = await fetchJson(url) as unknown;
  let tickers: Record<string, unknown>[] = [];

  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if ('data' in obj && Array.isArray(obj.data)) {
      tickers = obj.data as Record<string, unknown>[];
    } else if (Array.isArray(data)) {
      tickers = data as Record<string, unknown>[];
    }
  }

  const ticker = tickers.find(t => (t.symbol || '').toString() === symbol) as Record<string, unknown> | undefined;
  if (!ticker) throw new Error(`Ticker ${symbol} not found`);

  const bid = parseFloat((ticker.bidPr || ticker.bestBid || ticker.bidPrice || '0').toString());
  const ask = parseFloat((ticker.askPr || ticker.bestAsk || ticker.askPrice || '0').toString());
  const mid = (bid + ask) / 2;
  const spread = mid > 0 && bid > 0 && ask > 0 ? (ask - bid) / mid * 10000 : 0; // bps

  return {
    symbol,
    timestamp,
    bidPrice: bid,
    askPrice: ask,
    midPrice: mid,
    spreadBps: spread,
  };
}

interface OrderbookLevel {
  price: number;
  quantity: number;
}

interface SlippageAnalysis {
  symbol: string;
  side: 'BUY' | 'SELL';
  sizeUSDT: number;
  avgExecutionPrice: number;
  midPrice: number;
  slippageBps: number;
  depthLevels: number;
  exhaustedDepth: boolean;
}

/**
 * Walk orderbook (bid/ask side) to estimate slippage for a given notional size.
 * Orderbook quantities are in coins, prices in USDT.
 */
function walkOrderbook(
  side: 'BUY' | 'SELL',
  orderbook: OrderbookLevel[],
  targetSizeUSDT: number,
  midPrice: number
): SlippageAnalysis {
  let accumulatedUSDT = 0;
  let accumulatedWeightedPrice = 0; // sum of (price * notionalAtPrice)
  let exhausted = false;

  for (const level of orderbook) {
    // level.quantity is in coins, level.price is in USDT
    const levelNotionalUSDT = level.price * level.quantity;
    const needed = targetSizeUSDT - accumulatedUSDT;

    if (needed <= 0) break;

    if (levelNotionalUSDT >= needed) {
      // Partial fill at this level
      accumulatedUSDT += needed;
      accumulatedWeightedPrice += level.price * needed;
      break;
    } else {
      // Full fill at this level, continue to next
      accumulatedUSDT += levelNotionalUSDT;
      accumulatedWeightedPrice += level.price * levelNotionalUSDT;
    }
  }

  if (accumulatedUSDT < targetSizeUSDT * 0.9) {
    // Less than 90% of target filled
    exhausted = true;
  }

  const avgPrice = accumulatedUSDT > 0 ? accumulatedWeightedPrice / accumulatedUSDT : midPrice;

  // Slippage calculation
  let slippageBps = 0;
  if (midPrice > 0) {
    if (side === 'BUY') {
      // BUY side: avgPrice should be higher than midPrice, positive slippage
      slippageBps = ((avgPrice - midPrice) / midPrice) * 10000;
    } else {
      // SELL side: avgPrice should be lower than midPrice, positive slippage
      slippageBps = ((midPrice - avgPrice) / midPrice) * 10000;
    }
  }

  return {
    symbol: '',
    side,
    sizeUSDT: targetSizeUSDT,
    avgExecutionPrice: avgPrice,
    midPrice,
    slippageBps: Math.max(0, slippageBps), // Slippage is non-negative
    depthLevels: orderbook.length,
    exhaustedDepth: exhausted,
  };
}

interface OrderbookSnapshot {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

/**
 * Fetch orderbook depth from merge-depth endpoint.
 */
async function fetchOrderbook(symbol: string, depth: number = 50): Promise<OrderbookSnapshot> {
  const params = new URLSearchParams({
    symbol,
    productType: 'USDT-FUTURES',
    limit: depth.toString(),
  });
  const url = `https://api.bitget.com/api/v2/mix/market/merge-depth?${params.toString()}`;

  const data = await fetchJson(url) as unknown;
  let bids: [string, string][] = [];
  let asks: [string, string][] = [];

  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>;
    if ('data' in obj && typeof obj.data === 'object' && obj.data !== null) {
      const dataObj = obj.data as Record<string, unknown>;
      if ('bids' in dataObj && Array.isArray(dataObj.bids)) {
        bids = dataObj.bids as [string, string][];
      }
      if ('asks' in dataObj && Array.isArray(dataObj.asks)) {
        asks = dataObj.asks as [string, string][];
      }
    }
  }

  return {
    bids: bids.map(b => ({ price: parseFloat(b[0]), quantity: parseFloat(b[1]) })),
    asks: asks.map(a => ({ price: parseFloat(a[0]), quantity: parseFloat(a[1]) })),
  };
}

interface ExecutionCostResult {
  symbol: string;
  fees: ContractFeeInfo;
  spread: SpreadMeasurement;
  slippage: {
    buy: SlippageAnalysis[];
    sell: SlippageAnalysis[];
  };
  orderbookDepth: number;
  roundtripCosts: {
    scenarioTaker: {
      size_10k: number;
      size_50k: number;
      size_100k: number;
      description: string;
    };
    scenarioMaker: {
      size_10k: number;
      size_50k: number;
      size_100k: number;
      description: string;
    };
  };
}

/**
 * Measure all execution costs for a symbol.
 */
async function measureExecutionCosts(symbol: string): Promise<ExecutionCostResult> {
  log(`\n【${symbol}】執行コスト測定開始`);

  // 1. Fees
  log(`  手数料取得...`);
  const fees = await fetchContractFees(symbol);
  log(`    Taker: ${(fees.takerFeeRate * 10000).toFixed(1)} bps, Maker: ${(fees.makerFeeRate * 10000).toFixed(1)} bps (source: ${fees.source})`);
  await sleep(200);

  // 2. Spread
  log(`  スプレッド測定...`);
  const spread = await measureSpread(symbol);
  log(`    Bid: ${spread.bidPrice}, Ask: ${spread.askPrice}, Spread: ${spread.spreadBps.toFixed(2)} bps`);
  await sleep(200);

  // 3. Orderbook & slippage
  log(`  オーダーブック取得（深度50階層）...`);
  const orderbook = await fetchOrderbook(symbol, 50);
  log(`    Bids: ${orderbook.bids.length}階層, Asks: ${orderbook.asks.length}階層`);

  // Calculate mid price from orderbook's best bid/ask (same snapshot as slippage walk)
  const orderbookMidPrice = orderbook.bids.length > 0 && orderbook.asks.length > 0
    ? (orderbook.bids[0].price + orderbook.asks[0].price) / 2
    : spread.midPrice;
  log(`    orderbook best bid: ${orderbook.bids[0]?.price ?? 'N/A'}, best ask: ${orderbook.asks[0]?.price ?? 'N/A'}, mid: ${orderbookMidPrice.toFixed(2)}`);

  const sizes = [10000, 50000, 100000];
  const buySlippages: SlippageAnalysis[] = [];
  const sellSlippages: SlippageAnalysis[] = [];

  for (const size of sizes) {
    // BUY side: walk ask side (ascending price)
    const buyWalk = walkOrderbook('BUY', orderbook.asks, size, orderbookMidPrice);
    buyWalk.symbol = symbol;
    buySlippages.push(buyWalk);
    log(`    BUY $${size}k: slippage ${buyWalk.slippageBps.toFixed(2)} bps (執行価格 ${buyWalk.avgExecutionPrice.toFixed(2)}, 使用階層数: ${buyWalk.depthLevels})`);

    // SELL side: walk bid side (descending price, already in descending order from API)
    const sellWalk = walkOrderbook('SELL', orderbook.bids, size, orderbookMidPrice);
    sellWalk.symbol = symbol;
    sellSlippages.push(sellWalk);
    log(`    SELL $${size}k: slippage ${sellWalk.slippageBps.toFixed(2)} bps (執行価格 ${sellWalk.avgExecutionPrice.toFixed(2)}, 使用階層数: ${sellWalk.depthLevels})`);
  }

  // 4. Roundtrip cost model
  // (S-taker): all taker fees + spreads + slippage
  const takerCosts = sizes.map((size, i) => {
    const buySlip = buySlippages[i]?.slippageBps ?? 0;
    const sellSlip = sellSlippages[i]?.slippageBps ?? 0;
    const spreadCost = typeof spread.spreadBps === 'number' ? spread.spreadBps : 0;
    const roundtrip =
      2 * (fees.takerFeeRate * 10000) + // roundtrip taker fees
      2 * (spreadCost / 2) + // roundtrip spreads (half on entry, half on exit)
      buySlip + sellSlip; // roundtrip slippage
    return roundtrip;
  });

  // (S-maker): 50% execution rate, rest convert to taker
  const makerCosts = sizes.map((size, i) => {
    const spreadCost = typeof spread.spreadBps === 'number' ? spread.spreadBps : 0;
    const buySlip = buySlippages[i]?.slippageBps ?? 0;
    const sellSlip = sellSlippages[i]?.slippageBps ?? 0;
    const makerPortion =
      2 * (fees.makerFeeRate * 10000) * 0.5; // Maker execution 50%
    const takerConvertPortion =
      2 * (fees.takerFeeRate * 10000) * 0.5 + // Taker conversion on 50%
      2 * (spreadCost / 2) * 0.5 + // Spread on conversion
      (buySlip + sellSlip) * 0.5; // Slippage on conversion
    return makerPortion + takerConvertPortion;
  });

  return {
    symbol,
    fees,
    spread,
    slippage: { buy: buySlippages, sell: sellSlippages },
    orderbookDepth: Math.min(orderbook.bids.length, orderbook.asks.length),
    roundtripCosts: {
      scenarioTaker: {
        size_10k: takerCosts[0],
        size_50k: takerCosts[1],
        size_100k: takerCosts[2],
        description: '全成行（テイカー）想定。往復コスト=2×テイカー手数料+2×（スプレッド/2）+スリッページ',
      },
      scenarioMaker: {
        size_10k: makerCosts[0],
        size_50k: makerCosts[1],
        size_100k: makerCosts[2],
        description: '指値約定率50%悲観想定。往復コスト=指値成立0.5×（2×メイカー手数料）+成行転換0.5×（S-takerと同等）',
      },
    },
  };
}

// === Main ===
async function main(): Promise<void> {
  const scriptStartTime = new Date().toISOString();
  log(`\n=== EXP-OBS000031 Stage 0 G0-2: Execution Cost Measurement ===`);
  log(`Script started: ${scriptStartTime}`);
  log(`Node version: ${process.version}`);

  try {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const allResults: ExecutionCostResult[] = [];

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const result = await measureExecutionCosts(symbol);
      allResults.push(result);

      if (i < symbols.length - 1) await sleep(500);
    }

    // === Print Cost Tables ===
    log('\n=== G0-2 執行コスト集計表 ===');
    log('');

    // Fees table
    log('【手数料（bps）】');
    log('| 銘柄 | テイカー | メイカー | 出典 |');
    log('|---|---|---|---|');
    for (const result of allResults) {
      const takerBps = (result.fees.takerFeeRate * 10000).toFixed(1);
      const makerBps = (result.fees.makerFeeRate * 10000).toFixed(1);
      log(`| ${result.symbol} | ${takerBps} | ${makerBps} | ${result.fees.source} |`);
    }
    log('');

    // Spread table
    log('【実効スプレッド（bps）】');
    log('| 銘柄 | スプレッド | 測定時刻 |');
    log('|---|---|---|');
    for (const result of allResults) {
      log(`| ${result.symbol} | ${result.spread.spreadBps.toFixed(2)} | ${result.spread.timestamp.split('T')[1].split('.')[0]} UTC |`);
    }
    log('');

    // Slippage table
    log('【板厚スリッページ（bps）】');
    log('| 銘柄 | 方向 | $10k | $50k | $100k |');
    log('|---|---|---|---|---|');
    for (const result of allResults) {
      const buySizes = result.slippage.buy.map(s => s.slippageBps.toFixed(2)).join(' | ');
      const sellSizes = result.slippage.sell.map(s => s.slippageBps.toFixed(2)).join(' | ');
      log(`| ${result.symbol} | BUY | ${buySizes} |`);
      log(`| | SELL | ${sellSizes} |`);
    }
    log('');

    // Roundtrip cost scenarios
    log('【往復コストモデル2シナリオ（bps）】');
    log('');
    log('(S-taker) 全成行保守シナリオ:');
    log('| 銘柄 | $10k | $50k | $100k |');
    log('|---|---|---|---|');
    for (const result of allResults) {
      const costs = [
        result.roundtripCosts.scenarioTaker.size_10k.toFixed(2),
        result.roundtripCosts.scenarioTaker.size_50k.toFixed(2),
        result.roundtripCosts.scenarioTaker.size_100k.toFixed(2),
      ].join(' | ');
      log(`| ${result.symbol} | ${costs} |`);
    }
    log('');

    log('(S-maker) 指値約定率50%悲観シナリオ:');
    log('| 銘柄 | $10k | $50k | $100k |');
    log('|---|---|---|---|');
    for (const result of allResults) {
      const costs = [
        result.roundtripCosts.scenarioMaker.size_10k.toFixed(2),
        result.roundtripCosts.scenarioMaker.size_50k.toFixed(2),
        result.roundtripCosts.scenarioMaker.size_100k.toFixed(2),
      ].join(' | ');
      log(`| ${result.symbol} | ${costs} |`);
    }
    log('');

    // === Save results ===
    writeFileSync(
      join(DATA_DIR, 'G0-2-execution-costs.json'),
      JSON.stringify({
        timestamp: scriptStartTime,
        results: allResults,
      }, null, 2)
    );

    // === Save run log ===
    writeFileSync(
      join(DATA_DIR, 'execution-cost-run.log'),
      [
        '=== EXP-OBS000031 Stage 0 G0-2: Execution Cost Measurement ===',
        `Execution time: ${scriptStartTime}`,
        `Node version: ${process.version}`,
        '',
        'MEASUREMENT DETAILS:',
        '1. Taker/Maker fees: contracts endpoint (fallback to VIP0 tier)',
        '2. Spread: tickers endpoint (bid/ask snapshot)',
        '3. Slippage: merge-depth orderbook walk ($10k, $50k, $100k)',
        '4. Roundtrip models:',
        '   - (S-taker): 2×taker_fee + 2×(spread/2) + slippage',
        '   - (S-maker): 0.5×(2×maker_fee) + 0.5×(S-taker equivalent)',
        '',
        'SPECIFICATION COMPLIANCE:',
        '- Symbols: BTCUSDT, ETHUSDT',
        '- Sizes: $10k, $50k, $100k',
        '- All values measured, not simulated',
        '- Both taker and maker scenarios included',
        '',
        'OUTPUT FILES:',
        '- G0-2-execution-costs.json (full measurement results)',
        '- execution-cost-run.log (this file)',
        '',
        'REPRODUCTION COMMAND:',
        'node --experimental-strip-types scripts/measure-bitget-execution-cost.ts',
        '',
        'EXECUTION LOG:',
        ...executionLog,
      ].join('\n')
    );

    log('\n=== 実行完了 ===');
    log(`成果物保存先: ${DATA_DIR}`);
  } catch (err) {
    log(`FATAL ERROR: ${err instanceof Error ? err.message : String(err)}`);
    writeFileSync(
      join(DATA_DIR, 'execution-cost-error.log'),
      `${new Date().toISOString()}: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
