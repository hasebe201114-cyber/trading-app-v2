/**
 * Stage 1-A: 予測単位（ネットキャリー期待値の統計検定）
 *
 * spec §6 Stage 1-A:
 * - §2の W=7 SMA シグナル（現物×perp・反転ルール・先読み排除）で日次ネットキャリーP&L列を構築
 * - BTC/ETH別・連続全期間＋T1/T2/T3＋calm＋前半/後半で n・累積・平均日次・年率利回り・block-bootstrap p値を出力
 * - block-bootstrap: ブロック長=7日、N=5000、seed=20260705、平均0中心化リサンプリング
 *
 * kill-1（G1A）:
 * - 連続全期間で BTC・ETH両方「平均日次>0 かつ bootstrap p<0.05」
 * - かつ テール窓どれもが全期間を負に転じさせない
 */

import * as fs from 'fs';
import * as path from 'path';

interface DailyData {
  date: string;
  spotPrice: number;
  perpPrice: number;
  fundingRate: number; // daily funding合算
}

interface PeriodSummary {
  period: string;
  n: number;
  cumulativeNetCarry_bps: number;
  meanDailyNetCarry_bps: number;
  annualizedNetCarryRate_pct: number;
  bootstrapPValue: number;
}

// コスト定数（spec §0-2）
const COSTS = {
  BTC: {
    singleLegBps: 6.016,
    reversalFourLegBps: 24.064,
  },
  ETH: {
    singleLegBps: 6.056,
    reversalFourLegBps: 24.224,
  },
};

// テール窓（spec §0-1・固定）
const TAIL_WINDOWS = {
  T1: { start: '2020-02-20', end: '2020-04-30' },
  T2: { start: '2022-05-01', end: '2022-06-30' },
  T3: { start: '2022-10-25', end: '2022-12-15' },
  calm: { start: '2021-01-01', end: '2021-06-30' },
};

// 資本コスト（spec §4-4・年率4%）
const ANNUAL_CAPITAL_COST_RATE = 0.04;

async function loadCSV(filePath: string): Promise<Record<string, string>[]> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const values = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((key, i) => {
      row[key] = values[i];
    });
    return row;
  });
}

function dateToISO(dateStr: string): string {
  return dateStr.split('T')[0]; // 'YYYY-MM-DD' 形式を保証
}

