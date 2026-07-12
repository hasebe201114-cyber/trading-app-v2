/**
 * EXP-OBS000037 Stage 0: Deribit 実コストモデルプローブ（G0-3）
 * spec: research/EXP-OBS000037/00-spec-stage0.md §3 G0-3
 *
 * 本スクリプトは判定を行わない。実測値・実レスポンス・実仕様のみを記録する。
 * 対象は BTC のみ（spec §1-1・ETH取得禁止）。
 *
 * 調査対象（spec §3 G0-3）:
 *   (a) オプション/バリアンスレッグの手数料（get_instruments kind=option の該当フィールド + 公式手数料表URL）
 *   (b) 実スプレッド（BTC ATM近傍オプション + BTC-PERPETUAL の get_order_book/ticker 現時点スナップショット）
 *   (c) perpデルタヘッジコスト（BTC-PERPETUAL テイカー/メイカー手数料 + 板厚スリッページ見積り）
 *   (d) 統合: lab仮置き（往復1.5 + ヘッジ0.3 vol pt/週）と並置
 *
 * API非配信の項目は「仮置き/公式表由来」と明示する（spec §3 G0-3 注記）。
 *
 * 実行: node --experimental-strip-types scripts/probe-deribit-cost-model.ts
 * APIキー・.env.local は読まない（Deribit publicエンドポイントは認証不要）。
 */

import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(__dirname, '..', 'research', 'EXP-OBS000037', '10-result');
mkdirSync(RESULT_DIR, { recursive: true });

