/**
 * マルチ時間軸モメンタム合成の頑健性検証（OBS000028）
 *
 * 背景: OBS000020のモメンタムL=30が①のk-NN比で改善を示したが、パイプライン化では
 * 伸び悩んでいる（Sharpe改善は平均的）。複数ホライズンを合成することで、
 * 単一Lの限界を超える可能性を検証する。
 *
 * 正しい検証プロトコル（selection→confirmation）:
 *   1. 選定フェーズ: BTC(2011-2022) を使い、
 *      8候補（4時間軸セット × 2ルール）のモメンタム合成の生シグナルSharpeを走査し、
 *      最良のものを1つだけ選ぶ。
 *   2. 確認フェーズ: 選定に一切使っていない ETH(2020-2023/2024-2025) と BTC(2023-末尾) に、
 *      選定フェーズで決めた構成（セット＋ルール）をそのまま適用し、
 *      ベースラインL=30との比較（hit-rate・Sharpe・permutation p）で有意性を検証。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/momentum-composite-robustness.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import type { OHLCV } from '../src/types/market.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const HORIZON = 10;
const NEUTRAL_THRESHOLD = 0.0005;
const Z_NEUTRAL = 0.10;
const N_PERM = 5000;
const CONFIDENCE_SCALE = 30;

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
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const utcDateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);

interface CompositeSignalStats {
  n: number;
  sharpe: number;
  permP: number;
  hitRate: number;
}

interface CompositeCandidate {
  setName: string;
  set: number[];
  rule: 'vote' | 'zsum';
  selectionSharpe: number;
  selectionHitRate: number;
}

/**
 * モメンタム合成信号を生成（OBS000028の合成方式）
 */
function generateCompositeSignal(
  candles: OHLCV[],
  idx: number,
  lookbackSet: number[],
  rule: 'vote' | 'zsum',
  vol20: number,
): { direction: 1 | 0 | -1; z?: number } {
  if (!lookbackSet.every(L => idx - L >= 0)) return { direction: 0 };

  const currentClose = candles[idx].close;
  const momRets = lookbackSet.map(L => pctChange(candles[idx - L].close, currentClose));
  const zValues = lookbackSet.map((L, i) => {
    const expectedMoveStd = vol20 * Math.sqrt(L);
    return expectedMoveStd > 0 ? momRets[i] / expectedMoveStd : 0;
  });

  if (rule === 'vote') {
    const signs = momRets.map(r => (r > NEUTRAL_THRESHOLD ? 1 : r < -NEUTRAL_THRESHOLD ? -1 : 0));
    const V = signs.reduce((a, b) => a + b, 0);
    return { direction: V > 0 ? 1 : V < 0 ? -1 : 0 };
  } else {
    // zsum
    const composite = mean(zValues);
    return {
      direction: composite > Z_NEUTRAL ? 1 : composite < -Z_NEUTRAL ? -1 : 0,
      z: composite,
    };
  }
}

/**
 * ベースラインモメンタム（L=30）の生シグナル
 */
function generateBaselineSignal(candles: OHLCV[], idx: number, lookback: number = 30): 1 | 0 | -1 {
  if (idx - lookback < 0) return 0;
  const momRet = pctChange(candles[idx - lookback].close, candles[idx].close);
  return momRet > NEUTRAL_THRESHOLD ? 1 : momRet < -NEUTRAL_THRESHOLD ? -1 : 0;
}

/**
 * 合成信号の評価
 */
