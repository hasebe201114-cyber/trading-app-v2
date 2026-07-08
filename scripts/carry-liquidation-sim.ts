/**
 * Stage 1-B: 清算シミュレーション + CVaRサイジング（judge書v2 差し戻し反映・再実装）
 *
 * spec §4: 連続保有・mark基準日次MTM・証拠金勘定・funding反転枯渇・方式I主/方式II参考・CVaRサイジング
 *
 * 21-verdict-stage1-v2.md 差し戻し反映:
 * - バグG修正: carry-net-expectation.ts と同一の W=7 SMA シグナル（signal）を
 *   margin更新・dailyPnl計算の両方に適用する（pos = signal===-1 ? -1 : 1）。
 *   signal=-1（逆キャリー）時は 現物ショート×perpロング に反転し、perpのMTM・funding受払・
 *   spotレッグP&Lの符号を pos で反転する。Stage1-A（carry-net-expectation.ts）と同一戦略。
 * - バグF修正: デルタニュートラルの清算会計を作り直す。
 *   margin_t（perpレッグ単独の証拠金）は pos 適用後の perpMtm+funding を加算し、0で床(floor)する
 *   （＝isolated marginは1/L超の損失を負わない。floor自体が「1/L上限」を自然に体現する）。
 *   spotレッグのP&Lは「前日比の日次リターン」で計算し、清算・再構築の有無に関わらず
 *   毎日そのままdailyPnlに合算する＝現物の含み益は消えない・清算のたびに実現もされない
 *   （spec「現物ロングの含み益は清算時点で実現されず」）。
 *   dailyPnl_bps = spotLegPnl_bps + perpレッグの実現P&L(floor後の増分) − 反転コスト − 資本コスト
 *     − （清算日のみ）再構築コスト。
 *   これにより「連続MTM(旧basisPnl)」と「離散清算損(旧1/L全損)」の二重計上を排除する
 *   （旧実装は上記dailyPnlに"basisPnl"を通常通り計上した上で、清算のたびにさらに1/Lを全損として
 *   引いていたため二重計上だった。新実装はperpレッグの実現P&Lをfloorで頭打ちする一本の会計のみ）。
 *   discreteLossAmount_bps は「清算サイクル開始時のmarginから清算時点のmarginまでの減少額」を
 *   参考情報として記録する（dailyPnlから再度引くことはしない＝二重計上排除）。
 * - バグE残修正: T1/T2/T3/calm・前半/後半の各期間別に、清算回数・被害幅（真の最大DD・最悪日・
 *   CVaR等）を分解出力する。w*サイジングの制約2（最悪単一テール窓の累積損失≤配分資本20%）は、
 *   全期間の単純maxDDでなく、T1/T2/T3/calmの中で最悪の期間内maxDDを使う。
 * - mark価格: markPriceKlines は本Stage1でも取得できておらず、last価格で代用する
 *   （spec §4-1: mark非可用時はlast代用と明記。last代用は薄商い時に瞬間乖離を過大計上し
 *   清算を過大にカウントする向き＝保守側/偽陽性側）。
 * - MMR=0.5%は「業界標準の仮置き（Bitget API非配信）」であり「Bitget API取得」ではない。
 */

import * as fs from 'fs';
import * as path from 'path';

interface DailyData {
  date: string;
  spotPrice: number;
  perpPrice: number;
  fundingRate: number; // 日次合算funding rate（小数）
}

interface LiquidationEvent {
  date: string;
  index: number;
  cycleStartMarginBps: number;
  marginAtLiquidationBps: number;
  marginConsumed_bps: number; // 参考情報。dailyPnlからは再度引かない（二重計上排除）
}

interface PeriodStats {
  period: string;
  n: number;
  liquidationCount: number;
  liquidationDates: string[];
  discreteLossAmount_bps: number; // 参考情報（cycleStartMargin - marginAtLiquidation の合計）
  reconstructionCost_bps: number; // 実際にdailyPnlから控除済みの合計（情報開示）
  cumulativePnl_bps: number;
  meanDailyNetCarry_bps: number;
  annualizedNetCarryRate_pct: number;
  maxDrawdown_bps: number; // 期間内で自己完結（自己リセット）した累積和のpeak-trough（G0-4と同一方式で直接比較可能）
  worstDailyLoss_bps: number;
  cvar97_5_bps: number | null;
}