function mergeData(
  spotRows: Record<string, string>[],
  perpRows: Record<string, string>[],
  fundingRows: Record<string, string>[],
): DailyData[] {
  const spotByDate = new Map(spotRows.map(r => [dateToISO(r.date), parseFloat(r.close)]));
  const perpByDate = new Map(perpRows.map(r => [dateToISO(r.date), parseFloat(r.close)]));

  // funding は日次集計（1日に複数の8h funding イベント）
  // funding row の datetime は 'YYYY-MM-DDTHH:MM:SS.000Z' 形式
  const fundingByDate = new Map<string, number>();
  fundingRows.forEach(r => {
    const datetime = r.datetime || r.date;
    const date = dateToISO(datetime);
    const rate = parseFloat(r.funding_rate) || 0;
    fundingByDate.set(date, (fundingByDate.get(date) || 0) + rate);
  });

  // スポットとperp last の日付交集合のみ使用
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

function calculateNetCarryP_L(
  daily: DailyData[],
  assetCode: string,
): { pnlSeries: number[]; reversalDates: Set<string> } {
  const pnlSeries: number[] = [];
  const reversalDates = new Set<string>();

  const costs = COSTS[assetCode as keyof typeof COSTS];
  const dailyCapitalCost = ANNUAL_CAPITAL_COST_RATE / 365; // 名目に対する日次コスト

  // W=7 SMA シグナル（先読み排除：t-1まで）
  let prevSignal: number | null = null;

  for (let i = 0; i < daily.length; i++) {
    const d = daily[i];

    // funding P&L: ショートperp（funding受払）
    // funding_rate は小数（0.0001 = 0.01%）→ bps に変換：* 10000
    // funding > 0 → ショート受取＝+
    const fundingPnl_bps = d.fundingRate * 10000;

    // basis P&L（日次変化）: (spot_return - perp_return) * 10000
    // テレスコープ累積がほぼゼロになるのが正しい（初日は0）
    let basisPnl_bps = 0;
    if (i > 0) {
      const spotReturn = (daily[i].spotPrice / daily[i - 1].spotPrice) - 1;
      const perpReturn = (daily[i].perpPrice / daily[i - 1].perpPrice) - 1;
      basisPnl_bps = (spotReturn - perpReturn) * 10000;
    }

    // 先読み排除：t-1までのfunding SMA の符号を使用
    let currentPnl_bps = fundingPnl_bps + basisPnl_bps;
    let signal: number = 0; // デフォルト：逆キャリー方向（現物ショート×perpロング）

    if (i >= 7) {
      // 過去7日（i-6 から i-1）の funding を合算
      let sum7day = 0;
      for (let j = i - 6; j <= i - 1; j++) {
        sum7day += daily[j].fundingRate;
      }
      // signal > 0 → 順キャリー方向（現物ロング×perpショート）
      // signal < 0 → 逆キャリー方向（現物ショート×perpロング）
      signal = sum7day > 0 ? 1 : sum7day < 0 ? -1 : 0;
    }

    // signal が負（逆キャリー・現物ショート×perpロング）の場合、pnl を反転
    // （逆キャリー時は funding/basis の符号が反転し、ロングperpが受け取る）
    if (signal === -1) {
      currentPnl_bps = -currentPnl_bps;
    }

    // 反転チェック
    if (i > 0 && prevSignal !== null && prevSignal !== signal && prevSignal !== 0 && signal !== 0) {
      // 反転した日に4レッグ往復コストを控除
      currentPnl_bps -= costs.reversalFourLegBps;
      reversalDates.add(d.date);
    }

    // 資本コスト控除（名目ベース・日次）
    const capitalCost_bps = dailyCapitalCost * 10000; // bps単位
    currentPnl_bps -= capitalCost_bps;

    pnlSeries.push(currentPnl_bps);
    prevSignal = signal;
  }

  return { pnlSeries, reversalDates };
}

function calculatePeriodStats(pnlSeries: number[]): PeriodSummary | null {
  if (pnlSeries.length === 0) return null;

  const n = pnlSeries.length;
  const cumulativeNetCarry_bps = pnlSeries.reduce((a, b) => a + b, 0);
  const meanDailyNetCarry_bps = cumulativeNetCarry_bps / n;
  const annualizedNetCarryRate_pct = (meanDailyNetCarry_bps / 10000) * 365 * 100;

  // block-bootstrap p値（平均0中心化リサンプリング）
  const pValue = blockBootstrapPValue(pnlSeries, meanDailyNetCarry_bps);

  return {
    period: '', // 呼び出し側で設定
    n,
    cumulativeNetCarry_bps,
    meanDailyNetCarry_bps,
    annualizedNetCarryRate_pct,
    bootstrapPValue: pValue,
  };
}

function blockBootstrapPValue(pnlSeries: number[], observedMean: number): number {
  /**
   * block-bootstrap（平均0中心化リサンプリング）
   * - ブロック長 L=7（spec §6）
   * - リサンプリング回数 N=5000
   * - seed=20260705（deterministic）
   * - H0: 平均≤0
   * - p値：中心化リサンプルの平均がobservedMean以上になる頻度
   */
  const L = 7; // ブロック長
  const N = 5000; // リサンプリング数
  const seed = 20260705;

  // 平均0中心化
  const centered = pnlSeries.map(x => x - observedMean);
  const numBlocks = Math.ceil(centered.length / L);

  // 疑似乱数生成（seed で決定的）
  const rng = seededRandom(seed);

  let countExtreme = 0;
  for (let iter = 0; iter < N; iter++) {
    // ランダムにブロックを抽出してリサンプリング
    const resample: number[] = [];
    for (let b = 0; b < numBlocks; b++) {
      const blockStart = Math.floor(rng() * (centered.length - L + 1));
      for (let j = 0; j < L && resample.length < centered.length; j++) {
        resample.push(centered[blockStart + j]);
      }
    }

    const resampledMean = resample.slice(0, centered.length).reduce((a, b) => a + b, 0) / centered.length;
    if (resampledMean >= observedMean) {
      countExtreme++;
    }
  }

  return countExtreme / N;
}

function seededRandom(seed: number): () => number {
  // 線形合同法（簡易版・決定的疑似乱数）
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

async function main() {
  const assetCode = process.argv[2] || 'BTC';
  if (!['BTC', 'ETH'].includes(assetCode)) {
    console.error('Usage: node --experimental-strip-types scripts/carry-net-expectation.ts [BTC|ETH]');
    process.exit(1);
  }

  // Windows / POSIX path handling
  const baseDir = 'C:\\Users\\Atsushi Hasebe\\Project\\trading-app-v2\\research\\EXP-OBS000032\\10-result';

  const assetLower = assetCode.toLowerCase();
  const spotPath = path.join(baseDir, `${assetLower}usdt-spot-daily.csv`);
  const perpPath = path.join(baseDir, `${assetLower}usdt-perp-last-daily.csv`);
  const fundingPath = path.join(baseDir, `${assetLower}usdt-funding.csv`);

  console.log(`[${assetCode}] Loading data...`);
  const [spotRows, perpRows, fundingRows] = await Promise.all([
    loadCSV(spotPath),
    loadCSV(perpPath),
    loadCSV(fundingPath),
  ]);

  const daily = mergeData(spotRows, perpRows, fundingRows);
  console.log(`Merged ${daily.length} daily records (${daily[0].date} ~ ${daily[daily.length - 1].date})`);

  const { pnlSeries, reversalDates } = calculateNetCarryP_L(daily, assetCode);

  // 期間別P&L分割
  const periodPnls: Record<string, number[]> = {
    'FULL': pnlSeries,
    'T1': [],
    'T2': [],
    'T3': [],
    'calm': [],
    'H1-2019': [], // 前半（2019-09 ~ 2021-06 ≈ データ中央）
    'H2-2021': [], // 後半
  };

  const dateByIndex = daily.map(d => d.date);
  const midpoint = Math.floor(dateByIndex.length / 2);

  pnlSeries.forEach((pnl, i) => {
    const date = dateByIndex[i];

    // テール窓分類
    const window = getWindowForDate(date);
    if (window) {
      periodPnls[window].push(pnl);
    }

    // 前半/後半分類
    if (i < midpoint) {
      periodPnls['H1-2019'].push(pnl);
    } else {
      periodPnls['H2-2021'].push(pnl);
    }
  });

  // 統計算出
  const results: PeriodSummary[] = [];
  for (const [period, pnls] of Object.entries(periodPnls)) {
    const stats = calculatePeriodStats(pnls);
    if (stats) {
      stats.period = period;
      results.push(stats);
    }
  }

  // JSON出力
  const output = {
    asset: assetCode,
    startDate: daily[0].date,
    endDate: daily[daily.length - 1].date,
    totalDays: daily.length,
    reversalCount: reversalDates.size,
    reversalDates: Array.from(reversalDates).sort(),
    periodSummaries: results,
    bootStrapConfig: {
      blockLength: 7,
      resamplingCount: 5000,
      seed: 20260705,
      centeringMethod: 'mean0',
    },
    notes: 'W=7 SMA signal, mean0-centered block-bootstrap, 4-leg reversal cost on reversion days',
  };

  const outputPath = path.join(baseDir, `stage1-net-expectation-${assetLower}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\nResults written to: ${outputPath}`);

  // 日次P&Lリスト出力（Stage 1-C用）
  const dailyExportPath = path.join(baseDir, `stage1-carry-daily-returns-${assetLower}.json`);
  const dailyExport = {
    asset: assetCode,
    startDate: daily[0].date,
    endDate: daily[daily.length - 1].date,
    totalDays: daily.length,
    data: daily.map((d, i) => ({
      date: d.date,
      pnl_bps: pnlSeries[i],
      returnPct: (pnlSeries[i] / 10000) * 100,
    })),
  };
  fs.writeFileSync(dailyExportPath, JSON.stringify(dailyExport, null, 2));
  console.log(`Daily returns written to: ${dailyExportPath}`);

  // Summary を console に出力（確認用）
  console.log(`\n=== ${assetCode} ===`);
  results.forEach(r => {
    console.log(`${r.period.padEnd(15)} | n=${r.n} | cum=${r.cumulativeNetCarry_bps.toFixed(0)} bps | mean=${r.meanDailyNetCarry_bps.toFixed(3)} bps/day | annual=${r.annualizedNetCarryRate_pct.toFixed(2)}% | p=${r.bootstrapPValue.toFixed(4)}`);
  });
}

main().catch(console.error);
