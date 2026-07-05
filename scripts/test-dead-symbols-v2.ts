/**
 * 死銘柄テスト（code 40034 vs 40309 の識別）
 *
 * テスト対象:
 *  - SRMUSDT (実在した廃止銘柄 → code 40309 を期待)
 *  - LUNA2USDT (架空シンボル → code 40034 を期待)
 *  - TERRUSDT (誤綴り → code 40034 を期待)
 *
 * 実行:
 *   node --experimental-strip-types scripts/test-dead-symbols-v2.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'research', 'EXP-OBS000030', '10-result');

interface DeadSymbolTestResult {
  symbol: string;
  testEndTime: string;
  httpStatus?: number;
  apiCode?: string;
  apiMsg?: string;
  interpretation: 'nonexistent' | 'removed' | 'active';
  candlesDataAvailable: boolean;
  candlesCount: number;
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function testDeadSymbols(): Promise<DeadSymbolTestResult[]> {
  console.log('=== G0-2 Dead Symbol Test (code 40034 vs 40309 discrimination) ===');

  // Test symbols with expectations
  const testSymbols = [
    { symbol: 'SRMUSDT', expectedCode: 40309, label: 'Removed (real delisted symbol)' },
    { symbol: 'LUNA2USDT', expectedCode: 40034, label: 'Nonexistent (B test error)' },
    { symbol: 'TERRUSDT', expectedCode: 40034, label: 'Misspelled (B test error)' },
  ];

  const results: DeadSymbolTestResult[] = [];

  for (const test of testSymbols) {
    console.log(`  Testing ${test.symbol} (${test.label})...`);

    try {
      const params = new URLSearchParams({
        symbol: test.symbol,
        productType: 'USDT-FUTURES',
        granularity: '1D',
        limit: '200',
        endTime: '1672531199999', // 2023-01-01 00:00:00 UTC
      });
      const url = `https://api.bitget.com/api/v2/mix/market/history-candles?${params.toString()}`;

      const res = await fetch(url);
      const body = (await res.json()) as unknown;

      if (!res.ok) {
        // Error response
        const errorObj = body as Record<string, unknown>;
        const code = String(errorObj.code || res.status);
        const msg = String(errorObj.msg || errorObj.message || '');

        let interpretation: 'nonexistent' | 'removed' = 'nonexistent';
        if (code === '40309') {
          interpretation = 'removed';
        } else if (code === '40034') {
          interpretation = 'nonexistent';
        }

        console.log(`    ${test.symbol}: HTTP ${res.status} / code ${code} / msg "${msg}" → ${interpretation}`);
        results.push({
          symbol: test.symbol,
          testEndTime: '1672531199999',
          httpStatus: res.status,
          apiCode: code,
          apiMsg: msg,
          interpretation,
          candlesDataAvailable: false,
          candlesCount: 0,
        });
      } else {
        // Success response
        let candlesList: unknown[] = [];
        if (typeof body === 'object' && body !== null) {
          const obj = body as Record<string, unknown>;
          if ('data' in obj && Array.isArray(obj.data)) {
            candlesList = obj.data;
          } else if (Array.isArray(body)) {
            candlesList = body as unknown[];
          }
        }

        console.log(`    ${test.symbol}: HTTP 200 / candles ${candlesList.length}件 → active`);
        results.push({
          symbol: test.symbol,
          testEndTime: '1672531199999',
          httpStatus: 200,
          apiCode: '00000',
          apiMsg: 'success',
          interpretation: 'active',
          candlesDataAvailable: candlesList.length > 0,
          candlesCount: candlesList.length,
        });
      }
    } catch (err) {
      console.log(`    ${test.symbol}: Exception: ${err instanceof Error ? err.message : String(err)}`);
      results.push({
        symbol: test.symbol,
        testEndTime: '1672531199999',
        interpretation: 'nonexistent',
        candlesDataAvailable: false,
        candlesCount: 0,
      });
    }

    await sleep(200);
  }

  return results;
}

async function main(): Promise<void> {
  const results = await testDeadSymbols();

  // Save results
  writeFileSync(
    join(DATA_DIR, 'G0-2-dead-symbol-test-results-v2.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      note: '修正版テスト: code 40034（不存在）vs 40309（廃止済）の識別',
      testResults: results,
      summary: {
        nonexistentCount: results.filter(r => r.interpretation === 'nonexistent').length,
        removedCount: results.filter(r => r.interpretation === 'removed').length,
        activeCount: results.filter(r => r.interpretation === 'active').length,
      },
    }, null, 2)
  );

  console.log('\n=== Summary ===');
  console.log(`Nonexistent (40034): ${results.filter(r => r.interpretation === 'nonexistent').length}`);
  console.log(`Removed (40309): ${results.filter(r => r.interpretation === 'removed').length}`);
  console.log(`Active (200): ${results.filter(r => r.interpretation === 'active').length}`);
  console.log('\nResults saved to G0-2-dead-symbol-test-results-v2.json');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
