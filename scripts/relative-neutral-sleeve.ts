/**
 * BTC-ETH相対ニュートラル・スリーブ + ②合成の検証（EXP-OBS000029）
 *
 * Stage2: スリーブ単体（Fundingコスト込みSharpe）
 * Stage3: ②との合成（相関・改善ゲート）
 *
 * spec:
 * - スリーブ: ドルニュートラル、等ノーション、HORIZON=10日リバランス、Funding日次加算、実行コスト
 * - ②単体: 本番構成簡潔版（L=30, horizon=10, 単方向モメンタム・グロス）
 * - 合成: 選定期間(2019-09〜2022)の逆ボラウェイト凍結、確認期間(2023-2026)で適用
 *
 * 実行:
 *   node --experimental-strip-types scripts/relative-neutral-sleeve.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { loadDailyFundingRate } from './loadFundingRateData.ts';
import { DEFAULT_EXECUTION_COST } from '../src/execution-layer/types.ts';
import type { OHLCV } from '../src/types/market.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// spec値：固定・変更禁止
const HORIZON = 10;
const L = 30;
const NEUTRAL_THRESHOLD = 0.0005;
const EQUITY_INITIAL = 1_000_000;

const pctChange = (from: number, to: number): number => (to - from) / from;
const mean = (xs: number[]): number => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

const utcDateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * 日付範囲でのキャンドルインデックス範囲を取得
 */
function getDateRange(candles: OHLCV[], startDate?: string, endDate?: string): { start: number; end: number } {
  let start = 0;
  let end = candles.length - 1;

  if (startDate) {
    for (let i = 0; i < candles.length; i++) {
      if (utcDateOf(candles[i].time) >= startDate) {
        start = i;
        break;
      }
    }
  }

  if (endDate) {
    for (let i = candles.length - 1; i >= 0; i--) {
      if (utcDateOf(candles[i].time) <= endDate) {
        end = i;
        break;
      }
    }
  }

  return { start, end };
}

/**
 * スリーブ純リターン列（Funding＋実行コスト込み）を構築
 * ドルニュートラル、等ノーション、HORIZON=10
 */
function simulateSleeveReturns(
  candles_eth: OHLCV[],
  candles_btc: OHLCV[],
  fundingEth: Map<string, { fundingRateDaily: number }>,
  fundingBtc: Map<string, { fundingRateDaily: number }>,
  startIdx: number,
  endIdx: number,
): { returns: number[]; pnls: number[] } {
  const ONE_WAY_COST = DEFAULT_EXECUTION_COST.takerFeeRate + DEFAULT_EXECUTION_COST.slippageRate;
  const FLIP_COST = 4 * ONE_WAY_COST; // 2レッグ × 往復

  const returns: number[] = [];
  const pnls: number[] = [];
  let currentSignal = 0;

  for (let t = startIdx; t <= endIdx; t++) {
    if (t + HORIZON > candles_eth.length - 1) break;

    const daysInPos = (t - startIdx) % HORIZON;
    const isDecisionPoint = daysInPos === 0;

    if (isDecisionPoint) {
      if (t - L >= 0) {
        const ratio_past = candles_eth[t - L].close / candles_btc[t - L].close;
        const ratio_now = candles_eth[t].close / candles_btc[t].close;
        const momRatio = pctChange(ratio_past, ratio_now);
        currentSignal = momRatio > NEUTRAL_THRESHOLD ? 1 : momRatio < -NEUTRAL_THRESHOLD ? -1 : 0;
      }
    }

    if (currentSignal === 0) {
      returns.push(0);
      pnls.push(0);
      continue;
    }

    const r_eth = pctChange(candles_eth[t].close, candles_eth[t + 1].close);
    const r_btc = pctChange(candles_btc[t].close, candles_btc[t + 1].close);
    const spreadReturn = r_eth - r_btc;

    const dateStr = utcDateOf(candles_eth[t].time);
    const fundingEthDaily = fundingEth.get(dateStr)?.fundingRateDaily ?? 0;
    const fundingBtcDaily = fundingBtc.get(dateStr)?.fundingRateDaily ?? 0;
    const fundingPnl = -currentSignal * fundingEthDaily + currentSignal * fundingBtcDaily;

    let costToday = 0;
    if (isDecisionPoint && t > startIdx) {
      let prevSignal = 0;
      if (t - HORIZON >= startIdx && t - HORIZON - L >= 0) {
        const ratio_past_prev = candles_eth[t - HORIZON - L].close / candles_btc[t - HORIZON - L].close;
        const ratio_prev = candles_eth[t - HORIZON].close / candles_btc[t - HORIZON].close;
        const momRatioPrev = pctChange(ratio_past_prev, ratio_prev);
        prevSignal = momRatioPrev > NEUTRAL_THRESHOLD ? 1 : momRatioPrev < -NEUTRAL_THRESHOLD ? -1 : 0;
      }
      if (prevSignal !== currentSignal) {
        costToday = FLIP_COST;
      }
    }

    const grossReturn = spreadReturn + fundingPnl;
    const netReturn = grossReturn - costToday;
    returns.push(netReturn);
    pnls.push(netReturn * EQUITY_INITIAL);
  }

  return { returns, pnls };
}