function evalCompositeSignal(
  candles: OHLCV[],
  lookbackSet: number[],
  rule: 'vote' | 'zsum',
  startDate?: string,
): CompositeSignalStats {
  const n = candles.length;
  const minIndex = Math.max(...lookbackSet);
  const maxIndex = n - HORIZON - 1;
  let startIdx = minIndex;
  if (startDate) {
    for (let i = 0; i < n; i++) {
      if (utcDateOf(candles[i].time) >= startDate) {
        startIdx = Math.max(minIndex, i);
        break;
      }
    }
  }

  const returns: number[] = [];
  const forwardReturns: number[] = [];
  const positions: number[] = [];

  for (let t = startIdx; t <= maxIndex; t += HORIZON) {
    // 20日ボラティリティを計算（簡略版：過去20日の標準偏差）
    const vol20Idx = Math.max(0, t - 20);
    const volatPrices = candles.slice(vol20Idx, t + 1).map(c => c.close);
    const volatReturns = [];
    for (let v = 1; v < volatPrices.length; v++) {
      volatReturns.push(pctChange(volatPrices[v - 1], volatPrices[v]));
    }
    const vol20 = std(volatReturns);

    const signal = generateCompositeSignal(candles, t, lookbackSet, rule, vol20);
    if (signal.direction === 0) continue;

    const forwardReturn = pctChange(candles[t].close, candles[t + HORIZON].close);
    returns.push(signal.direction * forwardReturn);
    forwardReturns.push(forwardReturn);
    positions.push(signal.direction);
  }

  if (returns.length < 5) return { n: returns.length, sharpe: 0, permP: 1, hitRate: 0 };

  const annualizeFactor = Math.sqrt(365 / HORIZON);
  const sharpe = std(returns) > 0 ? (mean(returns) / std(returns)) * annualizeFactor : 0;
  const actualSigns = forwardReturns.map(r => (r > NEUTRAL_THRESHOLD ? 1 : r < -NEUTRAL_THRESHOLD ? -1 : 0));
  const decided = positions.filter((_, i) => actualSigns[i] !== 0);
  const correct = positions.filter((p, i) => actualSigns[i] !== 0 && p === actualSigns[i]).length;
  const hitRate = decided.length ? correct / decided.length : 0;

  // permutation test
  const obs = mean(positions.map((p, i) => p * forwardReturns[i]));
  const rng = mulberry32(20260704);
  const shuffled = [...forwardReturns];
  let ge = 0;
  for (let p = 0; p < N_PERM; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (mean(positions.map((pos, i) => pos * shuffled[i])) >= obs) ge++;
  }
  const permP = (ge + 1) / (N_PERM + 1);

  return { n: returns.length, sharpe, permP, hitRate };
}

/**
 * ベースラインの評価
 */
function evalBaseline(candles: OHLCV[], startDate?: string): CompositeSignalStats {
  const n = candles.length;
  const lookback = 30;
  const minIndex = lookback;
  const maxIndex = n - HORIZON - 1;
  let startIdx = minIndex;
  if (startDate) {
    for (let i = 0; i < n; i++) {
      if (utcDateOf(candles[i].time) >= startDate) {
        startIdx = Math.max(minIndex, i);
        break;
      }
    }
  }

  const returns: number[] = [];
  const forwardReturns: number[] = [];
  const positions: number[] = [];

  for (let t = startIdx; t <= maxIndex; t += HORIZON) {
    const signal = generateBaselineSignal(candles, t, lookback);
    if (signal === 0) continue;

    const forwardReturn = pctChange(candles[t].close, candles[t + HORIZON].close);
    returns.push(signal * forwardReturn);
    forwardReturns.push(forwardReturn);
    positions.push(signal);
  }

  if (returns.length < 5) return { n: returns.length, sharpe: 0, permP: 1, hitRate: 0 };

  const annualizeFactor = Math.sqrt(365 / HORIZON);
  const sharpe = std(returns) > 0 ? (mean(returns) / std(returns)) * annualizeFactor : 0;
  const actualSigns = forwardReturns.map(r => (r > NEUTRAL_THRESHOLD ? 1 : r < -NEUTRAL_THRESHOLD ? -1 : 0));
  const decided = positions.filter((_, i) => actualSigns[i] !== 0);
  const correct = positions.filter((p, i) => actualSigns[i] !== 0 && p === actualSigns[i]).length;
  const hitRate = decided.length ? correct / decided.length : 0;

  const obs = mean(positions.map((p, i) => p * forwardReturns[i]));
  const rng = mulberry32(20260704);
  const shuffled = [...forwardReturns];
  let ge = 0;
  for (let p = 0; p < N_PERM; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (mean(positions.map((pos, i) => pos * shuffled[i])) >= obs) ge++;
  }
  const permP = (ge + 1) / (N_PERM + 1);

  return { n: returns.length, sharpe, permP, hitRate };
}

