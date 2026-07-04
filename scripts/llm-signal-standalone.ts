/**
 * ③LLM特徴量層 予測単位テスト（OBS000027）
 *
 * ②・④を一切通さず、③の生シグナル eventImpactScore が単独で
 * horizon=10日先リターンに対して直交エッジを持つかを測定する。
 *
 * Q1（方向一致）: |eventImpactScore| >= 0.3 の日について、
 *   sign(eventImpactScore) と sign(10日先リターン) の一致率・件数・permutation p値。
 * Q2（連続IC）: eventImpactScore と 10日先リターンの Spearman順位相関（符号・p値）。
 *   全ニュース日、および |eventImpactScore| >= 0.3 の部分集合の両方で算出。
 *
 * permutation検定: forwardReturn 側をシャッフルし、統計量（Q1=一致率, Q2=Spearman rho）を
 * 帰無分布の下で再計算する。N=1000回、seed固定（mulberry32）で決定的に再現可能。
 * p値は両側検定: p = (#{|stat_perm| >= |stat_obs|} + 1) / (N + 1)。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/llm-signal-standalone.ts
 *
 * 入力:
 *   scripts/data/llm-features-daily.live.json （③liveキャッシュ。--mock相当のフォールバックはしない）
 *   scripts/data/btc-daily-2010-2026.csv （日足OHLCV。10日先リターン算出用）
 *
 * 出力: 生の数値のみ（判定・解釈は行わない。Cの判定用）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import type { MarketContextLogEntry } from '../src/llm-layer/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const HORIZON = 10;
const CONFIDENCE_THRESHOLD = 0.3;
const N_PERM = 1000;
const PERM_SEED = 12345;

const CACHE_PATH = join(DATA_DIR, 'llm-features-daily.live.json');
const CSV_PATH = join(DATA_DIR, 'btc-daily-2010-2026.csv');

if (!existsSync(CACHE_PATH)) {
  console.error(`liveキャッシュが見つかりません: ${CACHE_PATH}`);
  process.exit(1);
}

// --- 乱数（再現性のためseed固定 mulberry32。edge-validation.tsと同一実装）---
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
const utcDateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

function rank(xs: number[]): number[] {
  // 平均順位法（同値=タイの場合、その集合の順位の平均を割り当てる）
  const idx = xs.map((v, i) => ({ v, i }));
  idx.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // 1始まり
    for (let m = i; m <= j; m++) ranks[idx[m].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

function spearman(xs: number[], ys: number[]): number {
  return pearson(rank(xs), rank(ys));
}

// --- データ読み込み ---
const cacheRaw = readFileSync(CACHE_PATH, 'utf-8');
const cache: Record<string, MarketContextLogEntry> = JSON.parse(cacheRaw);
const cacheStat = statSync(CACHE_PATH);

const candles = loadOhlcvFromDailyCsv(CSV_PATH);
const n = candles.length;
const dateToIndex = new Map<string, number>();
for (let i = 0; i < n; i++) dateToIndex.set(utcDateOf(candles[i].time), i);

// --- 各ニュース日について10日先リターンを算出（先読みなし：i+HORIZON<=n-1が必要）---
interface Sample {
  date: string;
  year: string;
  score: number;
  forwardReturn: number;
}
const allSamples: Sample[] = [];
const cacheEntries = Object.entries(cache);
for (const [date, entry] of cacheEntries) {
  const idx = dateToIndex.get(date);
  if (idx === undefined) continue;
  if (idx + HORIZON >= n) continue; // 10日先が存在しない（データ末尾）
  const forwardReturn = pctChange(candles[idx].close, candles[idx + HORIZON].close);
  allSamples.push({ date, year: date.slice(0, 4), score: entry.output.eventImpactScore, forwardReturn });
}
allSamples.sort((a, b) => a.date.localeCompare(b.date));

const subsetSamples = allSamples.filter(s => Math.abs(s.score) >= CONFIDENCE_THRESHOLD);

// --- Q1: 方向一致率 + permutation検定 ---
function q1Stats(samples: Sample[], rng: () => number): {
  n: number; matchRate: number; upCount: number; downCount: number; permP: number;
} {
  const decided = samples.filter(s => s.score !== 0 && s.forwardReturn !== 0);
  const signMatch = (s: Sample): boolean => Math.sign(s.score) === Math.sign(s.forwardReturn);
  const matches = decided.filter(signMatch).length;
  const matchRate = decided.length > 0 ? matches / decided.length : NaN;
  const upCount = decided.filter(s => Math.sign(s.score) === 1).length;
  const downCount = decided.filter(s => Math.sign(s.score) === -1).length;

  let permP = NaN;
  if (decided.length > 0) {
    const scoreSigns = decided.map(s => Math.sign(s.score));
    const returns = decided.map(s => s.forwardReturn);
    const obsRate = matchRate;
    const shuffled = [...returns];
    let geCount = 0;
    for (let p = 0; p < N_PERM; p++) {
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      let m = 0;
      for (let i = 0; i < scoreSigns.length; i++) {
        if (shuffled[i] !== 0 && scoreSigns[i] === Math.sign(shuffled[i])) m++;
      }
      const permRate = m / decided.length;
      // 両側検定: 観測との乖離(|rate-0.5|)が偶然分布以上に大きいか
      if (Math.abs(permRate - 0.5) >= Math.abs(obsRate - 0.5)) geCount++;
    }
    permP = (geCount + 1) / (N_PERM + 1);
  }

  return { n: decided.length, matchRate, upCount, downCount, permP };
}

// --- Q2: Spearman IC + permutation検定 ---
function q2Stats(samples: Sample[], rng: () => number): { n: number; rho: number; permP: number } {
  if (samples.length < 2) return { n: samples.length, rho: NaN, permP: NaN };
  const scores = samples.map(s => s.score);
  const returns = samples.map(s => s.forwardReturn);
  const obsRho = spearman(scores, returns);

  const shuffled = [...returns];
  let geCount = 0;
  for (let p = 0; p < N_PERM; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const permRho = spearman(scores, shuffled);
    if (Math.abs(permRho) >= Math.abs(obsRho)) geCount++;
  }
  const permP = (geCount + 1) / (N_PERM + 1);
  return { n: samples.length, rho: obsRho, permP };
}

// --- 出力 ---
console.log('=== ③LLM特徴量層 予測単位テスト（llm-signal-standalone） ===\n');
console.log(`git非依存の再現メタは run.log 参照。`);
console.log(`日足データ: ${n}本（${utcDateOf(candles[0].time)}〜${utcDateOf(candles[n - 1].time)}）`);
console.log(`③キャッシュ: ${CACHE_PATH}`);
const source0 = cacheEntries[0]?.[1].source ?? '不明';
const model0 = cacheEntries[0]?.[1].model ?? '不明';
console.log(`  ソース=${source0}, モデル=${model0}, 収録=${cacheEntries.length}日, ファイルサイズ=${cacheStat.size}バイト`);
console.log(`設定: horizon=${HORIZON}, |score|閾値=${CONFIDENCE_THRESHOLD}, permutations=${N_PERM}, seed=${PERM_SEED}\n`);

console.log(`有効サンプル数（10日先が算出可能な日）: 全ニュース日=${allSamples.length}, |score|>=${CONFIDENCE_THRESHOLD}部分集合=${subsetSamples.length}\n`);

console.log('=== Q1（方向一致率, |score|>=0.3） ===');
{
  const rng = mulberry32(PERM_SEED);
  const r = q1Stats(subsetSamples, rng);
  console.log(`n(score!=0 かつ forwardReturn!=0)=${r.n}`);
  console.log(`一致率=${r.n > 0 ? (r.matchRate * 100).toFixed(2) + '%' : 'NaN'}`);
  console.log(`score符号内訳: up(score>0)=${r.upCount}, down(score<0)=${r.downCount}`);
  console.log(`permutation p値(両側, N=${N_PERM})=${Number.isNaN(r.permP) ? 'NaN' : r.permP.toFixed(4)}`);
}
console.log();

console.log('=== Q2（Spearman IC） ===');
{
  const rngAll = mulberry32(PERM_SEED);
  const rAll = q2Stats(allSamples, rngAll);
  console.log(`[全ニュース日] n=${rAll.n}, rho=${Number.isNaN(rAll.rho) ? 'NaN' : rAll.rho.toFixed(4)}, ` +
    `符号=${Number.isNaN(rAll.rho) ? 'NaN' : (rAll.rho > 0 ? '正' : rAll.rho < 0 ? '負' : 'ゼロ')}, ` +
    `permutation p値(両側, N=${N_PERM})=${Number.isNaN(rAll.permP) ? 'NaN' : rAll.permP.toFixed(4)}`);

  const rngSub = mulberry32(PERM_SEED);
  const rSub = q2Stats(subsetSamples, rngSub);
  console.log(`[|score|>=${CONFIDENCE_THRESHOLD}部分集合] n=${rSub.n}, rho=${Number.isNaN(rSub.rho) ? 'NaN' : rSub.rho.toFixed(4)}, ` +
    `符号=${Number.isNaN(rSub.rho) ? 'NaN' : (rSub.rho > 0 ? '正' : rSub.rho < 0 ? '負' : 'ゼロ')}, ` +
    `permutation p値(両側, N=${N_PERM})=${Number.isNaN(rSub.permP) ? 'NaN' : rSub.permP.toFixed(4)}`);
}
console.log();

// --- 年次内訳 ---
console.log('=== 年次内訳 ===');
const years = Array.from(new Set(allSamples.map(s => s.year))).sort();
for (const year of years) {
  const yearAll = allSamples.filter(s => s.year === year);
  const yearSub = subsetSamples.filter(s => s.year === year);
  const rngQ1 = mulberry32(PERM_SEED);
  const q1 = q1Stats(yearSub, rngQ1);
  const rngQ2All = mulberry32(PERM_SEED);
  const q2All = q2Stats(yearAll, rngQ2All);
  const rngQ2Sub = mulberry32(PERM_SEED);
  const q2Sub = q2Stats(yearSub, rngQ2Sub);
  console.log(`[${year}] n(全)=${yearAll.length}, n(|score|>=${CONFIDENCE_THRESHOLD})=${yearSub.length}`);
  console.log(`  Q1: n=${q1.n}, 一致率=${q1.n > 0 ? (q1.matchRate * 100).toFixed(2) + '%' : 'NaN'}, permP=${Number.isNaN(q1.permP) ? 'NaN' : q1.permP.toFixed(4)}`);
  console.log(`  Q2(全): rho=${Number.isNaN(q2All.rho) ? 'NaN' : q2All.rho.toFixed(4)}, permP=${Number.isNaN(q2All.permP) ? 'NaN' : q2All.permP.toFixed(4)}`);
  console.log(`  Q2(|score|>=${CONFIDENCE_THRESHOLD}): n=${q2Sub.n}, rho=${Number.isNaN(q2Sub.rho) ? 'NaN' : q2Sub.rho.toFixed(4)}, permP=${Number.isNaN(q2Sub.permP) ? 'NaN' : q2Sub.permP.toFixed(4)}`);
}
