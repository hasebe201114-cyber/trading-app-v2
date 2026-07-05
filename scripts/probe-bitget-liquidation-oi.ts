/**
 * Bitget清算/OI履歴可用性プローブ（EXP-OBS000031 Stage 0 G0-3）
 *
 * 調査内容:
 * 1. 公開APIに清算履歴エンドポイントが存在するかを確認
 * 2. 公開APIにOI履歴エンドポイントが存在するかを確認
 * 3. 存在する場合、深度（最古タイムスタンプ）を実測
 * 4. 2022通年カバーが可能かを判定材料として記録
 *
 * このゲートは「情報ゲート」であり、総合GO/保留を単独では左右しない。
 * 路線β（清算反発）を Stage 1で採用可能かの材料提供。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/probe-bitget-liquidation-oi.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'research', 'EXP-OBS000031', '10-result');
mkdirSync(DATA_DIR, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// === Logging ===
const executionLog: string[] = [];

function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  executionLog.push(`[${timestamp}] ${message}`);
}

// === HTTP Probe ===
async function probeEndpoint(url: string, description: string): Promise<{
  description: string;
  url: string;
  httpStatus: number | null;
  success: boolean;
  responseType: string;
  responseSample: string;
  error?: string;
}> {
  log(`  Probing: ${description}`);
  log(`    URL: ${url}`);

  try {
    const res = await fetch(url);
    const text = await res.text();
    const success = res.ok;
    const sample = text.slice(0, 300);

    log(`    Status: HTTP ${res.status}${success ? ' ✓' : ' ✗'}`);

    return {
      description,
      url,
      httpStatus: res.status,
      success,
      responseType: success ? 'JSON' : 'Error',
      responseSample: sample,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`    Error: ${errMsg}`);

    return {
      description,
      url,
      httpStatus: null,
      success: false,
      responseType: 'Exception',
      responseSample: errMsg,
      error: errMsg,
    };
  }
}

interface LiquidationOIProbeResult {
  timestamp: string;
  symbol: string;
  liquidationHistory: {
    endpoint: string;
    probed: boolean;
    httpStatus: number | null;
    exists: boolean;
    depth?: {
      oldestTimestamp: number | null;
      oldestDate: string | null;
      totalRecords: number;
      coversYear2022: boolean;
    };
    error?: string;
  };
  oiHistory: {
    endpoint: string;
    probed: boolean;
    httpStatus: number | null;
    exists: boolean;
    depth?: {
      oldestTimestamp: number | null;
      oldestDate: string | null;
      totalRecords: number;
      samplingInterval: string;
      coversYear2022: boolean;
    };
    error?: string;
  };
  currentOISnapshot: {
    endpoint: string;
    probed: boolean;
    httpStatus: number | null;
    exists: boolean;
    currentOI?: number;
    error?: string;
  };
}

/**
 * Try to fetch liquidation history with pagination.
 */