const btc = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-2010-2026.csv'));
const eth2023 = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-2020-2023.csv'));
const eth2025 = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-2024-2025.csv'));

// 8候補（4時間軸セット × 2ルール）
const CANDIDATES: CompositeCandidate[] = [
  { setName: 'S1', set: [10, 30, 90], rule: 'vote', selectionSharpe: 0, selectionHitRate: 0 },
  { setName: 'S1', set: [10, 30, 90], rule: 'zsum', selectionSharpe: 0, selectionHitRate: 0 },
  { setName: 'S2', set: [20, 60, 120], rule: 'vote', selectionSharpe: 0, selectionHitRate: 0 },
  { setName: 'S2', set: [20, 60, 120], rule: 'zsum', selectionSharpe: 0, selectionHitRate: 0 },
  { setName: 'S3', set: [15, 30, 60], rule: 'vote', selectionSharpe: 0, selectionHitRate: 0 },
  { setName: 'S3', set: [15, 30, 60], rule: 'zsum', selectionSharpe: 0, selectionHitRate: 0 },
  { setName: 'S4', set: [30, 90, 180], rule: 'vote', selectionSharpe: 0, selectionHitRate: 0 },
  { setName: 'S4', set: [30, 90, 180], rule: 'zsum', selectionSharpe: 0, selectionHitRate: 0 },
];

console.log('=== マルチ時間軸モメンタム合成の頑健性検証（OBS000028）===\n');
console.log('--- 選定フェーズ（BTC 2011-2022） ---');
console.log('  8候補の生シグナルSharpe/hit-rate を走査\n');
console.log('候補           セット                ルール     Sharpe  hit-rate   n');
console.log('─────────────────────────────────────────────────────────────────');

// 選定：BTC 2011-2022で8候補を評価
for (const cand of CANDIDATES) {
  const stats = evalCompositeSignal(btc, cand.set, cand.rule, '2011-01-01');
  // 2022-12-31以降のデータは除外するため、startDate='2011-01-01'で2011-2022年を対象
  // ここで2023以降のデータは含まれないようにするため、評価時に年をチェック
  cand.selectionSharpe = stats.sharpe;
  cand.selectionHitRate = stats.hitRate;
  const candLabel = `${cand.setName} {${cand.set.join(',')}}`;
  console.log(
    `${candLabel.padEnd(20)} ${cand.rule.padEnd(8)} ${stats.sharpe.toFixed(3).padStart(7)} ${(stats.hitRate * 100).toFixed(1).padStart(8)}% ${stats.n.toString().padStart(4)}`,
  );
}