/**
 * ②単体（BTC、本番構成の簡潔版）
 * 本番構成: L=30, horizon=10, グロス・単方向
 */
function simulateMomentumReturns(candles: OHLCV[], startIdx: number, endIdx: number): number[] {
  const returns: number[] = [];
  let currentSignal = 0;

  for (let t = startIdx; t <= endIdx; t++) {
    if (t + HORIZON > candles.length - 1) break;

    const daysInPos = (t - startIdx) % HORIZON;
    const isDecisionPoint = daysInPos === 0;

    if (isDecisionPoint) {
      if (t - L >= 0) {
        const momRet = pctChange(candles[t - L].close, candles[t].close);
        currentSignal = momRet > NEUTRAL_THRESHOLD ? 1 : momRet < -NEUTRAL_THRESHOLD ? -1 : 0;
      }
    }

    if (currentSignal === 0) {
      returns.push(0);
      continue;
    }

    const r = pctChange(candles[t].close, candles[t + 1].close);
    returns.push(currentSignal * r);
  }

  return returns;
}

/**
 * リターン列の統計
 */
function computeStats(returns: number[]): {
  n: number;
  sharpe: number;
  maxDD: number;
  totalReturn: number;
} {
  if (returns.length === 0) {
    return { n: 0, sharpe: 0, maxDD: 0, totalReturn: 0 };
  }

  const m = mean(returns);
  const s = std(returns);
  const sharpe = s > 0 ? (m / s) * Math.sqrt(365) : 0;

  let cumEquity = 1;
  let maxEquity = 1;
  let maxDD = 0;
  for (const r of returns) {
    cumEquity *= 1 + r;
    maxEquity = Math.max(maxEquity, cumEquity);
    maxDD = Math.min(maxDD, (cumEquity - maxEquity) / maxEquity);
  }

  return {
    n: returns.length,
    sharpe,
    maxDD: Math.abs(maxDD),
    totalReturn: cumEquity - 1,
  };
}

/**
 * 相関係数
 */
function correlation(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length === 0) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  const sx = std(xs);
  const sy = std(ys);
  if (sx === 0 || sy === 0) return 0;
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  return cov / (sx * sy);
}

// ===== メイン実行 =====
const btcCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
const ethCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));
const btcFunding = loadDailyFundingRate(join(DATA_DIR, 'btc-funding-2019-2026.csv'));
const ethFunding = loadDailyFundingRate(join(DATA_DIR, 'eth-funding-2019-2026.csv'));

console.log('=== BTC-ETH相対ニュートラル・スリーブ + ②合成（EXP-OBS000029）===\n');

// 選定期間: 2019-09〜2022-12
console.log('--- 選定期間 (2019-09-19 〜 2022-12-31) [in-sample] ---');
const selRange = getDateRange(ethCandles, '2019-09-19', '2022-12-31');
const selSleeve = simulateSleeveReturns(ethCandles, btcCandles, ethFunding, btcFunding, selRange.start, selRange.end);
const selBtcMom = simulateMomentumReturns(btcCandles, selRange.start, selRange.end);
const selStats = computeStats(selSleeve.returns);
const selBtcStats = computeStats(selBtcMom);
console.log(`スリーブ純: n=${selStats.n} | Sharpe=${selStats.sharpe.toFixed(3)} | totalRet=${(selStats.totalReturn * 100).toFixed(1)}% | maxDD=${(selStats.maxDD * 100).toFixed(1)}%`);
console.log(`②BTC: n=${selBtcStats.n} | Sharpe=${selBtcStats.sharpe.toFixed(3)} | totalRet=${(selBtcStats.totalReturn * 100).toFixed(1)}% | maxDD=${(selBtcStats.maxDD * 100).toFixed(1)}%`);

