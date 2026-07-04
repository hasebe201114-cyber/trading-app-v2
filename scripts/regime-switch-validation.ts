/**
 * レジームスイッチ戦略の検証（第三者レビュー提案2 / OBS000018後続）
 *
 * OBS000018で「ERゲート（低ER局面を"休む"）」はポートフォリオ水準で不採用だった。
 * レビュー提案2は「休む」のではなく「ロジックを入れ替える」——
 * 高ER(トレンド)局面ではモメンタムを、低ER(レンジ)局面ではRSI逆張り(平均回帰)を使う。
 * 休む場合の機会損失がなくなる分、ゲート版より有利になる可能性がある。
 *
 * 予測単位でまず安価に検証し（②同様、edge-validation/regime-gate-validationと同じ
 * 非重複・permutation検定の方法論）、有望なら次にパイプライン統合へ進む。
 *
 * 検証プロトコル（selection→confirmation、多重検定を回避）:
 *   1. 選定: BTCで比較（モメンタム単体 vs レジームスイッチ）
 *   2. 確認: 選定に使っていないETHで確認
 *
 * 実行例:
 *   node --experimental-strip-types scripts/regime-switch-validation.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { extractFeatureVector, type FeatureVector } from '../src/pattern-engine/features.ts';
import type { OHLCV } from '../src/types/market.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const HORIZON = 10;
const MOMENTUM_L = 30;
const NEUTRAL_THRESHOLD = 0.0005;
const N_PERM = 5000;
const RSI_INDEX = 7; // features.ts FEATURE_NAMES: rsi14
const ER_INDEX = 9; // efficiencyRatio20
const GATE_WARMUP = 40; // OBS000018のadaptiveErGateWarmupと同じ考え方

const pctChange = (from: number, to: number): number => (to - from) / from;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
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
function candleIndexAtOrAfter(candles: OHLCV[], date: string): number {
  for (let i = 0; i < candles.length; i++) if (utcDateOf(candles[i].time) >= date) return i;
  return candles.length;
}

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

function evaluate(candles: OHLCV[], startDate: string, endDate: string | undefined, mode: 'momentumOnly' | 'regimeSwitch'): Stats {
  const n = candles.length;
  const minIndex = 20;
  const maxIndex = n - HORIZON - 1;
  const validIndices: number[] = [];
  const rawVectors: FeatureVector[] = [];
  for (let i = minIndex; i <= maxIndex; i++) {
    const vec = extractFeatureVector(candles, i);
    if (vec) { validIndices.push(i); rawVectors.push(vec); }
  }
  const startIdx0 = candleIndexAtOrAfter(candles, startDate);
  const endIdx0 = endDate ? candleIndexAtOrAfter(candles, endDate) : n;
  let tStart = 0;
  for (let t = 0; t < validIndices.length; t++) { if (validIndices[t] >= startIdx0) { tStart = t; break; } }
  let tEnd = validIndices.length;
  for (let t = 0; t < validIndices.length; t++) { if (validIndices[t] >= endIdx0) { tEnd = t; break; } }

  const positions: number[] = [];
  const returns: number[] = [];
  const actualSigns: number[] = [];
  const pastErValues: number[] = [];

  // ゲート中央値のwarmupは対象期間より前から蓄積する（先読み防止・実運用相当）
  for (let t = 0; t < tStart; t++) pastErValues.push(rawVectors[t][ER_INDEX]);

  for (let t = tStart; t < tEnd; t += HORIZON) {
    const currentCandleIndex = validIndices[t];
    if (currentCandleIndex - MOMENTUM_L < 0) { pastErValues.push(rawVectors[t][ER_INDEX]); continue; }

    const momRet = pctChange(candles[currentCandleIndex - MOMENTUM_L].close, candles[currentCandleIndex].close);
    const momentumSign = momRet > NEUTRAL_THRESHOLD ? 1 : momRet < -NEUTRAL_THRESHOLD ? -1 : 0;

    let sign = momentumSign;
    if (mode === 'regimeSwitch') {
      const er = rawVectors[t][ER_INDEX];
      const gatePassed = pastErValues.length >= GATE_WARMUP && er >= median(pastErValues);
      if (!gatePassed) {
        const rsi = rawVectors[t][RSI_INDEX];
        sign = rsi < 30 ? 1 : rsi > 70 ? -1 : 0; // 低ER局面: RSI逆張り(平均回帰)
      }
    }
    pastErValues.push(rawVectors[t][ER_INDEX]);

    if (sign === 0) continue;
    const forwardReturn = pctChange(candles[currentCandleIndex].close, candles[currentCandleIndex + HORIZON].close);
    positions.push(sign);
    returns.push(sign * forwardReturn);
    actualSigns.push(forwardReturn > NEUTRAL_THRESHOLD ? 1 : forwardReturn < -NEUTRAL_THRESHOLD ? -1 : 0);
  }

  if (positions.length < 5) return { n: 0, sharpe: 0, permP: 1, hitRate: 0 };
  const annualizeFactor = Math.sqrt(365 / HORIZON);
  const sharpe = std(returns) > 0 ? (mean(returns) / std(returns)) * annualizeFactor : 0;
  const decided = actualSigns.filter(s => s !== 0).length;
  const correct = positions.filter((p, i) => actualSigns[i] !== 0 && p === actualSigns[i]).length;
  const hitRate = decided ? correct / decided : 0;
  const permP = permTest(positions, returns);
  return { n: positions.length, sharpe, permP, hitRate };
}

const btc = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
const eth = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));

const fmt = (s: Stats): string => `n=${s.n} 的中${(s.hitRate * 100).toFixed(1)}% Sharpe${s.sharpe.toFixed(2)} permP${s.permP.toFixed(4)}${s.permP < 0.05 ? '★' : ''}`;

console.log('=== レジームスイッチ戦略の検証（第三者レビュー提案2）===\n');
console.log('--- 選定フェーズ（BTC）---');
const BTC_WINDOWS: { label: string; start: string; end?: string }[] = [
  { label: 'BTC 2021-2026連続', start: '2021-01-01' },
  { label: 'BTC 2023-2026直近', start: '2023-01-01' },
  { label: 'BTC 2022年', start: '2022-01-01', end: '2023-01-01' },
];
let btcMomSum = 0, btcSwitchSum = 0;
for (const w of BTC_WINDOWS) {
  const mom = evaluate(btc, w.start, w.end, 'momentumOnly');
  const sw = evaluate(btc, w.start, w.end, 'regimeSwitch');
  btcMomSum += mom.sharpe; btcSwitchSum += sw.sharpe;
  console.log(`[${w.label}]`);
  console.log(`  モメンタムのみ:     ${fmt(mom)}`);
  console.log(`  レジームスイッチ:   ${fmt(sw)}`);
}
console.log(`\nBTC合計Sharpe: モメンタムのみ=${btcMomSum.toFixed(2)} レジームスイッチ=${btcSwitchSum.toFixed(2)}`);

console.log('\n--- 確認フェーズ（ETH・未見データ）---');
const ETH_WINDOWS: { label: string; start: string; end?: string }[] = [
  { label: 'ETH 2021-2026連続', start: '2021-01-01' },
  { label: 'ETH 2023-2026直近', start: '2023-01-01' },
];
let ethMomSum = 0, ethSwitchSum = 0;
for (const w of ETH_WINDOWS) {
  const mom = evaluate(eth, w.start, w.end, 'momentumOnly');
  const sw = evaluate(eth, w.start, w.end, 'regimeSwitch');
  ethMomSum += mom.sharpe; ethSwitchSum += sw.sharpe;
  console.log(`[${w.label}]`);
  console.log(`  モメンタムのみ:     ${fmt(mom)}`);
  console.log(`  レジームスイッチ:   ${fmt(sw)}`);
}
console.log(`\nETH合計Sharpe: モメンタムのみ=${ethMomSum.toFixed(2)} レジームスイッチ=${ethSwitchSum.toFixed(2)}`);

console.log('\n=== 判定 ===');
if (btcSwitchSum > btcMomSum && ethSwitchSum > ethMomSum) {
  console.log('✅ BTC・ETHともレジームスイッチがモメンタム単体を上回った。パイプライン統合検証に進む価値がある。');
} else if (ethSwitchSum > ethMomSum) {
  console.log('△ ETHでは改善したがBTCでは改善せず（またはその逆）。頑健性に疑問が残るため慎重に判断。');
} else {
  console.log('⚠️ 選定に使っていないETHで改善が確認できなかった。レジームスイッチは不採用とし、モメンタム単体を維持する。');
}
