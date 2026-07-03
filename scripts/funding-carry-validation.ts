/**
 * Funding Rateキャリー戦略の検証（第三者レビュー提案1 / OBS000021後続）
 *
 * レビュー提案: Funding Rateは②(価格パターン)・モメンタムとは独立した情報源であり、
 * 非相関なエッジ・分散効果が期待できる。まず「デルタヘッジなしの片側簡易版」で
 * 統計的優位性を検証してから、複雑なヘッジ構成を検討する段階的アプローチを取る。
 *
 * 検証する仮説（逆張り的な資金調達率シグナル）:
 *   「Funding Rateが持続的に高い(強気に偏りすぎ)ときは反落しやすく、
 *    持続的に低い(弱気に偏りすぎ)ときは反発しやすい」という、いわゆる
 *   "crowded trade / 過熱シグナル"としての予測力があるかを、
 *   position = -sign(直近W日平均のfundingRateDaily) の方向的中率・シャープ・
 *   permutation検定で測定する（既存のedge-validation/momentum-robustnessと
 *   同じ非重複・permutation検定の方法論を踏襲）。
 *
 * 検証プロトコル（selection→confirmation、多重検定を回避）:
 *   1. 選定フェーズ: BTC(2020-2026, funding開始後)で複数の平滑化窓Wを走査し、
 *      最良のWを選ぶ。
 *   2. 確認フェーズ: 選定に使っていないETHで、そのWをそのまま適用し確認する。
 *
 * 副次的に、モメンタム戦略(OBS000020, L=30)との相関も測定し、
 * 「独立した収益源になっているか」（レビューの成功基準2）を確認する。
 *
 * 併せて、デルタヘッジ前提の理論キャリー利回り（記述統計・検定ではない）も算出する。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/funding-carry-validation.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { loadDailyFundingRate } from './loadFundingRateData.ts';
import type { OHLCV } from '../src/types/market.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const HORIZON = 10;
const NEUTRAL_THRESHOLD = 0.0005;
const N_PERM = 5000;
const MOMENTUM_L = 30; // OBS000020で選定した値

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

interface Stats { n: number; sharpe: number; permP: number; hitRate: number; }

function permTest(positions: number[], returns: number[]): number {
  const obs = mean(positions.map((p, i) => p * returns[i]));
  const rng = mulberry32(20260704);
  const shuffled = [...returns];
  let ge = 0;
  for (let p = 0; p < N_PERM; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (mean(positions.map((pos, i) => pos * shuffled[i])) >= obs) ge++;
  }
  return (ge + 1) / (N_PERM + 1);
}

/** 資金調達率の逆張りシグナル（過熱時に反対方向へ）を非重複サンプルで評価する */
function evalFundingContrarian(
  candles: OHLCV[],
  funding: Map<string, { fundingRateDaily: number }>,
  smoothingWindow: number,
  startDate: string,
): Stats & { positions: Map<string, number>; forwardReturns: Map<string, number> } {
  const n = candles.length;
  const dateIndex = new Map<string, number>();
  candles.forEach((c, i) => dateIndex.set(utcDateOf(c.time), i));

  // 日次fundingの時系列（価格データの日付に整列。欠損日は0扱い）
  const dailyRates: number[] = candles.map(c => funding.get(utcDateOf(c.time))?.fundingRateDaily ?? 0);

  let startIdx = smoothingWindow;
  for (let i = 0; i < n; i++) { if (utcDateOf(candles[i].time) >= startDate) { startIdx = Math.max(smoothingWindow, i); break; } }
  const maxIndex = n - HORIZON - 1;

  const returns: number[] = [];
  const positions: number[] = [];
  const forwardReturnsArr: number[] = [];
  const actualSigns: number[] = [];
  const posByDate = new Map<string, number>();
  const fwdByDate = new Map<string, number>();

  for (let t = startIdx; t <= maxIndex; t += HORIZON) {
    // t-1日以前のsmoothingWindow日平均（先読み防止：当日のfundingは使わない）
    const window = dailyRates.slice(t - smoothingWindow, t);
    const avgRate = mean(window);
    const sign = avgRate > 0 ? -1 : avgRate < 0 ? 1 : 0; // 過熱(正)なら逆張りでショート
    if (sign === 0) continue;
    const forwardReturn = pctChange(candles[t].close, candles[t + HORIZON].close);
    returns.push(sign * forwardReturn);
    positions.push(sign);
    forwardReturnsArr.push(forwardReturn);
    actualSigns.push(forwardReturn > NEUTRAL_THRESHOLD ? 1 : forwardReturn < -NEUTRAL_THRESHOLD ? -1 : 0);
    posByDate.set(utcDateOf(candles[t].time), sign);
    fwdByDate.set(utcDateOf(candles[t].time), forwardReturn);
  }
  if (returns.length < 5) return { n: 0, sharpe: 0, permP: 1, hitRate: 0, positions: posByDate, forwardReturns: fwdByDate };

  const annualizeFactor = Math.sqrt(365 / HORIZON);
  const sharpe = std(returns) > 0 ? (mean(returns) / std(returns)) * annualizeFactor : 0;
  const decided = actualSigns.filter(s => s !== 0).length;
  const correct = positions.filter((p, i) => actualSigns[i] !== 0 && p === actualSigns[i]).length;
  const hitRate = decided ? correct / decided : 0;
  const permP = permTest(positions, forwardReturnsArr);

  return { n: returns.length, sharpe, permP, hitRate, positions: posByDate, forwardReturns: fwdByDate };
}

