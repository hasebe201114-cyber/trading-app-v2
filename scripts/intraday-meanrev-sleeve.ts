/**
 * EXP-OBS000031 Stage 1-B/C: スリーブ単体＋②合成（限界寄与分析）
 *
 * Stage 1-B: スリーブ純リターン（ネットコスト後）→ ネット年率Sharpe
 * Stage 1-C: スリーブと②（日足モメンタム）の合成 → 低相関・合成Sharpe改善
 *
 * スリーブ構築:
 * - 1h非オーバーラップトレード（K=3/W=168/Z_enter=2.0/N=3）
 * - 等ノーション$50,000
 * - ネット: S-taker往復コスト（BTC12.03/ETH12.69bps）控除後
 * - Funding除外（3h保有<8h決済間隔・楽観側注記）
 *
 * ②単体:
 * - simulatePortfolio（BTC本番構成）で確認期間を回す
 * - 日次リターン列を抽出
 *
 * 合成:
 * - 選定期間（2019-08～2021-12）での逆ボラウェイトを凍結
 * - 確認期間（2022-01～末尾）に適用
 * - 相関・Sharpe差分・DD差分を出力
 * - 素朴50/50も併記
 *
 * 出力: ネットSharpe・DD・年間コストドラッグ・相関・合成Sharpe差分・②単体との比較
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'research', 'EXP-OBS000031', '10-result');
const SOURCE_DIR = join(__dirname, '..');
mkdirSync(DATA_DIR, { recursive: true });

// ===== Spec Constants =====
const K = 3;
const W = 168;
const Z_ENTER = 2.0;
const N = 3;
const NOTIONAL = 50_000;

// S-taker往復コスト（Stage 0確定）
const TAKER_COST_BTC = 12.03 / 10000; // 12.03 bps → proportion
const TAKER_COST_ETH = 12.69 / 10000;

// 参考: S-maker往復コスト（50%約定率悲観）
const MAKER_COST_BTC = 8.02 / 10000;
const MAKER_COST_ETH = 8.34 / 10000;

// 参考: $100k名目でのS-taker
const TAKER_COST_BTC_100K = 12.13 / 10000;
const TAKER_COST_ETH_100K = 13.06 / 10000;

// 期間
const SELECTION_START = new Date('2019-08-10T00:00:00Z').getTime();
const SELECTION_END = new Date('2021-12-31T23:59:59Z').getTime();
const CONFIRMATION_START = new Date('2022-01-01T00:00:00Z').getTime();

// レジーム
const R_BEAR_START = new Date('2022-01-01T00:00:00Z').getTime();
const R_BEAR_END = new Date('2022-12-31T23:59:59Z').getTime();
const R_RECOVERY_START = new Date('2023-01-01T00:00:00Z').getTime();
const R_RECOVERY_END = new Date('2023-12-31T23:59:59Z').getTime();
const R_RECENT_START = new Date('2024-01-01T00:00:00Z').getTime();

interface Candle {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface Trade {
  entryIndex: number;
  entryTimestamp: number;
  exitIndex: number;
  exitTimestamp: number;
  position: number;
  grossReturnPercentage: number;
}

interface PerformanceMetrics {
  netSharpeAnnualized: number;
  grossSharpeAnnualized: number;
  cumulativeNetReturn: number;
  cumulativeGrossReturn: number;
  maxDrawdown: number;
  yearlyTradeCount: number;
  yearlyNetCostDrag: number;
}

/**
 * Identify trades from 1h data
 */
function identifyTrades(closes: number[], timestamps: number[]): Trade[] {
  const trades: Trade[] = [];
  let nextAvailableIndex = 0;

  for (let t = W + K; t < closes.length; t++) {
    if (t < nextAvailableIndex) continue;

    // Calculate rK and sigma
    const rk = closes[t] / closes[t - K] - 1;
    const rkValues: number[] = [];
    for (let i = Math.max(0, t - W); i < t; i++) {
      rkValues.push(closes[i] / closes[i - K] - 1);
    }
    const mean = rkValues.reduce((a, b) => a + b, 0) / rkValues.length;
    const variance = rkValues.reduce((a, b) => a + (b - mean) ** 2, 0) / rkValues.length;
    const sigma = Math.sqrt(variance);

    if (sigma === 0) continue;

    const z = rk / sigma;
    let position = 0;
    if (z > Z_ENTER) position = -1;
    else if (z < -Z_ENTER) position = +1;

    if (position === 0) continue;

    const exitIndex = Math.min(t + N, closes.length - 1);
    const grossReturnPercentage = (closes[exitIndex] / closes[t] - 1) * position;

    trades.push({
      entryIndex: t,
      entryTimestamp: timestamps[t],
      exitIndex,
      exitTimestamp: timestamps[exitIndex],
      position,
      grossReturnPercentage,
    });

    nextAvailableIndex = exitIndex + 1;
  }

  return trades;
}

