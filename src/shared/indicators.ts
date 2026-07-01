/**
 * 統一指標計算エンジン
 * ブラウザ・サーバー双方で使用する canonical 実装
 * フロントエンド・バックテスト・ライブトレードで同一の計算結果を保証
 */

/** EMA（指数加重移動平均） */
export function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;

  if (prices.length < period) {
    return prices.reduce((a, b) => a + b) / prices.length;
  }

  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b) / period;

  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * multiplier + ema * (1 - multiplier);
  }

  return ema;
}

/** RSI（相対力指数） */
export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50;

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  let gains = 0;
  let losses = 0;

  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) {
      gains += changes[i];
    } else {
      losses += Math.abs(changes[i]);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < changes.length; i++) {
    if (changes[i] > 0) {
      avgGain = (avgGain * (period - 1) + changes[i]) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(changes[i])) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return rsi;
}

/** MACD（移動平均収束発散） */
export function calculateMACD(
  prices: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { macd: number; signal: number; histogram: number } {
  if (prices.length < slowPeriod) return { macd: 0, signal: 0, histogram: 0 };

  const emaFast = calculateEMA(prices, fastPeriod);
  const emaSlow = calculateEMA(prices, slowPeriod);
  const macd = emaFast - emaSlow;

  const macdValues: number[] = [];
  for (let i = Math.max(0, prices.length - slowPeriod); i < prices.length; i++) {
    const sliced = prices.slice(0, i + 1);
    if (sliced.length >= slowPeriod) {
      macdValues.push(calculateEMA(sliced, fastPeriod) - calculateEMA(sliced, slowPeriod));
    }
  }

  const signal = macdValues.length >= signalPeriod ? calculateEMA(macdValues, signalPeriod) : macd;
  const histogram = macd - signal;

  return { macd, signal, histogram };
}

/** ボリンジャーバンド */
export function calculateBollingerBands(
  prices: number[],
  period: number = 20,
  stdDev: number = 2,
): { upper: number; middle: number; lower: number } {
  if (prices.length < period) {
    const price = prices[prices.length - 1];
    return { upper: price * 1.02, middle: price, lower: price * 0.98 };
  }

  const recentPrices = prices.slice(-period);
  const middle = recentPrices.reduce((a, b) => a + b) / period;

  const squaredDiffs = recentPrices.map((p) => Math.pow(p - middle, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b) / period;
  const stdev = Math.sqrt(variance);

  const upper = middle + stdDev * stdev;
  const lower = middle - stdDev * stdev;

  return { upper, middle, lower };
}

/** ストキャスティクス */
export function calculateStochastic(
  closes: number[],
  highs: number[],
  lows: number[],
  period: number = 14,
): { k: number; d: number } {
  if (closes.length < period) return { k: 50, d: 50 };

  const recentCloses = closes.slice(-period);
  const recentHighs = highs.slice(-period);
  const recentLows = lows.slice(-period);

  const highest = Math.max(...recentHighs);
  const lowest = Math.min(...recentLows);
  const currentClose = closes[closes.length - 1];

  const k = highest - lowest === 0 ? 50 : ((currentClose - lowest) / (highest - lowest)) * 100;

  const kValues: number[] = [];
  for (let i = Math.max(0, closes.length - 14); i < closes.length; i++) {
    const sliced = closes.slice(i - period + 1, i + 1);
    const slicedH = highs.slice(i - period + 1, i + 1);
    const slicedL = lows.slice(i - period + 1, i + 1);
    if (sliced.length === period) {
      const h = Math.max(...slicedH);
      const l = Math.min(...slicedL);
      kValues.push(h - l === 0 ? 50 : ((sliced[sliced.length - 1] - l) / (h - l)) * 100);
    }
  }

  const d = kValues.length >= 3 ? kValues.slice(-3).reduce((a, b) => a + b) / 3 : k;

  return { k, d };
}

/** ATR（平均真の値） */
export function calculateATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period: number = 14,
): number {
  if (closes.length < period + 1) return 0;

  const trValues: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevClose = closes[i - 1];

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    trValues.push(tr);
  }

  if (trValues.length < period) {
    return trValues.reduce((a, b) => a + b) / trValues.length;
  }

  const atrValue = trValues.slice(-period).reduce((a, b) => a + b) / period;
  return atrValue;
}

/** サポート・レジスタンスレベル */
export function detectSupportResistance(prices: number[]): {
  support1: number;
  support2: number;
  support3: number;
  resistance1: number;
  resistance2: number;
  resistance3: number;
} {
  if (prices.length < 20) {
    const price = prices[prices.length - 1];
    return {
      support1: price * 0.98,
      support2: price * 0.96,
      support3: price * 0.94,
      resistance1: price * 1.02,
      resistance2: price * 1.04,
      resistance3: price * 1.06,
    };
  }

  const recentPrices = prices.slice(-30);
  const minPrice = Math.min(...recentPrices);
  const maxPrice = Math.max(...recentPrices);
  const currentPrice = prices[prices.length - 1];
  const range = maxPrice - minPrice;

  const support1 = currentPrice - range * 0.15;
  const support2 = currentPrice - range * 0.3;
  const support3 = currentPrice - range * 0.45;

  const resistance1 = currentPrice + range * 0.15;
  const resistance2 = currentPrice + range * 0.3;
  const resistance3 = currentPrice + range * 0.45;

  return {
    support1,
    support2,
    support3,
    resistance1,
    resistance2,
    resistance3,
  };
}

/** フィボナッチレベル */
export function calculateFibonacci(prices: number[]): {
  high: number;
  low: number;
  levels: { ratio: number; price: number }[];
} {
  if (prices.length < 2) return { high: 0, low: 0, levels: [] };

  const recent = prices.slice(-50);
  const high = Math.max(...recent);
  const low = Math.min(...recent);
  const range = high - low;

  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const levels = ratios.map((ratio) => ({
    ratio,
    price: low + range * ratio,
  }));

  return { high, low, levels };
}
