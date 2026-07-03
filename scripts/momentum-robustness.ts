/**
 * トレンドフォロー(モメンタム)戦略の頑健性検証（OBS000019後続）
 *
 * 背景: OBS000019のETHクロス検証で、②(k-NN)はBTC/ETHいずれの期間でも優位性が
 * 再現しなかった一方、ETH2024-2025で単純なトレンドフォロー(モメンタム)が
 * Sharpe2.63・p=0.0024と強く有意という副次的発見があった。
 * ただし複数パラメータ・複数データセットを試した中の1つであり、多重検定で
 * 「たまたま当たった」可能性を排除できていない。
 *
 * 正しい検証プロトコル（selection→confirmation）:
 *   1. 選定フェーズ: BTC(2021-2026連続) と ETH(2020-2023) を使い、
 *      複数のlookback(L)でモメンタムのSharpe/permPを走査し、最良のLを選ぶ。
 *      ※ここで複数L×複数データセットを試すこと自体が多重検定なので、
 *        この段階の「有意」は参考値に過ぎない。
 *   2. 確認フェーズ: 選定に一切使っていない ETH(2024-2025) に、選定フェーズで
 *      決めたL（このデータを見ずに決めた値）をそのまま適用し、なお有意かを見る。
 *      ここで有意なら初めて「たまたまではない」と言える一次的な証拠になる。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/momentum-robustness.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import type { OHLCV } from '../src/types/market.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const HORIZON = 10;
const NEUTRAL_THRESHOLD = 0.0005;
const N_PERM = 5000;

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

interface MomentumStats { n: number; sharpe: number; permP: number; hitRate: number; }

function evalMomentum(candles: OHLCV[], lookback: number, startDate?: string): MomentumStats {
  const n = candles.length;
  const minIndex = lookback;
  const maxIndex = n - HORIZON - 1;
  let startIdx = minIndex;
  if (startDate) {
    for (let i = 0; i < n; i++) { if (utcDateOf(candles[i].time) >= startDate) { startIdx = Math.max(minIndex, i); break; } }
  }
  const returns: number[] = [];
  const forwardReturns: number[] = [];
  const positions: number[] = [];
  for (let t = startIdx; t <= maxIndex; t += HORIZON) {
    const momRet = pctChange(candles[t - lookback].close, candles[t].close);
    const sign = momRet > NEUTRAL_THRESHOLD ? 1 : momRet < -NEUTRAL_THRESHOLD ? -1 : 0;
    if (sign === 0) continue;
    const forwardReturn = pctChange(candles[t].close, candles[t + HORIZON].close);
    returns.push(sign * forwardReturn);
    forwardReturns.push(forwardReturn);
    positions.push(sign);
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

const LOOKBACKS = [10, 15, 20, 30, 40, 60];

console.log('=== モメンタム頑健性検証（選定→確認プロトコル）===\n');
console.log('--- 選定フェーズ（BTC 2021-2026連続 + ETH 2020-2023）---');
console.log('lookback  BTC(2021-2026) Sharpe/permP        ETH(2020-2023) Sharpe/permP');

interface SelRow { L: number; btcSharpe: number; btcP: number; ethSharpe: number; ethP: number; }
const selRows: SelRow[] = [];
for (const L of LOOKBACKS) {
  const btcStats = evalMomentum(btc, L, '2021-01-01');
  const ethStats = evalMomentum(eth2023, L);
  selRows.push({ L, btcSharpe: btcStats.sharpe, btcP: btcStats.permP, ethSharpe: ethStats.sharpe, ethP: ethStats.permP });
  console.log(`L=${String(L).padEnd(3)}     Sharpe${btcStats.sharpe.toFixed(2).padStart(6)} permP${btcStats.permP.toFixed(3)}${btcStats.permP < 0.05 ? '★' : ' '} (n=${btcStats.n})    Sharpe${ethStats.sharpe.toFixed(2).padStart(6)} permP${ethStats.permP.toFixed(3)}${ethStats.permP < 0.05 ? '★' : ' '} (n=${ethStats.n})`);
}

// 選定基準: 両データセットで有意(p<0.05)かつSharpeが正であるLの中から、合計Sharpeが最良のものを選ぶ
const bothSignificant = selRows.filter(r => r.btcP < 0.05 && r.ethP < 0.05 && r.btcSharpe > 0 && r.ethSharpe > 0);
const candidates = bothSignificant.length > 0 ? bothSignificant : selRows;
const chosen = candidates.sort((a, b) => (b.btcSharpe + b.ethSharpe) - (a.btcSharpe + a.ethSharpe))[0];
console.log(`\n選定結果: L=${chosen.L}（両データセットで${bothSignificant.length > 0 ? '有意かつ正のSharpeのうち最良' : '有意な候補なし・参考選定'}）`);
console.log('※この段階の有意性は複数L×複数データセットを試した多重検定の産物であり、参考値に過ぎない。');

console.log(`\n--- 確認フェーズ（ETH 2024-2025・選定に一切使っていない未見データ、L=${chosen.L}固定）---`);
const confirmStats = evalMomentum(eth2025, chosen.L);
console.log(`n=${confirmStats.n}, 的中率=${(confirmStats.hitRate * 100).toFixed(1)}%, Sharpe=${confirmStats.sharpe.toFixed(2)}, permP=${confirmStats.permP.toFixed(4)} ${confirmStats.permP < 0.05 ? '★有意' : '有意でない'}`);

// 参考: BTC直近期間（2023-2026）でも追加確認
console.log(`\n--- 追加参考（BTC 2023-2026直近・同じくL=${chosen.L}固定で未見データ確認）---`);
const btcRecentStats = evalMomentum(btc, chosen.L, '2023-04-01');
console.log(`n=${btcRecentStats.n}, 的中率=${(btcRecentStats.hitRate * 100).toFixed(1)}%, Sharpe=${btcRecentStats.sharpe.toFixed(2)}, permP=${btcRecentStats.permP.toFixed(4)} ${btcRecentStats.permP < 0.05 ? '★有意' : '有意でない'}`);

console.log('\n=== 判定 ===');
if (confirmStats.permP < 0.05 && confirmStats.sharpe > 0) {
  console.log(`✅ 選定に使っていないETH(2024-2025)でL=${chosen.L}のモメンタムが有意(p=${confirmStats.permP.toFixed(3)})に確認できた。`);
  console.log('   多重検定の産物ではない一次的な証拠が得られた。②の後継候補として正式な統合検証(パイプライン化)に進む価値がある。');
} else {
  console.log(`⚠️ 選定に使っていないETH(2024-2025)ではL=${chosen.L}のモメンタムは有意でない(p=${confirmStats.permP.toFixed(3)})。`);
  console.log('   選定フェーズの「有意」は多重検定によるものだった可能性が高い。モメンタム単体をこのまま採用するのは時期尚早。');
}