interface LeverageResult {
  leverage: number;
  imr: number;
  periods: PeriodStats[];
  sizing: {
    fullPeriodCvar97_5_bps: number;
    worstTailWindow: string;
    worstTailWindowMaxDD_bps: number;
    constraint1_wStar_dailyCvarBudget: number;
    constraint2_wStar_worstTailWindowBudget: number;
    w_star: number;
    w_star_annualizedNetCarry_pct: number;
  };
  netAnnualSharpeRatio_fullPeriod: number;
  grossAnnualSharpeRatio_fullPeriod: number;
  methodII_crossMargin_reference: {
    description: string;
    liquidationCount: number;
    liquidationDates: string[];
  };
}

const COSTS = {
  BTC: { reversalFourLegBps: 24.064 },
  ETH: { reversalFourLegBps: 24.224 },
};

const MMR = 0.005; // 業界標準の仮置き（Bitget API非配信・「Bitget API取得」ではない）
const ANNUAL_CAPITAL_COST_RATE = 0.04;

const TAIL_WINDOWS = {
  T1: { start: '2020-02-20', end: '2020-04-30' },
  T2: { start: '2022-05-01', end: '2022-06-30' },
  T3: { start: '2022-10-25', end: '2022-12-15' },
  calm: { start: '2021-01-01', end: '2021-06-30' },
};

async function loadCSV(filePath: string): Promise<Record<string, string>[]> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((key, i) => { row[key] = values[i]; });
    return row;
  });
}

function dateToISO(dateStr: string): string {
  return dateStr.split('T')[0];
}

function mergeData(
  spotRows: Record<string, string>[],
  perpRows: Record<string, string>[],
  fundingRows: Record<string, string>[],
): DailyData[] {
  const spotByDate = new Map(spotRows.map(r => [dateToISO(r.date), parseFloat(r.close)]));
  const perpByDate = new Map(perpRows.map(r => [dateToISO(r.date), parseFloat(r.close)]));
  const fundingByDate = new Map<string, number>();

  fundingRows.forEach(r => {
    const datetime = r.datetime || r.date;
    const date = dateToISO(datetime);
    const rate = parseFloat(r.funding_rate) || 0;
    fundingByDate.set(date, (fundingByDate.get(date) || 0) + rate);
  });

  const allDates = Array.from(new Set([...spotByDate.keys(), ...perpByDate.keys()])).sort();
  const result: DailyData[] = [];

  for (const date of allDates) {
    const spot = spotByDate.get(date);
    const perp = perpByDate.get(date);
    const funding = fundingByDate.get(date) || 0;
    if (spot !== undefined && perp !== undefined) {
      result.push({ date, spotPrice: spot, perpPrice: perp, fundingRate: funding });
    }
  }
  return result;
}

function isInWindow(date: string, window: { start: string; end: string }): boolean {
  return date >= window.start && date <= window.end;
}

function getWindowForDate(date: string): string | null {
  for (const [key, window] of Object.entries(TAIL_WINDOWS)) {
    if (isInWindow(date, window)) return key;
  }
  return null;
}

function calculateCVaR(dailyPnlBps: number[]): number | null {
  if (dailyPnlBps.length === 0) return null;
  const sorted = [...dailyPnlBps].sort((a, b) => a - b); // 昇順（最悪が先）
  const thresholdIndex = Math.max(1, Math.ceil(sorted.length * 0.025));
  const tailValues = sorted.slice(0, thresholdIndex);
  return tailValues.reduce((a, b) => a + b, 0) / tailValues.length;
}

/**
 * §4の連続保有シミュレーション（方式I・分離証拠金・主判定）。
 * signal（W=7 SMA、Stage1-Aと同一ロジック）を pos に変換し、margin更新・dailyPnl計算の
 * 両方に適用する（バグG修正）。
 */
