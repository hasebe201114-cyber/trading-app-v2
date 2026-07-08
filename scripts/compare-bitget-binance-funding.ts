/**
 * Bitget vs Binance Funding Rate代表性比較（EXP-OBS000032 G0-2）
 *
 * Bitget無料APIのFunding履歴（≈90日）とBinance（全期間）を重複期間でペア化し、
 * 符号一致率・Pearson/Spearman相関・水準差を計算。
 * テール窓（T1/T2/T3）は重複期間外であることを確認。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/compare-bitget-binance-funding.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000032', '10-result');
mkdirSync(RESULT_DIR, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const executionLog: string[] = [];

function log(message: string): void {
  console.log(message);
  executionLog.push(`[${new Date().toISOString()}] ${message}`);
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

interface FundingEvent {
  datetime: string;
  fundingRate: number;
}

// Bitget funding 直近履歴取得（ページベース、pageSize=100）
async function fetchBitgetFundingHistory(symbol: string): Promise<FundingEvent[]> {
  const rows: FundingEvent[] = [];
  let pageNo = 1;
  const pageSize = 100;
  const maxPages = 100;

  log(`Bitget ${symbol} funding: ページング開始`);

  while (pageNo <= maxPages) {
    const params = new URLSearchParams({
      symbol,
      productType: 'USDT-FUTURES',
      pageSize: pageSize.toString(),
      pageNo: pageNo.toString(),
    });
    const url = `https://api.bitget.com/api/v2/mix/market/history-fund-rate?${params.toString()}`;

    try {
      const data = await fetchJson(url) as unknown;
      let fundRates: { fundingTime?: string | number; fundingRate?: string }[] = [];

      if (typeof data === 'object' && data !== null) {
        const obj = data as Record<string, unknown>;
        if ('data' in obj && Array.isArray(obj.data)) {
          fundRates = obj.data as typeof fundRates;
        } else if (Array.isArray(data)) {
          fundRates = data as typeof fundRates;
        }
      }

      if (fundRates.length === 0) {
        log(`Bitget ${symbol}: page ${pageNo} 空応答で終了`);
        break;
      }

      for (const f of fundRates) {
        let dtStr = '';
        if (typeof f.fundingTime === 'string') {
          // UNIXタイムスタンプ(ms)の文字列として返される
          const ms = parseInt(f.fundingTime, 10);
          dtStr = new Date(ms).toISOString();
        } else if (typeof f.fundingTime === 'number') {
          dtStr = new Date(f.fundingTime).toISOString();
        }
        if (dtStr) {
          rows.push({
            datetime: dtStr,
            fundingRate: parseFloat(f.fundingRate || '0'),
          });
        }
      }

      log(`Bitget ${symbol}: page ${pageNo} ${fundRates.length}件（計${rows.length}件）`);

      if (fundRates.length < pageSize) {
        log(`Bitget ${symbol}: ページネーション終了（${fundRates.length} < ${pageSize}）`);
        break;
      }

      pageNo++;
      await sleep(200);
    } catch (err) {
      log(`ERROR Bitget ${symbol}: page ${pageNo}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  log(`Bitget ${symbol}: 合計${rows.length}件取得`);
  return rows;
}

// Binance CSV から指定期間のデータ読み込み
function readBinanceFunding(csvPath: string, startUTC: string, endUTC: string): FundingEvent[] {
  try {
    const csv = readFileSync(csvPath, 'utf-8');
    const lines = csv.trim().split('\n');
    const rows: FundingEvent[] = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const datetime = parts[0];
      const fundingRate = parseFloat(parts[1]);

      if (datetime >= startUTC && datetime <= endUTC) {
        rows.push({ datetime, fundingRate });
      }
    }

    log(`Binance (CSV): ${csvPath} から ${startUTC}～${endUTC} に${rows.length}件マッチ`);
    return rows;
  } catch (err) {
    log(`ERROR reading ${csvPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// ペアの組成：タイムスタンプの丸め（8時間イベント単位）
interface FundingPair {
  timestamp: string;
  binance_rate: number;
  bitget_rate: number;
}

function pairFundingData(binance: FundingEvent[], bitget: FundingEvent[]): FundingPair[] {
  const bitgetMap = new Map<string, number>();
  for (const f of bitget) {
    bitgetMap.set(f.datetime.slice(0, 13), f.fundingRate); // HH:00 単位で丸める
  }

  const pairs: FundingPair[] = [];
  for (const b of binance) {
    const key = b.datetime.slice(0, 13);
    if (bitgetMap.has(key)) {
      pairs.push({
        timestamp: b.datetime,
        binance_rate: b.fundingRate,
        bitget_rate: bitgetMap.get(key)!,
      });
    }
  }

  return pairs;
}

// 符号一致率
function signAgreement(pairs: FundingPair[]): number {
  if (pairs.length === 0) return 0;
  let agree = 0;
  for (const p of pairs) {
    const bSign = Math.sign(p.binance_rate);
    const bgSign = Math.sign(p.bitget_rate);
    if (bSign === bgSign) agree++;
  }
  return (agree / pairs.length) * 100;
}

// Pearson相関
function pearsonCorrelation(pairs: FundingPair[]): number {
  if (pairs.length < 2) return 0;
  const binanceRates = pairs.map(p => p.binance_rate);
  const bitgetRates = pairs.map(p => p.bitget_rate);

  const meanB = binanceRates.reduce((a, b) => a + b, 0) / binanceRates.length;
  const meanBg = bitgetRates.reduce((a, b) => a + b, 0) / bitgetRates.length;

  let cov = 0;
  let varB = 0;
  let varBg = 0;

  for (let i = 0; i < pairs.length; i++) {
    const dB = binanceRates[i] - meanB;
    const dBg = bitgetRates[i] - meanBg;
    cov += dB * dBg;
    varB += dB * dB;
    varBg += dBg * dBg;
  }

  if (varB === 0 || varBg === 0) return 0;
  return cov / Math.sqrt(varB * varBg);
}

// Spearman相関（順位ベース）
function spearmanCorrelation(pairs: FundingPair[]): number {
  if (pairs.length < 2) return 0;

  const binanceRates = pairs.map(p => p.binance_rate);
  const bitgetRates = pairs.map(p => p.bitget_rate);

  // 順位付け
  const rankB = rankData(binanceRates);
  const rankBg = rankData(bitgetRates);

  // Pearson on ranks
  const meanRankB = rankB.reduce((a, b) => a + b, 0) / rankB.length;
  const meanRankBg = rankBg.reduce((a, b) => a + b, 0) / rankBg.length;

  let cov = 0;
  let varB = 0;
  let varBg = 0;

  for (let i = 0; i < rankB.length; i++) {
    const dB = rankB[i] - meanRankB;
    const dBg = rankBg[i] - meanRankBg;
    cov += dB * dBg;
    varB += dB * dB;
    varBg += dBg * dBg;
  }

  if (varB === 0 || varBg === 0) return 0;
  return cov / Math.sqrt(varB * varBg);
}

function rankData(data: number[]): number[] {
  const indexed = data.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(data.length);
  for (let i = 0; i < indexed.length; i++) {
    ranks[indexed[i].i] = i + 1;
  }
  return ranks;
}

// 水準差統計
function levelDifference(pairs: FundingPair[]): { mean: number; std: number; mean_ann: number; std_ann: number } {
  if (pairs.length === 0) return { mean: 0, std: 0, mean_ann: 0, std_ann: 0 };

  const diff = pairs.map(p => p.bitget_rate - p.binance_rate);
  const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
  const variance = diff.reduce((a, b) => a + (b - mean) ** 2, 0) / diff.length;
  const std = Math.sqrt(variance);

  // 8hイベント→年率換算（365/365 * 3 = 3倍で年365回の8h間隔）
  return {
    mean,
    std,
    mean_ann: mean * 365 * 3,
    std_ann: std * Math.sqrt(365 * 3),
  };
}

async function main(): Promise<void> {
  const startTime = new Date().toISOString();
  log(`=== EXP-OBS000032 G0-2: 取引所代表性（Bitget vs Binance） ===`);
  log(`開始時刻: ${startTime}\n`);

  const results = {
    timestamp: startTime,
    tail_windows: {
      T1: { start: '2020-02-20T00:00:00Z', end: '2020-04-30T23:59:59Z' },
      T2: { start: '2022-05-01T00:00:00Z', end: '2022-06-30T23:59:59Z' },
      T3: { start: '2022-10-25T00:00:00Z', end: '2022-12-15T23:59:59Z' },
    },
    symbols: {} as Record<string, unknown>,
  };

  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    log(`\n======== ${symbol} ========`);

    // Bitget funding 直近取得
    const bitgetFunding = await fetchBitgetFundingHistory(symbol);
    if (bitgetFunding.length === 0) {
      log(`WARNING: ${symbol} Bitget funding 取得失敗。スキップ。`);
      continue;
    }

    // Sort by datetime to get oldest and newest
    const sorted = [...bitgetFunding].sort((a, b) => a.datetime.localeCompare(b.datetime));
    const bitgetOldest = sorted[0].datetime;
    const bitgetNewest = sorted[sorted.length - 1].datetime;

    log(`Bitget: ${bitgetOldest} ～ ${bitgetNewest} (${bitgetFunding.length}件)`);

    // Binance funding CSV 読み込み（重複期間）
    // G0-1で結果DirにCSVを保存している
    const csvPath = join(RESULT_DIR, `${symbol.toLowerCase()}-funding.csv`);
    const binanceFunding = readBinanceFunding(csvPath, bitgetOldest, bitgetNewest);

    // ペア組成
    const pairs = pairFundingData(binanceFunding, bitgetFunding);
    log(`重複期間: ${bitgetOldest} ～ ${bitgetNewest}`);
    log(`ペア組成: ${pairs.length}件`);

    if (pairs.length === 0) {
      log(`ERROR: ${symbol} ペア不成立。代表性測定不可。`);
      results.symbols[symbol] = { error: 'no_pairs' };
      continue;
    }

    // メトリクス計算
    const agreement = signAgreement(pairs);
    const pearson = pearsonCorrelation(pairs);
    const spearman = spearmanCorrelation(pairs);
    const levelDiff = levelDifference(pairs);

    log(`\n代表性メトリクス:`);
    log(`  符号一致率: ${agreement.toFixed(1)}%`);
    log(`  Pearson相関: ${pearson.toFixed(4)}`);
    log(`  Spearman相関: ${spearman.toFixed(4)}`);
    log(`  水準差（Bitget - Binance）:`);
    log(`    8h平均: ${levelDiff.mean.toFixed(6)} bps`);
    log(`    8h標準偏差: ${levelDiff.std.toFixed(6)} bps`);
    log(`    年率平均: ${levelDiff.mean_ann.toFixed(4)} %`);
    log(`    年率標準偏差: ${levelDiff.std_ann.toFixed(4)} %`);

    // テール窓が重複期間外であることを確認
    log(`\nテール窓と重複期間の関係:`);
    const overlapWindows = [];
    for (const [wkey, wval] of Object.entries(results.timestamp ? {} : results.tail_windows)) {
      const w = wval as { start: string; end: string };
      if (bitgetOldest <= w.end && bitgetNewest >= w.start) {
        overlapWindows.push(wkey);
      }
    }
    if (overlapWindows.length > 0) {
      log(`  ⚠ テール窓 ${overlapWindows.join(', ')} が重複期間に含まれている`);
    } else {
      log(`  ✓ すべてのテール窓が重複期間外（平時代表性のみ測定）`);
    }

    results.symbols[symbol] = {
      bitget_depth: { oldest: bitgetOldest, newest: bitgetNewest, count: bitgetFunding.length },
      binance_period: { oldest: binanceFunding[0]?.datetime, newest: binanceFunding[binanceFunding.length - 1]?.datetime, count: binanceFunding.length },
      overlap_period: { oldest: bitgetOldest, newest: bitgetNewest },
      pair_count: pairs.length,
      metrics: {
        sign_agreement_pct: agreement,
        pearson_correlation: pearson,
        spearman_correlation: spearman,
        level_diff_8h: {
          mean_bps: levelDiff.mean,
          std_bps: levelDiff.std,
        },
        level_diff_annualized: {
          mean_pct: levelDiff.mean_ann / 100,
          std_pct: levelDiff.std_ann / 100,
        },
      },
      note: 'テール窓は重複期間外。平時の代表性のみ測定。テール期間の取引所間乖離は本メトリクスでは観測不可。',
    };

    await sleep(500);
  }

  // JSON 保存
  writeFileSync(join(RESULT_DIR, 'g0-2-exchange-representativeness.json'), JSON.stringify(results, null, 2));
  log(`\n>>> 結果JSON保存: g0-2-exchange-representativeness.json`);

  // 実行ログ保存
  const runLog = [
    '=== EXP-OBS000032 G0-2: 取引所代表性 ===',
    `Execution: ${startTime}`,
    'DATA SOURCES:',
    '  Binance: scripts/data/{symbol}-funding.csv（G0-1で取得）',
    '  Bitget: https://api.bitget.com/api/v2/mix/market/history-fund-rate (pageSize=100)',
    '',
    'METRICS:',
    '  - Sign agreement: sign(Binance) == sign(Bitget) の割合 (%)',
    '  - Pearson correlation: 水準相関（[-1, 1]）',
    '  - Spearman correlation: 順位相関（[-1, 1]）',
    '  - Level diff: (Bitget - Binance) の平均・標準偏差（8h単位・年率換算）',
    '',
    'IMPORTANT NOTES:',
    '  - Bitget無料API履歴は≈90日で枯渇（OBS000030実測）',
    '  - テール窓（T1/T2/T3）は重複期間外のため、テール時取引所間乖離は観測不可',
    '  - 本メトリクスは平時の代表性のみ示す',
    '',
    'EXECUTION LOG:',
    ...executionLog,
    '',
    'REPRODUCTION:',
    'node --experimental-strip-types scripts/compare-bitget-binance-funding.ts',
  ];

  writeFileSync(join(RESULT_DIR, 'run-g0-2.log'), runLog.join('\n'));
  log(`\n>>> 実行ログ: run-g0-2.log`);

  log('\n=== G0-2完了 ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
