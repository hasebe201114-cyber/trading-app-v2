/**
 * ②パターン認識層 優位性検定（OBS000016 / 方針レビュー2026-07-04）
 *
 * 目的: 「②に本当に統計的優位性があるのか」を、これまでの年次36トレード（検定力不足）ではなく
 *       予測単位・非重複サンプル＋permutation検定で決着させる。同時に、絶対ベンチマーク
 *       （買い持ち・トレンドフォロー）と横並び比較し、②が"倒すべき相手"に勝てるかを見る。
 *
 * 設計:
 *   - pooled walk-forward。学習境界(warmup)以降を通しでテスト。
 *   - 近傍プールは index+horizon<=t の「実現済み」局面のみ（先読み防止）。
 *   - 正規化(z-score)統計は学習区間のみで算出しテストへ適用（スケーラの先読み防止）。
 *   - テスト点は horizon 刻みで非重複サンプル化（リターンの重なりによる自己相関を排除し、
 *     permutation検定・シャープの前提を満たす）。
 *
 * 比較する3戦略（同一テスト点・同一forwardリターン、建玉符号のみ異なる）:
 *   1. ② k-NN（現行ロジック）
 *   2. トレンドフォロー（時系列モメンタム: 過去L日リターンの符号で建玉）
 *   3. 買い持ち（常時ロング＝絶対ベンチマーク）
 *
 * permutation検定: 統計量 S = mean(position_i * r_i)。
 *   帰無仮説「建玉は将来リターンと独立」の下で r_i をシャッフルして S を再計算（nPerm回）。
 *   p値(片側, S>0) = (#{S_perm >= S_obs} + 1) / (nPerm + 1)。
 *   → 建玉タイミングが偶然を超えて実現リターンに整合しているかを直接検定する。
 *   （買い持ちは常時ロングでシャッフル不変のため検定対象外）
 *
 * 実行例:
 *   node --experimental-strip-types scripts/edge-validation.ts
 *   node --experimental-strip-types scripts/edge-validation.ts --horizon 10 --k 30 --momentum 20 --warmup 0.4 --perm 5000
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { extractFeatureVector, type FeatureVector } from '../src/pattern-engine/features.ts';
import { findNearestNeighbors } from '../src/pattern-engine/similarity.ts';
import { predictFromNeighborReturns } from '../src/pattern-engine/predict.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// --- 引数パース ---
function argNum(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? Number(process.argv[i + 1]) : def;
}
const HORIZON = argNum('--horizon', 10);
const K = argNum('--k', 30);
const MOMENTUM_LOOKBACK = argNum('--momentum', 20);
const WARMUP_FRACTION = argNum('--warmup', 0.4);
const N_PERM = argNum('--perm', 5000);
const NEUTRAL_THRESHOLD = 0.0005;

// --- 乱数（再現性のためseed固定 mulberry32）---
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pctChange = (from: number, to: number): number => (to - from) / from;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

// --- データ読み込み・特徴量 ---
function argStr(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const candles = loadOhlcvFromDailyCsv(join(DATA_DIR, argStr('--data', 'btc-daily-2010-2026.csv')));
const n = candles.length;
const minIndex = 20;
const maxIndex = n - HORIZON - 1;

const validIndices: number[] = [];
const rawVectors: FeatureVector[] = [];
for (let i = minIndex; i <= maxIndex; i++) {
  const vec = extractFeatureVector(candles, i);
  if (vec) { validIndices.push(i); rawVectors.push(vec); }
}

// --- 正規化統計は学習区間(warmup)のみで算出 → 全体へ適用（スケーラ先読み防止）---
const trainEnd = Math.floor(validIndices.length * WARMUP_FRACTION);
const dims = rawVectors[0].length;
const means: number[] = [];
const stds: number[] = [];
for (let d = 0; d < dims; d++) {
  const vals = rawVectors.slice(0, trainEnd).map(v => v[d]);
  const m = mean(vals);
  const s = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length) || 1;
  means.push(m); stds.push(s);
}
const normalizedAll = rawVectors.map(v => v.map((val, d) => (val - means[d]) / stds[d]));

const utcDateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

// --- テスト点を horizon 刻みで非重複サンプル化 ---
interface Sample {
  date: string;               // テスト時点(currentCandleIndex)のUTC日付
  patternSign: 0 | 1 | -1;   // ② の建玉方向（0=neutral見送り）
  momentumSign: 0 | 1 | -1;  // トレンドフォローの建玉方向
  forwardReturn: number;      // 実現forwardリターン（常時ロング=買い持ちのリターンでもある）
  actualSign: 1 | -1 | 0;
}
const samples: Sample[] = [];

for (let t = trainEnd; t < validIndices.length; t += HORIZON) {
  const currentCandleIndex = validIndices[t];
  const targetVector = normalizedAll[t];

  // ② k-NN: 実現済み局面のみを近傍候補に
  const candidates = validIndices
    .map((idx, pos) => ({ index: idx, vector: normalizedAll[pos] }))
    .filter(c => c.index + HORIZON <= currentCandleIndex);
  let patternSign: 0 | 1 | -1 = 0;
  if (candidates.length >= K) {
    const neighbors = findNearestNeighbors(targetVector, candidates, K);
    const forwardReturns = neighbors.map(nb => pctChange(candles[nb.index].close, candles[nb.index + HORIZON].close));
    const pred = predictFromNeighborReturns(forwardReturns);
    patternSign = pred.direction === 'up' ? 1 : pred.direction === 'down' ? -1 : 0;
  }

  // トレンドフォロー: 過去L日リターンの符号
  const momRet = pctChange(candles[currentCandleIndex - MOMENTUM_LOOKBACK].close, candles[currentCandleIndex].close);
  const momentumSign: 0 | 1 | -1 = momRet > NEUTRAL_THRESHOLD ? 1 : momRet < -NEUTRAL_THRESHOLD ? -1 : 0;

  const forwardReturn = pctChange(candles[currentCandleIndex].close, candles[currentCandleIndex + HORIZON].close);
  const actualSign: 1 | -1 | 0 = forwardReturn > NEUTRAL_THRESHOLD ? 1 : forwardReturn < -NEUTRAL_THRESHOLD ? -1 : 0;

  samples.push({ date: utcDateOf(candles[currentCandleIndex].time), patternSign, momentumSign, forwardReturn, actualSign });
}

// --- 指標算出 ---
const annualizeFactor = Math.sqrt(365 / HORIZON);

interface StrategyStats {
  name: string;
  nTrades: number;
  accuracy: number | null;   // 非neutral予測に対する方向的中率（買い持ちはnull）
  longRatio: number;
  shortRatio: number;
  meanReturn: number;
  sharpe: number;
  permP: number | null;
}

function baseRateOf(set: Sample[]): number {
  const up = set.filter(s => s.actualSign === 1).length;
  const down = set.filter(s => s.actualSign === -1).length;
  return up + down > 0 ? Math.max(up, down) / (up + down) : 0;
}

function evaluate(name: string, positionOf: (s: Sample) => 0 | 1 | -1, set: Sample[], baseRate: number, isBuyHold = false): StrategyStats {
  const active = set.filter(s => positionOf(s) !== 0);
  const tradeReturns = active.map(s => positionOf(s) * s.forwardReturn);
  const longs = active.filter(s => positionOf(s) === 1).length;
  const shorts = active.filter(s => positionOf(s) === -1).length;

  // 的中率（買い持ちは方向予測ではないのでnull）
  let accuracy: number | null = null;
  if (!isBuyHold) {
    const correct = active.filter(s => positionOf(s) === s.actualSign && s.actualSign !== 0).length;
    const decided = active.filter(s => s.actualSign !== 0).length;
    accuracy = decided > 0 ? correct / decided : 0;
  }

  const m = mean(tradeReturns);
  const sd = std(tradeReturns);
  const sharpe = sd > 0 ? (m / sd) * annualizeFactor : 0;

  // permutation検定（買い持ちは常時同符号でシャッフル不変のため対象外）
  let permP: number | null = null;
  if (!isBuyHold && active.length > 0) {
    const positions = active.map(positionOf);
    const returns = active.map(s => s.forwardReturn);
    const obs = mean(positions.map((p, i) => p * returns[i]));
    const rng = mulberry32(12345);
    const shuffled = [...returns];
    let ge = 0;
    for (let p = 0; p < N_PERM; p++) {
      // Fisher-Yates
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const s = mean(positions.map((pos, i) => pos * shuffled[i]));
      if (s >= obs) ge++;
    }
    permP = (ge + 1) / (N_PERM + 1);
  }

  return {
    name, nTrades: active.length, accuracy,
    longRatio: active.length ? longs / active.length : 0,
    shortRatio: active.length ? shorts / active.length : 0,
    meanReturn: m, sharpe, permP,
  };
}

const baseRate = baseRateOf(samples);
const upCount = samples.filter(s => s.actualSign === 1).length;
const downCount = samples.filter(s => s.actualSign === -1).length;
const decidedCount = upCount + downCount;

const patternStats = evaluate('② k-NN', s => s.patternSign, samples, baseRate);
const momentumStats = evaluate(`トレンドフォロー(L=${MOMENTUM_LOOKBACK})`, s => s.momentumSign, samples, baseRate);
const buyHoldStats = evaluate('買い持ち', () => 1, samples, baseRate, true);

// --- 出力 ---
console.log('=== ②パターン認識層 優位性検定（edge-validation） ===\n');
console.log(`データ: ${n}本 (${utcDateOf(candles[0].time)}〜${utcDateOf(candles[n - 1].time)})`);
console.log(`設定: horizon=${HORIZON}, k=${K}, momentumLookback=${MOMENTUM_LOOKBACK}, warmup=${(WARMUP_FRACTION * 100).toFixed(0)}%, 非重複ステップ=${HORIZON}, permutations=${N_PERM}`);
console.log(`テストサンプル数(非重複): ${samples.length}`);
console.log(`実現方向の内訳: up ${(upCount / decidedCount * 100).toFixed(1)}% / down ${(downCount / decidedCount * 100).toFixed(1)}% → ベースレート(多数派)= ${(baseRate * 100).toFixed(1)}%\n`);

function printStats(st: StrategyStats): void {
  console.log(`--- ${st.name} ---`);
  console.log(`  建玉数: ${st.nTrades}  (long ${(st.longRatio * 100).toFixed(0)}% / short ${(st.shortRatio * 100).toFixed(0)}%)`);
  if (st.accuracy !== null) {
    const edge = (st.accuracy - baseRate) * 100;
    console.log(`  方向的中率: ${(st.accuracy * 100).toFixed(1)}%  (ベースレート ${(baseRate * 100).toFixed(1)}%, 差 ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pt)`);
  }
  console.log(`  平均トレードリターン: ${(st.meanReturn * 100).toFixed(2)}%`);
  console.log(`  非重複シャープ(年率): ${st.sharpe.toFixed(2)}`);
  if (st.permP !== null) {
    console.log(`  permutation p値(平均リターン>0): ${st.permP.toFixed(4)}  ${st.permP < 0.05 ? '★有意(p<0.05)' : '有意でない'}`);
  }
  console.log();
}
printStats(patternStats);
printStats(momentumStats);
printStats(buyHoldStats);

// --- 時代別分解（全期間プールがBTC初期爆騰に引っ張られていないかの頑健性チェック）---
console.log('=== 時代別分解（②の優位性が直近まで持続するか）===');
console.log('※全期間プールはBTC初期の高リターン期を含むため過大評価されやすい。3等分して持続性を確認する。\n');
const third = Math.ceil(samples.length / 3);
const eras: Sample[][] = [samples.slice(0, third), samples.slice(third, 2 * third), samples.slice(2 * third)];
const eraResults: { pattern: StrategyStats; buyHold: StrategyStats }[] = [];
for (const era of eras) {
  if (era.length === 0) continue;
  const br = baseRateOf(era);
  const p = evaluate('②', s => s.patternSign, era, br);
  const bh = evaluate('買い持ち', () => 1, era, br, true);
  eraResults.push({ pattern: p, buyHold: bh });
  const accEdgeEra = p.accuracy !== null ? (p.accuracy - br) * 100 : 0;
  console.log(`[${era[0].date}〜${era[era.length - 1].date}] n=${era.length}`);
  console.log(`  ② 的中率 ${(p.accuracy! * 100).toFixed(1)}% (基準${(br * 100).toFixed(1)}%, 差${accEdgeEra >= 0 ? '+' : ''}${accEdgeEra.toFixed(1)}pt), シャープ ${p.sharpe.toFixed(2)}, permP ${p.permP!.toFixed(4)}${p.permP! < 0.05 ? '★' : ''} | 買い持ちシャープ ${bh.sharpe.toFixed(2)}`);
}
console.log();

// --- 判定 ---
console.log('=== 判定 ===');
const accEdge = patternStats.accuracy !== null ? (patternStats.accuracy - baseRate) * 100 : 0;
console.log(`・②の方向的中率 vs ベースレート: ${accEdge >= 0 ? '+' : ''}${accEdge.toFixed(1)}pt`);
console.log(`・②のタイミング優位性(permutation): p=${patternStats.permP?.toFixed(4)} → ${patternStats.permP! < 0.05 ? '偶然でない優位性あり' : '偶然と区別できない'}`);
console.log(`・シャープ比較: ② ${patternStats.sharpe.toFixed(2)} / トレンドフォロー ${momentumStats.sharpe.toFixed(2)} / 買い持ち ${buyHoldStats.sharpe.toFixed(2)}`);
const beatsBenchmarks = patternStats.sharpe > buyHoldStats.sharpe && patternStats.sharpe > momentumStats.sharpe;
console.log(`・②はベンチマーク(買い持ち・トレンドフォロー)を${beatsBenchmarks ? '上回る' : '上回らない'}（全期間プール）`);

// 直近期間の持続性を最重視する（プール値はBTC初期・中間の大相場で過大評価されやすい）
const recent = eraResults[eraResults.length - 1];
if (recent) {
  const recentSignificant = recent.pattern.permP! < 0.05;
  const recentBeatsBH = recent.pattern.sharpe > recent.buyHold.sharpe;
  console.log(`・直近期間: permP=${recent.pattern.permP!.toFixed(4)}(${recentSignificant ? '有意' : '有意でない'}), シャープ ② ${recent.pattern.sharpe.toFixed(2)} vs 買い持ち ${recent.buyHold.sharpe.toFixed(2)}(${recentBeatsBH ? '②勝' : '②負'})`);

  let verdict: string;
  if (patternStats.permP! < 0.05 && recentSignificant && recentBeatsBH) {
    verdict = '✅ ②に統計的優位性あり・直近も持続 → ②の強化を進める価値がある';
  } else if (patternStats.permP! < 0.05 && !recentSignificant) {
    verdict = '△ 全期間では優位だが直近では優位性が消失（レジーム依存）。②を無条件に使うのは危険。'
      + '有利レジームの判定（提案2: ADX/Hurst/vol等）をゲートとして導入し「②が効く局面だけ張る」方向を検証すべき';
  } else {
    verdict = '⚠️ ②の統計的優位性は確認できず → 特徴量/モデルクラスの再設計が必要。③④の追加は②が固まるまで保留が妥当';
  }
  console.log(`\n結論: ${verdict}`);
}
