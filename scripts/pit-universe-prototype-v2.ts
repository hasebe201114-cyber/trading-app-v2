/**
 * G0-3: PIT Universe Prototype v2（修正版データ用）
 *
 * 既存の history-*.json から、修正後の深い日足データを使用し、
 * 直近1年（2025-07-05〜2026-07-05）の月次PITユニバースが構成可能かを検証
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'research', 'EXP-OBS000030', '10-result');

interface CandleRecord {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PITRebalance {
  rebalanceDate: string;
  rebalanceYear: number;
  rebalanceMonth: number;
  symbolsWithData: number;
  candidateSymbols: { symbol: string; candleCount: number }[];
}

async function main(): Promise<void> {
  console.log('=== G0-3 PIT Universe Prototype v2 ===');
  console.log('Using fixed history data from storage\n');

  // Load all history files
  const files = readdirSync(DATA_DIR).filter(f => f.startsWith('history-') && f.endsWith('.json'));
  console.log(`Loaded ${files.length} history files\n`);

  const allHistory: Record<string, CandleRecord[]> = {};
  for (const file of files) {
    const symbol = file.replace('history-', '').replace('.json', '').toUpperCase();
    const content = readFileSync(join(DATA_DIR, file), 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;
    const candles = (data.candles || []) as CandleRecord[];
    allHistory[symbol] = candles.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Define rebalance dates (monthly, 1st of each month, last 12 months from 2025-07 to 2026-07)
  const rebalanceDates = [
    '2025-07-01',
    '2025-08-01',
    '2025-09-01',
    '2025-10-01',
    '2025-11-01',
    '2025-12-01',
    '2026-01-01',
    '2026-02-01',
    '2026-03-01',
    '2026-04-01',
    '2026-05-01',
    '2026-06-01',
    '2026-07-01',
  ];

  const pitResults: PITRebalance[] = [];

  for (const rbDate of rebalanceDates) {
    console.log(`\nRebalance date: ${rbDate}`);

    // For each symbol, count how many days of data are available UP TO this date
    const candidates: { symbol: string; candleCount: number }[] = [];

    for (const [symbol, candles] of Object.entries(allHistory)) {
      // Filter candles up to rebalanceDate (as-of)
      const availableCandles = candles.filter(c => c.date <= rbDate);
      if (availableCandles.length > 0) {
        candidates.push({ symbol, candleCount: availableCandles.length });
      }
    }

    // Sort by candle count (descending) to show depth
    candidates.sort((a, b) => b.candleCount - a.candleCount);

    console.log(`  Symbols with data up to ${rbDate}: ${candidates.length}`);
    console.log(`  Top 5 by depth: ${candidates.slice(0, 5).map(c => `${c.symbol}(${c.candleCount})`).join(', ')}`);

    pitResults.push({
      rebalanceDate: rbDate,
      rebalanceYear: parseInt(rbDate.split('-')[0]),
      rebalanceMonth: parseInt(rbDate.split('-')[1]),
      symbolsWithData: candidates.length,
      candidateSymbols: candidates.slice(0, 20), // Top 20 by depth
    });
  }

  // Save results
  writeFileSync(
    join(DATA_DIR, 'G0-3-pit-universe-prototype-v2.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      note: '修正版スクリプト実行結果。月次リバランス日時点でのユニバース構成可能性',
      rebalancePeriod: '2025-07-01 to 2026-07-01',
      rebalanceFrequency: 'monthly',
      results: pitResults,
      summary: {
        totalRebalanceDates: pitResults.length,
        avgSymbolsAvailable: Math.round(pitResults.reduce((sum, r) => sum + r.symbolsWithData, 0) / pitResults.length),
        minSymbolsAvailable: Math.min(...pitResults.map(r => r.symbolsWithData)),
        maxSymbolsAvailable: Math.max(...pitResults.map(r => r.symbolsWithData)),
      },
    }, null, 2)
  );

  // Summary output
  console.log('\n=== G0-3 Summary ===');
  console.log(`Total rebalance dates: ${pitResults.length}`);
  console.log(`Avg symbols available: ${Math.round(pitResults.reduce((sum, r) => sum + r.symbolsWithData, 0) / pitResults.length)}`);
  console.log(`Min/Max symbols: ${Math.min(...pitResults.map(r => r.symbolsWithData))}/${Math.max(...pitResults.map(r => r.symbolsWithData))}`);

  console.log('\nResults saved to G0-3-pit-universe-prototype-v2.json');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
