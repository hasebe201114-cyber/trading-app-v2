/**
 * Bitget/Binance 証拠金・清算コスト実測（EXP-OBS000032 G0-3）
 *
 * 実装内容（spec G0-3）:
 *   (a) ベーシス統計：G0-1の取得データから統計化（別のスクリプトで済み）
 *   (b) 証拠金率・レバレッジ：Bitget contracts API から実測、またはpublic仕様表から
 *   (c) ショートperp清算価格式：維持証拠金率から清算価格を計算・テール窓での発生判定
 *   (d) 4レッグ往復コスト：031実測値を使用（テイカー6bps+スプレッド等）
 *
 * 実行例:
 *   node --experimental-strip-types scripts/probe-perp-margin-liquidation.ts
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

interface DailyData {
  date: string;
  high: number;
  low: number;
  close: number;
}

interface ContractSpec {
  symbol: string;
  maintMarginRate?: string | number;
  maxLeverage?: string | number;
  initialMarginRate?: string | number;
  [key: string]: unknown;
}

// Bitget contracts API から契約仕様取得
async function fetchBitgetContracts(): Promise<ContractSpec[]> {
  log('Bitget contracts API取得中...');
  try {
    const url = 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES';
    const data = await fetchJson(url) as unknown;

    let contracts: ContractSpec[] = [];
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if ('data' in obj && Array.isArray(obj.data)) {
        contracts = obj.data as ContractSpec[];
      } else if (Array.isArray(data)) {
        contracts = data as ContractSpec[];
      }
    }

    log(`  取得: ${contracts.length}銘柄`);

    // BTCUSDT, ETHUSDT をフィルタ
    const btc = contracts.find(c => c.symbol === 'BTCUSDT');
    const eth = contracts.find(c => c.symbol === 'ETHUSDT');

    return [btc, eth].filter(Boolean);
  } catch (err) {
    log(`ERROR contracts取得: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

// CSV から日付範囲内のperp高値を取得
function getPerpHighsInWindow(csvPath: string, startDate: string, endDate: string): Map<string, number> {
  try {
    const csv = readFileSync(csvPath, 'utf-8');
    const lines = csv.trim().split('\n');
    const highs = new Map<string, number>();

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      const date = parts[0];
      const high = parseFloat(parts[2]);

      if (date >= startDate && date <= endDate && !isNaN(high)) {
        highs.set(date, high);
      }
    }

    return highs;
  } catch (err) {
    log(`ERROR reading ${csvPath}: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

interface LiquidationResult {
  symbol: string;
  maintMarginRate: number | string;
  initialMarginRate: number | string;
  maxLeverage: number | string;
  source: string;
  liquidation_price_formula: string;
  tail_windows: Record<string, unknown>;
}

async function main(): Promise<void> {
  const startTime = new Date().toISOString();
  log(`=== EXP-OBS000032 G0-3: コストモデル化 ===`);
  log(`開始時刻: ${startTime}\n`);

  const results = {
    timestamp: startTime,
    components: {
      a_basis_statistics: 'G0-1 JSON に記録済み',
      b_margin_leverage: {} as Record<string, unknown>,
      c_liquidation: {} as Record<string, unknown>,
      d_flip_cost: {} as Record<string, unknown>,
    },
  };

  // (b) 証拠金率・レバレッジ取得
  log('>>> (b) 証拠金率・レバレッジ取得');
  const contracts = await fetchBitgetContracts();

  if (contracts.length > 0) {
    log(`  BTCUSDT: maintMarginRate=${contracts[0]?.maintMarginRate}, initialMarginRate=${contracts[0]?.initialMarginRate}, maxLeverage=${contracts[0]?.maxLeverage}`);
    log(`  ETHUSDT: maintMarginRate=${contracts[1]?.maintMarginRate}, initialMarginRate=${contracts[1]?.initialMarginRate}, maxLeverage=${contracts[1]?.maxLeverage}`);

    for (const contract of contracts) {
      const mmr = parseFloat(String(contract.maintMarginRate || 0.005)); // デフォルト 0.5%
      const imr = parseFloat(String(contract.initialMarginRate || 0.02)); // デフォルト 2%
      const lev = parseFloat(String(contract.maxLeverage || 50));

      results.components.b_margin_leverage[contract.symbol!] = {
        maintMarginRate: mmr,
        initialMarginRate: imr,
        maxLeverage: lev,
        source: 'Bitget API / public仕様',
        capital_cost_assumption: '年率4% (ショートperp証拠金)',
        leverage_assumption: '3倍（IM≈33%）',
      };
    }
  } else {
    log('  WARNING: Bitget contracts API 取得失敗。デフォルト値で進行。');
    // デフォルト値
    results.components.b_margin_leverage['BTCUSDT'] = {
      maintMarginRate: 0.005, // 0.5%
      initialMarginRate: 0.02, // 2%
      maxLeverage: 50,
      source: 'default',
      note: 'API未取得のため業界標準値の仮置き',
    };
    results.components.b_margin_leverage['ETHUSDT'] = {
      maintMarginRate: 0.005,
      initialMarginRate: 0.02,
      maxLeverage: 50,
      source: 'default',
      note: 'API未取得のため業界標準値の仮置き',
    };
  }

  await sleep(300);

  // (c) 清算価格式・テール窓での清算判定
  log('\n>>> (c) ショートperp清算価格 & テール窓での清算発生判定');

  const TAIL_WINDOWS = {
    T1: { name: 'T1 (2020-03 コロナ)', start: '2020-02-20', end: '2020-04-30' },
    T2: { name: 'T2 (2022-05 LUNA)', start: '2022-05-01', end: '2022-06-30' },
    T3: { name: 'T3 (2022-11 FTX)', start: '2022-10-25', end: '2022-12-15' },
    calm: { name: 'calm (2021-01〜06)', start: '2021-01-01', end: '2021-06-30' },
  };

  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    const csvPath = join(RESULT_DIR, `${symbol.toLowerCase()}-perp-last-daily.csv`);
    const margins = results.components.b_margin_leverage[symbol] as Record<string, unknown>;
    const mmr = parseFloat(String(margins.maintMarginRate || 0.005));
    const leverage = 3; // spec 固定値

    log(`\n  ${symbol}:`);
    log(`    ショートperp清算式: エントリー価格 × (1 + 初期IM - 維持証拠金率)`);
    log(`    = Entry × (1 + ${(1 / leverage).toFixed(3)} - ${mmr.toFixed(4)})`);
    log(`    = Entry × ${(1 + 1 / leverage - mmr).toFixed(4)}`);

    const windowResults: Record<string, unknown> = {};

    for (const [wkey, window] of Object.entries(TAIL_WINDOWS)) {
      const highs = getPerpHighsInWindow(csvPath, window.start, window.end);

      if (highs.size === 0) {
        log(`    ${window.name}: highsデータ無し`);
        windowResults[wkey] = { error: 'no_data' };
        continue;
      }

      // テール窓内で最初のperp価格をエントリー価格とする（簡略化）
      const sortedDates = Array.from(highs.keys()).sort();
      const entryPrice = highs.get(sortedDates[0])!;
      const liquidationPrice = entryPrice * (1 + 1 / leverage - mmr);
      const maxHigh = Math.max(...Array.from(highs.values()));
      const liquidated = maxHigh >= liquidationPrice;

      log(
        `    ${window.name}: Entry=${entryPrice.toFixed(2)}, Liquidation=${liquidationPrice.toFixed(2)}, ` +
        `MaxHigh=${maxHigh.toFixed(2)}, Liquidated=${liquidated}`
      );

      windowResults[wkey] = {
        entry_price: entryPrice,
        liquidation_price: liquidationPrice,
        max_high_in_window: maxHigh,
        liquidated: liquidated,
        days_covered: highs.size,
      };
    }

    results.components.c_liquidation[symbol] = {
      leverage: leverage,
      initial_margin_rate: 1 / leverage,
      maint_margin_rate: mmr,
      tail_windows: windowResults,
    };
  }

  // (d) 4レッグ往復コスト（031実測値）
  log('\n>>> (d) 4レッグ往復コスト（spec G0-3(d) より）');

  const ONE_WAY_COST_BPS = 6 + 0.016; // Bitgetテイカー6bps + BTC実効スプレッド0.016bps（031実測）
  const ONE_WAY_COST_ETH_BPS = 6 + 0.056; // ETH実効スプレッド0.056bps
  const SLIPPAGE_BPS = 0; // 板厚により <0.2bps

  const FLIP_COST_BTC_BPS = 4 * ONE_WAY_COST_BPS; // 2レッグ×往復(クローズ+オープン)
  const FLIP_COST_ETH_BPS = 4 * ONE_WAY_COST_ETH_BPS;

  log(`  BTC: 片道 = テイカー6bps + スプレッド0.016bps + スリッページ${SLIPPAGE_BPS}bps = ${ONE_WAY_COST_BPS.toFixed(3)}bps`);
  log(`       4レッグ往復 = ${FLIP_COST_BTC_BPS.toFixed(3)}bps`);
  log(`  ETH: 片道 = テイカー6bps + スプレッド0.056bps + スリッページ${SLIPPAGE_BPS}bps = ${ONE_WAY_COST_ETH_BPS.toFixed(3)}bps`);
  log(`       4レッグ往復 = ${FLIP_COST_ETH_BPS.toFixed(3)}bps`);
  log(`  出典: OBS000031実測値（Bitget実コスト）`);

  results.components.d_flip_cost['BTCUSDT'] = {
    maker_fee_bps: 2,
    taker_fee_bps: 6,
    spread_bps: 0.016,
    slippage_bps: SLIPPAGE_BPS,
    one_way_bps: ONE_WAY_COST_BPS,
    flip_cost_4legs_bps: FLIP_COST_BTC_BPS,
    source: 'OBS000031実測（Bitget実コスト）',
  };

  results.components.d_flip_cost['ETHUSDT'] = {
    maker_fee_bps: 2,
    taker_fee_bps: 6,
    spread_bps: 0.056,
    slippage_bps: SLIPPAGE_BPS,
    one_way_bps: ONE_WAY_COST_ETH_BPS,
    flip_cost_4legs_bps: FLIP_COST_ETH_BPS,
    source: 'OBS000031実測（Bitget実コスト）',
  };

  // 結果保存
  writeFileSync(join(RESULT_DIR, 'g0-3-cost-model.json'), JSON.stringify(results, null, 2));
  log(`\n>>> 結果JSON保存: g0-3-cost-model.json`);

  // 実行ログ保存
  const runLog = [
    '=== EXP-OBS000032 G0-3: コストモデル化 ===',
    `Execution: ${startTime}`,
    '',
    'COMPONENTS:',
    '(a) Basis statistics: G0-1 JSON に記録済み',
    '(b) Margin & Leverage: Bitget contracts API (productType=USDT-FUTURES)',
    '(c) Liquidation: Short perp liquidation formula',
    '    = Entry × (1 + Initial IM rate - Maintenance margin rate)',
    '    = Entry × (1 + 1/leverage - maint_margin)',
    '    Leverage fixed at 3x (IM ≈ 33%) per spec',
    '(d) Flip cost: OBS000031 measured cost (Bitget actual)',
    '',
    'RESULTS:',
    '- (b) Margin rates retrieved from API or public specs',
    '- (c) Liquidation prices calculated & checked against tail windows',
    '- (d) 4-leg round-trip cost for regime changes',
    '',
    'CAPITAL COST ASSUMPTION:',
    '- Current spot long: fully self-funded (no leverage, no cost)',
    '- Short perp leg: requires margin (capital cost @ 4%/year fixed)',
    '',
    'EXECUTION LOG:',
    ...executionLog,
    '',
    'REPRODUCTION:',
    'node --experimental-strip-types scripts/probe-perp-margin-liquidation.ts',
  ];

  writeFileSync(join(RESULT_DIR, 'run-g0-3.log'), runLog.join('\n'));
  log(`\n>>> 実行ログ: run-g0-3.log`);

  log('\n=== G0-3完了 ===');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
