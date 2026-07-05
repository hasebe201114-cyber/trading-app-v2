/**
 * EXP-OBS000031 Stage 1-A: 予測単位（短期平均回帰の有意性検証）
 *
 * 1h終値のz-scoreフェード信号による非オーバーラップのトレード列について、
 * グロス往復リターン、hitRate、Sharpe、permutation p値を測定する。
 *
 * パラメータ（全ハードコード・変更禁止）:
 * - K = 3（形成ルックバック本数）
 * - W = 168（ボラティリティ正規化窓=168時間・先読み排除）
 * - Z_enter = 2.0（|z|>2.0でフェード・z>+2.0→SHORT, z<-2.0→LONG）
 * - N = 3（保有本数・時間イグジット）
 * - 非オーバーラップ: t+N まで新規エントリー禁止
 * - 等ノーション $50,000
 *
 * 期間分割:
 * - 選定: 2019-08-10 00:00 UTC ~ 2021-12-31 23:59 UTC
 * - 確認: 2022-01-01 00:00 UTC ~ データ末尾
 *   - R-bear: 2022-01-01 ~ 2022-12-31
 *   - R-recovery: 2023-01-01 ~ 2023-12-31
 *   - R-recent: 2024-01-01 ~ 末尾
 *   - 前半/後半: 確認期間の中央で2分割
 *
 * 出力: トレード数・hitRate・平均グロス往復リターン(bps)・グロス年率Sharpe・permutation p値
 *
 * Permutation検定: N_PERM=5000, seed=20260705, リターン系列そのものをシャッフル
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'research', 'EXP-OBS000031', '10-result');
mkdirSync(DATA_DIR, { recursive: true });

// ===== Spec Constants =====
const K = 3;                    // 形成ルックバック本数
const W = 168;                  // ボラティリティ正規化窓（時間）
const Z_ENTER = 2.0;           // エントリー閾値
const N = 3;                    // 保有本数（時間）
const NOTIONAL = 50_000;        // 等ノーション（$）
const N_PERM = 5000;           // Permutation回数
const PERM_SEED = 20260705;    // Permutation seed

// 期間境界（UTC milliseconds）
const SELECTION_START = new Date('2019-08-10T00:00:00Z').getTime();
const SELECTION_END = new Date('2021-12-31T23:59:59Z').getTime();
const CONFIRMATION_START = new Date('2022-01-01T00:00:00Z').getTime();

// レジーム期間
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
  entryClose: number;
  position: number; // +1 LONG, -1 SHORT
  exitIndex: number;
  exitTimestamp: number;
  exitClose: number;
  grossReturn: number; // (exitClose/entryClose - 1)
  grossReturnBps: number; // grossReturn * 10000
}

interface RobustnessResult {
  symbol: string;
  period: string;
  sampleCount: number;
  trades: Trade[];
  tradeCount: number;
  hitRate: number;
  avgGrossReturn: number;
  avgGrossReturnBps: number;
  sharpeAnnualized: number;
  permutationP: number;
  stdDev: number;
  minReturn: number;
  maxReturn: number;
}

/**
 * Seeded Random Number Generator (Linear Congruential Generator)
 */
class SeededRNG {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return (this.seed >>> 0) / 0x100000000;
  }
}

/**
 * Cumulative return over K bars from index t-K to t (inclusive)
 */
function calculateRK(closes: number[], t: number, k: number): number {
  if (t < k) return 0;
  return closes[t] / closes[t - k] - 1;
}

/**
 * Rolling standard deviation of RK, using data up to t-1
 */
function calculateSigmaK(closes: number[], t: number, k: number, w: number): number {
  if (t < w + k) return 0; // Not enough data

  const rks: number[] = [];
  for (let i = Math.max(0, t - w); i < t; i++) {
    rks.push(calculateRK(closes, i, k));
  }

  const mean = rks.reduce((a, b) => a + b, 0) / rks.length;
  const variance = rks.reduce((a, b) => a + (b - mean) ** 2, 0) / rks.length;
  return Math.sqrt(variance);
}

/**
 * Identify non-overlapping trades
 */
function identifyTrades(closes: number[], timestamps: number[], k: number, w: number, z_enter: number, n: number): Trade[] {
  const trades: Trade[] = [];
  let nextAvailableIndex = 0;

  for (let t = w + k; t < closes.length; t++) {
    if (t < nextAvailableIndex) continue; // Still in holding period

    const rk = calculateRK(closes, t, k);
    const sigma = calculateSigmaK(closes, t, k, w);

    if (sigma === 0) continue;

    const z = rk / sigma;

    let position = 0;
    if (z > z_enter) position = -1;      // SHORT
    else if (z < -z_enter) position = +1; // LONG

    if (position === 0) continue;

    // Entry
    const exitIndex = Math.min(t + n, closes.length - 1);
    const grossReturn = (closes[exitIndex] / closes[t] - 1) * position;

    trades.push({
      entryIndex: t,
      entryTimestamp: timestamps[t],
      entryClose: closes[t],
      position,
      exitIndex,
      exitTimestamp: timestamps[exitIndex],
      exitClose: closes[exitIndex],
      grossReturn,
      grossReturnBps: grossReturn * 10000,
    });

    nextAvailableIndex = exitIndex + 1;
  }

  return trades;
}

