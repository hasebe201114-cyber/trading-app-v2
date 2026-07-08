/**
 * デルタニュートラル・ポジションのテール被害幅実測（EXP-OBS000032 G0-4）
 *
 * OBS000026の funding-carry-delta-neutral.ts を拡張し、
 * 実perp価格ベーシスP&Lを追加した日次損益をシミュレート。
 * テール窓（T1/T2/T3）での最大DD・最悪日次損失・清算発生フラグを算出。
 *
 * 日次P&L構成:
 *   funding P&L = 日次合算funding（ショート側受取）
 *   basis P&L = 現物ロング × perpショート等ノーション の価格方向以外の残差
 *            = ノーション × [ (spot_t/spot_{t-1} - 1) - (perp_t/perp_{t-1} - 1) ]
 *            ≈ -Δbasis
 *
 * 実行例:
 *   node --experimental-strip-types scripts/tail-damage-delta-neutral.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000032', '10-result');
mkdirSync(RESULT_DIR, { recursive: true });

const executionLog: string[] = [];

function log(message: string): void {
  console.log(message);
  executionLog.push(`[${new Date().toISOString()}] ${message}`);
}

interface PriceData {
  date: string;
  close: number;
}

interface FundingData {
  date: string;
  dailyRate: number;
}

// CSV から日足OHLCV読み込み
function loadDailyPrices(csvPath: string): PriceData[] {
  const csv = readFileSync(csvPath, 'utf-8');
  const lines = csv.trim().split('\n');
  const prices: PriceData[] = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const date = parts[0];
    const close = parseFloat(parts[4]);
    if (!isNaN(close)) {
      prices.push({ date, close });
    }
  }

  return prices;
}

// CSV からfunding読み込み & 日次合算
function loadDailyFunding(csvPath: string): FundingData[] {
  const csv = readFileSync(csvPath, 'utf-8');
  const lines = csv.trim().split('\n');
  const fundingByDate = new Map<string, number[]>();

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    const datetime = parts[0];
    const fundingRate = parseFloat(parts[1]);

    if (!isNaN(fundingRate)) {
      const date = datetime.slice(0, 10);
      if (!fundingByDate.has(date)) {
        fundingByDate.set(date, []);
      }
      fundingByDate.get(date)!.push(fundingRate);
    }
  }

  const result: FundingData[] = [];
  for (const [date, rates] of fundingByDate) {
    const dailyRate = rates.reduce((a, b) => a + b, 0);
    result.push({ date, dailyRate });
  }

  result.sort((a, b) => a.date.localeCompare(b.date));
  return result;
}

interface DailyPnL {
  date: string;
  spot_return: number;
  perp_return: number;
  funding_pnl_bps: number;
  basis_pnl_bps: number;
  total_pnl_bps: number;
}

// テール窓でのシミュレーション
function simulateTailWindow(
  spot: PriceData[],
  perp: PriceData[],
  funding: FundingData[],
  startDate: string,
  endDate: string,
): {
  window_pnl: DailyPnL[];
  cumulative_pnl_bps: number;
  max_dd_bps: number;
  worst_day_loss_bps: number;
  liquidated: boolean;
} {
  // ウィンドウ内のデータフィルタ
  const windowSpot = spot.filter(s => s.date >= startDate && s.date <= endDate);
  const windowPerp = perp.filter(p => p.date >= startDate && p.date <= endDate);
  const windowFunding = funding.filter(f => f.date >= startDate && f.date <= endDate);

  if (windowSpot.length === 0 || windowPerp.length === 0) {
    return {
      window_pnl: [],
      cumulative_pnl_bps: 0,
      max_dd_bps: 0,
      worst_day_loss_bps: 0,
      liquidated: false,
    };
  }

  // Date→Price マッピング
  const spotMap = new Map(windowSpot.map(s => [s.date, s.close]));
  const perpMap = new Map(windowPerp.map(p => [p.date, p.close]));
  const fundingMap = new Map(windowFunding.map(f => [f.date, f.dailyRate]));

  // 共通日付でのみ損益計算
  const commonDates = Array.from(spotMap.keys()).filter(d => perpMap.has(d));
  commonDates.sort();

  const pnls: DailyPnL[] = [];
  let liquidated = false;

  for (let i = 0; i < commonDates.length; i++) {
    const date = commonDates[i];
    const spotClose = spotMap.get(date)!;
    const perpClose = perpMap.get(date)!;
    const fundingDaily = fundingMap.get(date) ?? 0;

    let spotReturn = 0;
    let perpReturn = 0;

    if (i > 0) {
      const prevDate = commonDates[i - 1];
      const prevSpot = spotMap.get(prevDate)!;
      const prevPerp = perpMap.get(prevDate)!;

      spotReturn = (spotClose - prevSpot) / prevSpot;
      perpReturn = (perpClose - prevPerp) / prevPerp;
    }

    // funding P&L: ショートperpが正のfundingを受取
    const fundingPnlBps = fundingDaily * 10000; // rate to bps

    // basis P&L: 現物ロング × perpショート等ノーション の価格方向以外の残差
    // = ノーション × [(spot_t/spot_{t-1} - 1) - (perp_t/perp_{t-1} - 1)]
    // = ノーション × (spotReturn - perpReturn)
    // 単位: bps （ノーション=1と正規化）
    const basisPnlBps = (spotReturn - perpReturn) * 10000;

    // 総P&L
    const totalPnlBps = fundingPnlBps + basisPnlBps;

    pnls.push({
      date,
      spot_return: spotReturn * 10000,
      perp_return: perpReturn * 10000,
      funding_pnl_bps: fundingPnlBps,
      basis_pnl_bps: basisPnlBps,
      total_pnl_bps: totalPnlBps,
    });

    // 簡略化：窓内で現物ロング＋perpショート構成が清算されないと仮定
    // (詳細な清算判定は G0-3 で）
  }

  // 累積P&L
  let cumPnl = 0;
  let maxCumPnl = 0;
  let maxDD = 0;
  let worstDay = 0;

  for (const pnl of pnls) {
    cumPnl += pnl.total_pnl_bps;
    maxCumPnl = Math.max(maxCumPnl, cumPnl);
    maxDD = Math.min(maxDD, cumPnl - maxCumPnl);
    worstDay = Math.min(worstDay, pnl.total_pnl_bps);
  }

  return {
    window_pnl: pnls,
    cumulative_pnl_bps: cumPnl,
    max_dd_bps: -maxDD, // 正の値として返す（DD=drawdown）
    worst_day_loss_bps: -worstDay, // 正の値として返す（loss）
    liquidated,
  };
}

// 比較用：basis P&L を0にしたシミュレーション（OBS026相当）
function simulateTailWindowNoBasis(
  spot: PriceData[],
  perp: PriceData[],
  funding: FundingData[],
  startDate: string,
  endDate: string,
): {
  cumulative_pnl_bps: number;
  max_dd_bps: number;
  worst_day_loss_bps: number;
} {
  const windowSpot = spot.filter(s => s.date >= startDate && s.date <= endDate);
  const windowPerp = perp.filter(p => p.date >= startDate && p.date <= endDate);
  const windowFunding = funding.filter(f => f.date >= startDate && f.date <= endDate);

  if (windowSpot.length === 0 || windowPerp.length === 0) {
    return { cumulative_pnl_bps: 0, max_dd_bps: 0, worst_day_loss_bps: 0 };
  }

  const spotMap = new Map(windowSpot.map(s => [s.date, s.close]));
  const perpMap = new Map(windowPerp.map(p => [p.date, p.close]));
  const fundingMap = new Map(windowFunding.map(f => [f.date, f.dailyRate]));

  const commonDates = Array.from(spotMap.keys()).filter(d => perpMap.has(d));
  commonDates.sort();

  let cumPnl = 0;
  let maxCumPnl = 0;
  let maxDD = 0;
  let worstDay = 0;

  for (const date of commonDates) {
    const fundingDaily = fundingMap.get(date) ?? 0;
    const fundingPnlBps = fundingDaily * 10000;
    // basis P&L = 0 (026相当)

    cumPnl += fundingPnlBps;
    maxCumPnl = Math.max(maxCumPnl, cumPnl);
    maxDD = Math.min(maxDD, cumPnl - maxCumPnl);
    worstDay = Math.min(worstDay, fundingPnlBps);
  }

  return {
    cumulative_pnl_bps: cumPnl,
    max_dd_bps: -maxDD,
    worst_day_loss_bps: -worstDay,
  };
}

async function main(): Promise<void> {
  const startTime = new Date().toISOString();
  log(`=== EXP-OBS000032 G0-4: テール被害幅実測 ===`);
  log(`開始時刻: ${startTime}\n`);

  const TAIL_WINDOWS = {
    T1: { name: 'T1 (2020-03 コロナ)', start: '2020-02-20', end: '2020-04-30' },
    T2: { name: 'T2 (2022-05 LUNA)', start: '2022-05-01', end: '2022-06-30' },
    T3: { name: 'T3 (2022-11 FTX)', start: '2022-10-25', end: '2022-12-15' },
    calm: { name: 'calm (2021-01〜06)', start: '2021-01-01', end: '2021-06-30' },
  };

  const results = {
    timestamp: startTime,
    delta_neutral_structure: {
      spot_leg: 'Long 等ノーション（1.0正規化）',
      perp_leg: 'Short 等ノーション（1.0正規化）',
      pnl_components: [
        'funding P&L: 日次合算funding × ノーション (ショート側が受取)',
        'basis P&L: (spot_return - perp_return) × 10000 bps',
        'total: funding + basis',
      ],
    },
    windows: {} as Record<string, unknown>,
  };

  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    log(`\n======== ${symbol} ========`);

    const spotCsv = join(RESULT_DIR, `${symbol.toLowerCase()}-spot-daily.csv`);
    const perpCsv = join(RESULT_DIR, `${symbol.toLowerCase()}-perp-last-daily.csv`);
    const fundingCsv = join(RESULT_DIR, `${symbol.toLowerCase()}-funding.csv`);

    const spot = loadDailyPrices(spotCsv);
    const perp = loadDailyPrices(perpCsv);
    const funding = loadDailyFunding(fundingCsv);

    log(`  現物: ${spot.length}本, Perp: ${perp.length}本, Funding: ${funding.length}件`);

    const symbolResults: Record<string, unknown> = {};

    for (const [wkey, window] of Object.entries(TAIL_WINDOWS)) {
      log(`  ${window.name}:`);

      const result = simulateTailWindow(spot, perp, funding, window.start, window.end);
      const resultNoBasis = simulateTailWindowNoBasis(spot, perp, funding, window.start, window.end);

      log(`    PnL数: ${result.window_pnl.length}日`);
      log(`    累積P&L: ${result.cumulative_pnl_bps.toFixed(1)} bps`);
      log(`    最大DD: ${result.max_dd_bps.toFixed(1)} bps`);
      log(`    最悪日次損失: ${result.worst_day_loss_bps.toFixed(1)} bps`);
      log(`    [026比較(basis=0)] 累積: ${resultNoBasis.cumulative_pnl_bps.toFixed(1)} bps, DD: ${resultNoBasis.max_dd_bps.toFixed(1)} bps`);

      // 詳細な日次PnLをCSV保存
      if (result.window_pnl.length > 0) {
        const csvLines = ['date,spot_return_bps,perp_return_bps,funding_pnl_bps,basis_pnl_bps,total_pnl_bps'];
        for (const pnl of result.window_pnl) {
          csvLines.push(
            `${pnl.date},${pnl.spot_return.toFixed(4)},${pnl.perp_return.toFixed(4)},${pnl.funding_pnl_bps.toFixed(4)},${pnl.basis_pnl_bps.toFixed(4)},${pnl.total_pnl_bps.toFixed(4)}`
          );
        }
        const csvPath = join(RESULT_DIR, `daily-pnl-${symbol.toLowerCase()}-${wkey}.csv`);
        writeFileSync(csvPath, csvLines.join('\n') + '\n');
      }

      symbolResults[wkey] = {
        window_dates: { start: window.start, end: window.end },
        days: result.window_pnl.length,
        cumulative_pnl_bps: result.cumulative_pnl_bps,
        max_dd_bps: result.max_dd_bps,
        worst_day_loss_bps: result.worst_day_loss_bps,
        liquidated: result.liquidated,
        pnl_stats: result.window_pnl.length > 0 ? {
          mean_daily_bps: result.window_pnl.reduce((a, p) => a + p.total_pnl_bps, 0) / result.window_pnl.length,
          std_daily_bps: Math.sqrt(
            result.window_pnl.reduce((a, p) => a + p.total_pnl_bps ** 2, 0) / result.window_pnl.length -
            (result.window_pnl.reduce((a, p) => a + p.total_pnl_bps, 0) / result.window_pnl.length) ** 2
          ),
          min_daily_bps: Math.min(...result.window_pnl.map(p => p.total_pnl_bps)),
          max_daily_bps: Math.max(...result.window_pnl.map(p => p.total_pnl_bps)),
        } : null,
        obs026_comparison: {
          cumulative_pnl_bps: resultNoBasis.cumulative_pnl_bps,
          max_dd_bps: resultNoBasis.max_dd_bps,
          worst_day_loss_bps: resultNoBasis.worst_day_loss_bps,
          note: 'basis P&L = 0 の場合（OBS026相当。現物価格でperpを代用）',
        },
      };
    }

    results.windows[symbol] = symbolResults;
  }

  // 結果JSON保存
  writeFileSync(join(RESULT_DIR, 'g0-4-tail-damage.json'), JSON.stringify(results, null, 2));
  log(`\n>>> 結果JSON保存: g0-4-tail-damage.json`);

  // 実行ログ保存
  const runLog = [
    '=== EXP-OBS000032 G0-4: テール被害幅実測 ===',
    `Execution: ${startTime}`,
    '',
    'DELTA-NEUTRAL STRUCTURE (Fixed):',
    '  Spot leg: Long 等ノーション (normalized to 1.0)',
    '  Perp leg: Short 等ノーション (normalized to 1.0)',
    '  No regime flipping (fixed long/short orientation)',
    '',
    'DAILY PnL COMPONENTS:',
    '  funding P&L = Daily summed funding rate × 10000 (in bps)',
    '                Short leg receives positive funding',
    '  basis P&L = (spot_return - perp_return) × 10000 bps',
    '              ≈ -Δbasis (price deviation risk)',
    '  total P&L = funding P&L + basis P&L',
    '',
    'METRICS:',
    '  Cumulative P&L: sum of all daily P&L over window',
    '  Max DD: maximum drawdown (peak to trough)',
    '  Worst day loss: single worst day',
    '  Liquidated: true if short perp cleared in window (simplified, see G0-3)',
    '',
    'OBS026 COMPARISON:',
    '  basis P&L set to 0 (spot price substituted for perp)',
    '  Shows impact of actual perp price deviation risk',
    '',
    'TAIL WINDOWS (Fixed by Spec):',
    '  T1: 2020-02-20 ~ 2020-04-30 (Corona)',
    '  T2: 2022-05-01 ~ 2022-06-30 (LUNA)',
    '  T3: 2022-10-25 ~ 2022-12-15 (FTX)',
    '  calm: 2021-01-01 ~ 2021-06-30 (Placid)',
    '',
    'EXECUTION LOG:',
    ...executionLog,
    '',
    'REPRODUCTION:',
    'node --experimental-strip-types scripts/tail-damage-delta-neutral.ts',
  ];

  writeFileSync(join(RESULT_DIR, 'run-g0-4.log'), runLog.join('\n'));
  log(`\n>>> 実行ログ: run-g0-4.log`);

  log('\n=== G0-4完了 ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