function runSimulation(
  daily: DailyData[],
  assetCode: string,
  leverage: number,
): { dailyPnlBps: number[]; liquidationEvents: LiquidationEvent[]; methodII: { liquidationDates: string[] } } {
  const costs = COSTS[assetCode as keyof typeof COSTS];
  const imr = 1 / leverage;
  const dailyCapitalCost_bps = (ANNUAL_CAPITAL_COST_RATE / leverage / 365) * 10000;

  const dailyPnlBps: number[] = [];
  const liquidationEvents: LiquidationEvent[] = [];

  // 方式I: margin（perpレッグ単独の証拠金、bps単位・名目に対する率×10000）
  let marginBps = imr * 10000;
  let cycleStartMarginBps = marginBps;

  // 方式II（参考）: クロス証拠金＝現物益で追証可能と仮定した合成エクイティ（floorしない）
  let methodIICombinedBps = imr * 10000;
  const methodIILiquidationDates: string[] = [];

  let prevSignal: number | null = null;

  for (let i = 0; i < daily.length; i++) {
    const d = daily[i];

    // --- シグナル（Stage1-Aと完全同一のW=7 SMA。先読み排除：t-7〜t-1） ---
    let signal = 0;
    if (i >= 7) {
      let sum7day = 0;
      for (let j = i - 7; j < i; j++) sum7day += daily[j].fundingRate;
      signal = sum7day > 0 ? 1 : sum7day < 0 ? -1 : 0;
    }
    const pos = signal === -1 ? -1 : 1; // signal=0はStage1-Aと同様デフォルト順方向扱い

    // --- 日次リターン（前日比） ---
    let spotReturn = 0;
    let perpReturn = 0;
    if (i > 0) {
      spotReturn = daily[i].spotPrice / daily[i - 1].spotPrice - 1;
      perpReturn = daily[i].perpPrice / daily[i - 1].perpPrice - 1;
    }

    // ベース方向（pos=+1: 現物ロング×perpショート）でのレッグ別P&L
    const spotLegPnlBase_bps = spotReturn * 10000;
    const perpShortMtmBase_bps = -(perpReturn * 10000); // ショートは価格上昇で損
    const fundingBase_bps = d.fundingRate * 10000; // 正=ショート受取（順キャリー方向）

    // pos適用（signal=-1なら現物ショート×perpロングに反転＝符号反転）
    const spotLegPnl_bps = pos * spotLegPnlBase_bps;
    const perpLegMtm_bps = pos * perpShortMtmBase_bps;
    const fundingFlow_bps = pos * fundingBase_bps;

    // 反転コスト（signalが非ゼロ同士で反転した日）
    let reversalCost_bps = 0;
    if (i > 0 && prevSignal !== null && prevSignal !== signal && prevSignal !== 0 && signal !== 0) {
      reversalCost_bps = costs.reversalFourLegBps;
    }

    // --- margin更新（方式I・分離証拠金）: perpレッグのみのP&Lをfloor(0)で頭打ち ---
    const marginDelta_bps = perpLegMtm_bps + fundingFlow_bps;
    const provisionalMarginBps = marginBps + marginDelta_bps;
    const flooredMarginBps = Math.max(0, provisionalMarginBps);
    const actualPerpContribution_bps = flooredMarginBps - marginBps; // floor後の実現分（1/L超の損失は負わない）
    marginBps = flooredMarginBps;

    // --- 日次P&L（連続MTM一本のみ。basisPnlと離散清算損の二重計上をしない） ---
    let dailyPnl_bps = spotLegPnl_bps + actualPerpContribution_bps - reversalCost_bps - dailyCapitalCost_bps;

    // --- 清算判定（方式I）: margin < MMR×名目 ---
    if (marginBps < MMR * 10000) {
      const marginConsumed_bps = cycleStartMarginBps - marginBps;
      liquidationEvents.push({
        date: d.date,
        index: i,
        cycleStartMarginBps,
        marginAtLiquidationBps: marginBps,
        marginConsumed_bps,
      });
      dailyPnl_bps -= costs.reversalFourLegBps; // 再構築コスト（実コスト・唯一の追加控除）
      // 再構築: margin=IMRにリセット（現在価格で4レッグ再構築。スポットレッグは
      // 前日比リターンで計算しているため再基準化不要＝含み益は消えない）
      marginBps = imr * 10000;
      cycleStartMarginBps = marginBps;
    }

    dailyPnlBps.push(dailyPnl_bps);

    // --- 方式II（参考・クロス証拠金）: floorせず現物益で追証可能と仮定 ---
    methodIICombinedBps += spotLegPnl_bps + perpLegMtm_bps + fundingFlow_bps - dailyCapitalCost_bps - reversalCost_bps;
    if (methodIICombinedBps < MMR * 10000) {
      methodIILiquidationDates.push(d.date);
      methodIICombinedBps = imr * 10000; // 参考: 便宜上リセット（クロス証拠金でも枯渇時は再構築が必要という扱い）
    }

    prevSignal = signal;
  }

  return { dailyPnlBps, liquidationEvents, methodII: { liquidationDates: methodIILiquidationDates } };
}