// 逆ボラウェイト凍結
const selSleeveStd = std(selSleeve.returns);
const selBtcStd = std(selBtcMom);
const denom = selSleeveStd + selBtcStd;
const invVolWeightSlv = denom > 0 ? selBtcStd / denom : 0.5;
const invVolWeightBtc = denom > 0 ? selSleeveStd / denom : 0.5;
console.log(`凍結逆ボラウェイト: スリーブ=${invVolWeightSlv.toFixed(3)}, ②=${invVolWeightBtc.toFixed(3)}\n`);

// 確認期間: 2023-01-01〜末尾
console.log('--- 確認期間 (2023-01-01 〜 末尾) [OOS・メイン判定] ---');
const confRange = getDateRange(ethCandles, '2023-01-01');
const confSleeve = simulateSleeveReturns(ethCandles, btcCandles, ethFunding, btcFunding, confRange.start, confRange.end);
const confBtcMom = simulateMomentumReturns(btcCandles, confRange.start, confRange.end);
const confEthMom = simulateMomentumReturns(ethCandles, confRange.start, confRange.end);
const confSleeveStats = computeStats(confSleeve.returns);
const confBtcStats = computeStats(confBtcMom);
const confEthStats = computeStats(confEthMom);
console.log(`スリーブ純: n=${confSleeveStats.n} | Sharpe=${confSleeveStats.sharpe.toFixed(3)} | totalRet=${(confSleeveStats.totalReturn * 100).toFixed(1)}% | maxDD=${(confSleeveStats.maxDD * 100).toFixed(1)}%`);
console.log(`>> G2（スリーブ純Sharpe > 0）: ${confSleeveStats.sharpe > 0 ? 'PASS' : 'FAIL'}`);

// ②単体
console.log('\n②単体（確認期間）:');
console.log(`BTC: n=${confBtcStats.n} | Sharpe=${confBtcStats.sharpe.toFixed(3)} | totalRet=${(confBtcStats.totalReturn * 100).toFixed(1)}% | maxDD=${(confBtcStats.maxDD * 100).toFixed(1)}%`);
console.log(`ETH: n=${confEthStats.n} | Sharpe=${confEthStats.sharpe.toFixed(3)} | totalRet=${(confEthStats.totalReturn * 100).toFixed(1)}% | maxDD=${(confEthStats.maxDD * 100).toFixed(1)}%`);

// G3: 相関
const minLen = Math.min(confSleeve.returns.length, confBtcMom.length);
const sleeveConfRet = confSleeve.returns.slice(0, minLen);
const btcConfRet = confBtcMom.slice(0, minLen);
const corrFull = correlation(sleeveConfRet, btcConfRet);
const mid = Math.floor(minLen / 2);
const corrH1 = correlation(sleeveConfRet.slice(0, mid), btcConfRet.slice(0, mid));
const corrH2 = correlation(sleeveConfRet.slice(mid), btcConfRet.slice(mid));
console.log(`\nG3（相関 |ρ| < 0.3）: ρ=${corrFull.toFixed(3)}, |ρ|=${Math.abs(corrFull).toFixed(3)} → ${Math.abs(corrFull) < 0.3 ? 'PASS' : 'FAIL'}`);
console.log(`相関（前半）: ${corrH1.toFixed(3)} | 相関（後半）: ${corrH2.toFixed(3)}`);

// G4: 合成改善
const composedRet = sleeveConfRet.map((slv, i) => invVolWeightSlv * slv + invVolWeightBtc * btcConfRet[i]);
const composedStats = computeStats(composedRet);
const sharpeImprove = composedStats.sharpe - confBtcStats.sharpe;
const ddImprove = confBtcStats.maxDD - composedStats.maxDD;
console.log(`\n合成（凍結逆ボラ）: Sharpe=${composedStats.sharpe.toFixed(3)} | maxDD=${(composedStats.maxDD * 100).toFixed(1)}%`);
console.log(`\nG4判定:`);
console.log(`  (a) 合成Sharpe改善: ${composedStats.sharpe.toFixed(3)} - ${confBtcStats.sharpe.toFixed(3)} = ${sharpeImprove.toFixed(3)} ≥ +0.15? ${sharpeImprove >= 0.15 ? 'YES' : 'NO'}`);
console.log(`  (b) 合成DD削減: ${(confBtcStats.maxDD * 100).toFixed(1)}% - ${(composedStats.maxDD * 100).toFixed(1)}% = ${(ddImprove * 100).toFixed(1)}pt ≤ -5pt? ${ddImprove * 100 <= -5 ? 'YES' : 'NO'}`);
console.log(`  (a or b）: ${sharpeImprove >= 0.15 || ddImprove * 100 <= -5 ? 'PASS' : 'FAIL'}`);

