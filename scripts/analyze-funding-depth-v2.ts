/**
 * Funding履歴の深度分析（修正版pageSize=100結果）
 *
 * 実行:
 *   node --experimental-strip-types scripts/analyze-funding-depth-v2.ts
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'research', 'EXP-OBS000030', '10-result');

interface FundingAnalysis {
  symbol: string;
  fundingCount: number;
  oldestDatetime: string | null;
  newestDatetime: string | null;
  depthDays: number | null;
}

async function main(): Promise<void> {
  console.log('=== Analyzing Funding Rate History Depth (v2) ===');

  const files = readdirSync(DATA_DIR).filter(f => f.startsWith('history-') && f.endsWith('.json'));
  console.log(`Found ${files.length} history files`);

  const fundingAnalyses: FundingAnalysis[] = [];

  for (const file of files.sort()) {
    const filePath = join(DATA_DIR, file);
    const content = readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;

    const symbol = file.replace('history-', '').replace('.json', '').toUpperCase();
    const fundingRates = (data.fundingRates || []) as Array<{ datetime: string; fundingRate: number }>;

    if (fundingRates.length === 0) {
      fundingAnalyses.push({
        symbol,
        fundingCount: 0,
        oldestDatetime: null,
        newestDatetime: null,
        depthDays: null,
      });
      continue;
    }

    // Sort by datetime (datetime is Unix timestamp in milliseconds as string)
    const sorted = fundingRates
      .map(f => ({
        ...f,
        ts: parseInt(f.datetime),
      }))
      .sort((a, b) => a.ts - b.ts);

    const oldestTs = sorted[0].ts;
    const newestTs = sorted[sorted.length - 1].ts;
    const oldestDateObj = new Date(oldestTs);
    const newestDateObj = new Date(newestTs);
    const oldestDatetime = oldestDateObj.toISOString();
    const newestDatetime = newestDateObj.toISOString();

    // Calculate depth in days
    const depthMs = newestTs - oldestTs;
    const depthDays = Math.round(depthMs / (1000 * 60 * 60 * 24));

    fundingAnalyses.push({
      symbol,
      fundingCount: fundingRates.length,
      oldestDatetime,
      newestDatetime,
      depthDays,
    });

    console.log(`  ${symbol}: ${fundingRates.length}件 (${depthDays}日, ${oldestDatetime.split('T')[0]} .. ${newestDatetime.split('T')[0]})`);
  }

  // Save results
  writeFileSync(
    join(DATA_DIR, 'G0-1-funding-depth-analysis-v2.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      note: '修正版スクリプト実行結果（pageSize=100で逐次実行）',
      analysis: fundingAnalyses,
    }, null, 2)
  );

  // Statistics
  const withFunding = fundingAnalyses.filter(a => a.fundingCount > 0);
  const avgDepth = withFunding.length > 0
    ? withFunding.reduce((sum, a) => sum + (a.depthDays || 0), 0) / withFunding.length
    : 0;
  const maxDepth = Math.max(...withFunding.map(a => a.depthDays || 0));

  console.log('\n=== Funding Depth Statistics ===');
  console.log(`Symbols with funding data: ${withFunding.length}/${fundingAnalyses.length}`);
  console.log(`Average depth: ${Math.round(avgDepth)}日`);
  console.log(`Maximum depth: ${maxDepth}日`);

  // Save CSV
  const csv = [
    'Symbol,FundingCount,DepthDays,OldestDatetime,NewestDatetime',
    ...fundingAnalyses.map(a =>
      `${a.symbol},${a.fundingCount},${a.depthDays ?? 'N/A'},${a.oldestDatetime ?? 'N/A'},${a.newestDatetime ?? 'N/A'}`
    ),
  ].join('\n');

  writeFileSync(
    join(DATA_DIR, 'G0-1-funding-depth-analysis-v2.csv'),
    csv
  );

  console.log('\nResults saved to G0-1-funding-depth-analysis-v2.json and .csv');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
