/**
 * Stage 1-C: キャリー×②合成（限界寄与検定）（21-verdict-stage1-v2.md 差し戻し反映・再実装）
 *
 * spec §6-C・§7:
 * - スリーブ: Stage 1-B（3倍・w*サイズ・清算込み）の日次純リターン（BTC/ETH等ウェイト合算）
 * - ②単体: simulatePortfolio をBTC本番構成（momentumLookback:30, momentumConfidenceScale:30,
 *   horizon:10, k:30, initialEquity:1_000_000）で実際に呼び出し、equityCurveから日次リターン列を得る。
 * - 選定期間（2019-09〜2021-12）の[スリーブ, ②単体]日次リターンの標準偏差から逆ボラ(リスクパリティ)
 *   ウェイトを算出し凍結。確認期間（2022-01〜末尾）ではこの凍結ウェイトのみ適用。素朴50/50も併記。
 *
 * 21-verdict-stage1-v2.md 差し戻し反映:
 * - バグJ修正: 手製の裸±1モメンタムを撤廃し、import済み simulatePortfolio を実際に呼び出す。
 * - バグI修正: G4C判定式を正しいオペランド・不等号で実装（合成−②単体、DDは合成−②単体≤−5pt）。
 *   「✓-」等の捏造表示を撤廃し、実値をそのまま出力する。
 * - バグH修正: maxDDを複利エクイティカーブ（Π(1+r)のピーク比）で算出し0〜100%に有界化。
 *   returnPctの二重100倍スケールを解消（単位はStage1-Bのbps→%変換1回のみ）。
 * - 入力是正: スリーブをStage1-B（バグF/G修正後）の3倍・w*サイジング込み清算シミュ結果に
 *   差し替え（無レバのStage1-A系列を使わない）。凍結ウェイトは0.5/0.5ハードコードをやめ、
 *   選定期間2019-09〜2021-12の実測標準偏差から算出する。
 * - frozenWeightsの意味論修正: 旧実装は{btc,eth}という誤った軸で0.5/0.5ハードコードしていたが、
 *   spec §6-Cが要求する凍結ウェイトは「スリーブ(BTC/ETH等ウェイト合算後) vs ②単体」の2軸。
 *   BTC/ETHの合算自体はspecが明示的に等ウェイトとして固定している（§6-C1文目）。
 *
 * 判定語（達成/採用/不採用等）は一切使用しない。生数値・真偽値（式の結果）のみ出力する。
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { simulatePortfolio } from '../src/pipeline/simulatePortfolio.ts';
import type { OHLCV } from '../src/types/market.ts';
import type { EquityPoint } from '../src/risk-layer/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const HORIZON = 10;
const K = 30;
const MOMENTUM_L = 30;
const CONFIDENCE_SCALE = 30;
const INITIAL_EQUITY = 1_000_000;

const SELECTION_START = '2019-09-10';
const SELECTION_END = '2021-12-31';
const CONFIRM_START = '2022-01-01';

interface DailyReturnRow { date: string; returnPct: number }

interface Metrics {
  n: number;
  mean_pct: number;
  std_pct: number;
  sharpe_annualized_sqrt365: number;
  maxDrawdown_pct: number; // 複利エクイティカーブベース・0〜100%有界
  cumReturn_pct: number; // 複利
}

function utcDateOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function candleIndexAtOrAfter(candles: OHLCV[], date: string): number {
  for (let i = 0; i < candles.length; i++) if (utcDateOf(candles[i].time) >= date) return i;
  return candles.length;
}

/** カレンダー日付の配列（両端含む） */
function allDatesBetween(startISO: string, endISO: string): string[] {
  const dates: string[] = [];
  let cur = new Date(`${startISO}T00:00:00Z`).getTime();
  const end = new Date(`${endISO}T00:00:00Z`).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  while (cur <= end) {
    dates.push(new Date(cur).toISOString().slice(0, 10));
    cur += DAY;
  }
  return dates;
}

/**
 * equityCurve（トレード決済ごとのタイムスタンプ+エクイティ）を日次リターン列に変換する。
 * 決済のない日はエクイティを前値のまま据え置く（フラット＝日次リターン0）。
 * 決済のあった日にそのトレードの実現リターンが計上される（バグJ修正: simulatePortfolioを
 * 実際に本番構成で呼び出した結果のequityCurveをそのまま使う）。
 */