/** 自己完結（自己リセット）の累積和peak-troughで最大DDを算出（G0-4と同一方式・bps単位） */
function computeSelfContainedMaxDD_bps(pnlSlice: number[]): number {
  let peak = 0;
  let running = 0;
  let maxDD = 0;
  for (const pnl of pnlSlice) {
    running += pnl;
    peak = Math.max(peak, running);
    maxDD = Math.max(maxDD, peak - running);
  }
  return maxDD;
}

function computePeriodStats(
  period: string,
  indices: number[],
  dailyPnlBps: number[],
  daily: DailyData[],
  liquidationEvents: LiquidationEvent[],
  costs: { reversalFourLegBps: number },
  includeCvar: boolean,
): PeriodStats {
  const slice = indices.map(i => dailyPnlBps[i]);
  const n = slice.length;
  const cumulativePnl_bps = slice.reduce((a, b) => a + b, 0);
  const meanDailyNetCarry_bps = n > 0 ? cumulativePnl_bps / n : 0;
  const annualizedNetCarryRate_pct = (meanDailyNetCarry_bps / 10000) * 365 * 100;
  const maxDrawdown_bps = computeSelfContainedMaxDD_bps(slice);
  const worstDailyLoss_bps = n > 0 ? Math.min(...slice) : 0;

  const indexSet = new Set(indices);
  const eventsInPeriod = liquidationEvents.filter(e => indexSet.has(e.index));
  const discreteLossAmount_bps = eventsInPeriod.reduce((a, e) => a + e.marginConsumed_bps, 0);
  const reconstructionCost_bps = eventsInPeriod.length * costs.reversalFourLegBps;

  const cvar97_5_bps = includeCvar ? calculateCVaR(slice) : null;

  return {
    period,
    n,
    liquidationCount: eventsInPeriod.length,
    liquidationDates: eventsInPeriod.map(e => e.date),
    discreteLossAmount_bps,
    reconstructionCost_bps,
    cumulativePnl_bps,
    meanDailyNetCarry_bps,
    annualizedNetCarryRate_pct,
    maxDrawdown_bps,
    worstDailyLoss_bps,
    cvar97_5_bps,
  };
}

