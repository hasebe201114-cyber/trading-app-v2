/**
 * ②レジームゲート仮説の検証（OBS000016 後続 / 方針レビュー2026-07-04）
 *
 * 発見（edge-validation.ts）: ②のエッジはレジーム依存。2020-2023の高ボラ大相場では明確だが
 * 直近2023-2026では消失。→ 仮説「②が効くレジームだけ張るゲートを設ければ改善する」を検証する。
 *
 * レジーム指標（いずれも決定時点までの情報のみ＝先読みなし）:
 *   - vol   = volatility20（特徴量index5, 直近20本のリターン標準偏差）… 実現ボラ
 *   - er    = efficiencyRatio20（特徴量index9, Kaufman効率比）… トレンドの一方向性
 *
 * 2部構成:
 *   Part A（探索）: 全サンプルを各指標の3分位(低/中/高)に分け、②のエッジがどの分位に集中するかを見る。
 *                   ※分位境界は全体から算出＝先読みを含む探索的分析（関係の有無を見るだけ）。
 *   Part B（実運用ゲート）: 「指標が"過去サンプルの中央値"以上のときだけ②を張る」ゲート（先読みなし）を
 *                   ②無ゲートと比較。全期間と直近期間で改善するかを permutation検定付きで判定。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/regime-gate-validation.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { extractFeatureVector, type FeatureVector } from '../src/pattern-engine/features.ts';
import { findNearestNeighbors } from '../src/pattern-engine/similarity.ts';
import { predictFromNeighborReturns } from '../src/pattern-engine/predict.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

function argNum(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? Number(process.argv[i + 1]) : def;
}
const HORIZON = argNum('--horizon', 10);
const K = argNum('--k', 30);
const WARMUP_FRACTION = argNum('--warmup', 0.4);
const N_PERM = argNum('--perm', 5000);
const GATE_MEDIAN_WARMUP = argNum('--gateWarmup', 30); // ゲート中央値を確定するのに必要な過去サンプル数
const NEUTRAL_THRESHOLD = 0.0005;
const VOL_INDEX = 5;   // features.ts: volatility20
const ER_INDEX = 9;    // features.ts: efficiencyRatio20

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
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// --- データ・特徴量 ---
const candles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-2010-2026.csv'));
const n = candles.length;
const minIndex = 20;
const maxIndex = n - HORIZON - 1;
const validIndices: number[] = [];
const rawVectors: FeatureVector[] = [];
for (let i = minIndex; i <= maxIndex; i++) {
  const vec = extractFeatureVector(candles, i);
  if (vec) { validIndices.push(i); rawVectors.push(vec); }
}
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

// --- サンプル生成（horizon刻み・非重複）---
interface Sample {
  date: string;
  patternSign: 0 | 1 | -1;
  forwardReturn: number;
  actualSign: 1 | -1 | 0;
  vol: number;
  er: number;
}
const samples: Sample[] = [];
for (let t = trainEnd; t < validIndices.length; t += HORIZON) {
  const currentCandleIndex = validIndices[t];
  const targetVector = normalizedAll[t];
  const candidates = validIndices
    .map((idx, pos) => ({ index: idx, vector: normalizedAll[pos] }))
    .filter(c => c.index + HORIZON <= currentCandleIndex);
  let patternSign: 0 | 1 | -1 = 0;
  if (candidates.length >= K) {
    const neighbors = findNearestNeighbors(targetVector, candidates, K);
    const fr = neighbors.map(nb => pctChange(candles[nb.index].close, candles[nb.index + HORIZON].close));
    const pred = predictFromNeighborReturns(fr);
    patternSign = pred.direction === 'up' ? 1 : pred.direction === 'down' ? -1 : 0;
  }
  const forwardReturn = pctChange(candles[currentCandleIndex].close, candles[currentCandleIndex + HORIZON].close);
  const actualSign: 1 | -1 | 0 = forwardReturn > NEUTRAL_THRESHOLD ? 1 : forwardReturn < -NEUTRAL_THRESHOLD ? -1 : 0;
  samples.push({
    date: utcDateOf(candles[currentCandleIndex].time),
    patternSign, forwardReturn, actualSign,
    vol: rawVectors[t][VOL_INDEX],
    er: rawVectors[t][ER_INDEX],
  });
}

const annualizeFactor = Math.sqrt(365 / HORIZON);

interface Stats { n: number; accuracy: number; baseRate: number; sharpe: number; permP: number; }
function evalSet(set: Sample[]): Stats {
  const active = set.filter(s => s.patternSign !== 0);
  const up = set.filter(s => s.actualSign === 1).length;
  const down = set.filter(s => s.actualSign === -1).length;
  const baseRate = up + down > 0 ? Math.max(up, down) / (up + down) : 0;
  if (active.length === 0) return { n: 0, accuracy: 0, baseRate, sharpe: 0, permP: 1 };
  const decided = active.filter(s => s.actualSign !== 0);
  const correct = decided.filter(s => s.patternSign === s.actualSign).length;
  const accuracy = decided.length ? correct / decided.length : 0;
  const tr = active.map(s => s.patternSign * s.forwardReturn);
  const m = mean(tr); const sd = std(tr);
  const sharpe = sd > 0 ? (m / sd) * annualizeFactor : 0;
  // permutation
  const positions = active.map(s => s.patternSign);
  const returns = active.map(s => s.forwardReturn);
  const obs = mean(positions.map((p, i) => p * returns[i]));
  const rng = mulberry32(12345);
  const shuffled = [...returns];
  let ge = 0;
  for (let p = 0; p < N_PERM; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (mean(positions.map((pos, i) => pos * shuffled[i])) >= obs) ge++;
  }
  return { n: active.length, accuracy, baseRate, sharpe, permP: (ge + 1) / (N_PERM + 1) };
}
function fmt(label: string, st: Stats): string {
  const edge = (st.accuracy - st.baseRate) * 100;
  return `${label}: n=${String(st.n).padStart(3)} 的中${(st.accuracy * 100).toFixed(1)}%(基準${(st.baseRate * 100).toFixed(1)}%,${edge >= 0 ? '+' : ''}${edge.toFixed(1)}pt) シャープ${st.sharpe.toFixed(2)} permP${st.permP.toFixed(4)}${st.permP < 0.05 ? '★' : ''}`;
}

const recentThird = samples.slice(2 * Math.ceil(samples.length / 3));

console.log('=== ②レジームゲート仮説の検証 ===\n');
console.log(`データ: ${n}本, テストサンプル ${samples.length}件 (${samples[0].date}〜${samples[samples.length - 1].date})`);
console.log(`設定: horizon=${HORIZON}, k=${K}, warmup=${(WARMUP_FRACTION * 100).toFixed(0)}%, perm=${N_PERM}`);
console.log(`直近期間(下位1/3): ${recentThird[0].date}〜${recentThird[recentThird.length - 1].date} (${recentThird.length}件)\n`);

// --- Part A: 3分位の探索 ---
function tercileAnalysis(name: string, valueOf: (s: Sample) => number): void {
  console.log(`--- Part A: ${name} の3分位別②エッジ（探索・境界は全体から算出）---`);
  const sorted = [...samples].sort((a, b) => valueOf(a) - valueOf(b));
  const t1 = Math.floor(sorted.length / 3);
  const t2 = Math.floor(sorted.length * 2 / 3);
  const low = sorted.slice(0, t1);
  const mid = sorted.slice(t1, t2);
  const high = sorted.slice(t2);
  console.log(`  ${name}範囲: 低[${valueOf(low[0]).toFixed(4)}〜${valueOf(low[low.length - 1]).toFixed(4)}] 高[${valueOf(high[0]).toFixed(4)}〜${valueOf(high[high.length - 1]).toFixed(4)}]`);
  console.log(`  ${fmt('低', evalSet(low))}`);
  console.log(`  ${fmt('中', evalSet(mid))}`);
  console.log(`  ${fmt('高', evalSet(high))}`);
  console.log();
}
tercileAnalysis('vol(実現ボラ)', s => s.vol);
tercileAnalysis('er(効率比)', s => s.er);

// --- Part B: 実運用ゲート（過去中央値以上のときだけ張る）---
function realtimeGate(name: string, valueOf: (s: Sample) => number, direction: 'high' | 'low'): { gatedAll: Sample[]; gatedRecent: Sample[] } {
  const gated: Sample[] = [];
  const past: number[] = [];
  const recentStartIdx = 2 * Math.ceil(samples.length / 3);
  const gatedRecent: Sample[] = [];
  for (let i = 0; i < samples.length; i++) {
    const v = valueOf(samples[i]);
    if (past.length >= GATE_MEDIAN_WARMUP) {
      const med = median(past);
      const pass = direction === 'high' ? v >= med : v <= med;
      if (pass) {
        gated.push(samples[i]);
        if (i >= recentStartIdx) gatedRecent.push(samples[i]);
      }
    }
    past.push(v);
  }
  return { gatedAll: gated, gatedRecent };
}

console.log('--- Part B: 実運用ゲート（指標≥過去中央値のときだけ②を張る・先読みなし）---');
console.log(`（ゲート中央値は直前${GATE_MEDIAN_WARMUP}サンプル以上が貯まってから有効）\n`);

console.log('■ 無ゲート（参照）');
console.log(`  全期間  ${fmt('②', evalSet(samples))}`);
console.log(`  直近    ${fmt('②', evalSet(recentThird))}\n`);

for (const [name, valueOf] of [['vol≥中央値', (s: Sample) => s.vol], ['er≥中央値', (s: Sample) => s.er]] as const) {
  const { gatedAll, gatedRecent } = realtimeGate(name, valueOf, 'high');
  console.log(`■ ゲート: ${name}`);
  console.log(`  全期間  ${fmt('②gated', evalSet(gatedAll))}`);
  console.log(`  直近    ${fmt('②gated', evalSet(gatedRecent))}\n`);
}

// --- 判定 ---
// 信頼できるゲートの条件: 直近サンプルが十分(n>=MIN_N)かつ permP<0.05 かつ 無ゲート比でシャープ改善。
// ※小n(例 vol≥中央値の直近n=13)はp値が出ても偶然の域を出ないため MIN_N で足切りする。
const MIN_N = 30;
console.log('=== 判定 ===');
const recentUngated = evalSet(recentThird);
const volGateRecent = evalSet(realtimeGate('vol', s => s.vol, 'high').gatedRecent);
const erGateRecent = evalSet(realtimeGate('er', s => s.er, 'high').gatedRecent);
const note = (st: Stats): string => (st.n < MIN_N ? `(n=${st.n} 小・信頼不可)` : '');
console.log(`直近期間の②シャープ: 無ゲート ${recentUngated.sharpe.toFixed(2)}(permP${recentUngated.permP.toFixed(3)}) / vol≥中央値 ${volGateRecent.sharpe.toFixed(2)}(permP${volGateRecent.permP.toFixed(3)})${note(volGateRecent)} / er≥中央値 ${erGateRecent.sharpe.toFixed(2)}(permP${erGateRecent.permP.toFixed(3)})${note(erGateRecent)}`);

const reliable = [
  { name: 'vol≥中央値', st: volGateRecent },
  { name: 'er≥中央値', st: erGateRecent },
].filter(g => g.st.n >= MIN_N && g.st.permP < 0.05 && g.st.sharpe > recentUngated.sharpe + 0.2)
 .sort((a, b) => b.st.sharpe - a.st.sharpe);

if (reliable.length > 0) {
  const best = reliable[0];
  console.log(`✅ レジームゲート「${best.name}」で直近②エッジが回復（シャープ${recentUngated.sharpe.toFixed(2)}→${best.st.sharpe.toFixed(2)}, permP${best.st.permP.toFixed(3)}, n=${best.st.n}）。`);
  console.log('   → ②にこのゲートを実装し、別パラメータ(k/horizon)・別銘柄(ETH)で頑健性を再確認する価値あり。');
} else {
  console.log('⚠️ 十分なサンプル(n>=30)を伴い有意に改善するゲートは確認できず。分位閾値・複合条件・別指標(ADX等)を追加検討。');
}
