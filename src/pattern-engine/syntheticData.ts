/**
 * PoC検証用の合成データ生成器。
 * 実相場データではなく、モメンタム持続性（ret[t] は ret[t-1] と相関する）を
 * 意図的に注入した価格系列を作る。パターン認識ロジックが「注入した規則性」を
 * 検出できるかどうかの動作確認（実市場での優位性を主張するものではない）。
 */
import type { OHLCV } from '../types/market.ts';

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateMomentumSyntheticSeries(
  n: number,
  seed: number = 42,
  momentumStrength: number = 0.35,
): OHLCV[] {
  const rng = mulberry32(seed);
  const candles: OHLCV[] = [];
  let price = 100;
  let prevReturn = 0;

  for (let i = 0; i < n; i++) {
    const noise = (rng() - 0.5) * 0.02;
    const ret = prevReturn * momentumStrength + noise;
    price = Math.max(0.01, price * (1 + ret));

    const open = price * (1 - noise * 0.1);
    const high = price * (1 + Math.abs(noise) * 0.5);
    const low = price * (1 - Math.abs(noise) * 0.5);
    const volume = 1000 + rng() * 500;

    candles.push({ time: i, open, high, low, close: price, volume });
    prevReturn = ret;
  }

  return candles;
}

/** モメンタムを一切注入しない純粋ランダムウォーク（比較対照用） */
export function generateRandomWalkSeries(n: number, seed: number = 7): OHLCV[] {
  return generateMomentumSyntheticSeries(n, seed, 0);
}