const RUN_TIMESTAMP = new Date().toISOString();
const executionLog: string[] = [];
function log(msg: string): void {
  console.log(msg);
  executionLog.push(`[${new Date().toISOString()}] ${msg}`);
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const BASE = 'https://www.deribit.com/api/v2';

async function fetchJson(url: string): Promise<{ status: number; json: unknown | null; error?: string }> {
  try {
    const res = await fetch(url);
    const text = await res.text();
    let json: unknown | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// lab仮置き（spec §3 G0-3・往復1.5 vol pt/週＋デルタヘッジ0.3 vol pt/週）
const LAB_PLACEHOLDER_COST = {
  reversalRoundTripVolPtPerWeek: 1.5,
  deltaHedgeVolPtPerWeek: 0.3,
  totalVolPtPerWeek: 1.8,
  source: 'crypto-strategy-lab Stage 2 仮置き値（本specでの置換対象）',
};

// ============================================================
// (a) オプション手数料（get_instruments + 公式手数料表URL）
// ============================================================
interface OptionInstrument {
  instrument_name: string;
  strike?: number;
  option_type?: string;
  expiration_timestamp?: number;
  maker_commission?: number;
  taker_commission?: number;
  block_trade_commission?: number;
  is_active?: boolean;
  state?: string;
  [key: string]: unknown;
}

async function fetchOptionInstruments(currency: string): Promise<OptionInstrument[]> {
  const url = `${BASE}/public/get_instruments?currency=${currency}&kind=option&expired=false`;
  log(`  GET ${url}`);
  const r = await fetchJson(url);
  const arr = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as OptionInstrument[] | undefined : undefined;
  const rows = Array.isArray(arr) ? arr : [];
  log(`  取得件数: ${rows.length}`);
  return rows;
}

async function fetchFutureInstruments(currency: string): Promise<OptionInstrument[]> {
  const url = `${BASE}/public/get_instruments?currency=${currency}&kind=future&expired=false`;
  log(`  GET ${url}`);
  const r = await fetchJson(url);
  const arr = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as OptionInstrument[] | undefined : undefined;
  const rows = Array.isArray(arr) ? arr : [];
  log(`  取得件数: ${rows.length}`);
  return rows;
}

/** 公式手数料表ページのfetch試行（到達可否・本文断片を事実として記録。解析はしない） */
async function probeOfficialFeePage(): Promise<{ url: string; status: number; bodyHeadLength: number; fetchSucceeded: boolean; error?: string }> {
  const url = 'https://www.deribit.com/kb/fees';
  try {
    const res = await fetch(url);
    const text = await res.text();
    log(`  公式手数料表ページ fetch: status=${res.status} bodyLength=${text.length}`);
    return { url, status: res.status, bodyHeadLength: text.length, fetchSucceeded: res.ok };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  公式手数料表ページ fetch失敗: ${msg}`);
    return { url, status: 0, bodyHeadLength: 0, fetchSucceeded: false, error: msg };
  }
}

// ============================================================
// (b) 実スプレッド スナップショット（get_order_book / ticker）
// ============================================================
interface OrderBookSnapshot {
  instrumentName: string;
  requestUrl: string;
  status: number;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spreadAbsolute: number | null;
  spreadBps: number | null;
  bidSizeTop: number | null;
  askSizeTop: number | null;
  snapshotUtc: string;
}

async function fetchOrderBookSnapshot(instrumentName: string, depth: number): Promise<OrderBookSnapshot> {
  const url = `${BASE}/public/get_order_book?instrument_name=${instrumentName}&depth=${depth}`;
  const r = await fetchJson(url);
  const result = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
  const bids = (result?.bids as number[][] | undefined) ?? [];
  const asks = (result?.asks as number[][] | undefined) ?? [];
  const bestBid = bids.length > 0 ? bids[0][0] : null;
  const bestAsk = asks.length > 0 ? asks[0][0] : null;
  const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spreadAbsolute = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const spreadBps = spreadAbsolute !== null && midPrice !== null && midPrice > 0 ? (spreadAbsolute / midPrice) * 10000 : null;
  return {
    instrumentName,
    requestUrl: url,
    status: r.status,
    bestBid,
    bestAsk,
    midPrice,
    spreadAbsolute,
    spreadBps,
    bidSizeTop: bids.length > 0 ? bids[0][1] : null,
    askSizeTop: asks.length > 0 ? asks[0][1] : null,
    snapshotUtc: new Date().toISOString(),
  };
}

interface TickerSnapshot {
  instrumentName: string;
  requestUrl: string;
  status: number;
  indexPrice: number | null;
  markPrice: number | null;
  bestBidPrice: number | null;
  bestAskPrice: number | null;
  greeks: Record<string, unknown> | null;
  raw: unknown;
}

async function fetchTickerSnapshot(instrumentName: string): Promise<TickerSnapshot> {
  const url = `${BASE}/public/ticker?instrument_name=${instrumentName}`;
  const r = await fetchJson(url);
  const result = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
  return {
    instrumentName,
    requestUrl: url,
    status: r.status,
    indexPrice: (result?.index_price as number | undefined) ?? null,
    markPrice: (result?.mark_price as number | undefined) ?? null,
    bestBidPrice: (result?.best_bid_price as number | undefined) ?? null,
    bestAskPrice: (result?.best_ask_price as number | undefined) ?? null,
    greeks: (result?.greeks as Record<string, unknown> | undefined) ?? null,
    raw: result ?? null,
  };
}

// ============================================================
// (c) perp板厚スリッページ見積り
// ============================================================
function estimateSlippageBps(orderBook: { price: number; size: number }[], notionalUsd: number, midPrice: number): { filledNotional: number; avgFillPrice: number | null; slippageBps: number | null } {
  let remainingUsd = notionalUsd;
  let notionalFilled = 0;
  let costSum = 0; // sum(price * qtyUsd)
  for (const level of orderBook) {
    if (remainingUsd <= 0) break;
    const levelNotionalUsd = level.price * level.size; // Deribit BTC-PERPETUAL: size in USD (contracts=$1 each), price in BTC/USD... we treat size as-is (see note in output)
    const takeUsd = Math.min(remainingUsd, levelNotionalUsd);
    costSum += level.price * takeUsd;
    notionalFilled += takeUsd;
    remainingUsd -= takeUsd;
  }
  if (notionalFilled === 0) return { filledNotional: 0, avgFillPrice: null, slippageBps: null };
  const avgFillPrice = costSum / notionalFilled;
  const slippageBps = midPrice > 0 ? ((avgFillPrice - midPrice) / midPrice) * 10000 : null;
  return { filledNotional: notionalFilled, avgFillPrice, slippageBps };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 Stage 0 G0-3: Deribit 実コストモデルプローブ ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  log(`Node version: ${process.version}`);
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim();
  } catch {
    /* ignore */
  }
  log(`Git commit: ${gitCommit}`);

  // ---------------- (a) オプション手数料 ----------------
  log('\n>>> (a) オプション手数料体系（get_instruments kind=option）');
  const optionInstruments = await fetchOptionInstruments('BTC');
  const sampleOptionFees = optionInstruments.slice(0, 5).map(o => ({
    instrument_name: o.instrument_name,
    maker_commission: o.maker_commission,
    taker_commission: o.taker_commission,
    block_trade_commission: o.block_trade_commission,
  }));
  const distinctMakerCommissions = [...new Set(optionInstruments.map(o => o.maker_commission))];
  const distinctTakerCommissions = [...new Set(optionInstruments.map(o => o.taker_commission))];
  log(`  サンプル5件: ${JSON.stringify(sampleOptionFees)}`);
  log(`  distinct maker_commission値: ${JSON.stringify(distinctMakerCommissions)}`);
  log(`  distinct taker_commission値: ${JSON.stringify(distinctTakerCommissions)}`);

  await sleep(300);
  const futureInstruments = await fetchFutureInstruments('BTC');
  const perpInstrument = futureInstruments.find(f => f.instrument_name === 'BTC-PERPETUAL');
  log(`  BTC-PERPETUAL instrument spec: maker_commission=${perpInstrument?.maker_commission} taker_commission=${perpInstrument?.taker_commission}`);

  await sleep(300);
  const officialFeePageProbe = await probeOfficialFeePage();

  // ---------------- (b) 実スプレッド スナップショット ----------------
  log('\n>>> (b) 実スプレッド スナップショット（BTC ATM近傍オプション + BTC-PERPETUAL）');
  const perpTicker = await fetchTickerSnapshot('BTC-PERPETUAL');
  const indexPrice = perpTicker.indexPrice;
  log(`  BTC-PERPETUAL index_price=${indexPrice}`);

  // 有効な（is_active）オプションのうち、直近満期・現物ATMに最も近い3銘柄（Call）を選定
  const activeOptions = optionInstruments.filter(o => o.is_active !== false && o.state !== 'expired' && typeof o.strike === 'number' && typeof o.expiration_timestamp === 'number');
  const nowMs = Date.now();
  const futureExpirations = [...new Set(activeOptions.map(o => o.expiration_timestamp as number))].filter(e => e > nowMs).sort((a, b) => a - b);
  const nearestExpiration = futureExpirations.length > 0 ? futureExpirations[0] : null;
  log(`  直近満期候補: ${nearestExpiration !== null ? new Date(nearestExpiration).toISOString() : 'なし'}`);

  let selectedOptionNames: string[] = [];
  if (nearestExpiration !== null && indexPrice !== null) {
    const candidatesAtExpiry = activeOptions.filter(o => o.expiration_timestamp === nearestExpiration && o.option_type === 'call');
    const sortedByDistance = [...candidatesAtExpiry].sort((a, b) => Math.abs((a.strike as number) - indexPrice) - Math.abs((b.strike as number) - indexPrice));
    selectedOptionNames = sortedByDistance.slice(0, 3).map(o => o.instrument_name);
  }
  log(`  選定ATM近傍オプション: ${JSON.stringify(selectedOptionNames)}`);

  const optionSpreadSnapshots: OrderBookSnapshot[] = [];
  const optionTickerSnapshots: TickerSnapshot[] = [];
  for (const name of selectedOptionNames) {
    const ob = await fetchOrderBookSnapshot(name, 5);
    optionSpreadSnapshots.push(ob);
    log(`  ${name}: bestBid=${ob.bestBid} bestAsk=${ob.bestAsk} spreadBps=${ob.spreadBps}`);
    await sleep(300);
    const tk = await fetchTickerSnapshot(name);
    optionTickerSnapshots.push(tk);
    log(`  ${name} greeks: ${JSON.stringify(tk.greeks)}`);
    await sleep(300);
  }

  const perpOrderBookForSpread = await fetchOrderBookSnapshot('BTC-PERPETUAL', 5);
  log(`  BTC-PERPETUAL: bestBid=${perpOrderBookForSpread.bestBid} bestAsk=${perpOrderBookForSpread.bestAsk} spreadBps=${perpOrderBookForSpread.spreadBps}`);

  // ---------------- (c) perpデルタヘッジコスト（手数料＋板厚スリッページ） ----------------
  log('\n>>> (c) perpデルタヘッジコスト（BTC-PERPETUAL 手数料 + 板厚スリッページ, $100k想定）');
  await sleep(300);
  const perpOrderBookDeep = await fetchOrderBookSnapshot('BTC-PERPETUAL', 50);
  const rawOrderBookForSlippage = await fetchJson(`${BASE}/public/get_order_book?instrument_name=BTC-PERPETUAL&depth=50`);
  const rawResult = rawOrderBookForSlippage.json && typeof rawOrderBookForSlippage.json === 'object' ? (rawOrderBookForSlippage.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
  const asksRaw = ((rawResult?.asks as number[][] | undefined) ?? []).map(a => ({ price: a[0], size: a[1] }));
  const bidsRaw = ((rawResult?.bids as number[][] | undefined) ?? []).map(b => ({ price: b[0], size: b[1] }));
  const NOTIONAL_USD = 100000;
  const midForSlippage = perpOrderBookDeep.midPrice ?? 0;
  const buySlippage = estimateSlippageBps(asksRaw, NOTIONAL_USD, midForSlippage);
  const sellSlippage = estimateSlippageBps(bidsRaw, NOTIONAL_USD, midForSlippage);
  log(`  想定ヘッジ名目=$${NOTIONAL_USD}: 買い方向スリッページ=${buySlippage.slippageBps}bps 売り方向スリッページ=${sellSlippage.slippageBps}bps`);
  log(`  ⚠ Deribit BTC-PERPETUAL の get_order_book size単位はUSD建て建玉（$1=1コントラクト想定）。size単位の解釈はDeribit契約仕様のcontract_sizeフィールドに準拠すべきだが、本Stage 0では簡易にsize値をUSD建て名目として扱っている旨を明記（Stage 1で契約仕様を再確認のこと）。`);

  // perp手数料
  const perpTakerCommission = perpInstrument?.taker_commission ?? null;
  const perpMakerCommission = perpInstrument?.maker_commission ?? null;

  // ---------------- (d) 統合: lab仮置きと並置 ----------------
  log('\n>>> (d) 統合週次コストとlab仮置きの並置');
  const optionTakerFeeRate = (distinctTakerCommissions[0] as number | undefined) ?? null;

  const integrated = {
    optionFeeRate: {
      makerCommissionValuesObserved: distinctMakerCommissions,
      takerCommissionValuesObserved: distinctTakerCommissions,
      source: 'API配信 (get_instruments kind=option の maker_commission/taker_commission フィールド)',
      conversionToVolPtPerWeekMethod:
        'cost_per_leg_in_underlying = taker_commission (× underlying価格の割合として定義。Deribitのオプション手数料は原資産建て建玉に対する比率で表示される)。' +
        'vol pt換算には対象オプションのvega（ticker.greeks.vegaフィールド、通貨建て/vol pt単位）が必要。本実行で取得したATM近傍オプションのgreeksは optionTickerSnapshots に記録。' +
        'vegaが取得できた場合、cost_vol_pt = (taker_commission × underlying_price × contract相当プレミアム) / vega の形で変換可能（本Stage 0では変換式の構築可否のみ確認し、実数値の確定はしていない）。',
      officialFeePageProbe,
    },
    realSpreadSnapshot: {
      note: '現時点スナップショットのみ取得可能。過去スプレッドはAPI非配信のため取得不可（事実）。',
      perpBtcPerpetual: perpOrderBookForSpread,
      selectedNearAtmOptions: optionSpreadSnapshots,
      optionGreeksSnapshots: optionTickerSnapshots,
    },
    perpDeltaHedgeCost: {
      perpTakerCommission,
      perpMakerCommission,
      commissionSource: 'API配信 (get_instruments kind=future の maker_commission/taker_commission フィールド)',
      slippageEstimateNotionalUsd: NOTIONAL_USD,
      buySideSlippageBps: buySlippage.slippageBps,
      sellSideSlippageBps: sellSlippage.slippageBps,
      orderBookDepthUsed: 50,
    },
    integratedWeeklyCostVolPtPerWeek: {
      note: 'vega非取得または変換式未確定の場合、統合週次コストのvol pt/週への数値変換は本Stage 0では実施しない（構築手段のfeasibility確認に留める。実数値の確定・採否判断はStage 1）。',
      labPlaceholder: LAB_PLACEHOLDER_COST,
    },
  };

  const output = {
    experiment: 'EXP-OBS000037',
    stage: 'Stage 0',
    gate: 'G0-3',
    scriptPath: 'scripts/probe-deribit-cost-model.ts',
    specReference: 'research/EXP-OBS000037/00-spec-stage0.md',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    scope: { assets: ['BTC'], note: 'ETH取得禁止（spec §1-1固定）' },
    endpoints: {
      base: BASE,
      get_instruments_option: `${BASE}/public/get_instruments?currency=BTC&kind=option&expired=false`,
      get_instruments_future: `${BASE}/public/get_instruments?currency=BTC&kind=future&expired=false`,
      get_order_book: `${BASE}/public/get_order_book?instrument_name={inst}&depth={n}`,
      ticker: `${BASE}/public/ticker?instrument_name={inst}`,
      officialFeePageUrl: officialFeePageProbe.url,
    },
    sampleOptionInstrumentsCount: optionInstruments.length,
    sampleOptionFees,
    a_optionFeeStructure: integrated.optionFeeRate,
    b_realSpreadSnapshot: integrated.realSpreadSnapshot,
    c_perpDeltaHedgeCost: integrated.perpDeltaHedgeCost,
    d_integratedWeeklyCost: integrated.integratedWeeklyCostVolPtPerWeek,
  };

  const outPath = join(RESULT_DIR, 'deribit-cost-model.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  const runLogPath = join(RESULT_DIR, 'probe-deribit-cost-model-run.log');
  const block = [
    '='.repeat(70),
    `=== probe-deribit-cost-model.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/probe-deribit-cost-model.ts',
    '',
    'EXECUTION LOG:',
    ...executionLog,
    '',
  ].join('\n');
  appendFileSync(runLogPath, block);
  log(`>>> 保存: ${runLogPath}`);

  log('\n=== 実行完了 ===');
}

main().catch(err => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