function simulateWithLiquidation(daily: DailyData[], assetCode: string, leverage: number): LeverageResult {
  const costs = COSTS[assetCode as keyof typeof COSTS];
  const imr = 1 / leverage;

  const { dailyPnlBps, liquidationEvents, methodII } = runSimulation(daily, assetCode, leverage);

  const allIndices = daily.map((_, i) => i);
  const midpoint = Math.floor(daily.length / 2);
  const h1Indices = allIndices.filter(i => i < midpoint);
  const h2Indices = allIndices.filter(i => i >= midpoint);

  const windowIndices: Record<string, number[]> = { T1: [], T2: [], T3: [], calm: [] };
  daily.forEach((d, i) => {
    const w = getWindowForDate(d.date);
    if (w) windowIndices[w].push(i);
  });

  const periods: PeriodStats[] = [];
  periods.push(computePeriodStats('FULL', allIndices, dailyPnlBps, daily, liquidationEvents, costs, true));
  for (const key of ['T1', 'T2', 'T3', 'calm']) {
    periods.push(computePeriodStats(key, windowIndices[key], dailyPnlBps, daily, liquidationEvents, costs, false));
  }
  periods.push(computePeriodStats('H1', h1Indices, dailyPnlBps, daily, liquidationEvents, costs, false));
  periods.push(computePeriodStats('H2', h2Indices, dailyPnlBps, daily, liquidationEvents, costs, false));

  const fullPeriod = periods[0];
  const tailPeriods = periods.filter(p => ['T1', 'T2', 'T3', 'calm'].includes(p.period));
  const worstTail = tailPeriods.reduce((worst, p) => (p.maxDrawdown_bps > worst.maxDrawdown_bps ? p : worst), tailPeriods[0]);

  const fullCvar_bps = fullPeriod.cvar97_5_bps ?? 0;
  // 制約1: 日次CVaR97.5(テール+清算込み・全期間を母集団) ≤ 配分資本の2.0%、f=0.5
  const constraint1 = Math.abs(fullCvar_bps) > 0 ? (0.02 * 10000 / Math.abs(fullCvar_bps)) * 0.5 : Infinity;
  // 制約2: 最悪単一テール窓の累積損失(清算込み) ≤ 配分資本の20%、f=0.5
  // （配分資本＝グロス名目の基準。imrを二重に掛けない＝制約1と同じ「配分資本に対する率」ベース）
  const constraint2 = worstTail.maxDrawdown_bps > 0 ? (0.20 * 10000 / worstTail.maxDrawdown_bps) * 0.5 : Infinity;
  const wStar = Math.min(constraint1, constraint2);
  const wStarAnnualCarry_pct = fullPeriod.annualizedNetCarryRate_pct * wStar;

  // Sharpe（参考。net=コスト・清算込み、gross=資本コスト控除前）
  const mean = fullPeriod.meanDailyNetCarry_bps;
  const std = Math.sqrt(dailyPnlBps.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / dailyPnlBps.length);
  const netAnnualSharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;
  const dailyCapitalCost_bps = (ANNUAL_CAPITAL_COST_RATE / leverage / 365) * 10000;
  const grossMean = mean + dailyCapitalCost_bps;
  const grossAnnualSharpe = std > 0 ? (grossMean / std) * Math.sqrt(365) : 0;

  return {
    leverage,
    imr,
    periods,
    sizing: {
      fullPeriodCvar97_5_bps: fullCvar_bps,
      worstTailWindow: worstTail.period,
      worstTailWindowMaxDD_bps: worstTail.maxDrawdown_bps,
      constraint1_wStar_dailyCvarBudget: constraint1,
      constraint2_wStar_worstTailWindowBudget: constraint2,
      w_star: wStar,
      w_star_annualizedNetCarry_pct: wStarAnnualCarry_pct,
    },
    netAnnualSharpeRatio_fullPeriod: netAnnualSharpe,
    grossAnnualSharpeRatio_fullPeriod: grossAnnualSharpe,
    methodII_crossMargin_reference: {
      description: '参考併記のみ・採否判定には使わない（spec §4-3 方式II）。現物益で追証可能と仮定した合成証拠金（floorしない）。実運用の資金移動遅延・取引所リスクは織り込んでいない。',
      liquidationCount: methodII.liquidationDates.length,
      liquidationDates: methodII.liquidationDates,
    },
  };
}