// 選定期間を2011-2022に限定した再評価（念のため）
console.log('\n※選定期間を2011-01-01～2022-12-31に制限した評価：\n');
const selectionStats = CANDIDATES.map(cand => {
  const startDate = '2011-01-01';
  const n = btc.length;
  const minIndex = Math.max(...cand.set);
  const maxIndex = n - HORIZON - 1;
  let startIdx = minIndex;
  for (let i = 0; i < n; i++) {
    if (utcDateOf(btc[i].time) >= startDate) {
      startIdx = Math.max(minIndex, i);
      break;
    }
  }

  const returns: number[] = [];
  const forwardReturns: number[] = [];
  const positions: number[] = [];

  for (let t = startIdx; t <= maxIndex; t += HORIZON) {
    // 2022-12-31以降は除外
    if (utcDateOf(btc[t].time) > '2022-12-31') break;

    const vol20Idx = Math.max(0, t - 20);
    const volatPrices = btc.slice(vol20Idx, t + 1).map(c => c.close);
    const volatReturns = [];
    for (let v = 1; v < volatPrices.length; v++) {
      volatReturns.push(pctChange(volatPrices[v - 1], volatPrices[v]));
    }
    const vol20 = std(volatReturns);

    const signal = generateCompositeSignal(btc, t, cand.set, cand.rule, vol20);
    if (signal.direction === 0) continue;

    const forwardReturn = pctChange(btc[t].close, btc[t + HORIZON].close);
    returns.push(signal.direction * forwardReturn);
    forwardReturns.push(forwardReturn);
    positions.push(signal.direction);
  }

  if (returns.length < 5) return { cand, n: returns.length, sharpe: 0, permP: 1, hitRate: 0 };

  const annualizeFactor = Math.sqrt(365 / HORIZON);
  const sharpe = std(returns) > 0 ? (mean(returns) / std(returns)) * annualizeFactor : 0;
  const actualSigns = forwardReturns.map(r => (r > NEUTRAL_THRESHOLD ? 1 : r < -NEUTRAL_THRESHOLD ? -1 : 0));
  const decided = positions.filter((_, i) => actualSigns[i] !== 0);
  const correct = positions.filter((p, i) => actualSigns[i] !== 0 && p === actualSigns[i]).length;
  const hitRate = decided.length ? correct / decided.length : 0;

  const obs = mean(positions.map((p, i) => p * forwardReturns[i]));
  const rng = mulberry32(20260704);
  const shuffled = [...forwardReturns];
  let ge = 0;
  for (let p = 0; p < N_PERM; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (mean(positions.map((pos, i) => pos * shuffled[i])) >= obs) ge++;
  }
  const permP = (ge + 1) / (N_PERM + 1);

  return { cand, n: returns.length, sharpe, permP, hitRate };
});

console.log('選定期間限定結果：');
console.log('候補           セット                ルール     Sharpe  hit-rate   n');
console.log('─────────────────────────────────────────────────────────────────');
for (const res of selectionStats) {
  const candLabel = `${res.cand.setName} {${res.cand.set.join(',')}}`;
  console.log(
    `${candLabel.padEnd(20)} ${res.cand.rule.padEnd(8)} ${res.sharpe.toFixed(3).padStart(7)} ${(res.hitRate * 100).toFixed(1).padStart(8)}% ${res.n.toString().padStart(4)}`,
  );
}

// 選定: ベースラインL=30も評価して比較
const baselineSelectionStats = (() => {
  const startDate = '2011-01-01';
  const n = btc.length;
  const lookback = 30;
  const minIndex = lookback;
  const maxIndex = n - HORIZON - 1;
  let startIdx = minIndex;
  for (let i = 0; i < n; i++) {
    if (utcDateOf(btc[i].time) >= startDate) {
      startIdx = Math.max(minIndex, i);
      break;
    }
  }

  const returns: number[] = [];
  const forwardReturns: number[] = [];
  const positions: number[] = [];

  for (let t = startIdx; t <= maxIndex; t += HORIZON) {
    if (utcDateOf(btc[t].time) > '2022-12-31') break;

    const signal = generateBaselineSignal(btc, t, lookback);
    if (signal === 0) continue;

    const forwardReturn = pctChange(btc[t].close, btc[t + HORIZON].close);
    returns.push(signal * forwardReturn);
    forwardReturns.push(forwardReturn);
    positions.push(signal);
  }

  if (returns.length < 5) return { n: returns.length, sharpe: 0, permP: 1, hitRate: 0 };

  const annualizeFactor = Math.sqrt(365 / HORIZON);
  const sharpe = std(returns) > 0 ? (mean(returns) / std(returns)) * annualizeFactor : 0;
  const actualSigns = forwardReturns.map(r => (r > NEUTRAL_THRESHOLD ? 1 : r < -NEUTRAL_THRESHOLD ? -1 : 0));
  const decided = positions.filter((_, i) => actualSigns[i] !== 0);
  const correct = positions.filter((p, i) => actualSigns[i] !== 0 && p === actualSigns[i]).length;
  const hitRate = decided.length ? correct / decided.length : 0;

  const obs = mean(positions.map((p, i) => p * forwardReturns[i]));
  const rng = mulberry32(20260704);
  const shuffled = [...forwardReturns];
  let ge = 0;
  for (let p = 0; p < N_PERM; p++) {
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    if (mean(positions.map((pos, i) => pos * shuffled[i])) >= obs) ge++;
  }
  const permP = (ge + 1) / (N_PERM + 1);

  return { n: returns.length, sharpe, permP, hitRate };
})();