/**
 * Calculate statistics for trades
 */
function calculateStatistics(trades: Trade[]): {
  tradeCount: number;
  hitRate: number;
  avgReturn: number;
  avgGrossReturnBps: number;
  sharpeAnnualized: number;
  stdDev: number;
  minReturn: number;
  maxReturn: number;
} {
  if (trades.length === 0) {
    return {
      tradeCount: 0,
      hitRate: 0,
      avgReturn: 0,
      avgGrossReturnBps: 0,
      sharpeAnnualized: 0,
      stdDev: 0,
      minReturn: 0,
      maxReturn: 0,
    };
  }

  const returns = trades.map(t => t.grossReturn);
  const hits = returns.filter(r => r > 0).length;
  const hitRate = hits / trades.length;
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

  const variance = returns.reduce((a, b) => a + (b - avgReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);

  // Annualized Sharpe (assuming ~8760 1h bars per year)
  const sharpeAnnualized = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(8760) : 0;

  const minReturn = Math.min(...returns);
  const maxReturn = Math.max(...returns);

  return {
    tradeCount: trades.length,
    hitRate,
    avgReturn,
    avgGrossReturnBps: avgReturn * 10000,
    sharpeAnnualized,
    stdDev,
    minReturn,
    maxReturn,
  };
}

/**
 * Permutation test: shuffle trade returns, recalculate mean, find p-value
 */
function permutationTest(trades: Trade[], nPerm: number, seed: number): number {
  if (trades.length === 0) return 1.0;

  const realReturns = trades.map(t => t.grossReturn);
  const realMean = realReturns.reduce((a, b) => a + b, 0) / realReturns.length;

  let countExtremeOrMore = 0;
  const rng = new SeededRNG(seed);

  for (let perm = 0; perm < nPerm; perm++) {
    // Fisher-Yates shuffle
    const permReturns = [...realReturns];
    for (let i = permReturns.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [permReturns[i], permReturns[j]] = [permReturns[j], permReturns[i]];
    }

    const permMean = permReturns.reduce((a, b) => a + b, 0) / permReturns.length;
    if (Math.abs(permMean) >= Math.abs(realMean)) {
      countExtremeOrMore++;
    }
  }

  return (countExtremeOrMore + 1) / (nPerm + 1);
}

/**
 * Filter trades by period
 */
function filterTradesByPeriod(trades: Trade[], startTs: number, endTs: number): Trade[] {
  return trades.filter(t => t.entryTimestamp >= startTs && t.entryTimestamp <= endTs);
}

/**
 * Process one symbol
 */
async function processSymbol(symbol: string): Promise<RobustnessResult[]> {
  const filename = `${symbol}_1h.json`;
  const filepath = join(DATA_DIR, filename);

  const rawData = readFileSync(filepath, 'utf8');
  const data = JSON.parse(rawData) as {
    candles: Candle[];
  };

  const candles = data.candles.sort((a, b) => a.timestamp - b.timestamp);
  const closes = candles.map(c => parseFloat(c.close));
  const timestamps = candles.map(c => c.timestamp);

  console.log(`[${symbol}] Loaded ${candles.length} candles`);

  // Identify all trades (no period restriction)
  const allTrades = identifyTrades(closes, timestamps, K, W, Z_ENTER, N);
  console.log(`[${symbol}] Identified ${allTrades.length} total trades`);

  const results: RobustnessResult[] = [];

  // Period definitions
  const periods: Array<{
    name: string;
    startTs: number;
    endTs: number;
  }> = [
    { name: 'selection', startTs: SELECTION_START, endTs: SELECTION_END },
    { name: 'confirmation', startTs: CONFIRMATION_START, endTs: timestamps[timestamps.length - 1] },
    { name: 'confirmation_first_half', startTs: CONFIRMATION_START, endTs: CONFIRMATION_START + (timestamps[timestamps.length - 1] - CONFIRMATION_START) / 2 },
    { name: 'confirmation_second_half', startTs: CONFIRMATION_START + (timestamps[timestamps.length - 1] - CONFIRMATION_START) / 2, endTs: timestamps[timestamps.length - 1] },
    { name: 'R-bear', startTs: R_BEAR_START, endTs: R_BEAR_END },
    { name: 'R-recovery', startTs: R_RECOVERY_START, endTs: R_RECOVERY_END },
    { name: 'R-recent', startTs: R_RECENT_START, endTs: timestamps[timestamps.length - 1] },
  ];

  for (const period of periods) {
    const periodTrades = filterTradesByPeriod(allTrades, period.startTs, period.endTs);
    const stats = calculateStatistics(periodTrades);

    let permP = 1.0;
    if (periodTrades.length >= 5) {
      permP = permutationTest(periodTrades, N_PERM, PERM_SEED);
    }

    results.push({
      symbol,
      period: period.name,
      sampleCount: candles.filter(c => c.timestamp >= period.startTs && c.timestamp <= period.endTs).length,
      trades: periodTrades,
      ...stats,
      permutationP: permP,
    });

    console.log(`[${symbol} ${period.name}] n=${stats.tradeCount}, hitRate=${stats.hitRate.toFixed(3)}, avgBps=${stats.avgGrossReturnBps.toFixed(1)}, Sharpe=${stats.sharpeAnnualized.toFixed(3)}, permP=${permP.toFixed(4)}`);
  }

  return results;
}

async function main(): Promise<void> {
  const startTime = new Date().toISOString();
  console.log(`\n=== EXP-OBS000031 Stage 1-A: Prediction Unit (1h Mean Reversion) ===`);
  console.log(`Start: ${startTime}`);
  console.log(`Node: ${process.version}`);
  console.log(`Specification:`);
  console.log(`  K=${K}, W=${W}, Z_enter=${Z_ENTER}, N=${N}, Notional=${NOTIONAL}`);
  console.log(`  Selection: ${new Date(SELECTION_START).toISOString().split('T')[0]} ~ ${new Date(SELECTION_END).toISOString().split('T')[0]}`);
  console.log(`  Confirmation: ${new Date(CONFIRMATION_START).toISOString().split('T')[0]} ~ data end`);
  console.log(`  Permutation: N=${N_PERM}, seed=${PERM_SEED}`);

  try {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const allResults: RobustnessResult[] = [];

    for (const symbol of symbols) {
      const results = await processSymbol(symbol);
      allResults.push(...results);
    }

    // Output JSON with all metrics
    const outputData = {
      timestamp: startTime,
      specification: {
        K,
        W,
        Z_enter: Z_ENTER,
        N,
        notional: NOTIONAL,
        selection_start: new Date(SELECTION_START).toISOString(),
        selection_end: new Date(SELECTION_END).toISOString(),
        confirmation_start: new Date(CONFIRMATION_START).toISOString(),
        permutation_n: N_PERM,
        permutation_seed: PERM_SEED,
      },
      results: allResults.map(r => ({
        symbol: r.symbol,
        period: r.period,
        sampleCount: r.sampleCount,
        tradeCount: r.tradeCount,
        hitRate: r.hitRate,
        avgGrossReturnBps: r.avgGrossReturnBps,
        sharpeAnnualized: r.sharpeAnnualized,
        permutationP: r.permutationP,
        stdDev: r.stdDev,
        minReturn: r.minReturn,
        maxReturn: r.maxReturn,
      })),
    };

    const outputPath = join(DATA_DIR, 'stage1-prediction-unit.json');
    writeFileSync(outputPath, JSON.stringify(outputData, null, 2));
    console.log(`\n✓ Saved: ${outputPath}`);

    // Execution log
    const logPath = join(DATA_DIR, 'stage1-prediction-unit-run.log');
    writeFileSync(logPath, [
      '=== EXP-OBS000031 Stage 1-A: Prediction Unit ===',
      `Timestamp: ${startTime}`,
      `Node: ${process.version}`,
      '',
      'SPECIFICATION:',
      `K=${K}, W=${W}, Z_enter=${Z_ENTER}, N=${N}`,
      `Notional: $${NOTIONAL}`,
      `Selection: 2019-08-10 ~ 2021-12-31`,
      `Confirmation: 2022-01-01 ~ data end`,
      `Permutation: N=${N_PERM}, seed=${PERM_SEED}`,
      '',
      'REPRODUCTION:',
      'node --experimental-strip-types scripts/intraday-meanrev-robustness.ts',
      '',
      'INPUT FILES:',
      'BTCUSDT_1h.json (60935 candles)',
      'ETHUSDT_1h.json (60199 candles)',
      '',
      'OUTPUT:',
      `stage1-prediction-unit.json (results)`,
    ].join('\n'));

    console.log(`✓ Saved: ${logPath}`);
    console.log('\n=== Complete ===');
  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled:', err);
  process.exit(1);
});
