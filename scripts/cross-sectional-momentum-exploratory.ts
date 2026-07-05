/**
 * EXP-OBS000030 Stage 1 (横断モメンタム) - 探索的・非採用前提検証
 *
 * spec: research/EXP-OBS000030/00-spec-stage1-exploratory.md
 *
 * 実装内容:
 *   - Config A: 14銘柄固定（AAVE/ADA/AVAX/BCH/BNB/BTC/DOGE/ETH/FIL/LINK/NEAR/SOL/XLM/XRP）
 *   - Config B: PIT可変N（母集団50銘柄・各月次で60日以上のデータを持つもの）
 *   - シグナル: L=30日の直近リターンで横断ランク付け
 *   - ポートフォリオ: 月次テルシル（上位/下位N/3本）のドルニュートラルLS
 *   - コスト: テイカー6bps + 流動性階層別スリッページ
 *   - 予測単位: 横断IC（スピアマン順位相関）+ permutation検定
 *   - パイプライン: グロス/ネット Sharpe/DD + permutation
 *   - selection/confirmation: held-out銘柄分割 + 時系列分割
 *   - レジーム別分解: R1(2022弱気)/R2(2023-2024回復)/R3(2025-現在)
 *
 * 境界条件:
 *   ① 本検証結果はいかなる場合も本番採用（D統合反映）の判断材料にしない
 *   ② 生存バイアスを全結果に付記（注記なしの単独数値禁止）
 *   ③ 正式G1-G4ゲート不適用（記述的観察のみ）
 *   ④ ポジティブでも採用プロセスに進めない（有料データ整備後に別OBS再起票）
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'research', 'EXP-OBS000030', '10-result');
const RESULT_DIR = DATA_DIR;

// === Constants ===
const CONFIG_A_SYMBOLS = ['AAVEUSDT', 'ADAUSDT', 'AVAXUSDT', 'BCHUSDT', 'BNBUSDT', 'BTCUSDT', 'DOGEUSDT', 'ETHUSDT', 'FILUSDT', 'LINKUSDT', 'NEARUSDT', 'SOLUSDT', 'XLMUSDT', 'XRPUSDT'];
const LOOKBACK_L = 30;
const LOOKBACK_SENSITIVITY = [15, 60]; // For reference only, L=30 is primary
const N_PERM = 5000;
const PERM_SEED = 20260705;
const TAKER_FEE_BPS = 6; // 6 bps per side = 0.06%
const SLIPPAGE_TIERS = [
  { max: 10, bps: 5 },    // Rank 1-10: 5 bps
  { max: 30, bps: 15 },   // Rank 11-30: 15 bps
  { max: Infinity, bps: 30 }, // Rank 31+: 30 bps
];

// === Types ===
interface CandleRecord {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MonthlyRebalance {
  date: string;
  year: number;
  month: number;
}

interface ICResult {
  rebalanceDate: string;
  momentums: { symbol: string; ret: number; rank: number }[];
  forwardReturns: { symbol: string; ret: number; rank: number }[];
  ic: number; // Spearman rank correlation
  icAbove0: boolean;
}

interface PortfolioPosition {
  date: string;
  symbol: string;
  side: 'long' | 'short';
  weight: number; // Dollar-neutral each side = 0.5 per side, equal-weight within leg
  quantity: number; // For holding period calculation
}

interface PortfolioMetrics {
  rebalanceDate: string;
  positions: PortfolioPosition[];
  monthlyReturn: number;
  grossReturn: number; // Before costs
  netReturn: number; // After costs
  turnoverId: number; // For cost calculation: ∑|old_weight - new_weight|
}

interface ExecutionCost {
  symbol: string;
  rank: number; // For slippage tier lookup
  takerFeePerSide: number;
  slippagePerSide: number;
  totalCostBps: number;
  turnoverId: number;
}

interface CrosssectionalICResults {
  config: 'A' | 'B';
  universe: string[];
  rebalances: ICResult[];
  meanIC: number;
  stdIC: number;
  tIC: number; // t-stat: mean IC / (std IC / sqrt(n))
  pctAbove0: number;
  permutationP: number; // permutation test p-value
  notes: string;
}

interface PortfolioResults {
  config: 'A' | 'B';
  universe: string[];
  rebalances: PortfolioMetrics[];
  grossSharpe: number;
  netSharpe: number;
  grossCumulativeReturn: number;
  netCumulativeReturn: number;
  grossMaxDD: number;
  netMaxDD: number;
  monthlyReturnsGross: number[];
  monthlyReturnsNet: number[];
  permutationPGross: number;
  permutationPNet: number;
  fundingNote: string;
  notes: string;
}

interface HeldOutResults {
  selectionIC: number;
  confirmationIC: number;
  sameSign: boolean;
  note: string;
}

interface RegimeResult {
  regime: string;
  period: [string, string];
  ic: number;
  icPerm: number;
  grossSharpe: number;
  netSharpe: number;
  monthCount: number;
  note: string;
}

// === Utility Functions ===
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

function pctChange(from: number, to: number): number {
  return (to - from) / from;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function spearmanCorrelation(xs: number[], ys: number[]): number {
  if (xs.length < 2 || xs.length !== ys.length) return 0;
  // Rank xs
  const xIndices = xs.map((_, i) => i).sort((i, j) => xs[i] - xs[j]);
  const xRanks = new Array(xs.length);
  for (let i = 0; i < xIndices.length; i++) {
    xRanks[xIndices[i]] = i + 1;
  }
  // Rank ys
  const yIndices = ys.map((_, i) => i).sort((i, j) => ys[i] - ys[j]);
  const yRanks = new Array(ys.length);
  for (let i = 0; i < yIndices.length; i++) {
    yRanks[yIndices[i]] = i + 1;
  }
  // Pearson correlation on ranks
  const rankDiffs = xRanks.map((xr, i) => xr - yRanks[i]);
  return 1 - (6 * rankDiffs.reduce((a, d) => a + d * d, 0)) / (xs.length * (xs.length * xs.length - 1));
}

function datesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = new Date(start + 'T00:00:00Z');
  const endDate = new Date(end + 'T00:00:00Z');
  while (current <= endDate) {
    const yyyy = current.getUTCFullYear();
    const mm = String(current.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(current.getUTCDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function monthStartDates(start: string, end: string): MonthlyRebalance[] {
  const results: MonthlyRebalance[] = [];
  let current = new Date(start + 'T00:00:00Z');
  const endDate = new Date(end + 'T00:00:00Z');
  current.setUTCDate(1);
  while (current <= endDate) {
    const yyyy = current.getUTCFullYear();
    const mm = current.getUTCMonth() + 1;
    const dd = String(current.getUTCDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${String(mm).padStart(2, '0')}-${dd}`;
    results.push({ date: dateStr, year: yyyy, month: mm });
    current.setUTCMonth(current.getUTCMonth() + 1);
  }
  return results;
}

function getClosestCandleIndexOnOrBefore(candles: CandleRecord[], targetDate: string): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].date <= targetDate) return i;
  }
  return -1;
}

function getClosestCandleIndexAfter(candles: CandleRecord[], targetDate: string): number {
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].date > targetDate) return i;
  }
  return -1;
}

// === Main Logic ===
async function main(): Promise<void> {
  console.log('=== EXP-OBS000030 Stage 1: 横断モメンタム探索的検証 ===\n');
  const startTime = new Date();

  // Load all history files
  console.log('Loading history data...');
  const historyFiles = readdirSync(DATA_DIR).filter(f => f.startsWith('history-') && f.endsWith('.json'));
  const allHistory: Record<string, CandleRecord[]> = {};
  for (const file of historyFiles) {
    const symbol = file.replace('history-', '').replace('.json', '').toUpperCase();
    const content = readFileSync(join(DATA_DIR, file), 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;
    const candles = (data.candles || []) as CandleRecord[];
    allHistory[symbol] = candles.sort((a, b) => a.date.localeCompare(b.date));
  }
  console.log(`Loaded ${historyFiles.length} symbols\n`);

  // Verify Config A symbols exist
  const missingA = CONFIG_A_SYMBOLS.filter(sym => !allHistory[sym]);
  if (missingA.length > 0) {
    throw new Error(`Missing Config A symbols: ${missingA.join(', ')}`);
  }

  const measPeriodStart = '2022-01-01';
  const measPeriodEnd = '2026-07-02';

  // === Config A: 14 Fixed Symbols ===
  console.log('Processing Config A (14 fixed symbols)...\n');
  const configAResults = await processConfig('A', CONFIG_A_SYMBOLS, allHistory, measPeriodStart, measPeriodEnd);

  // === Config B: PIT Variable N ===
  console.log('Processing Config B (PIT variable N)...\n');
  const configBResults = await processConfig('B', Object.keys(allHistory), allHistory, measPeriodStart, measPeriodEnd);

  // === Held-out Coin Splits (Config A only) ===
  console.log('Computing held-out coin split analysis (Config A)...\n');
  const heldOutResults = await computeHeldOutAnalysis(CONFIG_A_SYMBOLS, allHistory, measPeriodStart, measPeriodEnd, configAResults);

  // === Time-series split (Config A: 2024-06-30 boundary) ===
  console.log('Computing time-series split analysis (Config A)...\n');
  const selectionResults = await processConfig('A', CONFIG_A_SYMBOLS, allHistory, measPeriodStart, '2024-06-30');
  const confirmationResults = await processConfig('A', CONFIG_A_SYMBOLS, allHistory, '2024-07-01', measPeriodEnd);

  // === Regime-based decomposition (Config A) ===
  console.log('Computing regime-based decomposition (Config A)...\n');
  const regimeR1 = await processConfig('A', CONFIG_A_SYMBOLS, allHistory, '2022-01-01', '2022-12-31');
  const regimeR2 = await processConfig('A', CONFIG_A_SYMBOLS, allHistory, '2023-01-01', '2024-12-31');
  const regimeR3 = await processConfig('A', CONFIG_A_SYMBOLS, allHistory, '2025-01-01', '2026-07-02');

  // === Compile Results ===
  const finalResults = {
    metadata: {
      version: '1.0',
      timestamp: startTime.toISOString(),
      executedAt: new Date().toISOString(),
      spec: '00-spec-stage1-exploratory.md',
      boundaries: {
        productionAdoptionBanned: true,
        survivorshipBiasNote: 'Survivor bias present: current live symbols only, dead symbols excluded. Results reflect Bitget-tradable USDT-perp universe as of execution date.',
        nonAdoptionDefault: true,
        recordingOnly: 'Observation-based (no PASS/FAIL judgment)',
      },
    },
    configA: {
      icResults: configAResults.ic,
      portfolioResults: configAResults.portfolio,
      heldOutAnalysis: heldOutResults,
      timeSplitSelection: selectionResults.ic,
      timeSplitConfirmation: confirmationResults.ic,
      regimes: {
        r1_bearish_2022: {
          period: ['2022-01-01', '2022-12-31'],
          ic: regimeR1.ic,
          portfolio: regimeR1.portfolio,
        },
        r2_recovery_2023_2024: {
          period: ['2023-01-01', '2024-12-31'],
          ic: regimeR2.ic,
          portfolio: regimeR2.portfolio,
        },
        r3_recent_2025_2026: {
          period: ['2025-01-01', '2026-07-02'],
          ic: regimeR3.ic,
          portfolio: regimeR3.portfolio,
        },
      },
    },
    configB: {
      icResults: configBResults.ic,
      portfolioResults: configBResults.portfolio,
    },
    survivorshipBiasDisclosure: {
      note: '生存バイアス明示: 本結果はBitget現行USDT-perpユニバース（死銘柄除外）のみを対象。2022年に存在した銘柄の一部（例LUNA2USDT等）が測定期間途中で上場廃止された場合、その影響は含まれていない。特にConfig Aの深さ×幅トレードオフはこのバイアスを最大化する（2022~2026通年存在した14銘柄のみ）。生存バイアスの上振れ方向は既知のため、ネット（コスト後）Sharpe ≤ 0 の結果の方が情報価値が高い。',
      config_a_note: 'N=14 fixed: 最強い生存バイアス（2022時点で存在した14銘柄が現在まで生存）。深さ優先。',
      config_b_note: 'N=可変（実測14→50）: 生存バイアスは解消されない（PIT組入れは「現在存在する銘柄が過去にデータを持っていたか」で判定し、当時消えた銘柄は物理的に含められない）。幅優先。',
    },
  };

  // Save results
  const outputPath = join(RESULT_DIR, 'stage1-cross-sectional-momentum-exploratory.json');
  writeFileSync(outputPath, JSON.stringify(finalResults, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);

  // Save summary markdown
  const summaryPath = join(RESULT_DIR, 'stage1-exploratory-summary.md');
  const summary = generateSummaryMarkdown(configAResults, configBResults, heldOutResults, finalResults);
  writeFileSync(summaryPath, summary);
  console.log(`Summary saved to: ${summaryPath}`);

  // Save params
  const paramsPath = join(RESULT_DIR, 'stage1-params.json');
  writeFileSync(paramsPath, JSON.stringify({
    configA_symbols: CONFIG_A_SYMBOLS,
    lookbackL_primary: LOOKBACK_L,
    lookbackL_sensitivity: LOOKBACK_SENSITIVITY,
    rebalanceFrequency: 'monthly',
    portfolio: {
      tercileLong: 'top_n/3',
      tercileShort: 'bottom_n/3',
      neutrality: 'dollar-neutral',
    },
    costs: {
      takerFee_bps: TAKER_FEE_BPS,
      slippage_tiers: SLIPPAGE_TIERS,
      fundingNote: 'Funding履歴は3年取得不可のため全期間ネットから除外（ショート保有コストの過小評価）',
    },
    permutation: {
      nPerm: N_PERM,
      seed: PERM_SEED,
    },
    measurementPeriod: [measPeriodStart, measPeriodEnd],
    selectionConfirmationBoundary: '2024-06-30',
    regimeBoundaries: {
      r1: ['2022-01-01', '2022-12-31'],
      r2: ['2023-01-01', '2024-12-31'],
      r3: ['2025-01-01', '2026-07-02'],
    },
  }, null, 2));

  // Save run.log
  const logPath = join(RESULT_DIR, 'stage1-run.log');
  const logContent = `Stage 1 Exploratory Run Log
===========================

Start: ${startTime.toISOString()}
End: ${new Date().toISOString()}

Command:
  node --experimental-strip-types scripts/cross-sectional-momentum-exploratory.ts

Working directory: ${process.cwd()}

Data source: research/EXP-OBS000030/10-result/history-*.json (${historyFiles.length} symbols)

Config A symbols (14 fixed):
${CONFIG_A_SYMBOLS.map(s => '  ' + s).join('\n')}

Spec: research/EXP-OBS000030/00-spec-stage1-exploratory.md

Boundary Conditions (absolute):
  1. Production adoption banned: this exploratory result cannot be used for production (D staging).
  2. Survivorship bias disclosed: all outputs tagged with "生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）".
  3. No formal PASS/FAIL gates (G1-G4 not applied). Observation-based only.
  4. No adoption path even if positive. Any hint → reference for paid data re-run as separate OBS.

Output files:
  - stage1-cross-sectional-momentum-exploratory.json
  - stage1-exploratory-summary.md
  - stage1-params.json
  - stage1-run.log (this file)

Reproducibility:
  All results are deterministic (mulberry32 seed=${PERM_SEED}).
`;
  writeFileSync(logPath, logContent);
  console.log(`Run log saved to: ${logPath}`);

  console.log('\n=== Stage 1 Complete ===');
}

async function processConfig(
  config: 'A' | 'B',
  symbols: string[],
  allHistory: Record<string, CandleRecord[]>,
  startPeriod: string,
  endPeriod: string,
): Promise<{ ic: CrosssectionalICResults; portfolio: PortfolioResults }> {
  const rebalanceDates = monthStartDates(startPeriod, endPeriod);

  // Get available universe at each rebalance date (for Config B PIT logic)
  const getAvailableSymbols = (rbDate: string): string[] => {
    if (config === 'A') return symbols;
    // Config B: PIT - only symbols with ≥60 days (30 lookback + 30 forward observation) by rbDate
    return symbols.filter(sym => {
      const candles = allHistory[sym] || [];
      const available = candles.filter(c => c.date <= rbDate);
      return available.length >= 60;
    });
  };

  // === Cross-sectional IC Measurement ===
  const icData: ICResult[] = [];
  for (const rb of rebalanceDates) {
    const rbDate = rb.date;
    const availSymbols = getAvailableSymbols(rbDate);
    if (availSymbols.length < 3) continue; // Need at least 3 symbols for ranking

    // Get momentum ranks as of rbDate
    const momData = availSymbols
      .map(sym => {
        const candles = allHistory[sym] || [];
        const idx = getClosestCandleIndexOnOrBefore(candles, rbDate);
        if (idx < LOOKBACK_L) return null;
        const momRet = pctChange(candles[idx - LOOKBACK_L].close, candles[idx].close);
        return { symbol: sym, ret: momRet, rank: 0 };
      })
      .filter((x): x is typeof x => x !== null)
      .sort((a, b) => b.ret - a.ret)
      .map((x, i) => ({ ...x, rank: i + 1 }));

    if (momData.length < 3) continue;

    // Get forward returns (1 month ahead)
    const nextMonth = new Date(rbDate + 'T00:00:00Z');
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const nextMonthEnd = new Date(nextMonth);
    nextMonthEnd.setUTCMonth(nextMonthEnd.getUTCMonth() + 1);
    nextMonthEnd.setUTCDate(nextMonthEnd.getUTCDate() - 1);
    const nextMonthEndStr = nextMonthEnd.toISOString().slice(0, 10);

    const fwdData = momData
      .map(m => {
        const candles = allHistory[m.symbol] || [];
        const idxStart = getClosestCandleIndexOnOrBefore(candles, rbDate);
        const idxEnd = getClosestCandleIndexOnOrBefore(candles, nextMonthEndStr);
        if (idxStart < 0 || idxEnd <= idxStart) return null;
        const fwdRet = pctChange(candles[idxStart].close, candles[idxEnd].close);
        return { symbol: m.symbol, ret: fwdRet, rank: 0 };
      })
      .filter((x): x is typeof x => x !== null)
      .sort((a, b) => b.ret - a.ret)
      .map((x, i) => ({ ...x, rank: i + 1 }));

    if (fwdData.length !== momData.length) continue; // Alignment check

    // Compute Spearman IC
    const momRanks = momData.map(m => momData.find(mm => mm.symbol === m.symbol)?.rank || 0);
    const fwdRanks = fwdData.map(f => momData.find(m => m.symbol === f.symbol)?.rank || 0);
    const ic = spearmanCorrelation(momRanks, fwdRanks);

    icData.push({
      rebalanceDate: rbDate,
      momentums: momData,
      forwardReturns: fwdData,
      ic,
      icAbove0: ic > 0,
    });
  }

  // Permutation test for IC
  let icAbove0Count = 0;
  let icPermPGreater = 0;
  const rng = mulberry32(PERM_SEED);
  const meanIC = mean(icData.map(d => d.ic));

  for (let p = 0; p < N_PERM; p++) {
    // For each rebalance, shuffle the forward return ranks and recompute IC
    let permMeanIC = 0;
    for (const rebal of icData) {
      const fwdRanksOrig = rebal.forwardReturns.map(f => rebal.momentums.find(m => m.symbol === f.symbol)?.rank || 0);
      const fwdRanksShuffled = [...fwdRanksOrig];
      for (let i = fwdRanksShuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [fwdRanksShuffled[i], fwdRanksShuffled[j]] = [fwdRanksShuffled[j], fwdRanksShuffled[i]];
      }
      const momRanks = rebal.momentums.map(m => rebal.momentums.find(mm => mm.symbol === m.symbol)?.rank || 0);
      const icPerm = spearmanCorrelation(momRanks, fwdRanksShuffled);
      permMeanIC += icPerm;
    }
    permMeanIC /= icData.length;
    if (permMeanIC >= meanIC) icPermPGreater++;
  }

  const icPermP = (icPermPGreater + 1) / (N_PERM + 1);
  icAbove0Count = icData.filter(d => d.icAbove0).length;

  const icResults: CrosssectionalICResults = {
    config,
    universe: getAvailableSymbols(endPeriod),
    rebalances: icData,
    meanIC,
    stdIC: std(icData.map(d => d.ic)),
    tIC: std(icData.map(d => d.ic)) > 0 ? meanIC / (std(icData.map(d => d.ic)) / Math.sqrt(icData.length)) : 0,
    pctAbove0: icData.length > 0 ? icAbove0Count / icData.length : 0,
    permutationP: icPermP,
    notes: `生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）・N=${getAvailableSymbols(endPeriod).length}。測定期間=${icData.length}ヶ月。`,
  };

  // === Portfolio Simulation ===
  const portfolioMonthlyReturns: number[] = [];
  const portfolioMonthlyReturnsNet: number[] = [];
  const portfolioRebalances: PortfolioMetrics[] = [];

  for (let i = 0; i < rebalanceDates.length - 1; i++) {
    const rbDate = rebalanceDates[i].date;
    const nextRbDate = rebalanceDates[i + 1].date;
    const availSymbols = getAvailableSymbols(rbDate);

    // Momentum ranks
    const momData = availSymbols
      .map(sym => {
        const candles = allHistory[sym] || [];
        const idx = getClosestCandleIndexOnOrBefore(candles, rbDate);
        if (idx < LOOKBACK_L) return null;
        const momRet = pctChange(candles[idx - LOOKBACK_L].close, candles[idx].close);
        return { symbol: sym, ret: momRet };
      })
      .filter((x): x is typeof x => x !== null)
      .sort((a, b) => b.ret - a.ret);

    if (momData.length < 6) continue; // Need at least 6 for N/3 ≥ 2

    const k = Math.max(1, Math.round(momData.length / 3));
    const longSymbols = momData.slice(0, k).map(m => m.symbol);
    const shortSymbols = momData.slice(momData.length - k).map(m => m.symbol);

    // Build positions
    const positions: PortfolioPosition[] = [];
    for (const sym of longSymbols) {
      positions.push({
        date: rbDate,
        symbol: sym,
        side: 'long',
        weight: 0.5 / k, // 0.5 dollar / k symbols
        quantity: 0,
      });
    }
    for (const sym of shortSymbols) {
      positions.push({
        date: rbDate,
        symbol: sym,
        side: 'short',
        weight: -0.5 / k,
        quantity: 0,
      });
    }

    // Calculate returns
    let grossReturn = 0;
    let netReturn = 0;
    let turnoverId = 0; // Sum of absolute weight changes

    for (const pos of positions) {
      const candles = allHistory[pos.symbol] || [];
      const idxStart = getClosestCandleIndexOnOrBefore(candles, rbDate);
      const idxEnd = getClosestCandleIndexOnOrBefore(candles, nextRbDate);
      if (idxStart < 0 || idxEnd <= idxStart) continue;

      const periodRet = pctChange(candles[idxStart].close, candles[idxEnd].close);
      const posRet = pos.weight * periodRet;
      grossReturn += posRet;

      // Calculate cost
      const rank = (pos.side === 'long' ? longSymbols.indexOf(pos.symbol) + 1 : momData.length - shortSymbols.indexOf(pos.symbol));
      const slippageBps = SLIPPAGE_TIERS.find(t => rank <= t.max)?.bps || 30;
      const costBps = TAKER_FEE_BPS + slippageBps; // Per side, so *2 for round-trip
      const costAmount = pos.weight * (costBps * 2 / 10000); // Round-trip cost
      netReturn += posRet - costAmount;

      turnoverId += Math.abs(pos.weight);
    }

    portfolioMonthlyReturns.push(grossReturn);
    portfolioMonthlyReturnsNet.push(netReturn);

    portfolioRebalances.push({
      rebalanceDate: rbDate,
      positions,
      monthlyReturn: netReturn,
      grossReturn,
      netReturn,
      turnoverId,
    });
  }

  // Calculate Sharpe
  const grossMean = mean(portfolioMonthlyReturns);
  const grossStd = std(portfolioMonthlyReturns);
  const grossSharpe = grossStd > 0 ? (grossMean / grossStd) * Math.sqrt(12) : 0;

  const netMean = mean(portfolioMonthlyReturnsNet);
  const netStd = std(portfolioMonthlyReturnsNet);
  const netSharpe = netStd > 0 ? (netMean / netStd) * Math.sqrt(12) : 0;

  // Calculate cumulative return and max DD
  let grossCum = 1;
  let netCum = 1;
  let grossMaxDD = 0;
  let netMaxDD = 0;
  let grossPeak = 1;
  let netPeak = 1;

  for (const ret of portfolioMonthlyReturns) {
    grossCum *= 1 + ret;
    grossPeak = Math.max(grossPeak, grossCum);
    grossMaxDD = Math.min(grossMaxDD, (grossCum - grossPeak) / grossPeak);
  }

  for (const ret of portfolioMonthlyReturnsNet) {
    netCum *= 1 + ret;
    netPeak = Math.max(netPeak, netCum);
    netMaxDD = Math.min(netMaxDD, (netCum - netPeak) / netPeak);
  }

  // Permutation test for portfolio
  let portfolioPermPGreater = 0;
  for (let p = 0; p < N_PERM; p++) {
    const monthlyShuffled = [...portfolioMonthlyReturnsNet];
    for (let i = monthlyShuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [monthlyShuffled[i], monthlyShuffled[j]] = [monthlyShuffled[j], monthlyShuffled[i]];
    }
    const permMean = mean(monthlyShuffled);
    const permStd = std(monthlyShuffled);
    const permSharpe = permStd > 0 ? (permMean / permStd) * Math.sqrt(12) : 0;
    if (permSharpe >= netSharpe) portfolioPermPGreater++;
  }
  const portfolioPermP = (portfolioPermPGreater + 1) / (N_PERM + 1);

  const portfolioResults: PortfolioResults = {
    config,
    universe: getAvailableSymbols(endPeriod),
    rebalances: portfolioRebalances,
    grossSharpe,
    netSharpe,
    grossCumulativeReturn: grossCum - 1,
    netCumulativeReturn: netCum - 1,
    grossMaxDD,
    netMaxDD,
    monthlyReturnsGross: portfolioMonthlyReturns,
    monthlyReturnsNet: portfolioMonthlyReturnsNet,
    permutationPGross: 1, // Not computed for gross (cost-agnostic)
    permutationPNet: portfolioPermP,
    fundingNote: 'Funding履歴は無料API 3年不成立のため全期間ネットから除外。ショート保有コストが過小評価されている可能性。',
    notes: `生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）・N=${getAvailableSymbols(endPeriod).length}。測定期間=${portfolioRebalances.length}ヶ月。`,
  };

  return { ic: icResults, portfolio: portfolioResults };
}

async function computeHeldOutAnalysis(
  configASymbols: string[],
  allHistory: Record<string, CandleRecord[]>,
  startPeriod: string,
  endPeriod: string,
  configAResults: { ic: CrosssectionalICResults; portfolio: PortfolioResults },
): Promise<HeldOutResults> {
  // Split into odd/even indices (1-indexed per spec)
  const selectionSymbols = configASymbols.filter((_, i) => (i + 1) % 2 === 1); // Odd: 1,3,5,...
  const confirmationSymbols = configASymbols.filter((_, i) => (i + 1) % 2 === 0); // Even: 2,4,6,...

  // Compute IC on selection symbols
  const rebalanceDates = monthStartDates(startPeriod, endPeriod);
  let selectionICSum = 0;
  let selectionCount = 0;

  for (const rb of rebalanceDates) {
    const rbDate = rb.date;
    const momData = selectionSymbols
      .map(sym => {
        const candles = allHistory[sym] || [];
        const idx = getClosestCandleIndexOnOrBefore(candles, rbDate);
        if (idx < LOOKBACK_L) return null;
        const momRet = pctChange(candles[idx - LOOKBACK_L].close, candles[idx].close);
        return { symbol: sym, ret: momRet };
      })
      .filter((x): x is typeof x => x !== null)
      .sort((a, b) => b.ret - a.ret);

    if (momData.length < 2) continue;

    const nextMonth = new Date(rbDate + 'T00:00:00Z');
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const nextMonthEnd = new Date(nextMonth);
    nextMonthEnd.setUTCMonth(nextMonthEnd.getUTCMonth() + 1);
    nextMonthEnd.setUTCDate(nextMonthEnd.getUTCDate() - 1);
    const nextMonthEndStr = nextMonthEnd.toISOString().slice(0, 10);

    const fwdData = momData
      .map(m => {
        const candles = allHistory[m.symbol] || [];
        const idxStart = getClosestCandleIndexOnOrBefore(candles, rbDate);
        const idxEnd = getClosestCandleIndexOnOrBefore(candles, nextMonthEndStr);
        if (idxStart < 0 || idxEnd <= idxStart) return null;
        const fwdRet = pctChange(candles[idxStart].close, candles[idxEnd].close);
        return { symbol: m.symbol, ret: fwdRet };
      })
      .filter((x): x is typeof x => x !== null);

    if (fwdData.length === momData.length) {
      const momRanks = momData.map(m => momData.findIndex(mm => mm.symbol === m.symbol) + 1);
      const fwdRanks = fwdData.map(f => momData.findIndex(m => m.symbol === f.symbol) + 1);
      const ic = spearmanCorrelation(momRanks, fwdRanks);
      selectionICSum += ic;
      selectionCount++;
    }
  }

  const selectionIC = selectionCount > 0 ? selectionICSum / selectionCount : 0;

  // Compute IC on confirmation symbols
  let confirmationICSum = 0;
  let confirmationCount = 0;

  for (const rb of rebalanceDates) {
    const rbDate = rb.date;
    const momData = confirmationSymbols
      .map(sym => {
        const candles = allHistory[sym] || [];
        const idx = getClosestCandleIndexOnOrBefore(candles, rbDate);
        if (idx < LOOKBACK_L) return null;
        const momRet = pctChange(candles[idx - LOOKBACK_L].close, candles[idx].close);
        return { symbol: sym, ret: momRet };
      })
      .filter((x): x is typeof x => x !== null)
      .sort((a, b) => b.ret - a.ret);

    if (momData.length < 2) continue;

    const nextMonth = new Date(rbDate + 'T00:00:00Z');
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const nextMonthEnd = new Date(nextMonth);
    nextMonthEnd.setUTCMonth(nextMonthEnd.getUTCMonth() + 1);
    nextMonthEnd.setUTCDate(nextMonthEnd.getUTCDate() - 1);
    const nextMonthEndStr = nextMonthEnd.toISOString().slice(0, 10);

    const fwdData = momData
      .map(m => {
        const candles = allHistory[m.symbol] || [];
        const idxStart = getClosestCandleIndexOnOrBefore(candles, rbDate);
        const idxEnd = getClosestCandleIndexOnOrBefore(candles, nextMonthEndStr);
        if (idxStart < 0 || idxEnd <= idxStart) return null;
        const fwdRet = pctChange(candles[idxStart].close, candles[idxEnd].close);
        return { symbol: m.symbol, ret: fwdRet };
      })
      .filter((x): x is typeof x => x !== null);

    if (fwdData.length === momData.length) {
      const momRanks = momData.map(m => momData.findIndex(mm => mm.symbol === m.symbol) + 1);
      const fwdRanks = fwdData.map(f => momData.findIndex(m => m.symbol === f.symbol) + 1);
      const ic = spearmanCorrelation(momRanks, fwdRanks);
      confirmationICSum += ic;
      confirmationCount++;
    }
  }

  const confirmationIC = confirmationCount > 0 ? confirmationICSum / confirmationCount : 0;

  return {
    selectionIC,
    confirmationIC,
    sameSign: Math.sign(selectionIC) === Math.sign(confirmationIC) && selectionIC !== 0,
    note: `生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）・N_selection=${selectionSymbols.length}/N_confirmation=${confirmationSymbols.length}。パワー低い（各群N=7）。`,
  };
}

function generateSummaryMarkdown(
  configA: { ic: CrosssectionalICResults; portfolio: PortfolioResults },
  configB: { ic: CrosssectionalICResults; portfolio: PortfolioResults },
  heldOut: HeldOutResults,
  fullResults: Record<string, unknown>,
): string {
  return `# Stage 1 Cross-Sectional Momentum - Exploratory Summary

**生存バイアス上振れ・非採用前提・現行生存銘柄のみ（死銘柄除外）。本結果はいかなる場合も本番採用の判断材料にしない。**

## Boundary Conditions

1. **Production adoption banned**: This exploratory result cannot be used for production decision (D staging).
2. **Survivorship bias disclosed** (all tables below tagged): Bitget current live symbols only, dead symbols excluded.
3. **No formal PASS/FAIL judgment**: Observation-based only (no G1-G4 gates applied).
4. **No adoption path even if positive**: Any hint → reference for paid-data re-run as separate OBS.

---

## Config A: 14 Fixed Symbols

**生存バイアス: 最強（2022~2026通年の14銘柄のみ）**

### Prediction Unit (Cross-sectional IC)

| Metric | Value |
|---|---|
| Mean IC | ${configA.ic.meanIC.toFixed(4)} |
| Std IC | ${configA.ic.stdIC.toFixed(4)} |
| t-stat (IC) | ${configA.ic.tIC.toFixed(4)} |
| % Above 0 | ${(configA.ic.pctAbove0 * 100).toFixed(1)}% |
| Permutation p-value | ${configA.ic.permutationP.toFixed(4)} |
| Measurement periods (months) | ${configA.ic.rebalances.length} |

_注記: ${configA.ic.notes}_

### Pipeline Integration (Dollar-Neutral Long-Short Monthly Tercile)

| Metric | Gross | Net |
|---|---|---|
| Annual Sharpe | ${configA.portfolio.grossSharpe.toFixed(4)} | ${configA.portfolio.netSharpe.toFixed(4)} |
| Cumulative Return | ${(configA.portfolio.grossCumulativeReturn * 100).toFixed(2)}% | ${(configA.portfolio.netCumulativeReturn * 100).toFixed(2)}% |
| Max Drawdown | ${(configA.portfolio.grossMaxDD * 100).toFixed(2)}% | ${(configA.portfolio.netMaxDD * 100).toFixed(2)}% |
| Monthly observations | ${configA.portfolio.monthlyReturnsNet.length} |
| Permutation p-value (Net) | ${configA.portfolio.permutationPNet.toFixed(4)} |

_注記: ${configA.portfolio.notes}_

_Funding note: ${configA.portfolio.fundingNote}_

### Held-Out Coin Split (Config A only)

| Group | Mean IC |
|---|---|
| Selection (odd indices, 7 coins) | ${heldOut.selectionIC.toFixed(4)} |
| Confirmation (even indices, 7 coins) | ${heldOut.confirmationIC.toFixed(4)} |
| Same sign? | ${heldOut.sameSign ? 'Yes' : 'No'} |

_注記: ${heldOut.note}_

### Time-Series Split (2024-06-30 Boundary)

| Period | Mean IC | Std IC | Perm p |
|---|---|---|---|
| Selection (2022-01〜2024-06) | (computed in JSON) | — | — |
| Confirmation (2024-07〜2026-07) | (computed in JSON) | — | — |

_詳細は stage1-cross-sectional-momentum-exploratory.json を参照_

### Regime Decomposition (Config A)

| Regime | Period | Mean IC | Gross Sharpe | Net Sharpe | Note |
|---|---|---|---|---|---|
| R1 (Bearish/2022) | 2022-01〜2022-12 | (in JSON) | (in JSON) | (in JSON) | Weakness test |
| R2 (Recovery/2023-24) | 2023-01〜2024-12 | (in JSON) | (in JSON) | (in JSON) | Bull regime |
| R3 (Recent/2025-26) | 2025-01〜2026-07 | (in JSON) | (in JSON) | (in JSON) | Recent |

_詳細は stage1-cross-sectional-momentum-exploratory.json を参照_

---

## Config B: PIT Variable N (Supplementary)

**生存バイアス: 未解消（PIT組入れは「現在存在する銘柄が過去にデータを持っていたか」で判定し、当時消えた銘柄は物理的に含められない）**

### Prediction Unit (Cross-sectional IC)

| Metric | Value |
|---|---|
| Mean IC | ${configB.ic.meanIC.toFixed(4)} |
| Std IC | ${configB.ic.stdIC.toFixed(4)} |
| t-stat (IC) | ${configB.ic.tIC.toFixed(4)} |
| % Above 0 | ${(configB.ic.pctAbove0 * 100).toFixed(1)}% |
| Permutation p-value | ${configB.ic.permutationP.toFixed(4)} |
| Measurement periods (months) | ${configB.ic.rebalances.length} |
| Avg universe size (N) | ~${Math.round((configB.ic.rebalances.length > 0 ? configB.ic.universe.length : 0))} |

_注記: ${configB.ic.notes}_

### Pipeline Integration (Dollar-Neutral Long-Short Monthly Tercile)

| Metric | Gross | Net |
|---|---|---|
| Annual Sharpe | ${configB.portfolio.grossSharpe.toFixed(4)} | ${configB.portfolio.netSharpe.toFixed(4)} |
| Cumulative Return | ${(configB.portfolio.grossCumulativeReturn * 100).toFixed(2)}% | ${(configB.portfolio.netCumulativeReturn * 100).toFixed(2)}% |
| Max Drawdown | ${(configB.portfolio.grossMaxDD * 100).toFixed(2)}% | ${(configB.portfolio.netMaxDD * 100).toFixed(2)}% |
| Monthly observations | ${configB.portfolio.monthlyReturnsNet.length} |
| Permutation p-value (Net) | ${configB.portfolio.permutationPNet.toFixed(4)} |

_注記: ${configB.portfolio.notes}_

_Funding note: ${configB.portfolio.fundingNote}_

---

## Cost Structure

| Component | Value | Note |
|---|---|---|
| Taker fee | 6 bps / side | Bitget USDT-perp standard |
| Slippage Tier 1-10 | 5 bps / side | Based on 24h USDT volume rank |
| Slippage Tier 11-30 | 15 bps / side | — |
| Slippage Tier 31+ | 30 bps / side | — |
| Round-trip cost per trade | (fee + slippage) × 2 | Applied each monthly rebalance |
| Funding cost | **NOT INCLUDED** | 3-year history unavailable via free API (~90 day max). Short leg cost understated. |

---

## Key Observations (Factual, No Judgment)

1. **Config A (Deep, Fixed 14)**:
   - Mean IC = ${configA.ic.meanIC.toFixed(4)}, std = ${configA.ic.stdIC.toFixed(4)}, t = ${configA.ic.tIC.toFixed(4)}, perm-p = ${configA.ic.permutationP.toFixed(4)}
   - Net Sharpe = ${configA.portfolio.netSharpe.toFixed(4)}, cumulative net = ${(configA.portfolio.netCumulativeReturn * 100).toFixed(2)}%
   - Held-out confirmation IC = ${heldOut.confirmationIC.toFixed(4)} (same sign as selection: ${heldOut.sameSign})

2. **Config B (Broad, Variable N)**:
   - Mean IC = ${configB.ic.meanIC.toFixed(4)}, std = ${configB.ic.stdIC.toFixed(4)}, t = ${configB.ic.tIC.toFixed(4)}, perm-p = ${configB.ic.permutationP.toFixed(4)}
   - Net Sharpe = ${configB.portfolio.netSharpe.toFixed(4)}, cumulative net = ${(configB.portfolio.netCumulativeReturn * 100).toFixed(2)}%

3. **Funding gap**: Funding履歴欠損により、ショート保有コスト（キャリー・イージング）が測定に含まれていない。実際のネットコストはここで示す値より大きい可能性。

---

## Non-Judgment Template

**B implementation officer does not apply Rubric § 5 (seeds / weak hint / mixed classification). That interpretation is reserved for C critical reviewer.**

Raw numbers above. End of Stage 1.

---

## File References

- Full results: stage1-cross-sectional-momentum-exploratory.json
- Reproducibility: stage1-params.json, stage1-run.log
- Spec: research/EXP-OBS000030/00-spec-stage1-exploratory.md
`;
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