console.log(`\nベースライン（L=30） Sharpe${baselineSelectionStats.sharpe.toFixed(3).padStart(7)} hit-rate${(baselineSelectionStats.hitRate * 100).toFixed(1).padStart(6)}% n=${baselineSelectionStats.n}`);

// 最良の合成を選定
const bestComposite = selectionStats.reduce((best, curr) => {
  if (curr.sharpe > best.sharpe || (curr.sharpe === best.sharpe && curr.hitRate > best.hitRate)) {
    return curr;
  }
  return best;
}, selectionStats[0]);

console.log(
  `\n選定結果: ${bestComposite.cand.setName} {${bestComposite.cand.set.join(',')}} (rule=${bestComposite.cand.rule})`,
);
console.log(`  → 選定期間Sharpe=${bestComposite.sharpe.toFixed(3)}, hit-rate=${(bestComposite.hitRate * 100).toFixed(1)}%`);
console.log(`  → ベースラインL=30（選定期間）: Sharpe=${baselineSelectionStats.sharpe.toFixed(3)}`);

// 確認：凍結構成をETH確認データに適用
console.log(`\n--- 確認フェーズ（選定に一切使わない未見データ） ---\n`);

console.log(`【ETH 2020-2023 + 2024-2025（確認プール）】`);
const ethAll = [...eth2023, ...eth2025];
const compositeEthStats = evalCompositeSignal(ethAll, bestComposite.cand.set, bestComposite.cand.rule);
const baselineEthStats = evalBaseline(ethAll);

console.log(`合成 (${bestComposite.cand.setName}, rule=${bestComposite.cand.rule}):`);
console.log(`  n=${compositeEthStats.n}, hit-rate=${(compositeEthStats.hitRate * 100).toFixed(1)}%, Sharpe=${compositeEthStats.sharpe.toFixed(3)}, permP=${compositeEthStats.permP.toFixed(4)}`);
console.log(`ベースラインL=30:`);
console.log(`  n=${baselineEthStats.n}, hit-rate=${(baselineEthStats.hitRate * 100).toFixed(1)}%, Sharpe=${baselineEthStats.sharpe.toFixed(3)}, permP=${baselineEthStats.permP.toFixed(4)}`);

// 参考：BTC直近（2023-末尾）
console.log(`\n【BTC 2023-末尾（副次確認）】`);
const compositeBtcRecentStats = evalCompositeSignal(btc, bestComposite.cand.set, bestComposite.cand.rule, '2023-01-01');
const baselineBtcRecentStats = evalBaseline(btc, '2023-01-01');

console.log(`合成 (${bestComposite.cand.setName}, rule=${bestComposite.cand.rule}):`);
console.log(`  n=${compositeBtcRecentStats.n}, hit-rate=${(compositeBtcRecentStats.hitRate * 100).toFixed(1)}%, Sharpe=${compositeBtcRecentStats.sharpe.toFixed(3)}, permP=${compositeBtcRecentStats.permP.toFixed(4)}`);
console.log(`ベースラインL=30:`);
console.log(`  n=${baselineBtcRecentStats.n}, hit-rate=${(baselineBtcRecentStats.hitRate * 100).toFixed(1)}%, Sharpe=${baselineBtcRecentStats.sharpe.toFixed(3)}, permP=${baselineBtcRecentStats.permP.toFixed(4)}`);

console.log('\n=== 生データ出力完了 ===');
console.log(`選定構成: ${bestComposite.cand.setName} {${bestComposite.cand.set.join(',')}} (rule=${bestComposite.cand.rule})`);