function equityCurveToDailyReturns(equityCurve: EquityPoint[]): DailyReturnRow[] {
  if (equityCurve.length === 0) return [];
  const startDate = utcDateOf(equityCurve[0].timestamp);
  const endDate = utcDateOf(equityCurve[equityCurve.length - 1].timestamp);
  const changeByDate = new Map<string, number>();
  for (const p of equityCurve) changeByDate.set(utcDateOf(p.timestamp), p.equity);

  const dates = allDatesBetween(startDate, endDate);
  const rows: DailyReturnRow[] = [];
  let current = equityCurve[0].equity;
  let prev = current;
  for (const d of dates) {
    if (changeByDate.has(d)) current = changeByDate.get(d)!;
    const returnPct = prev !== 0 ? ((current - prev) / prev) * 100 : 0;
    rows.push({ date: d, returnPct });
    prev = current;
  }
  return rows;
}

/** Stage1-Bの日次P&L(bps・w*スケーリング前・名目1単位)を読み込み、w*倍した%リターン列に変換する */
function loadSleeveLegReturns(baseDir: string, assetLower: string, wStar: number): DailyReturnRow[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(baseDir, `stage1-liquidation-daily-returns-${assetLower}-L3.json`), 'utf-8'),
  );
  return raw.data.map((d: { date: string; pnl_bps: number }) => ({
    date: d.date,
    returnPct: (d.pnl_bps / 10000) * wStar * 100,
  }));
}

function loadWStar(baseDir: string, assetLower: string): number {
  const raw = JSON.parse(fs.readFileSync(path.join(baseDir, `stage1-liquidation-sim-${assetLower}.json`), 'utf-8'));
  const l3 = raw.results.find((r: { leverage: number }) => r.leverage === 3);
  return l3.sizing.w_star;
}

function toMap(rows: DailyReturnRow[]): Map<string, number> {
  return new Map(rows.map(r => [r.date, r.returnPct]));
}

function alignByDate(mapsAndKeys: Map<string, number>[]): { dates: string[]; series: number[][] } {
  const commonDates = [...mapsAndKeys[0].keys()].filter(d => mapsAndKeys.every(m => m.has(d))).sort();
  const series = mapsAndKeys.map(m => commonDates.map(d => m.get(d)!));
  return { dates: commonDates, series };
}

function filterByRange(dates: string[], series: number[], start: string, end: string): number[] {
  return dates.map((d, i) => ({ d, v: series[i] })).filter(x => x.d >= start && x.d <= end).map(x => x.v);
}

function calcMetrics(returnsPct: number[]): Metrics {
  const n = returnsPct.length;
  if (n === 0) return { n: 0, mean_pct: 0, std_pct: 0, sharpe_annualized_sqrt365: 0, maxDrawdown_pct: 0, cumReturn_pct: 0 };
  const mean_pct = returnsPct.reduce((a, b) => a + b, 0) / n;
  const variance = returnsPct.reduce((s, r) => s + (r - mean_pct) ** 2, 0) / n;
  const std_pct = Math.sqrt(variance);
  const sharpe_annualized_sqrt365 = std_pct > 0 ? (mean_pct / std_pct) * Math.sqrt(365) : 0;

  let equity = 1;
  let peak = 1;
  let maxDD = 0;
  for (const r of returnsPct) {
    equity *= 1 + r / 100;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  const cumReturn_pct = (equity - 1) * 100;

  return { n, mean_pct, std_pct, sharpe_annualized_sqrt365, maxDrawdown_pct: maxDD * 100, cumReturn_pct };
}

function calculateCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / x.length;
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  const cov = x.reduce((sum, xi, i) => sum + (xi - meanX) * (y[i] - meanY), 0) / x.length;
  const stdX = Math.sqrt(x.reduce((sum, xi) => sum + (xi - meanX) ** 2, 0) / x.length);
  const stdY = Math.sqrt(y.reduce((sum, yi) => sum + (yi - meanY) ** 2, 0) / y.length);
  return stdX > 0 && stdY > 0 ? cov / (stdX * stdY) : 0;
}

