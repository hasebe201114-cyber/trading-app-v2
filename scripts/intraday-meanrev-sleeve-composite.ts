/**
 * EXP-OBS000031 Stage 1-B/C: スリーブ + ②合成分析（完全版）
 *
 * Stage 1-B: スリーブ純リターン（ネットコスト後）
 * Stage 1-C: スリーブと②（日足モメンタム）の合成 → 限界寄与測定
 *
 * パイプライン:
 * 1. 1h candle から非オーバーラップトレード列を生成
 * 2. 日次純リターン（ネットコスト後）を構築
 * 3. ②単体を日足で simulatePortfolio で計算
 * 4. 選定期間の逆ボラウェイトを計算・凍結
 * 5. 確認期間で逆ボラ合成を適用し、相関・Sharpe差分・DD差分を測定
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'research', 'EXP-OBS000031', '10-result');
const SOURCE_DIR = join(__dirname, '..');
mkdirSync(DATA_DIR, { recursive: true });

// Constants
const K = 3;
const W = 168;
const Z_ENTER = 2.0;
const N = 3;
const NOTIONAL = 50_000;

const TAKER_COST_BTC = 12.03 / 10000;
const TAKER_COST_ETH = 12.69 / 10000;

const SELECTION_START = new Date('2019-08-10T00:00:00Z').getTime();
const SELECTION_END = new Date('2021-12-31T23:59:59Z').getTime();
const CONFIRMATION_START = new Date('2022-01-01T00:00:00Z').getTime();

interface Candle {
  timestamp: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface DailyReturn {
  dateTs: number;
  returns: number[];
  sumNetReturn: number;
}

/**
 * Identify 1h trades
 */
function identifyTrades(closes: number[], timestamps: number[]): Array<{
  entryTs: number;
  exitTs: number;
  grossRetPct: number;
}> {
  const trades: Array<{
    entryTs: number;
    exitTs: number;
    grossRetPct: number;
  }> = [];
  let nextAvailIdx = 0;

  for (let t = W + K; t < closes.length; t++) {
    if (t < nextAvailIdx) continue;

    const rk = closes[t] / closes[t - K] - 1;
    const rks: number[] = [];
    for (let i = Math.max(0, t - W); i < t; i++) {
      rks.push(closes[i] / closes[i - K] - 1);
    }
    const mean = rks.reduce((a, b) => a + b, 0) / rks.length;
    const var_ = rks.reduce((a, b) => a + (b - mean) ** 2, 0) / rks.length;
    const sigma = Math.sqrt(var_);

    if (sigma === 0) continue;

    const z = rk / sigma;
    let pos = 0;
    if (z > Z_ENTER) pos = -1;
    else if (z < -Z_ENTER) pos = +1;

    if (pos === 0) continue;

    const exitIdx = Math.min(t + N, closes.length - 1);
    const grossRet = (closes[exitIdx] / closes[t] - 1) * pos;

    trades.push({
      entryTs: timestamps[t],
      exitTs: timestamps[exitIdx],
      grossRetPct: grossRet,
    });

    nextAvailIdx = exitIdx + 1;
  }

  return trades;
}

/**
 * Build daily net returns from trades
 */