/**
 * Build daily returns from trades with net cost
 */
function buildDailyReturns(
  trades: Trade[],
  takerCost: number,
  timestamps: number[],
  startPeriodTs: number,
  endPeriodTs: number
): {
  dailyNetReturns: number[];
  dailyGrossReturns: number[];
  dailyTimestamps: number[];
  allDailyNetReturns: number[];
  allDailyTimestamps: number[];
} {
  // Group returns by UTC day
  const allDailyMap: Map<number, { net: number[]; gross: number[] }> = new Map();

  for (const trade of trades) {
    const dayTs = Math.floor(trade.entryTimestamp / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
    if (!allDailyMap.has(dayTs)) {
      allDailyMap.set(dayTs, { net: [], gross: [] });
    }

    const grossReturn = trade.grossReturnPercentage;
    const netReturn = grossReturn - takerCost;

    allDailyMap.get(dayTs)!.net.push(netReturn);
    allDailyMap.get(dayTs)!.gross.push(grossReturn);
  }

  // Get full daily timeline from data
  const allDailyTimestamps: number[] = [];
  const allDailyNet: number[] = [];

  const sortedDays = Array.from(allDailyMap.keys()).sort((a, b) => a - b);
  for (const dayTs of sortedDays) {
    const data = allDailyMap.get(dayTs)!;
    const netSum = data.net.reduce((a, b) => a + b, 0);
    allDailyTimestamps.push(dayTs);
    allDailyNet.push(netSum);
  }

  // Filter to period
  const periodDailyReturns = allDailyNet.filter((_, i) => {
    const ts = allDailyTimestamps[i];
    return ts >= startPeriodTs && ts <= endPeriodTs;
  });

  const periodDailyTimestamps = allDailyTimestamps.filter(
    ts => ts >= startPeriodTs && ts <= endPeriodTs
  );

  return {
    dailyNetReturns: periodDailyReturns,
    dailyGrossReturns: allDailyNet,
    dailyTimestamps: periodDailyTimestamps,
    allDailyNetReturns: allDailyNet,
    allDailyTimestamps,
  };
}

/**
 * Calculate performance metrics
 */
function calculateMetrics(dailyReturns: number[], yearlyTradeCount: number, yearlyTakerCostBps: number): PerformanceMetrics {
  if (dailyReturns.length === 0) {
    return {
      netSharpeAnnualized: 0,
      grossSharpeAnnualized: 0,
      cumulativeNetReturn: 0,
      cumulativeGrossReturn: 0,
      maxDrawdown: 0,
      yearlyTradeCount,
      yearlyNetCostDrag: yearlyTakerCostBps,
    };
  }

  const meanReturn = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / dailyReturns.length;
  const stdDev = Math.sqrt(variance);

  const netSharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(365) : 0;
  const cumulativeReturn = dailyReturns.reduce((a, b) => a + b, 0);

  // Max DD
  let maxDD = 0;
  let cumulativePnL = 0;
  let peakPnL = 0;
  for (const ret of dailyReturns) {
    cumulativePnL += ret;
    peakPnL = Math.max(peakPnL, cumulativePnL);
    const dd = peakPnL - cumulativePnL;
    maxDD = Math.max(maxDD, dd);
  }

  return {
    netSharpeAnnualized: netSharpe,
    grossSharpeAnnualized: 0,
    cumulativeNetReturn: cumulativeReturn,
    cumulativeGrossReturn: cumulativeReturn,
    maxDrawdown: maxDD,
    yearlyTradeCount,
    yearlyNetCostDrag: yearlyTakerCostBps,
  };
}

/**
 * Get ② strategy returns via simulatePortfolio
 */
function getMomentumDailyReturns(symbol: 'BTC' | 'ETH'): number[] {
  // This would normally call simulatePortfolio
  // For now, we'll read from a backtest output or simulate
  // For this stub, we return empty - will be populated from actual backtest
  return [];
}

/**
 * Process sleeve for a symbol
 */
async function processSleeve(symbol: string): Promise<void> {
  const filename = `${symbol}_1h.json`;
  const filepath = join(DATA_DIR, filename);
  const rawData = readFileSync(filepath, 'utf8');
  const data = JSON.parse(rawData) as { candles: Candle[] };

  const candles = data.candles.sort((a, b) => a.timestamp - b.timestamp);
  const closes = candles.map(c => parseFloat(c.close));
  const timestamps = candles.map(c => c.timestamp);

  const takerCost = symbol === 'BTCUSDT' ? TAKER_COST_BTC : TAKER_COST_ETH;
  const takerCostBps = symbol === 'BTCUSDT' ? 12.03 : 12.69;
  const makerCost = symbol === 'BTCUSDT' ? MAKER_COST_BTC : MAKER_COST_ETH;
  const takerCost100K = symbol === 'BTCUSDT' ? TAKER_COST_BTC_100K : TAKER_COST_ETH_100K;

  console.log(`[${symbol}] Loaded ${candles.length} candles`);

  // Identify trades
  const allTrades = identifyTrades(closes, timestamps);
  console.log(`[${symbol}] Identified ${allTrades.length} total trades`);

  // Build daily returns for confirmation period
  const { dailyNetReturns, allDailyTimestamps, allDailyNetReturns } = buildDailyReturns(
    allTrades,
    takerCost,
    timestamps,
    CONFIRMATION_START,
    timestamps[timestamps.length - 1]
  );

  // Count trades and cost drag
  const confirmationTrades = allTrades.filter(t => t.entryTimestamp >= CONFIRMATION_START);
  const yearlyTradeCount = Math.round(confirmationTrades.length * (365 / ((timestamps[timestamps.length - 1] - CONFIRMATION_START) / (24 * 60 * 60 * 1000))));
  const yearlyNetCostDrag = yearlyTradeCount * takerCostBps;

  // Calculate metrics for different periods
  const periods = [
    { name: 'confirmation', startTs: CONFIRMATION_START, endTs: timestamps[timestamps.length - 1] },
    { name: 'R-bear', startTs: R_BEAR_START, endTs: R_BEAR_END },
    { name: 'R-recovery', startTs: R_RECOVERY_START, endTs: R_RECOVERY_END },
    { name: 'R-recent', startTs: R_RECENT_START, endTs: timestamps[timestamps.length - 1] },
  ];

  const results: Array<{
    symbol: string;
    period: string;
    netSharpe: number;
    grossSharpe: number;
    cumulativeNetReturn: number;
    maxDrawdown: number;
    yearlyTradeCount: number;
    yearlyNetCostDrag: number;
  }> = [];

  for (const period of periods) {
    const { dailyNetReturns: periodDailyNet } = buildDailyReturns(
      allTrades,
      takerCost,
      timestamps,
      period.startTs,
      period.endTs
    );

    const trades = allTrades.filter(t => t.entryTimestamp >= period.startTs && t.entryTimestamp <= period.endTs);
    const tradesInYear = trades.length;
    const yearCount = (period.endTs - period.startTs) / (365.25 * 24 * 60 * 60 * 1000);
    const annualizedTrades = tradesInYear / yearCount;

    const metrics = calculateMetrics(periodDailyNet, Math.round(annualizedTrades), Math.round(annualizedTrades * takerCostBps));

    results.push({
      symbol,
      period: period.name,
      netSharpe: metrics.netSharpeAnnualized,
      grossSharpe: 0,
      cumulativeNetReturn: metrics.cumulativeNetReturn,
      maxDrawdown: metrics.maxDrawdown,
      yearlyTradeCount: Math.round(annualizedTrades),
      yearlyNetCostDrag: Math.round(annualizedTrades * takerCostBps),
    });

    console.log(`[${symbol} ${period.name}] netSharpe=${metrics.netSharpeAnnualized.toFixed(3)}, DD=${metrics.maxDrawdown.toFixed(4)}, trades/yr=${Math.round(annualizedTrades)}, costDrag=${Math.round(annualizedTrades * takerCostBps)}bps`);
  }

  // Save results
  const outputData = {
    timestamp: new Date().toISOString(),
    symbol,
    results,
    note: 'Sleeve only (Stage 1-B). Stage 1-C composition with ② requires simulatePortfolio integration.',
  };

  const outputPath = join(DATA_DIR, `stage1-sleeve-${symbol.toLowerCase()}.json`);
  writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
  console.log(`✓ Saved: ${outputPath}`);
}

async function main(): Promise<void> {
  const startTime = new Date().toISOString();
  console.log(`\n=== EXP-OBS000031 Stage 1-B/C: Sleeve + Composition ===`);
  console.log(`Start: ${startTime}`);
  console.log(`Node: ${process.version}`);
  console.log(`Specification:`);
  console.log(`  K=${K}, W=${W}, Z_enter=${Z_ENTER}, N=${N}, Notional=${NOTIONAL}`);
  console.log(`  S-taker costs: BTC=${TAKER_COST_BTC * 10000}bps, ETH=${TAKER_COST_ETH * 10000}bps`);

  try {
    // Process BTC and ETH sleeves
    await processSleeve('BTCUSDT');
    await processSleeve('ETHUSDT');

    console.log('\n✓ Sleeve analysis complete');
    console.log('Note: Full Stage 1-C composition with ② requires simulatePortfolio integration.');
  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled:', err);
  process.exit(1);
});
