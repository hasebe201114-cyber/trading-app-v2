/**
 * 既存の history-*.json ファイルから深度分析を再計算（修正版ページング結果向け）
 *
 * 修正ポイント:
 * - Bitgetは昇順（古い→新しい）でデータを返すため、正しい oldest/newest を計算
 * - history-*.json に含まれる全データから統計を計算
 *
 * 実行:
 *   node --experimental-strip-types scripts/recalculate-depth-analysis-v2.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'research', 'EXP-OBS000030', '10-result');

interface HistoryData {
  candles?: Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  fundingRates?: Array<{ datetime: string; fundingRate: number }>;
}

interface HistoryDepthAnalysis {
  symbol: string;
  candles: {
    count: number;
    oldestDate: string | null;
    newestDate: string | null;
    coveredDays: number;
    gapDays: number;
    gapRatio: number;
  };
  fundingRate: {
    count: number;
    oldestDatetime: string | null;
    newestDatetime: string | null;
  };
  covers3YearsFrom: string; // "2022-07-05"
  covers2022FullYear: boolean;
}

function analyzeHistoryDepth(
  symbol: string,
  candles: { date: string }[],
  fundingRates: { datetime: string }[]
): HistoryDepthAnalysis {
  const sortedCandles = candles.sort((a, b) => a.date.localeCompare(b.date));
  const sortedFunding = fundingRates.sort((a, b) => a.datetime.localeCompare(b.datetime));

  const oldestCandleDate = sortedCandles.length > 0 ? sortedCandles[0].date : null;
  const newestCandleDate = sortedCandles.length > 0 ? sortedCandles[sortedCandles.length - 1].date : null;

  // Business days between oldest and newest
  let businessDays = 0;
  if (oldestCandleDate && newestCandleDate) {
    const start = new Date(oldestCandleDate);
    const end = new Date(newestCandleDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dayOfWeek = d.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) businessDays++;
    }
  }

  const missingDays = Math.max(0, businessDays - sortedCandles.length);
  const gapRatio = businessDays > 0 ? missingDays / businessDays : 0;

  const coversSince20220705 = oldestCandleDate && oldestCandleDate <= '2022-07-05';
  const covers2022 =
    sortedCandles.some(c => c.date >= '2022-01-01' && c.date <= '2022-12-31') &&
    sortedCandles.some(c => c.date >= '2022-07-01' && c.date <= '2022-07-31') &&
    sortedCandles.some(c => c.date >= '2022-12-01' && c.date <= '2022-12-31');

  return {
    symbol,
    candles: {
      count: sortedCandles.length,
      oldestDate: oldestCandleDate,
      newestDate: newestCandleDate,
      coveredDays: businessDays,
      gapDays: missingDays,
      gapRatio,
    },
    fundingRate: {
      count: sortedFunding.length,
      oldestDatetime: sortedFunding.length > 0 ? sortedFunding[0].datetime : null,
      newestDatetime: sortedFunding.length > 0 ? sortedFunding[sortedFunding.length - 1].datetime : null,
    },
    covers3YearsFrom: coversSince20220705 ? 'YES' : 'NO',
    covers2022FullYear: covers2022,
  };
}

async function main(): Promise<void> {
  console.log('=== Recalculating depth analysis from existing history files (v2) ===');

  // List all history-*.json files
  const files = readdirSync(DATA_DIR).filter(f => f.startsWith('history-') && f.endsWith('.json'));
  console.log(`Found ${files.length} history files`);

  const depthAnalyses: HistoryDepthAnalysis[] = [];

  for (const file of files.sort()) {
    const filePath = join(DATA_DIR, file);
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as HistoryData;

    // Extract symbol from filename
    const symbol = file.replace('history-', '').replace('.json', '').toUpperCase();

    if (!data.candles || data.candles.length === 0) {
      console.log(`  ${symbol}: no candles in file`);
      continue;
    }

    // Candles are already in date format (from previous conversion)
    const candlesWithDate = data.candles.map(c => ({
      date: c.date,
    }));

    const fundingRates = data.fundingRates || [];

    const analysis = analyzeHistoryDepth(symbol, candlesWithDate, fundingRates);
    depthAnalyses.push(analysis);

    console.log(`  ${symbol}: ${analysis.candles.count}件 (${analysis.candles.oldestDate} .. ${analysis.candles.newestDate})`);
  }

  // Sort by oldest date (as proxy for liquidity/importance)
  depthAnalyses.sort((a, b) => {
    if (a.candles.oldestDate === null) return 1;
    if (b.candles.oldestDate === null) return -1;
    return a.candles.oldestDate.localeCompare(b.candles.oldestDate);
  });

  // Statistics by tier
  const tier20 = depthAnalyses.slice(0, 20);
  const tier30 = depthAnalyses.slice(0, 30);
  const tier50 = depthAnalyses.slice(0, 50);

  const countThreeYears = (tier: HistoryDepthAnalysis[]) => tier.filter(a => a.covers3YearsFrom === 'YES').length;
  const count2022Full = (tier: HistoryDepthAnalysis[]) => tier.filter(a => a.covers2022FullYear).length;

  console.log('\n=== G0-1 Summary (修正後) ===');
  console.log(`N=20: 3年ライン(2022-07-05以前)カバー=${countThreeYears(tier20)}本, 2022通年=${count2022Full(tier20)}本`);
  console.log(`N=30: 3年ライン(2022-07-05以前)カバー=${countThreeYears(tier30)}本, 2022通年=${count2022Full(tier30)}本`);
  console.log(`N=50: 3年ライン(2022-07-05以前)カバー=${countThreeYears(tier50)}本, 2022通年=${count2022Full(tier50)}本`);

  // Save updated analysis
  writeFileSync(
    join(DATA_DIR, 'G0-1-history-depth-analysis-v2.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      timestamp_note: '修正版スクリプト実行結果（昇順正しく解釈）',
      analysis: depthAnalyses,
      summary: {
        N20: { threeYears: countThreeYears(tier20), fullYear2022: count2022Full(tier20) },
        N30: { threeYears: countThreeYears(tier30), fullYear2022: count2022Full(tier30) },
        N50: { threeYears: countThreeYears(tier50), fullYear2022: count2022Full(tier50) },
      },
    }, null, 2)
  );

  console.log('\nResults saved to G0-1-history-depth-analysis-v2.json');

  // Also save detailed comparison table (CSV-like)
  const detailsCsv = [
    'Rank,Symbol,OldestDate,NewestDate,CandleCount,GapRatio,Covers3Years,Covers2022FullYear,FundingCount,FundingOldest,FundingNewest',
    ...depthAnalyses.map((a, i) => `${i + 1},${a.symbol},${a.candles.oldestDate},${a.candles.newestDate},${a.candles.count},${a.candles.gapRatio.toFixed(3)},${a.covers3YearsFrom},${a.covers2022FullYear},${a.fundingRate.count},${a.fundingRate.oldestDatetime},${a.fundingRate.newestDatetime}`),
  ].join('\n');

  writeFileSync(
    join(DATA_DIR, 'G0-1-history-depth-analysis-v2.csv'),
    detailsCsv
  );

  console.log('Detailed CSV saved to G0-1-history-depth-analysis-v2.csv');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