/** モメンタムシグナル（OBS000020, L固定）を同じ非重複グリッドで評価する（相関計算用） */
function computeMomentumSeries(candles: OHLCV[], lookback: number, startDate: string): { positions: Map<string, number>; forwardReturns: Map<string, number> } {
  const n = candles.length;
  let startIdx = lookback;
  for (let i = 0; i < n; i++) { if (utcDateOf(candles[i].time) >= startDate) { startIdx = Math.max(lookback, i); break; } }
  const maxIndex = n - HORIZON - 1;
  const positions = new Map<string, number>();
  const forwardReturns = new Map<string, number>();
  for (let t = startIdx; t <= maxIndex; t += HORIZON) {
    const momRet = pctChange(candles[t - lookback].close, candles[t].close);
    const sign = momRet > NEUTRAL_THRESHOLD ? 1 : momRet < -NEUTRAL_THRESHOLD ? -1 : 0;
    if (sign === 0) continue;
    positions.set(utcDateOf(candles[t].time), sign);
    forwardReturns.set(utcDateOf(candles[t].time), pctChange(candles[t].close, candles[t + HORIZON].close));
  }
  return { positions, forwardReturns };
}

function correlation(xs: number[], ys: number[]): number {
  if (xs.length < 3) return 0;
  const mx = mean(xs), my = mean(ys);
  const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  const sx = std(xs), sy = std(ys);
  return sx > 0 && sy > 0 ? cov / (sx * sy) : 0;
}

// --- データ読み込み ---
const btcCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
const ethCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));
const btcFunding = loadDailyFundingRate(join(DATA_DIR, 'btc-funding-2019-2026.csv'));
const ethFunding = loadDailyFundingRate(join(DATA_DIR, 'eth-funding-2019-2026.csv'));

console.log('=== Funding Rateキャリー戦略の検証（第三者レビュー提案1）===\n');

// --- 理論キャリー利回り（記述統計・検定ではない）---
function theoreticalCarryYield(funding: Map<string, { fundingRateDaily: number }>): number {
  const rates = Array.from(funding.values()).map(f => Math.abs(f.fundingRateDaily));
  return mean(rates) * 365; // 日次|rate|の平均を年率換算
}
console.log('--- 理論キャリー利回り（デルタヘッジ完全成立を仮定した参考値。検定ではない）---');
console.log(`BTC: 年率約${(theoreticalCarryYield(btcFunding) * 100).toFixed(1)}%（ヘッジコスト・バーシスリスク等は未考慮）`);
console.log(`ETH: 年率約${(theoreticalCarryYield(ethFunding) * 100).toFixed(1)}%（同上）\n`);

