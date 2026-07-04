/**
 * BTC-ETH相対モメンタムの予測単位検証（EXP-OBS000029）
 *
 * spec: ETH/BTCの比系列に対する順張りモメンタム(L=30)が、
 * HORIZON=10日先のスプレッド方向（sign(r_ETH - r_BTC)）を当てるか。
 * 非重複サンプル・permutation検定（N_PERM=5000, seed=20260704）。
 *
 * 段階的評価:
 * - Stage1（G1・必須）: 確認期間2023-2026で hitRate > 50% かつ permutation p < 0.05
 *   未達なら即打ち切り（相対モメンタムに未見期間のエッジなし）。
 *
 * 実行:
 *   node --experimental-strip-types scripts/relative-momentum-robustness.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import type { OHLCV } from '../src/types/market.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// spec値：固定・変更禁止
const L = 30;                             // ルックバック期間
const HORIZON = 10;                       // リバランス頻度
const NEUTRAL_THRESHOLD = 0.0005;
const N_PERM = 5000;
const SEED = 20260704;

const pctChange = (from: number, to: number): number => (to - from) / from;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const utcDateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

interface MomentumStats {
  n: number;
  hitRate: number;
  sharpe: number;
  permP: number;
}

/**
 * 比系列モメンタムの評価
 * candles_eth, candles_btc: 両方とも同じ長さ・同じ日付でアラインされていることを前提
 * startDate: 評価開始日（"YYYY-MM-DD"形式）
 * endDate: 評価終了日（"YYYY-MM-DD"形式、含まれる）
 */
function evalRelativeMomentum(
  candles_eth: OHLCV[],
  candles_btc: OHLCV[],
  lookback: number,
  startDate?: string,
  endDate?: string,
): MomentumStats {
  const n = candles_eth.length;
  if (n !== candles_btc.length) throw new Error('ETH and BTC candle counts must match');

  const minIndex = lookback;
  const maxIndex = n - HORIZON - 1;
  let startIdx = minIndex;
  let endIdx = maxIndex;

  if (startDate) {
    for (let i = 0; i < n; i++) {
      if (utcDateOf(candles_eth[i].time) >= startDate) {
        startIdx = Math.max(minIndex, i);
        break;
      }
    }
  }

  if (endDate) {
    for (let i = n - 1; i >= 0; i--) {
      if (utcDateOf(candles_eth[i].time) <= endDate) {
        endIdx = Math.min(maxIndex, i);
        break;
      }
    }
  }

  const returns: number[] = [];
  const spreadReturns: number[] = [];
  const positions: number[] = [];

  for (let t = startIdx; t <= endIdx; t += HORIZON) {
    // 比系列モメンタム
    const ratio_past = candles_eth[t - lookback].close / candles_btc[t - lookback].close;
    const ratio_now = candles_eth[t].close / candles_btc[t].close;
    const momRatio = pctChange(ratio_past, ratio_now);

    // signal: +1 (ETH相対強) / -1 (ETH相対弱) / 0 (neutral)
    const signal = momRatio > NEUTRAL_THRESHOLD ? 1 : momRatio < -NEUTRAL_THRESHOLD ? -1 : 0;
    if (signal === 0) continue;

    // スプレッドリターン（グロス・Fundingなし）
    const r_eth = pctChange(candles_eth[t].close, candles_eth[t + HORIZON].close);
    const r_btc = pctChange(candles_btc[t].close, candles_btc[t + HORIZON].close);
    const spreadReturn = r_eth - r_btc;

    // モメンタム予測リターン（signal × spreadReturn）
    const predictedReturn = signal * spreadReturn;
    returns.push(predictedReturn);
    spreadReturns.push(spreadReturn);
    positions.push(signal);
  }

  if (returns.length < 5) {
    return { n: returns.length, hitRate: 0, sharpe: 0, permP: 1 };
  }

  // Sharpe（年率化）
  const annualizeFactor = Math.sqrt(365 / HORIZON);
  const sharpe = std(returns) > 0 ? (mean(returns) / std(returns)) * annualizeFactor : 0;

  // hitRate: 符号的中率
  const spreadSigns = spreadReturns.map(r => (r > NEUTRAL_THRESHOLD ? 1 : r < -NEUTRAL_THRESHOLD ? -1 : 0));
  const decided = positions.filter((_, i) => spreadSigns[i] !== 0);
  const correct = positions.filter((p, i) => spreadSigns[i] !== 0 && p === spreadSigns[i]).length;
  const hitRate = decided.length ? correct / decided.length : 0;

  // Permutation検定: 符号付きスプレッドリターンをシャッフル
  const obs = mean(positions.map((p, i) => p * spreadReturns[i]));
  const rng = mulberry32(SEED);
  const shuffled = [...spreadReturns];
  let ge = 0;
  for (let p = 0; p < N_PERM; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (mean(positions.map((pos, i) => pos * shuffled[i])) >= obs) ge++;
  }
  const permP = (ge + 1) / (N_PERM + 1);

  return { n: returns.length, hitRate, sharpe, permP };
}

// ===== メイン実行 =====
const btcCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
const ethCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));

console.log('=== ETH/BTC相対モメンタム予測単位検証（EXP-OBS000029）===\n');
console.log(`設定: L=${L}, HORIZON=${HORIZON}, NEUTRAL_THRESHOLD=${NEUTRAL_THRESHOLD}, N_PERM=${N_PERM}, seed=${SEED}\n`);

// Stage1: 選定期間（2017-08〜2022-12）でin-sample特性を確認
console.log('--- 選定期間 (2017-08-01 〜 2022-12-31) [in-sample] ---');
const selectionStats = evalRelativeMomentum(ethCandles, btcCandles, L, '2017-08-01', '2022-12-31');
console.log(`n=${selectionStats.n} | hitRate=${(selectionStats.hitRate * 100).toFixed(1)}% | Sharpe=${selectionStats.sharpe.toFixed(3)} | permP=${selectionStats.permP.toFixed(4)}`);