async function main() {
  const assetCode = process.argv[2] || 'BTC';
  if (!['BTC', 'ETH'].includes(assetCode)) {
    console.error('Usage: node --experimental-strip-types scripts/carry-liquidation-sim.ts [BTC|ETH]');
    process.exit(1);
  }

  const baseDir = 'C:\\Users\\Atsushi Hasebe\\Project\\trading-app-v2\\research\\EXP-OBS000032\\10-result';
  const assetLower = assetCode.toLowerCase();

  const [spotRows, perpRows, fundingRows] = await Promise.all([
    loadCSV(path.join(baseDir, `${assetLower}usdt-spot-daily.csv`)),
    loadCSV(path.join(baseDir, `${assetLower}usdt-perp-last-daily.csv`)),
    loadCSV(path.join(baseDir, `${assetLower}usdt-funding.csv`)),
  ]);

  const daily = mergeData(spotRows, perpRows, fundingRows);
  console.log(`[${assetCode}] Simulating liquidation with ${daily.length} daily records (${daily[0].date}~${daily[daily.length - 1].date})...`);

  const results: LeverageResult[] = [];
  for (const leverage of [3, 5, 10]) {
    const result = simulateWithLiquidation(daily, assetCode, leverage);
    results.push(result);
    const full = result.periods[0];
    console.log(
      `L=${leverage}: Liq=${full.liquidationCount} | Cum=${full.cumulativePnl_bps.toFixed(0)}bps | MaxDD(FULL,self-contained)=${full.maxDrawdown_bps.toFixed(0)}bps | worstTail=${result.sizing.worstTailWindow}(${result.sizing.worstTailWindowMaxDD_bps.toFixed(1)}bps) | CVaR=${full.cvar97_5_bps?.toFixed(0)}bps | w*=${result.sizing.w_star.toFixed(3)} | w*Annual=${result.sizing.w_star_annualizedNetCarry_pct.toFixed(2)}% | Sharpe=${result.netAnnualSharpeRatio_fullPeriod.toFixed(3)}`,
    );
    for (const p of result.periods) {
      console.log(
        `  [${p.period.padEnd(6)}] n=${String(p.n).padStart(4)} liq=${p.liquidationCount} cum=${p.cumulativePnl_bps.toFixed(1).padStart(9)}bps maxDD=${p.maxDrawdown_bps.toFixed(1).padStart(8)}bps worst=${p.worstDailyLoss_bps.toFixed(1).padStart(8)}bps liqDates=${p.liquidationDates.join(',') || '-'}`,
      );
    }
  }

  const output = {
    asset: assetCode,
    startDate: daily[0].date,
    endDate: daily[daily.length - 1].date,
    totalDays: daily.length,
    mmr: MMR,
    mmr_note: '業界標準の仮置き（Bitget contracts API がMMR相当フィールドを undefined 返却・Bitget API取得ではない）',
    markPriceNote: 'Binance perp markPriceKlines は本Stage1でも未取得（連続期間・テール窓の深度確保に至らず）。last価格で代用。last代用は薄商い時の瞬間乖離を過大計上し得るため、清算回数・被害幅は保守側（過大計上・偽陽性側）に振れる可能性がある。',
    implementationNotes: {
      signal: 'carry-net-expectation.tsと同一W=7 SMA（先読み排除t-7〜t-1）。pos=signal===-1?-1:1をmargin更新・dailyPnl計算の両方に適用（21-verdict-v2 バグG修正）。',
      accounting: 'dailyPnl_bps = spotLegPnl_bps(前日比×pos) + perpレッグ実現P&L(floor(0)で頭打ち・1/L超の損失は負わない) - 反転コスト - 資本コスト - (清算日のみ)再構築コスト。連続MTMと離散清算損の二重計上を排除（21-verdict-v2 バグF修正）。discreteLossAmount_bpsは参考情報でありdailyPnlには含まれない。',
      liquidation: '清算判定 = margin(perpレッグ単独) < MMR×名目。清算時は再構築コストのみ実控除、marginをIMRにリセット。スポットレッグは前日比リターンで評価するため再基準化不要（含み益は消えない・清算時に実現もされない）。',
      maxDD_methodology: '期間ごとに自己完結（自己リセット）した累積和のpeak-trough・bps単位。G0-4（Stage0）と同一方式で直接比較可能。',
      sizing: 'w* = min(制約1: 0.02×10000/|CVaR97.5_bps(全期間)|, 制約2: 0.20×10000/worstTailWindowMaxDD_bps) × f(0.5)。制約1・2ともに「配分資本に対する率」ベースでimrの二重乗算をしない。',
      methodII: '参考併記のみ（spec §4-3）。現物益で追証可能と仮定した合成証拠金（floorしない）。採否判定には使わない。',
    },
    results,
  };

  const outputPath = path.join(baseDir, `stage1-liquidation-sim-${assetLower}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nJSON written: ${outputPath}`);

  // Stage1-C用: レバレッジ別の日次P&L系列（w*スケーリング前、bps・名目単位）を出力
  for (const leverage of [3, 5, 10]) {
    const { dailyPnlBps } = runSimulation(daily, assetCode, leverage);
    const dailyExportPath = path.join(baseDir, `stage1-liquidation-daily-returns-${assetLower}-L${leverage}.json`);
    fs.writeFileSync(
      dailyExportPath,
      JSON.stringify({
        asset: assetCode,
        leverage,
        note: 'dailyPnl_bpsは名目1単位・w*スケーリング前（Stage1-Cでw*を乗じてスリーブ実サイズに変換する）',
        data: daily.map((d, i) => ({ date: d.date, pnl_bps: dailyPnlBps[i] })),
      }, null, 2),
    );
  }
  console.log('Daily P&L series (L=3,5,10) written for Stage 1-C consumption.');
}

main().catch(console.error);