async function fetchLiquidationHistory(
  symbol: string,
  maxPages: number = 5
): Promise<{
  httpStatus: number | null;
  exists: boolean;
  oldestTimestamp: number | null;
  totalRecords: number;
  error?: string;
}> {
  let pageNo = 1;
  let oldestTimestamp: number | null = null;
  let totalRecords = 0;

  while (pageNo <= maxPages) {
    try {
      const params = new URLSearchParams({
        symbol,
        productType: 'USDT-FUTURES',
        pageNo: pageNo.toString(),
        pageSize: '100',
      });
      const url = `https://api.bitget.com/api/v2/mix/market/liquidation-orders?${params.toString()}`;

      const res = await fetch(url);
      const data = await res.json() as unknown;

      if (!res.ok) {
        return { httpStatus: res.status, exists: false, oldestTimestamp: null, totalRecords: 0 };
      }

      // Parse response
      let records: Record<string, unknown>[] = [];
      if (typeof data === 'object' && data !== null) {
        const obj = data as Record<string, unknown>;
        if ('data' in obj && Array.isArray(obj.data)) {
          records = obj.data as Record<string, unknown>[];
        } else if (Array.isArray(data)) {
          records = data as Record<string, unknown>[];
        }
      }

      if (records.length === 0) {
        // Reached end
        return { httpStatus: 200, exists: true, oldestTimestamp, totalRecords };
      }

      totalRecords += records.length;

      // Extract oldest timestamp
      for (const record of records) {
        const ts = record.time || record.timestamp;
        if (ts) {
          const tsNum = typeof ts === 'string' ? parseInt(ts) : (ts as number);
          if (oldestTimestamp === null || tsNum < oldestTimestamp) {
            oldestTimestamp = tsNum;
          }
        }
      }

      pageNo++;
      await sleep(200);
    } catch (err) {
      return {
        httpStatus: null,
        exists: false,
        oldestTimestamp,
        totalRecords,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { httpStatus: 200, exists: true, oldestTimestamp, totalRecords };
}

/**
 * Try to fetch OI history with pagination.
 */
async function fetchOIHistory(
  symbol: string,
  maxPages: number = 5
): Promise<{
  httpStatus: number | null;
  exists: boolean;
  oldestTimestamp: number | null;
  totalRecords: number;
  samplingInterval: string;
  error?: string;
}> {
  let pageNo = 1;
  let oldestTimestamp: number | null = null;
  let totalRecords = 0;
  let samplingInterval = 'unknown';

  while (pageNo <= maxPages) {
    try {
      const params = new URLSearchParams({
        symbol,
        productType: 'USDT-FUTURES',
        pageNo: pageNo.toString(),
        pageSize: '100',
      });
      const url = `https://api.bitget.com/api/v2/mix/market/open-interest?${params.toString()}`;

      const res = await fetch(url);
      const data = await res.json() as unknown;

      if (!res.ok) {
        return { httpStatus: res.status, exists: false, oldestTimestamp: null, totalRecords: 0, samplingInterval: 'unknown' };
      }

      // Parse response
      let records: Record<string, unknown>[] = [];
      if (typeof data === 'object' && data !== null) {
        const obj = data as Record<string, unknown>;
        if ('data' in obj && Array.isArray(obj.data)) {
          records = obj.data as Record<string, unknown>[];
        } else if (Array.isArray(data)) {
          records = data as Record<string, unknown>[];
        }
      }

      if (records.length === 0) {
        // Reached end
        return { httpStatus: 200, exists: true, oldestTimestamp, totalRecords, samplingInterval };
      }

      totalRecords += records.length;

      // Extract oldest timestamp and infer sampling interval
      for (const record of records) {
        const ts = record.timestamp || record.time;
        if (ts) {
          const tsNum = typeof ts === 'string' ? parseInt(ts) : (ts as number);
          if (oldestTimestamp === null || tsNum < oldestTimestamp) {
            oldestTimestamp = tsNum;
          }
        }
      }

      // Try to infer sampling interval from consecutive records
      if (records.length >= 2 && samplingInterval === 'unknown') {
        const ts1 = records[0].timestamp || records[0].time;
        const ts2 = records[1].timestamp || records[1].time;
        if (ts1 && ts2) {
          const n1 = typeof ts1 === 'string' ? parseInt(ts1) : (ts1 as number);
          const n2 = typeof ts2 === 'string' ? parseInt(ts2) : (ts2 as number);
          const diffMs = Math.abs(n2 - n1);
          if (diffMs < 60000) {
            samplingInterval = 'per-minute or less';
          } else if (diffMs < 3600000) {
            samplingInterval = 'per-hour';
          } else if (diffMs < 86400000) {
            samplingInterval = 'per-day';
          } else {
            samplingInterval = 'infrequent';
          }
        }
      }

      pageNo++;
      await sleep(200);
    } catch (err) {
      return {
        httpStatus: null,
        exists: false,
        oldestTimestamp,
        totalRecords,
        samplingInterval: 'unknown',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { httpStatus: 200, exists: true, oldestTimestamp, totalRecords, samplingInterval };
}

/**
 * Try to fetch current OI snapshot.
 */
async function fetchCurrentOI(symbol: string): Promise<{
  httpStatus: number | null;
  exists: boolean;
  currentOI?: number;
  error?: string;
}> {
  try {
    const params = new URLSearchParams({
      symbol,
      productType: 'USDT-FUTURES',
    });
    const url = `https://api.bitget.com/api/v2/mix/market/open-interest?${params.toString()}`;

    const res = await fetch(url);
    const data = await res.json() as unknown;

    if (!res.ok) {
      return { httpStatus: res.status, exists: false };
    }

    // Try to extract current OI
    let records: Record<string, unknown>[] = [];
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if ('data' in obj && Array.isArray(obj.data)) {
        records = obj.data as Record<string, unknown>[];
      } else if (Array.isArray(data)) {
        records = data as Record<string, unknown>[];
      }
    }

    if (records.length > 0) {
      const currentOI = parseFloat((records[0].oi || records[0].openInterest || 0).toString());
      return { httpStatus: 200, exists: true, currentOI };
    }

    return { httpStatus: 200, exists: false };
  } catch (err) {
    return {
      httpStatus: null,
      exists: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe all liquidation/OI endpoints for a symbol.
 */
async function probeSymbol(symbol: string): Promise<LiquidationOIProbeResult> {
  const timestamp = new Date().toISOString();

  log(`\n【${symbol}】清算/OI履歴プローブ開始`);

  // Try liquidation history
  log(`  清算履歴（liquidation-orders）を試行...`);
  const liquidationResult = await fetchLiquidationHistory(symbol);

  let liquidationProbe = {
    endpoint: 'https://api.bitget.com/api/v2/mix/market/liquidation-orders',
    probed: true,
    httpStatus: liquidationResult.httpStatus,
    exists: liquidationResult.exists,
    error: liquidationResult.error,
  };

  if (liquidationResult.exists && liquidationResult.totalRecords > 0) {
    log(`    ✓ 存在 (${liquidationResult.totalRecords}件取得)`);
    const oldestDate = liquidationResult.oldestTimestamp
      ? new Date(liquidationResult.oldestTimestamp).toISOString().split('T')[0]
      : null;
    const covers2022 = liquidationResult.oldestTimestamp
      ? liquidationResult.oldestTimestamp <= new Date('2022-01-01T00:00:00Z').getTime()
      : false;

    liquidationProbe = {
      ...liquidationProbe,
      depth: {
        oldestTimestamp: liquidationResult.oldestTimestamp,
        oldestDate,
        totalRecords: liquidationResult.totalRecords,
        coversYear2022: covers2022,
      },
    };
    log(`    最古: ${oldestDate}, 2022カバー: ${covers2022 ? 'YES' : 'NO'}`);
  } else {
    log(`    ✗ 存在しない or 空応答${liquidationResult.error ? ` (${liquidationResult.error})` : ''}`);
  }

  await sleep(300);

  // Try OI history
  log(`  OI履歴（open-interest）を試行...`);
  const oiResult = await fetchOIHistory(symbol);

  let oiProbe = {
    endpoint: 'https://api.bitget.com/api/v2/mix/market/open-interest',
    probed: true,
    httpStatus: oiResult.httpStatus,
    exists: oiResult.exists,
    error: oiResult.error,
  };

  if (oiResult.exists && oiResult.totalRecords > 0) {
    log(`    ✓ 存在 (${oiResult.totalRecords}件取得, サンプリング間隔: ${oiResult.samplingInterval})`);
    const oldestDate = oiResult.oldestTimestamp
      ? new Date(oiResult.oldestTimestamp).toISOString().split('T')[0]
      : null;
    const covers2022 = oiResult.oldestTimestamp
      ? oiResult.oldestTimestamp <= new Date('2022-01-01T00:00:00Z').getTime()
      : false;

    oiProbe = {
      ...oiProbe,
      depth: {
        oldestTimestamp: oiResult.oldestTimestamp,
        oldestDate,
        totalRecords: oiResult.totalRecords,
        samplingInterval: oiResult.samplingInterval,
        coversYear2022: covers2022,
      },
    };
    log(`    最古: ${oldestDate}, 2022カバー: ${covers2022 ? 'YES' : 'NO'}`);
  } else {
    log(`    ✗ 存在しない or 空応答${oiResult.error ? ` (${oiResult.error})` : ''}`);
  }

  await sleep(300);

  // Try current OI snapshot
  log(`  現在のOIスナップショット（open-interest現在値）を試行...`);
  const currentOI = await fetchCurrentOI(symbol);

  let currentOIProbe = {
    endpoint: 'https://api.bitget.com/api/v2/mix/market/open-interest (snapshot)',
    probed: true,
    httpStatus: currentOI.httpStatus,
    exists: currentOI.exists,
    error: currentOI.error,
  };

  if (currentOI.exists) {
    log(`    ✓ 取得可 (現在OI: ${currentOI.currentOI?.toFixed(0) || 'N/A'})`);
    if (currentOI.currentOI !== undefined) {
      currentOIProbe = { ...currentOIProbe, currentOI: currentOI.currentOI };
    }
  } else {
    log(`    ✗ 取得不可${currentOI.error ? ` (${currentOI.error})` : ''}`);
  }

  return {
    timestamp,
    symbol,
    liquidationHistory: liquidationProbe,
    oiHistory: oiProbe,
    currentOISnapshot: currentOIProbe,
  };
}

// === Main ===
async function main(): Promise<void> {
  const scriptStartTime = new Date().toISOString();
  log(`\n=== EXP-OBS000031 Stage 0 G0-3: Liquidation/OI Availability Probe ===`);
  log(`Script started: ${scriptStartTime}`);
  log(`Node version: ${process.version}`);
  log(`情報ゲート: Stage 1での路線β（清算反発）採用可否の材料を事前取得`);

  try {
    const symbols = ['BTCUSDT', 'ETHUSDT'];
    const allProbeResults: LiquidationOIProbeResult[] = [];

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const result = await probeSymbol(symbol);
      allProbeResults.push(result);

      if (i < symbols.length - 1) await sleep(500);
    }

    // === Summary ===
    log('\n=== G0-3 可用性集計 ===');
    log('');

    for (const result of allProbeResults) {
      log(`【${result.symbol}】`);
      log(`  清算履歴: ${result.liquidationHistory.exists ? '✓ 存在' : '✗ 非存在'}`);
      if (result.liquidationHistory.depth) {
        log(`    最古: ${result.liquidationHistory.depth.oldestDate}, 2022: ${result.liquidationHistory.depth.coversYear2022 ? 'YES' : 'NO'}`);
      }
      log(`  OI履歴: ${result.oiHistory.exists ? '✓ 存在' : '✗ 非存在'}`);
      if (result.oiHistory.depth) {
        log(`    最古: ${result.oiHistory.depth.oldestDate}, 2022: ${result.oiHistory.depth.coversYear2022 ? 'YES' : 'NO'}`);
      }
      log(`  現在OI: ${result.currentOISnapshot.exists ? '✓ 取得可' : '✗ 取得不可'}`);
      log('');
    }

    // === Save results ===
    writeFileSync(
      join(DATA_DIR, 'G0-3-liquidation-oi-probe.json'),
      JSON.stringify({
        timestamp: scriptStartTime,
        baseline_date: '2026-07-05',
        probe_results: allProbeResults,
        info_gate_assessment: {
          liquidation_or_oi_exists: allProbeResults.some(r => r.liquidationHistory.exists || r.oiHistory.exists),
          covers_2022: allProbeResults.some(r =>
            (r.liquidationHistory.depth?.coversYear2022) || (r.oiHistory.depth?.coversYear2022)
          ),
          route_beta_available: allProbeResults.some(r =>
            (r.liquidationHistory.exists && r.liquidationHistory.depth?.coversYear2022) ||
            (r.oiHistory.exists && r.oiHistory.depth?.coversYear2022)
          ),
        },
      }, null, 2)
    );

    // === Save run log ===
    writeFileSync(
      join(DATA_DIR, 'liquidation-oi-run.log'),
      [
        '=== EXP-OBS000031 Stage 0 G0-3: Liquidation/OI Availability Probe ===',
        `Execution time: ${scriptStartTime}`,
        `Node version: ${process.version}`,
        '',
        'INVESTIGATION SCOPE:',
        '1. Liquidation history endpoint (liquidation-orders)',
        '2. OI history endpoint (open-interest with pagination)',
        '3. Current OI snapshot availability',
        '4. Coverage check: can 2022 full-year be covered?',
        '',
        'ROLE OF G0-3:',
        'Information gate only - does NOT block overall GO/HOLD decision.',
        'Determines whether route-beta (liquidation-reversion edge) can be',
        'registered as a candidate in Stage 1, vs restricted to route-alpha',
        '(mean-reversion) only.',
        '',
        'SPECIFICATION:',
        '- Symbols: BTCUSDT, ETHUSDT',
        '- Baseline date: 2026-07-05',
        '- Target: 2022-01-01 or earlier coverage',
        '',
        'MEASUREMENT METHODOLOGY:',
        '- Paginate through each endpoint until empty response',
        '- Extract oldest timestamp from all pages',
        '- Determine 2022 coverage status',
        '- Record both history and snapshot availability',
        '',
        'OUTPUT FILES:',
        '- G0-3-liquidation-oi-probe.json (full probe results + assessment)',
        '- liquidation-oi-run.log (this file)',
        '',
        'REPRODUCTION COMMAND:',
        'node --experimental-strip-types scripts/probe-bitget-liquidation-oi.ts',
        '',
        'EXECUTION LOG:',
        ...executionLog,
      ].join('\n')
    );

    log('\n=== 実行完了 ===');
    log(`成果物保存先: ${DATA_DIR}`);
  } catch (err) {
    log(`FATAL ERROR: ${err instanceof Error ? err.message : String(err)}`);
    writeFileSync(
      join(DATA_DIR, 'liquidation-oi-error.log'),
      `${new Date().toISOString()}: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