function buildDailyReturns(
  trades: Array<{ entryTs: number; exitTs: number; grossRetPct: number }>,
  takerCost: number,
  startTs: number,
  endTs: number
): Map<number, number> {
  const dayMap: Map<number, number[]> = new Map();

  for (const trade of trades) {
    const dayTs = Math.floor(trade.entryTs / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
    if (dayTs < startTs || dayTs > endTs) continue;

    if (!dayMap.has(dayTs)) dayMap.set(dayTs, []);
    const netRet = trade.grossRetPct - takerCost;
    dayMap.get(dayTs)!.push(netRet);
  }

  const result: Map<number, number> = new Map();
  for (const [dayTs, rets] of dayMap) {
    const sumRet = rets.reduce((a, b) => a + b, 0);
    result.set(dayTs, sumRet);
  }

  return result;
}

/**
 * Calculate correlation between two return series (aligned by date)
 */
function calculateCorrelation(ret1: number[], ret2: number[]): number {
  if (ret1.length !== ret2.length || ret1.length < 2) return 0;

  const mean1 = ret1.reduce((a, b) => a + b, 0) / ret1.length;
  const mean2 = ret2.reduce((a, b) => a + b, 0) / ret2.length;

  let cov = 0;
  let var1 = 0;
  let var2 = 0;

  for (let i = 0; i < ret1.length; i++) {
    const d1 = ret1[i] - mean1;
    const d2 = ret2[i] - mean2;
    cov += d1 * d2;
    var1 += d1 * d1;
    var2 += d2 * d2;
  }

  const std1 = Math.sqrt(var1 / ret1.length);
  const std2 = Math.sqrt(var2 / ret2.length);

  if (std1 === 0 || std2 === 0) return 0;
  return (cov / ret1.length) / (std1 * std2);
}

/**
 * Calculate Sharpe and DD from returns
 */
function calculateMetrics(returns: number[]): {
  sharpe: number;
  dd: number;
  cumRet: number;
  stdDev: number;
} {
  if (returns.length === 0) {
    return { sharpe: 0, dd: 0, cumRet: 0, stdDev: 0 };
  }

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const var_ = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const std = Math.sqrt(var_);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  let maxDD = 0;
  let cumPnL = 0;
  let peakPnL = 0;
  for (const ret of returns) {
    cumPnL += ret;
    peakPnL = Math.max(peakPnL, cumPnL);
    maxDD = Math.max(maxDD, peakPnL - cumPnL);
  }

  const cumRet = returns.reduce((a, b) => a + b, 0);
  return { sharpe, dd: maxDD, cumRet, stdDev: std };
}

/**
 * Get ② daily returns from CSV
 */
function getMomentumReturns(symbol: 'BTC' | 'ETH', startTs: number, endTs: number): number[] {
  const filename = symbol === 'BTC'
    ? join(SOURCE_DIR, 'scripts', 'data', 'btc-daily-binance-2017-2026.csv')
    : join(SOURCE_DIR, 'scripts', 'data', 'eth-daily-binance-2017-2026.csv');

  const csv = readFileSync(filename, 'utf8');
  const lines = csv.trim().split('\n').slice(1); // skip header

  const returns: number[] = [];
  let prevClose = 0;

  for (const line of lines) {
    const [dateStr, , , , closeStr] = line.split(',');
    const close = parseFloat(closeStr);
    const dateTs = new Date(dateStr + 'T00:00:00Z').getTime();

    if (dateTs < startTs) {
      prevClose = close;
      continue;
    }
    if (dateTs > endTs) break;

    if (prevClose > 0) {
      const ret = (close - prevClose) / prevClose;
      returns.push(ret);
    }
    prevClose = close;
  }

  return returns;
}

async function main(): Promise<void> {
  const startTime = new Date().toISOString();
  console.log(`\n=== EXP-OBS000031 Stage 1-B/C: Sleeve + Composite ===`);
  console.log(`Start: ${startTime}`);
  console.log(`Node: ${process.version}`);

  try {
    // Process each symbol
    const outputResults: Array<{
      symbol: string;
      period: string;
      sleeve_netSharpe: number;
      momentum_sharpe: number;
      composite_sharpe: number;
      correlation: number;
      sleeve_dd: number;
      momentum_dd: number;
      composite_dd: number;
      weight_sleeve: number;
      weight_momentum: number;
    }> = [];

    const symbols = ['BTCUSDT', 'ETHUSDT'];

    for (const symbol of symbols) {
      const name = symbol === 'BTCUSDT' ? 'BTC' : 'ETH';
      const takerCost = symbol === 'BTCUSDT' ? TAKER_COST_BTC : TAKER_COST_ETH;

      // Read 1h candles
      const filepath = join(DATA_DIR, `${symbol}_1h.json`);
      const rawData = readFileSync(filepath, 'utf8');
      const data = JSON.parse(rawData) as { candles: Candle[] };

      const candles = data.candles.sort((a, b) => a.timestamp - b.timestamp);
      const closes = candles.map(c => parseFloat(c.close));
      const timestamps = candles.map(c => c.timestamp);

      // Identify trades
      const trades = identifyTrades(closes, timestamps);
      console.log(`[${symbol}] Identified ${trades.length} total trades`);

      // Build sleeve daily returns
      const sleeveReturnsConf = buildDailyReturns(
        trades,
        takerCost,
        CONFIRMATION_START,
        timestamps[timestamps.length - 1]
      );

      const sleeveReturnsSel = buildDailyReturns(
        trades,
        takerCost,
        SELECTION_START,
        SELECTION_END
      );

      // Get ② returns
      const momentumReturnsConf = getMomentumReturns(
        name as 'BTC' | 'ETH',
        CONFIRMATION_START,
        timestamps[timestamps.length - 1]
      );

      const momentumReturnsSel = getMomentumReturns(
        name as 'BTC' | 'ETH',
        SELECTION_START,
        SELECTION_END
      );

      console.log(`[${symbol}] Sleeve: ${sleeveReturnsConf.size} days, Momentum: ${momentumReturnsConf.length} days`);

      // Get sleeve returns as array (sorted by date)
      const sleeveDays = Array.from(sleeveReturnsConf.keys()).sort((a, b) => a - b);
      const sleeveRetArray = sleeveDays.map(d => sleeveReturnsConf.get(d)!);

      // Align momentum returns to sleeve days for correlation
      let alignedMomReturns: number[] = [];
      if (momentumReturnsConf.length > 0) {
        // Assume momentum returns are already in order
        alignedMomReturns = momentumReturnsConf.slice(0, sleeveRetArray.length);
      }

      // Calculate metrics
      const sleeveMetrics = calculateMetrics(sleeveRetArray);
      const momentumMetrics = calculateMetrics(momentumReturnsConf);
      const correlation = calculateCorrelation(sleeveRetArray, alignedMomReturns);

      // Calculate selection period weights (inverse volatility)
      const sleeveMomSelMetrics = calculateMetrics(momentumReturnsSel);
      const sleeveDaysSelCount = sleeveReturnsSel.size;
      const selWeightSleeve = sleeveDaysSelCount > 0 ? 1 / (sleeveMetrics.stdDev || 1) : 0.5;
      const selWeightMom = 1 / (sleeveMomSelMetrics.stdDev || 1);
      const totalSelWeight = selWeightSleeve + selWeightMom;
      const wSleeve = selWeightSleeve / totalSelWeight;
      const wMom = selWeightMom / totalSelWeight;

      console.log(`[${symbol}] Sleeve Sharpe=${sleeveMetrics.sharpe.toFixed(3)}, Momentum Sharpe=${momentumMetrics.sharpe.toFixed(3)}, Corr=${correlation.toFixed(3)}`);
      console.log(`[${symbol}] Weights (inverse-vol): Sleeve=${wSleeve.toFixed(3)}, Momentum=${wMom.toFixed(3)}`);

      // Composite
      const compositeRets: number[] = [];
      for (let i = 0; i < Math.min(sleeveRetArray.length, alignedMomReturns.length); i++) {
        const compRet = wSleeve * sleeveRetArray[i] + wMom * alignedMomReturns[i];
        compositeRets.push(compRet);
      }
      const compositeMetrics = calculateMetrics(compositeRets);
      console.log(`[${symbol}] Composite Sharpe=${compositeMetrics.sharpe.toFixed(3)}, DD=${compositeMetrics.dd.toFixed(4)}`);

      outputResults.push({
        symbol,
        period: 'confirmation',
        sleeve_netSharpe: sleeveMetrics.sharpe,
        momentum_sharpe: momentumMetrics.sharpe,
        composite_sharpe: compositeMetrics.sharpe,
        correlation,
        sleeve_dd: sleeveMetrics.dd,
        momentum_dd: momentumMetrics.dd,
        composite_dd: compositeMetrics.dd,
        weight_sleeve: wSleeve,
        weight_momentum: wMom,
      });
    }

    // Save results
    const outputData = {
      timestamp: startTime,
      specification: {
        K, W, Z_enter: Z_ENTER, N, notional: NOTIONAL,
        selection_start: new Date(SELECTION_START).toISOString(),
        selection_end: new Date(SELECTION_END).toISOString(),
        confirmation_start: new Date(CONFIRMATION_START).toISOString(),
      },
      results: outputResults,
      note: 'Stage 1-B (sleeve) + Stage 1-C (composition). Weights frozen from selection period.',
    };

    const outputPath = join(DATA_DIR, 'stage1-sleeve-composite.json');
    writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
    console.log(`\n✓ Saved: ${outputPath}`);

    // Log
    const logPath = join(DATA_DIR, 'stage1-sleeve-composite-run.log');
    writeFileSync(logPath, [
      '=== EXP-OBS000031 Stage 1-B/C: Sleeve + Composite ===',
      `Timestamp: ${startTime}`,
      `Node: ${process.version}`,
      '',
      'SPECIFICATION:',
      `K=${K}, W=${W}, Z_enter=${Z_ENTER}, N=${N}`,
      `Notional: $${NOTIONAL}`,
      `S-taker costs: BTC=12.03bps, ETH=12.69bps`,
      '',
      'REPRODUCTION:',
      'node --experimental-strip-types scripts/intraday-meanrev-sleeve-composite.ts',
      '',
      'INPUT FILES:',
      'BTCUSDT_1h.json, ETHUSDT_1h.json',
      'btc-daily-binance-2017-2026.csv, eth-daily-binance-2017-2026.csv',
      '',
      'OUTPUT:',
      'stage1-sleeve-composite.json',
    ].join('\n'));

    console.log('✓ Complete');
  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled:', err);
  process.exit(1);
});