// 参考：L∈{20,60}も選定期間のみで併記
console.log('\n参考 L=20:');
const sel20 = evalRelativeMomentum(ethCandles, btcCandles, 20, '2017-08-01', '2022-12-31');
console.log(`n=${sel20.n} | hitRate=${(sel20.hitRate * 100).toFixed(1)}% | Sharpe=${sel20.sharpe.toFixed(3)} | permP=${sel20.permP.toFixed(4)}`);

console.log('\n参考 L=60:');
const sel60 = evalRelativeMomentum(ethCandles, btcCandles, 60, '2017-08-01', '2022-12-31');
console.log(`n=${sel60.n} | hitRate=${(sel60.hitRate * 100).toFixed(1)}% | Sharpe=${sel60.sharpe.toFixed(3)} | permP=${sel60.permP.toFixed(4)}`);

// Stage1: 確認期間（2023-01-01〜末尾）で本判定
console.log('\n--- 確認期間 (2023-01-01 〜 末尾) [OOS・G1判定] ---');
const confirmStats = evalRelativeMomentum(ethCandles, btcCandles, L, '2023-01-01');
console.log(`n=${confirmStats.n} | hitRate=${(confirmStats.hitRate * 100).toFixed(1)}% | Sharpe=${confirmStats.sharpe.toFixed(3)} | permP=${confirmStats.permP.toFixed(4)}`);
console.log(`>> G1 判定: hitRate > 50% && permP < 0.05? ${confirmStats.hitRate > 0.5 && confirmStats.permP < 0.05 ? 'TRUE (PASS)' : 'FALSE (FAIL)'}`);

// 確認期間を前半/後半に2分割（縮退リスク対応）
const confirmPivot = ethCandles.findIndex(c => utcDateOf(c.time) >= '2024-06-15') || Math.floor(ethCandles.length / 2);
const confirmHalfEnd = ethCandles.findIndex(c => utcDateOf(c.time) >= '2023-07-01');

console.log('\n--- 確認期間・前半 (2023-01-01 〜 ≈2023-07) [OOS・縮退検証] ---');
const confirmH1 = evalRelativeMomentum(ethCandles, btcCandles, L, '2023-01-01', '2023-12-31');
console.log(`n=${confirmH1.n} | hitRate=${(confirmH1.hitRate * 100).toFixed(1)}% | Sharpe=${confirmH1.sharpe.toFixed(3)} | permP=${confirmH1.permP.toFixed(4)}`);

console.log('\n--- 確認期間・後半 (2024-01-01 以降) [OOS・縮退検証] ---');
const confirmH2 = evalRelativeMomentum(ethCandles, btcCandles, L, '2024-01-01');
console.log(`n=${confirmH2.n} | hitRate=${(confirmH2.hitRate * 100).toFixed(1)}% | Sharpe=${confirmH2.sharpe.toFixed(3)} | permP=${confirmH2.permP.toFixed(4)}`);

// レジーム窓（R1: アルトシーズン, R2: BTCドミナンス/弱気, R3: 確認期間）
console.log('\n--- レジーム窓 R1 (2020-07-01 〜 2021-05-31) [in-sample・アルトシーズン] ---');
const r1Stats = evalRelativeMomentum(ethCandles, btcCandles, L, '2020-07-01', '2021-05-31');
console.log(`n=${r1Stats.n} | hitRate=${(r1Stats.hitRate * 100).toFixed(1)}% | Sharpe=${r1Stats.sharpe.toFixed(3)} | permP=${r1Stats.permP.toFixed(4)}`);

console.log('\n--- レジーム窓 R2 (2022-01-01 〜 2022-12-31) [in-sample・弱気相場] ---');
const r2Stats = evalRelativeMomentum(ethCandles, btcCandles, L, '2022-01-01', '2022-12-31');
console.log(`n=${r2Stats.n} | hitRate=${(r2Stats.hitRate * 100).toFixed(1)}% | Sharpe=${r2Stats.sharpe.toFixed(3)} | permP=${r2Stats.permP.toFixed(4)}`);

console.log('\n--- レジーム窓 R3-2023 (2023-01-01 〜 2023-12-31) [OOS] ---');
const r3_2023 = evalRelativeMomentum(ethCandles, btcCandles, L, '2023-01-01', '2023-12-31');
console.log(`n=${r3_2023.n} | hitRate=${(r3_2023.hitRate * 100).toFixed(1)}% | Sharpe=${r3_2023.sharpe.toFixed(3)} | permP=${r3_2023.permP.toFixed(4)}`);

console.log('\n--- レジーム窓 R3-2024 (2024-01-01 〜 2024-12-31) [OOS] ---');
const r3_2024 = evalRelativeMomentum(ethCandles, btcCandles, L, '2024-01-01', '2024-12-31');
console.log(`n=${r3_2024.n} | hitRate=${(r3_2024.hitRate * 100).toFixed(1)}% | Sharpe=${r3_2024.sharpe.toFixed(3)} | permP=${r3_2024.permP.toFixed(4)}`);

console.log('\n--- レジーム窓 R3-2025 (2025-01-01 〜 末尾) [OOS] ---');
const r3_2025 = evalRelativeMomentum(ethCandles, btcCandles, L, '2025-01-01');
console.log(`n=${r3_2025.n} | hitRate=${(r3_2025.hitRate * 100).toFixed(1)}% | Sharpe=${r3_2025.sharpe.toFixed(3)} | permP=${r3_2025.permP.toFixed(4)}`);

console.log('\n--- 生データ終了 ---');