// --- 選定フェーズ: BTCで平滑化窓Wを走査 ---
console.log('--- 選定フェーズ（BTC 2020-01-01〜末尾、Funding逆張りシグナル）---');
const WINDOWS = [1, 3, 7, 14, 30];
console.log('window   Sharpe   permP    的中率   n');
const selRows: { w: number; sharpe: number; permP: number }[] = [];
for (const w of WINDOWS) {
  const s = evalFundingContrarian(btcCandles, btcFunding, w, '2020-01-01');
  selRows.push({ w, sharpe: s.sharpe, permP: s.permP });
  console.log(`${String(w).padEnd(8)} ${s.sharpe.toFixed(2).padStart(6)}   ${s.permP.toFixed(3)}${s.permP < 0.05 ? '★' : ' '}   ${(s.hitRate * 100).toFixed(1)}%   ${s.n}`);
}
const chosen = selRows.sort((a, b) => b.sharpe - a.sharpe)[0];
console.log(`\n選定結果: window=${chosen.w}（BTCでSharpe最良。この段階の有意性は参考値）`);

// --- 確認フェーズ: ETHで検証 ---
console.log(`\n--- 確認フェーズ（ETH・選定に使っていない未見データ、window=${chosen.w}固定）---`);
const ethConfirm = evalFundingContrarian(ethCandles, ethFunding, chosen.w, '2020-01-01');
console.log(`n=${ethConfirm.n}, 的中率=${(ethConfirm.hitRate * 100).toFixed(1)}%, Sharpe=${ethConfirm.sharpe.toFixed(2)}, permP=${ethConfirm.permP.toFixed(4)} ${ethConfirm.permP < 0.05 ? '★有意' : '有意でない'}`);

// --- 追加参考: BTC直近期間(2023-2026)で確認 ---
console.log(`\n--- 追加参考（BTC 2023-2026直近、window=${chosen.w}固定）---`);
const btcRecent = evalFundingContrarian(btcCandles, btcFunding, chosen.w, '2023-01-01');
console.log(`n=${btcRecent.n}, 的中率=${(btcRecent.hitRate * 100).toFixed(1)}%, Sharpe=${btcRecent.sharpe.toFixed(2)}, permP=${btcRecent.permP.toFixed(4)} ${btcRecent.permP < 0.05 ? '★有意' : '有意でない'}`);

// --- モメンタム(OBS000020, L=30)との相関 ---
console.log(`\n--- モメンタム(L=${MOMENTUM_L})との相関（分散効果の確認・BTC 2020-2026）---`);
const btcFundingFull = evalFundingContrarian(btcCandles, btcFunding, chosen.w, '2020-01-01');
const btcMomentum = computeMomentumSeries(btcCandles, MOMENTUM_L, '2020-01-01');
const commonDates = Array.from(btcFundingFull.positions.keys()).filter(d => btcMomentum.positions.has(d));
const fundingReturns = commonDates.map(d => btcFundingFull.positions.get(d)! * btcFundingFull.forwardReturns.get(d)!);
const momentumReturns = commonDates.map(d => btcMomentum.positions.get(d)! * btcMomentum.forwardReturns.get(d)!);
const corr = correlation(fundingReturns, momentumReturns);
console.log(`共通テスト日数: ${commonDates.length}, 戦略間リターン相関: ${corr.toFixed(3)} ${Math.abs(corr) <= 0.3 ? '（低相関・分散効果あり）' : '（相関あり・分散効果は限定的）'}`);

// --- 総合判定 ---
console.log('\n=== 判定 ===');
if (ethConfirm.permP < 0.05 && ethConfirm.sharpe > 0) {
  console.log(`✅ 選定に使っていないETHでwindow=${chosen.w}のFunding逆張りシグナルが有意(p=${ethConfirm.permP.toFixed(3)})に確認できた。`);
} else {
  console.log(`⚠️ 選定に使っていないETHではwindow=${chosen.w}のFunding逆張りシグナルは有意でない(p=${ethConfirm.permP.toFixed(3)})。`);
  console.log('   単純な逆張りタイミング戦略としては未確立。ただしデルタヘッジ版の理論キャリー利回り自体は別途評価に値する。');
}
console.log(`分散効果: モメンタムとの相関${corr.toFixed(3)}（${Math.abs(corr) <= 0.3 ? '目安0.3以下を満たす' : '目安0.3を超える'}）`);
