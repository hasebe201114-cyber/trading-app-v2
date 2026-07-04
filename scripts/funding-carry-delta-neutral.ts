/**
 * デルタヘッジ版 Funding Rateキャリー戦略の本格検証（OBS000022後続）
 *
 * OBS000022で「方向性シグナルとしてのFunding Rate」は不採用となったが、
 * 「デルタヘッジ前提の理論キャリー利回り（年率13-16%）」は基盤投資が必要な別課題として
 * 保留されていた。本スクリプトはそのデルタヘッジ版を実際にシミュレートする。
 *
 * 戦略: 現物ロング + 無期限先物ショート（またはその逆）でデルタニュートラルを維持し、
 * Funding Rateを徴収し続ける（cash-and-carry / キャッシュ&キャリー取引）。
 * fundingRate>0 のときは「現物ロング+先物ショート」（ロングがショートに支払う＝ショートが受取）、
 * fundingRate<0 のときは「現物ショート+先物ロング」（逆）でポジションを取る。
 *
 * 重要な簡略化（要継続検証）:
 *   - 本環境では無期限先物の価格系列を別途取得しておらず、現物価格で代用している。
 *     Funding Rateメカニズムにより先物価格は現物に収束するよう設計されているため、
 *     平時のベーシスは小さいと仮定するが、急変時のベーシス拡大リスクは未モデル化。
 *   - レジーム判定は生のFunding Rateだと日々のノイズで頻繁に反転しうるため、
 *     直近W日平均で平滑化してから符号判定する（実運用のヒステリシスに相当）。
 *   - レジーム反転時のみ、現物・先物それぞれの手数料・スリッページ（往復4レッグ分)を
 *     控除する（既存のDEFAULT_EXECUTION_COSTと同水準を仮定）。
 *   - 資本効率: デルタヘッジには現物ロング分＋先物証拠金の資本が必要。本シミュレーションは
 *     「現物ノーション基準の利回り」を主指標とし、証拠金効率化（クロスマージン等）による
 *     資本効率の改善余地は考慮していない（保守的な下限として扱う）。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/funding-carry-delta-neutral.ts
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { loadDailyFundingRate } from './loadFundingRateData.ts';
import { DEFAULT_EXECUTION_COST } from '../src/execution-layer/types.ts';
import type { OHLCV } from '../src/types/market.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const utcDateOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

// レッグあたり片道コスト（既存の執行コストモデルと同水準）。反転時は現物・先物それぞれ
// クローズ+オープンの往復が発生するため、1レッグ往復 = 2 x (fee+slippage)、2レッグで4倍。
const ONE_WAY_COST = DEFAULT_EXECUTION_COST.takerFeeRate + DEFAULT_EXECUTION_COST.slippageRate;
const FLIP_COST = 4 * ONE_WAY_COST; // 現物+先物 x 往復(クローズ+オープン)

interface CarryResult {
  days: number;
  flips: number;
  grossAnnualizedYield: number;
  netAnnualizedYield: number;
  netSharpe: number;
  totalCostDrag: number;
}

function simulateDeltaNeutralCarry(
  candles: OHLCV[],
  funding: Map<string, { fundingRateDaily: number }>,
  smoothingWindow: number,
): CarryResult {
  const dailyRates: number[] = candles.map(c => funding.get(utcDateOf(c.time))?.fundingRateDaily ?? 0);
  const n = dailyRates.length;

  const grossReturns: number[] = [];
  const netReturns: number[] = [];
  let currentRegime = 0; // +1: 現物ロング+先物ショート(fundingRate>0側で収益) / -1: 逆
  let flips = 0;

  for (let t = smoothingWindow; t < n; t++) {
    const window = dailyRates.slice(t - smoothingWindow, t); // 前日までのwindow日平均（先読み防止）
    const smoothed = mean(window);
    const targetRegime = smoothed > 0 ? 1 : smoothed < 0 ? -1 : currentRegime;

    let costToday = 0;
    if (targetRegime !== currentRegime && targetRegime !== 0) {
      if (currentRegime !== 0) costToday = FLIP_COST; // 初回のポジション確立はコストなしとみなす（簡略化）
      currentRegime = targetRegime;
      flips++;
    }

    const grossPnl = currentRegime * dailyRates[t]; // 現在のレジームで実際に受け取る(またはマイナスなら支払う)funding
    grossReturns.push(grossPnl);
    netReturns.push(grossPnl - costToday);
  }

  const grossAnnualizedYield = mean(grossReturns) * 365;
  const netAnnualizedYield = mean(netReturns) * 365;
  const netSharpe = std(netReturns) > 0 ? (mean(netReturns) / std(netReturns)) * Math.sqrt(365) : 0;
  const totalCostDrag = grossAnnualizedYield - netAnnualizedYield;

  return { days: netReturns.length, flips, grossAnnualizedYield, netAnnualizedYield, netSharpe, totalCostDrag };
}

const btcCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
const ethCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));
const btcFunding = loadDailyFundingRate(join(DATA_DIR, 'btc-funding-2019-2026.csv'));
const ethFunding = loadDailyFundingRate(join(DATA_DIR, 'eth-funding-2019-2026.csv'));

console.log('=== デルタヘッジ版 Funding Rateキャリー戦略の検証 ===\n');
console.log(`片道執行コスト想定: fee${(DEFAULT_EXECUTION_COST.takerFeeRate * 100).toFixed(2)}% + slippage${(DEFAULT_EXECUTION_COST.slippageRate * 100).toFixed(2)}% = ${(ONE_WAY_COST * 100).toFixed(2)}%`);
console.log(`反転時コスト(現物+先物 x 往復) = ${(FLIP_COST * 100).toFixed(2)}%\n`);

const fmt = (r: CarryResult): string =>
  `days=${r.days} flips=${r.flips} 総コスト控除=${(r.totalCostDrag * 100).toFixed(2)}%/年  総利回り(粗)=${(r.grossAnnualizedYield * 100).toFixed(1)}%/年 → (純)=${(r.netAnnualizedYield * 100).toFixed(1)}%/年  Sharpe(純,年率)=${r.netSharpe.toFixed(2)}`;

console.log('--- 平滑化窓の感度（BTC全期間）---');
for (const w of [1, 3, 7, 14, 30]) {
  const r = simulateDeltaNeutralCarry(btcCandles, btcFunding, w);
  console.log(`window=${String(w).padEnd(3)} ${fmt(r)}`);
}

console.log('\n--- 主要結果（window=3、日次ノイズを軽く均す程度）---');
const btcResult = simulateDeltaNeutralCarry(btcCandles, btcFunding, 3);
const ethResult = simulateDeltaNeutralCarry(ethCandles, ethFunding, 3);
console.log(`BTC: ${fmt(btcResult)}`);
console.log(`ETH: ${fmt(ethResult)}`);

console.log('\n--- 直近期間のみ（2023年以降、環境変化への感応度確認）---');
function sliceFrom(candles: OHLCV[], date: string): OHLCV[] {
  const idx = candles.findIndex(c => utcDateOf(c.time) >= date);
  return idx >= 0 ? candles.slice(idx) : [];
}
const btcRecent = simulateDeltaNeutralCarry(sliceFrom(btcCandles, '2023-01-01'), btcFunding, 3);
const ethRecent = simulateDeltaNeutralCarry(sliceFrom(ethCandles, '2023-01-01'), ethFunding, 3);
console.log(`BTC(2023-2026): ${fmt(btcRecent)}`);
console.log(`ETH(2023-2026): ${fmt(ethRecent)}`);

console.log('\n=== 判定 ===');
console.log(`反転コストの影響: BTC全期間で年率${(btcResult.totalCostDrag * 100).toFixed(2)}pt、直近で${(btcRecent.totalCostDrag * 100).toFixed(2)}pt控除（flips=${btcRecent.flips}件/${btcRecent.days}日）`);
if (btcResult.netAnnualizedYield > 0.05 && btcRecent.netAnnualizedYield > 0.03) {
  console.log('✅ 反転コスト控除後も年率5%超（直近でも3%超）のプラス利回りが残る。本格実装（実際の先物価格取得・証拠金管理設計）を検討する価値がある。');
} else if (btcResult.netAnnualizedYield > 0) {
  console.log('△ 反転コスト控除後もプラスだが薄い。資本効率(証拠金)・実際の先物価格とのベーシスを含めるとさらに目減りする可能性が高く、実装投資に見合うか要精査。');
} else {
  console.log('⚠️ 反転コストを控除すると純利回りがマイナスに転じる。この単純な平滑化レジーム方式ではデルタヘッジ版キャリーは割に合わない。');
}