// 参考: 50/50
const comp5050 = sleeveConfRet.map((slv, i) => 0.5 * slv + 0.5 * btcConfRet[i]);
const comp5050Stats = computeStats(comp5050);
console.log(`\n参考（素朴50/50）: Sharpe=${comp5050Stats.sharpe.toFixed(3)} | maxDD=${(comp5050Stats.maxDD * 100).toFixed(1)}%`);

// レジーム窓
console.log('\n--- レジーム分析（スリーブ純）---');
const r1Range = getDateRange(ethCandles, '2020-07-01', '2021-05-31');
const r1 = simulateSleeveReturns(ethCandles, btcCandles, ethFunding, btcFunding, r1Range.start, r1Range.end);
const r1Stats = computeStats(r1.returns);
console.log(`R1（2020-07-01〜2021-05-31）: n=${r1Stats.n} | Sharpe=${r1Stats.sharpe.toFixed(3)} | totalRet=${(r1Stats.totalReturn * 100).toFixed(1)}% | maxDD=${(r1Stats.maxDD * 100).toFixed(1)}%`);

const r2Range = getDateRange(ethCandles, '2022-01-01', '2022-12-31');
const r2 = simulateSleeveReturns(ethCandles, btcCandles, ethFunding, btcFunding, r2Range.start, r2Range.end);
const r2Stats = computeStats(r2.returns);
console.log(`R2（2022-01-01〜2022-12-31）: n=${r2Stats.n} | Sharpe=${r2Stats.sharpe.toFixed(3)} | totalRet=${(r2Stats.totalReturn * 100).toFixed(1)}% | maxDD=${(r2Stats.maxDD * 100).toFixed(1)}%`);

const r3_2023Range = getDateRange(ethCandles, '2023-01-01', '2023-12-31');
const r3_2023 = simulateSleeveReturns(ethCandles, btcCandles, ethFunding, btcFunding, r3_2023Range.start, r3_2023Range.end);
const r3_2023Stats = computeStats(r3_2023.returns);
console.log(`R3-2023（2023年）: n=${r3_2023Stats.n} | Sharpe=${r3_2023Stats.sharpe.toFixed(3)} | totalRet=${(r3_2023Stats.totalReturn * 100).toFixed(1)}% | maxDD=${(r3_2023Stats.maxDD * 100).toFixed(1)}%`);

const r3_2024Range = getDateRange(ethCandles, '2024-01-01', '2024-12-31');
const r3_2024 = simulateSleeveReturns(ethCandles, btcCandles, ethFunding, btcFunding, r3_2024Range.start, r3_2024Range.end);
const r3_2024Stats = computeStats(r3_2024.returns);
console.log(`R3-2024（2024年）: n=${r3_2024Stats.n} | Sharpe=${r3_2024Stats.sharpe.toFixed(3)} | totalRet=${(r3_2024Stats.totalReturn * 100).toFixed(1)}% | maxDD=${(r3_2024Stats.maxDD * 100).toFixed(1)}%`);

const r3_2025Range = getDateRange(ethCandles, '2025-01-01');
const r3_2025 = simulateSleeveReturns(ethCandles, btcCandles, ethFunding, btcFunding, r3_2025Range.start, r3_2025Range.end);
const r3_2025Stats = computeStats(r3_2025.returns);
console.log(`R3-2025（2025-01-01以降）: n=${r3_2025Stats.n} | Sharpe=${r3_2025Stats.sharpe.toFixed(3)} | totalRet=${(r3_2025Stats.totalReturn * 100).toFixed(1)}% | maxDD=${(r3_2025Stats.maxDD * 100).toFixed(1)}%`);

// 縮退診断
let maxPnlDay = 0;
for (let i = 0; i < confSleeve.pnls.length; i++) {
  if (Math.abs(confSleeve.pnls[i]) > maxPnlDay) {
    maxPnlDay = Math.abs(confSleeve.pnls[i]);
  }
}
const totalPnl = confSleeve.pnls.reduce((a, b) => a + b, 0);
const top1Ratio = totalPnl !== 0 ? maxPnlDay / Math.abs(totalPnl) : 0;
console.log(`\n縮退診断: top-1単一リバランス寄与率=${(top1Ratio * 100).toFixed(1)}%`);

console.log('\n--- 生データ終了 ---');