/** ②単体: simulatePortfolio を本番構成で実際に呼び出す（バグJ修正）。startDateから末尾まで。 */
function runMomentum(candles: OHLCV[], startDate: string): { equityCurve: EquityPoint[]; tradeCount: number } {
  const n = candles.length;
  const validLen = n - HORIZON - 20;
  const startPos = Math.max(0, candleIndexAtOrAfter(candles, startDate) - 20);
  const testRatio = 1 - startPos / validLen;

  const result = simulatePortfolio(candles, {
    horizon: HORIZON,
    k: K,
    initialEquity: INITIAL_EQUITY,
    testRatio,
    testEndFraction: 1,
    momentumLookback: MOMENTUM_L,
    momentumConfidenceScale: CONFIDENCE_SCALE,
  });
  return { equityCurve: result.equityCurve, tradeCount: result.trades.length };
}

async function main() {
  const baseDir = 'C:\\Users\\Atsushi Hasebe\\Project\\trading-app-v2\\research\\EXP-OBS000032\\10-result';

  console.log('[Stage 1-C] キャリー×②合成の限界寄与検定（再実装）');
  console.log('');

  // --- スリーブ（Stage1-B 3倍・w*サイズ・清算込み。バグF/G修正後） ---
  const wStarBtc = loadWStar(baseDir, 'btc');
  const wStarEth = loadWStar(baseDir, 'eth');
  console.log(`w* (L=3): BTC=${wStarBtc.toFixed(3)} ETH=${wStarEth.toFixed(3)}`);

  const btcSleeve = loadSleeveLegReturns(baseDir, 'btc', wStarBtc);
  const ethSleeve = loadSleeveLegReturns(baseDir, 'eth', wStarEth);
  const btcSleeveMap = toMap(btcSleeve);
  const ethSleeveMap = toMap(ethSleeve);
  const sleeveDates = [...btcSleeveMap.keys()].filter(d => ethSleeveMap.has(d)).sort();
  // BTC/ETH 等ウェイト合算（spec §6-C 固定・逆ボラ調整はしない）
  const sleeveMap = new Map<string, number>(
    sleeveDates.map(d => [d, (btcSleeveMap.get(d)! + ethSleeveMap.get(d)!) / 2]),
  );
  console.log(`Sleeve (BTC/ETH common) days: ${sleeveDates.length} (${sleeveDates[0]}~${sleeveDates[sleeveDates.length - 1]})`);

  // --- ②単体（BTC本番構成。simulatePortfolioを実際に呼ぶ＝バグJ修正） ---
  const btcCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'));
  const ethCandles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'));

  const btcMomentum = runMomentum(btcCandles, SELECTION_START);
  const ethMomentum = runMomentum(ethCandles, SELECTION_START); // 参考併記のみ

  const btcMomentumRows = equityCurveToDailyReturns(btcMomentum.equityCurve);
  const ethMomentumRows = equityCurveToDailyReturns(ethMomentum.equityCurve);
  console.log(`② BTC本番構成: trades=${btcMomentum.tradeCount} daily-rows=${btcMomentumRows.length}`);
  console.log(`② ETH本番構成(参考): trades=${ethMomentum.tradeCount} daily-rows=${ethMomentumRows.length}`);

  const btcMomentumMap = toMap(btcMomentumRows);

  // --- 日付整列（スリーブ・②BTC単体の共通日付のみ） ---
  const { dates: allDates, series } = alignByDate([sleeveMap, btcMomentumMap]);
  const [sleeveAligned, momentumAligned] = series;
  console.log(`Aligned (sleeve × momentum-BTC) dates: ${allDates.length}`);

  // --- 選定期間: 逆ボラ(リスクパリティ)ウェイトの算出・凍結 ---
  const selSleeve = filterByRange(allDates, sleeveAligned, SELECTION_START, SELECTION_END);
  const selMomentum = filterByRange(allDates, momentumAligned, SELECTION_START, SELECTION_END);
  const stdOf = (arr: number[]): number => {
    if (arr.length === 0) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, r) => s + (r - m) ** 2, 0) / arr.length);
  };
  const stdSleeveSel = stdOf(selSleeve);
  const stdMomentumSel = stdOf(selMomentum);
  const invSleeve = stdSleeveSel > 0 ? 1 / stdSleeveSel : 0;
  const invMomentum = stdMomentumSel > 0 ? 1 / stdMomentumSel : 0;
  const invSum = invSleeve + invMomentum;
  const frozenWeightSleeve = invSum > 0 ? invSleeve / invSum : 0.5;
  const frozenWeightMomentum = invSum > 0 ? invMomentum / invSum : 0.5;
  console.log(`選定期間(${SELECTION_START}~${SELECTION_END}) std: sleeve=${stdSleeveSel.toFixed(4)}% momentum=${stdMomentumSel.toFixed(4)}%`);
  console.log(`凍結逆ボラウェイト: sleeve=${frozenWeightSleeve.toFixed(4)} momentum=${frozenWeightMomentum.toFixed(4)}`);

  // --- 確認期間: G3C(相関)・G4C(Sharpe/DD差分) ---
  const confSleeve = filterByRange(allDates, sleeveAligned, CONFIRM_START, '2099-12-31');
  const confMomentum = filterByRange(allDates, momentumAligned, CONFIRM_START, '2099-12-31');
  const confDatesOnly = allDates.filter(d => d >= CONFIRM_START);
  const confMid = Math.floor(confDatesOnly.length / 2);
  const h1Sleeve = confSleeve.slice(0, confMid);
  const h1Momentum = confMomentum.slice(0, confMid);
  const h2Sleeve = confSleeve.slice(confMid);
  const h2Momentum = confMomentum.slice(confMid);

  const correlationFull = calculateCorrelation(confSleeve, confMomentum);
  const correlationH1 = calculateCorrelation(h1Sleeve, h1Momentum);
  const correlationH2 = calculateCorrelation(h2Sleeve, h2Momentum);

  const sleeveMetrics = calcMetrics(confSleeve);
  const momentumMetrics = calcMetrics(confMomentum);

  const compositeFrozen = confSleeve.map((s, i) => frozenWeightSleeve * s + frozenWeightMomentum * confMomentum[i]);
  const composite5050 = confSleeve.map((s, i) => 0.5 * s + 0.5 * confMomentum[i]);
  const compositeFrozenMetrics = calcMetrics(compositeFrozen);
  const composite5050Metrics = calcMetrics(composite5050);

  // G3C: |corr| < 0.3
  const g3c_abs_correlation_full = Math.abs(correlationFull);
  const g3c_condition_met = g3c_abs_correlation_full < 0.3;

  // G4C（バグI修正: 正しいオペランド・不等号）
  // (a) 合成Sharpe − ②単体Sharpe ≥ +0.15 かつ 合成maxDD − ②単体maxDD ≤ +2pt（悪化2pt以内）
  // (b) 合成maxDD − ②単体maxDD ≤ −5pt かつ 合成Sharpe − ②単体Sharpe ≥ −0.05
  const sharpeDiff_frozen = compositeFrozenMetrics.sharpe_annualized_sqrt365 - momentumMetrics.sharpe_annualized_sqrt365;
  const ddDiff_frozen = compositeFrozenMetrics.maxDrawdown_pct - momentumMetrics.maxDrawdown_pct;
  const g4c_condition_a_met = sharpeDiff_frozen >= 0.15 && ddDiff_frozen <= 2;
  const g4c_condition_b_met = ddDiff_frozen <= -5 && sharpeDiff_frozen >= -0.05;
  const g4c_any_condition_met = g4c_condition_a_met || g4c_condition_b_met;

  const sharpeDiff_5050 = composite5050Metrics.sharpe_annualized_sqrt365 - momentumMetrics.sharpe_annualized_sqrt365;
  const ddDiff_5050 = composite5050Metrics.maxDrawdown_pct - momentumMetrics.maxDrawdown_pct;

  const ethMomentumMetrics = calcMetrics(ethMomentumRows.map(r => r.returnPct));

  const output = {
    inputCorrection: 'スリーブはStage1-B（3倍・w*サイズ・清算込み・バグF/G修正後）の日次純リターン。無レバのStage1-A系列は使用しない（spec §6-C）。',
    wStar_L3: { btc: wStarBtc, eth: wStarEth },
    sleeveDateRange: { start: sleeveDates[0], end: sleeveDates[sleeveDates.length - 1], commonDays: sleeveDates.length },
    momentumProductionConfig: { horizon: HORIZON, k: K, initialEquity: INITIAL_EQUITY, momentumLookback: MOMENTUM_L, momentumConfidenceScale: CONFIDENCE_SCALE },
    momentumBtc: { tradeCount: btcMomentum.tradeCount, dailyRows: btcMomentumRows.length },
    momentumEthReference: { tradeCount: ethMomentum.tradeCount, dailyRows: ethMomentumRows.length, metrics_fullSeries: ethMomentumMetrics },
    alignedDates: { count: allDates.length, start: allDates[0], end: allDates[allDates.length - 1] },
    selectionPeriod: { start: SELECTION_START, end: SELECTION_END, std_sleeve_pct: stdSleeveSel, std_momentum_pct: stdMomentumSel },
    frozenWeights_inverseVol: { sleeve: frozenWeightSleeve, momentum: frozenWeightMomentum },
    frozenWeights_naive5050: { sleeve: 0.5, momentum: 0.5 },
    confirmationPeriod: { start: CONFIRM_START, end: allDates[allDates.length - 1], n: confSleeve.length },
    correlation: { full: correlationFull, h1: correlationH1, h2: correlationH2 },
    sleeveMetrics_confirmationPeriod: sleeveMetrics,
    momentumMetrics_confirmationPeriod: momentumMetrics,
    compositeFrozenWeight_confirmationPeriod: compositeFrozenMetrics,
    composite5050_confirmationPeriod: composite5050Metrics,
    g3c: {
      formula: '|corr(sleeve, momentum)| < 0.3',
      abs_correlation_full: g3c_abs_correlation_full,
      condition_met: g3c_condition_met,
    },
    g4c: {
      formula_a: '(合成Sharpe − ②単体Sharpe) ≥ +0.15 かつ (合成maxDD − ②単体maxDD) ≤ +2pt',
      formula_b: '(合成maxDD − ②単体maxDD) ≤ −5pt かつ (合成Sharpe − ②単体Sharpe) ≥ −0.05',
      frozenWeight: {
        sharpeDiff: sharpeDiff_frozen,
        ddDiff_pt: ddDiff_frozen,
        condition_a_met: g4c_condition_a_met,
        condition_b_met: g4c_condition_b_met,
        any_condition_met: g4c_any_condition_met,
      },
      naive5050_reference: {
        sharpeDiff: sharpeDiff_5050,
        ddDiff_pt: ddDiff_5050,
      },
    },
  };

  const outputPath = path.join(baseDir, 'stage1-composite.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log('');
  console.log('=== STAGE 1-C RAW RESULTS ===');
  console.log(`Sleeve(confirm)   : n=${sleeveMetrics.n} mean=${sleeveMetrics.mean_pct.toFixed(4)}% sharpe=${sleeveMetrics.sharpe_annualized_sqrt365.toFixed(3)} maxDD=${sleeveMetrics.maxDrawdown_pct.toFixed(2)}% cum=${sleeveMetrics.cumReturn_pct.toFixed(2)}%`);
  console.log(`Momentum②(confirm): n=${momentumMetrics.n} mean=${momentumMetrics.mean_pct.toFixed(4)}% sharpe=${momentumMetrics.sharpe_annualized_sqrt365.toFixed(3)} maxDD=${momentumMetrics.maxDrawdown_pct.toFixed(2)}% cum=${momentumMetrics.cumReturn_pct.toFixed(2)}%`);
  console.log(`CompositeFrozen   : sharpe=${compositeFrozenMetrics.sharpe_annualized_sqrt365.toFixed(3)} maxDD=${compositeFrozenMetrics.maxDrawdown_pct.toFixed(2)}%`);
  console.log(`Composite50/50    : sharpe=${composite5050Metrics.sharpe_annualized_sqrt365.toFixed(3)} maxDD=${composite5050Metrics.maxDrawdown_pct.toFixed(2)}%`);
  console.log(`corr full=${correlationFull.toFixed(4)} h1=${correlationH1.toFixed(4)} h2=${correlationH2.toFixed(4)}`);
  console.log(`G3C |corr|<0.3: abs=${g3c_abs_correlation_full.toFixed(4)} condition_met=${g3c_condition_met}`);
  console.log(`G4C sharpeDiff(frozen)=${sharpeDiff_frozen.toFixed(4)} ddDiff_pt(frozen)=${ddDiff_frozen.toFixed(2)} condition_a=${g4c_condition_a_met} condition_b=${g4c_condition_b_met} any=${g4c_any_condition_met}`);
  console.log('');
  console.log(`JSON written: ${outputPath}`);
}

main().catch(e => { console.error('Error:', e); process.exit(1); });
