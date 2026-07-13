/**
 * EXP-OBS000037 Stage 2: 実測コスト統合＋CVaRサイジング＋maxDD是正（spec §2・§3・§4）
 * spec: research/EXP-OBS000037/00-spec-stage2.md §2, §3, §4, §9-1
 *
 * 本スクリプトは判定を行わない。生数値のみを出力する（判定語禁止・spec §11）。
 * lab側スクリプト（crypto-strategy-lab/research/EXP-OBS000001/scripts/vrp-pipeline-accounting.ts）は
 * コピペしていない（独立実装）。
 *
 * 入力（再利用・再構築しない）:
 *   - research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json の mainSeries.weeklyPoints
 *     （週次VRP系列・RV窓長7リターン=D+1..D+8は不変・再計算しない）
 *   - research/EXP-OBS000037/10-result/deribit-cost-model.json の実測値（手数料率・スプレッド・スリッページ）
 *
 * 新規ライブ取得（spec §2-2・現時点スナップショット・限界をmetaに明記）:
 *   - 代表満期＝残存≥7日で最も近いDeribit上場expiry（get_instruments kind=option）
 *   - ATM＝index価格に最も近いstrike（|delta|∈[0.35,0.65]の候補内・get_instruments+ticker）
 *   - 代表満期ATM call/put各1枚の vega/gamma/delta/premium/spread（ticker）
 *   - 週次ヘッジコスト近似のための日次BTC-PERPETUAL価格系列（Deribit-tradingview。VRP計算はしない・
 *     価格系列のみ流用）
 *
 * §2 実測週次コスト C_real = C_options + C_hedge の構築式・§3 CVaRサイジング・§4 maxDD是正は
 * spec本文の数値をハードコードする（HARKing禁止・結果を見て振らない）。
 *
 * 実行: node --experimental-strip-types scripts/vrp-pipeline-accounting.ts
 * 出力: research/EXP-OBS000037/10-result/stage2-vrp-pipeline-accounting.json
 *       research/EXP-OBS000037/10-result/stage2-vrp-pipeline-accounting-params.json
 */

import { writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { fetchWithMeta, fetchDeribitPerpPriceDaily, dateKey, keyToMs, addDaysKey, DERIBIT_BASE } from './lib/vrp-daily-series.ts';

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

// ============================================================
// 固定パラメータ（spec §2・§3・§4・§11・ハードコード・可変にしない）
// ============================================================
const PARAMS = {
  // §2-2 代表満期・ATM定義
  minResidualDaysForRepresentativeMaturity: 7,
  atmDeltaRange: [0.35, 0.65] as [number, number],
  // §0-2 実測コスト率（deribit-cost-model.json・spec §2-3本文の固定値）
  optionTakerCommissionRate: 0.0003,
  optionPremiumCapRate: 0.125,
  perpTakerCommissionRate: 0.0005,
  realSpreadBps: 0.0784,
  slippageBps: 0.0392,
  hedgeReblancesPerWeek: 7,
  // §3 CVaRサイジング
  cvarTailFraction: 0.05, // 下側5%ES
  weeklyRiskBudget: 0.02, // 資本2%
  fFraction_main: 0.5,
  fFraction_reference: 1.0,
  ruin1CapitalFraction: 0.25,
  ruin2CapitalFraction: 0.4,
  // §4 maxDD是正
  ddSanityMaxDrawdownPct: 40,
  // テール窓（spec §8-1・Stage1不変）
  tailWindows: {
    T2: { start: '2022-05-01', end: '2022-06-30', label: 'LUNA/UST崩壊' },
    T3: { start: '2022-10-25', end: '2022-12-15', label: 'FTX破綻' },
  },
  confirmStart: '2023-07-01',
  labWeeklyCostVolPt: 1.8, // Stage1由来lab仮置き（並置比較用）
};

// ============================================================
// 統計ユーティリティ
// ============================================================
function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}
function stdSample(arr: number[]): number {
  if (arr.length < 2) return NaN;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

// ============================================================
// Stage 1週次VRP系列の読み込み（再構築しない）
// ============================================================
interface WeeklyVrpRow {
  date: string;
  vrp: number;
}
function loadStage1WeeklyVrp(): WeeklyVrpRow[] {
  const raw = JSON.parse(readFileSync(join(RESULT_DIR, 'stage1-vrp-prediction-unit.json'), 'utf-8'));
  const points = raw.mainSeries.weeklyPoints as { date: string; vrp: number | null }[];
  return points.filter((p): p is { date: string; vrp: number } => p.vrp !== null).map(p => ({ date: p.date, vrp: p.vrp }));
}

// ============================================================
// 代表満期・ATM選定（ライブ取得・spec §2-2）
// ============================================================
interface OptionInstrument {
  instrument_name: string;
  expiration_timestamp: number;
  strike: number;
  option_type: 'call' | 'put';
}
async function fetchOptionInstruments(): Promise<OptionInstrument[]> {
  const url = `${DERIBIT_BASE}/public/get_instruments?currency=BTC&kind=option&expired=false`;
  const r = await fetchWithMeta(url);
  const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result : undefined;
  return (resultObj as OptionInstrument[] | undefined) ?? [];
}

interface TickerGreeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}
interface TickerSnapshot {
  instrumentName: string;
  indexPrice: number;
  markPriceBtc: number;
  bestBidBtc: number;
  bestAskBtc: number;
  greeks: TickerGreeks;
  raw: unknown;
}
async function fetchTicker(instrumentName: string): Promise<TickerSnapshot | null> {
  const url = `${DERIBIT_BASE}/public/ticker?instrument_name=${instrumentName}`;
  const r = await fetchWithMeta(url);
  const resultObj = r.json && typeof r.json === 'object' ? (r.json as Record<string, unknown>).result as Record<string, unknown> | undefined : undefined;
  if (!resultObj) return null;
  const greeks = resultObj.greeks as Record<string, number> | undefined;
  if (!greeks) return null;
  return {
    instrumentName,
    indexPrice: resultObj.index_price as number,
    markPriceBtc: resultObj.mark_price as number,
    bestBidBtc: resultObj.best_bid_price as number,
    bestAskBtc: resultObj.best_ask_price as number,
    greeks: { delta: greeks.delta, gamma: greeks.gamma, vega: greeks.vega, theta: greeks.theta },
    raw: resultObj,
  };
}

async function selectRepresentativeMaturityAndAtm(nowMs: number): Promise<{
  expiryTimestamp: number;
  expiryIso: string;
  residualDays: number;
  strike: number;
  indexPriceAtSelection: number;
  callTicker: TickerSnapshot;
  putTicker: TickerSnapshot;
  candidateLog: { strike: number; delta: number; instrumentName: string }[];
}> {
  const instruments = await fetchOptionInstruments();
  log(`  option instruments fetched: count=${instruments.length}`);
  const expiries = [...new Set(instruments.map(i => i.expiration_timestamp))].sort((a, b) => a - b);
  const residuals = expiries.map(e => ({ e, days: (e - nowMs) / 86400000 }));
  const chosen = residuals.find(r => r.days >= PARAMS.minResidualDaysForRepresentativeMaturity);
  if (!chosen) throw new Error('代表満期（残存>=7日）が見つからない（全満期が残存<7日）');
  const expiryTimestamp = chosen.e;
  const expiryIso = new Date(expiryTimestamp).toISOString();
  log(`  代表満期選定: expiry=${expiryIso} residualDays=${chosen.days.toFixed(4)}`);

  const callStrikesAtExpiry = instruments.filter(i => i.expiration_timestamp === expiryTimestamp && i.option_type === 'call').map(i => i.strike).sort((a, b) => a - b);
  log(`  代表満期のcall strikes: ${callStrikesAtExpiry.join(',')}`);

  const candidateLog: { strike: number; delta: number; instrumentName: string }[] = [];
  const candidates: { strike: number; delta: number; indexPrice: number; ticker: TickerSnapshot }[] = [];
  for (const strike of callStrikesAtExpiry) {
    const expiryDateStr = new Date(expiryTimestamp).toISOString().slice(0, 11).split('T')[0];
    const dt = new Date(expiryTimestamp);
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][dt.getUTCMonth()];
    const yy = String(dt.getUTCFullYear()).slice(2);
    const instrumentName = `BTC-${dd}${mon}${yy}-${strike}-C`;
    const t = await fetchTicker(instrumentName);
    await sleep(150);
    if (!t) continue;
    candidateLog.push({ strike, delta: t.greeks.delta, instrumentName });
    if (t.greeks.delta >= PARAMS.atmDeltaRange[0] && t.greeks.delta <= PARAMS.atmDeltaRange[1]) {
      candidates.push({ strike, delta: t.greeks.delta, indexPrice: t.indexPrice, ticker: t });
    }
  }
  if (candidates.length === 0) throw new Error('ATM候補（|delta|∈[0.35,0.65]）が代表満期内に見つからない');
  // index価格に最も近いstrike（候補内）
  candidates.sort((a, b) => Math.abs(a.strike - a.indexPrice) - Math.abs(b.strike - b.indexPrice));
  const best = candidates[0];
  log(`  ATM選定: strike=${best.strike} delta=${best.delta} indexPrice=${best.indexPrice}`);

  const dt = new Date(expiryTimestamp);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][dt.getUTCMonth()];
  const yy = String(dt.getUTCFullYear()).slice(2);
  const putInstrumentName = `BTC-${dd}${mon}${yy}-${best.strike}-P`;
  const putTicker = await fetchTicker(putInstrumentName);
  if (!putTicker) throw new Error(`put ticker取得失敗: ${putInstrumentName}`);

  return {
    expiryTimestamp,
    expiryIso,
    residualDays: chosen.days,
    strike: best.strike,
    indexPriceAtSelection: best.indexPrice,
    callTicker: best.ticker,
    putTicker,
    candidateLog,
  };
}

// ============================================================
// §2-3 実測週次コスト構築
// ============================================================
interface CostBuild {
  C_options_volpt: number;
  C_hedge_volpt: number;
  C_real_volpt: number;
  detail: Record<string, unknown>;
}

function buildOptionsCost(call: TickerSnapshot, put: TickerSnapshot, indexPrice: number): { costUsdTotal: number; vegaTotalUsdPerVolPt: number; costVolPt: number; detail: Record<string, unknown> } {
  const callPremiumUsd = call.markPriceBtc * indexPrice;
  const putPremiumUsd = put.markPriceBtc * indexPrice;
  const callFeeUsd = Math.min(PARAMS.optionTakerCommissionRate * indexPrice, PARAMS.optionPremiumCapRate * callPremiumUsd);
  const putFeeUsd = Math.min(PARAMS.optionTakerCommissionRate * indexPrice, PARAMS.optionPremiumCapRate * putPremiumUsd);
  const callHalfSpreadUsd = 0.5 * (call.bestAskBtc - call.bestBidBtc) * indexPrice;
  const putHalfSpreadUsd = 0.5 * (put.bestAskBtc - put.bestBidBtc) * indexPrice;
  const perRoundCostUsd = (callFeeUsd + callHalfSpreadUsd) + (putFeeUsd + putHalfSpreadUsd); // call+put 1ラウンド分
  const costUsdTotal = perRoundCostUsd * 2; // entry+exit = 2ラウンド
  const vegaTotalUsdPerVolPt = call.greeks.vega + put.greeks.vega;
  const costVolPt = costUsdTotal / vegaTotalUsdPerVolPt;
  return {
    costUsdTotal,
    vegaTotalUsdPerVolPt,
    costVolPt,
    detail: {
      callPremiumUsd, putPremiumUsd, callFeeUsd, putFeeUsd, callHalfSpreadUsd, putHalfSpreadUsd, perRoundCostUsd,
      note: 'C_options = [(手数料+半スプレッド)×(call+put)] × 2ラウンド(entry+exit) の合計USD ÷ (call vega + put vega)',
    },
  };
}

async function buildHedgeCost(
  weeklyDates: string[],
  closeByDate: Map<string, number>,
  gammaTotal: number,
  vegaTotalUsdPerVolPt: number,
): Promise<{ meanCostVolPt: number; stdCostVolPt: number; minCostVolPt: number; maxCostVolPt: number; validWeeks: number; skippedWeeks: number; perWeek: { date: string; hedgeUsd: number; costVolPt: number }[] }> {
  const hedgeCostRateFraction = PARAMS.perpTakerCommissionRate + (PARAMS.realSpreadBps / 10000) + (PARAMS.slippageBps / 10000);
  const perWeek: { date: string; hedgeUsd: number; costVolPt: number }[] = [];
  let skipped = 0;
  for (const d of weeklyDates) {
    const dayCloses: number[] = [];
    let ok = true;
    for (let i = 0; i <= PARAMS.hedgeReblancesPerWeek; i++) {
      const dk = addDaysKey(d, i);
      const c = closeByDate.get(dk);
      if (c === undefined) { ok = false; break; }
      dayCloses.push(c);
    }
    if (!ok || dayCloses.length !== PARAMS.hedgeReblancesPerWeek + 1) { skipped++; continue; }
    let weeklyHedgeUsd = 0;
    for (let k = 1; k < dayCloses.length; k++) {
      const deltaS = dayCloses[k] - dayCloses[k - 1];
      const deltaDelta = gammaTotal * deltaS; // BTC単位のポジションdelta変化（gamma×価格変化）
      const hedgeNotionalUsd = Math.abs(deltaDelta) * dayCloses[k]; // gamma×価格変化×index
      weeklyHedgeUsd += hedgeNotionalUsd * hedgeCostRateFraction;
    }
    const costVolPt = weeklyHedgeUsd / vegaTotalUsdPerVolPt;
    perWeek.push({ date: d, hedgeUsd: weeklyHedgeUsd, costVolPt });
  }
  const costs = perWeek.map(p => p.costVolPt);
  return {
    meanCostVolPt: mean(costs),
    stdCostVolPt: stdSample(costs),
    minCostVolPt: Math.min(...costs),
    maxCostVolPt: Math.max(...costs),
    validWeeks: perWeek.length,
    skippedWeeks: skipped,
    perWeek,
  };
}

// ============================================================
// §3 CVaR・vegaNotionalPct・破産サニティ
// ============================================================
function computeCvarEs(values: number[], tailFraction: number): { esValue: number; absCvar: number; tailCount: number; tailValues: number[] } {
  const sorted = [...values].sort((a, b) => a - b);
  const tailCount = Math.max(1, Math.round(sorted.length * tailFraction));
  const tailValues = sorted.slice(0, tailCount);
  const esValue = mean(tailValues);
  return { esValue, absCvar: Math.abs(esValue), tailCount, tailValues };
}

// ============================================================
// §4 maxDD（global running peak基準%）
// ============================================================
interface EquityPointRow {
  date: string;
  r: number;
  equityCompound: number;
  equitySimple: number;
  peakCompound: number;
  peakSimple: number;
  ddCompoundPct: number;
  ddSimplePct: number;
}
function buildEquitySeries(weeklyDates: string[], netPayoff: number[], vegaNotionalPct: number): EquityPointRow[] {
  const rows: EquityPointRow[] = [];
  let equityCompound = 1.0;
  let equitySimple = 1.0;
  let peakCompound = 1.0;
  let peakSimple = 1.0;
  for (let i = 0; i < weeklyDates.length; i++) {
    const r = vegaNotionalPct * netPayoff[i];
    equityCompound = equityCompound * (1 + r);
    equitySimple = equitySimple + r;
    peakCompound = Math.max(peakCompound, equityCompound);
    peakSimple = Math.max(peakSimple, equitySimple);
    const ddCompoundPct = peakCompound > 0 ? ((peakCompound - equityCompound) / peakCompound) * 100 : 0;
    const ddSimplePct = peakSimple > 0 ? ((peakSimple - equitySimple) / peakSimple) * 100 : 0;
    rows.push({ date: weeklyDates[i], r, equityCompound, equitySimple, peakCompound, peakSimple, ddCompoundPct, ddSimplePct });
  }
  return rows;
}
function maxDdInRange(rows: EquityPointRow[], start: string | null, end: string | null): { maxDdCompoundPct: number; ddPeakDateCompound: string | null; ddTroughDateCompound: string | null; maxDdSimplePct: number; ddPeakDateSimple: string | null; ddTroughDateSimple: string | null; n: number } {
  const filtered = rows.filter(r => (start === null || r.date >= start) && (end === null || r.date <= end));
  if (filtered.length === 0) return { maxDdCompoundPct: NaN, ddPeakDateCompound: null, ddTroughDateCompound: null, maxDdSimplePct: NaN, ddPeakDateSimple: null, ddTroughDateSimple: null, n: 0 };
  let maxC = -Infinity, maxCRow: EquityPointRow | null = null;
  let maxS = -Infinity, maxSRow: EquityPointRow | null = null;
  for (const r of filtered) {
    if (r.ddCompoundPct > maxC) { maxC = r.ddCompoundPct; maxCRow = r; }
    if (r.ddSimplePct > maxS) { maxS = r.ddSimplePct; maxSRow = r; }
  }
  // peak日はそのtrough時点までの走行最高値が記録された日（グローバル系列を遡って特定）
  const findPeakDate = (troughRow: EquityPointRow, useCompound: boolean): string | null => {
    const idx = rows.findIndex(r => r.date === troughRow.date);
    const targetPeak = useCompound ? troughRow.peakCompound : troughRow.peakSimple;
    for (let i = idx; i >= 0; i--) {
      const v = useCompound ? rows[i].equityCompound : rows[i].equitySimple;
      if (Math.abs(v - targetPeak) < 1e-12) return rows[i].date;
    }
    return null;
  };
  return {
    maxDdCompoundPct: maxC,
    ddPeakDateCompound: maxCRow ? findPeakDate(maxCRow, true) : null,
    ddTroughDateCompound: maxCRow ? maxCRow.date : null,
    maxDdSimplePct: maxS,
    ddPeakDateSimple: maxSRow ? findPeakDate(maxSRow, false) : null,
    ddTroughDateSimple: maxSRow ? maxSRow.date : null,
    n: filtered.length,
  };
}

// ============================================================
// main
// ============================================================
async function main(): Promise<void> {
  log('=== EXP-OBS000037 Stage 2: vrp-pipeline-accounting.ts ===');
  log(`実行UTC時刻: ${RUN_TIMESTAMP}`);
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { cwd: join(__dirname, '..') }).toString().trim();
  } catch { /* ignore */ }
  log(`Git commit: ${gitCommit}`);
  log(`Node version: ${process.version}`);

  // ---- 1. Stage1週次VRP系列読み込み（再構築しない） ----
  const weekly = loadStage1WeeklyVrp();
  log(`Stage1週次VRP系列読み込み: n=${weekly.length} (${weekly[0].date}〜${weekly[weekly.length - 1].date})`);
  const weeklyDates = weekly.map(w => w.date);
  const vrpSeries = weekly.map(w => w.vrp);

  // ---- 2. 代表満期・ATM選定（ライブ取得） ----
  log('\n>>> §2-2 代表満期・ATM選定（ライブ取得）');
  const nowMs = Date.now();
  const atm = await selectRepresentativeMaturityAndAtm(nowMs);

  // ---- 3. C_options ----
  log('\n>>> §2-3(a) C_options 構築');
  const indexPriceUsed = atm.callTicker.indexPrice;
  const optionsCost = buildOptionsCost(atm.callTicker, atm.putTicker, indexPriceUsed);
  log(`  C_options = ${optionsCost.costVolPt.toFixed(6)} vol pt/週 (USD合計=${optionsCost.costUsdTotal.toFixed(4)} vegaTotal=${optionsCost.vegaTotalUsdPerVolPt.toFixed(4)})`);

  // ---- 4. C_hedge（日次価格系列ライブ取得） ----
  log('\n>>> §2-3(b) C_hedge 構築（日次BTC-PERPETUAL価格系列取得）');
  const todayKey = dateKey(new Date());
  const anchorDate = '2021-03-24';
  const price = await fetchDeribitPerpPriceDaily('BTC-PERPETUAL', anchorDate, todayKey, log);
  const gammaTotal = atm.callTicker.greeks.gamma + atm.putTicker.greeks.gamma;
  const hedgeCost = await buildHedgeCost(weeklyDates, price.closeByDate, gammaTotal, optionsCost.vegaTotalUsdPerVolPt);
  log(`  C_hedge = ${hedgeCost.meanCostVolPt.toFixed(6)} vol pt/週 (std=${hedgeCost.stdCostVolPt.toFixed(6)} validWeeks=${hedgeCost.validWeeks} skipped=${hedgeCost.skippedWeeks})`);

  const C_real = optionsCost.costVolPt + hedgeCost.meanCostVolPt;
  log(`  C_real = C_options + C_hedge = ${C_real.toFixed(6)} vol pt/週（lab仮置き=${PARAMS.labWeeklyCostVolPt}）`);

  // ---- 5. §2-4 SC-1〜SC-3 ----
  log('\n>>> §2-4 実コスト置換後ネット期待値（SC-1〜SC-3）');
  const netPayoff = vrpSeries.map(v => v - C_real);
  const netPayoff2x = vrpSeries.map(v => v - 2 * C_real);
  const confirmIdx = weeklyDates.map((d, i) => ({ d, i })).filter(x => x.d >= PARAMS.confirmStart).map(x => x.i);
  const netPayoffConfirm = confirmIdx.map(i => netPayoff[i]);
  const netPayoff2xConfirm = confirmIdx.map(i => netPayoff2x[i]);

  const sc1_meanFull = mean(netPayoff);
  const sc1_meanConfirm = mean(netPayoffConfirm);
  const sc2_sharpeFull = (mean(netPayoff) / stdSample(netPayoff)) * Math.sqrt(52);
  const sc2_sharpeConfirm = (mean(netPayoffConfirm) / stdSample(netPayoffConfirm)) * Math.sqrt(52);
  const sc3_mean2xFull = mean(netPayoff2x);
  const sc3_mean2xConfirm = mean(netPayoff2xConfirm);

  log(`  SC-1 meanFull=${sc1_meanFull.toFixed(6)} meanConfirm=${sc1_meanConfirm.toFixed(6)}`);
  log(`  SC-2 sharpeFull=${sc2_sharpeFull.toFixed(6)} sharpeConfirm=${sc2_sharpeConfirm.toFixed(6)}`);
  log(`  SC-3 mean2xFull=${sc3_mean2xFull.toFixed(6)} mean2xConfirm=${sc3_mean2xConfirm.toFixed(6)}`);

  // ---- 6. §3 CVaR・サイジング ----
  log('\n>>> §3 CVaRサイジング');
  const cvar = computeCvarEs(netPayoff, PARAMS.cvarTailFraction);
  const vegaNotionalPct_f05 = PARAMS.fFraction_main * (PARAMS.weeklyRiskBudget / cvar.absCvar);
  const vegaNotionalPct_f10 = PARAMS.fFraction_reference * (PARAMS.weeklyRiskBudget / cvar.absCvar);
  log(`  |CVaR_w|(下側5%ES)=${cvar.absCvar.toFixed(6)} (esValue=${cvar.esValue.toFixed(6)} tailCount=${cvar.tailCount}/${netPayoff.length})`);
  log(`  vegaNotionalPct(f=0.5)=${vegaNotionalPct_f05.toFixed(8)} vegaNotionalPct(f=1.0参考)=${vegaNotionalPct_f10.toFixed(8)}`);

  // RUIN-1
  const worstSingleWeeklyLoss = Math.abs(Math.min(...netPayoff));
  const ruin1Value = worstSingleWeeklyLoss * vegaNotionalPct_f05;
  const ruin1WithinBudget = ruin1Value <= PARAMS.ruin1CapitalFraction;
  log(`  RUIN-1: worstSingleWeeklyLoss=${worstSingleWeeklyLoss.toFixed(6)} × vegaNotionalPct = ${ruin1Value.toFixed(6)} (資本比・閾値=${PARAMS.ruin1CapitalFraction})`);

  // RUIN-2 (T2/T3)
  const ruin2Results: Record<string, unknown> = {};
  for (const [key, w] of Object.entries(PARAMS.tailWindows)) {
    const idxInWindow = weeklyDates.map((d, i) => ({ d, i })).filter(x => x.d >= w.start && x.d <= w.end).map(x => x.i);
    const cumulativeNet = idxInWindow.reduce((s, i) => s + netPayoff[i], 0);
    const worstCaseLoss = Math.max(0, -cumulativeNet);
    const ruin2Value = worstCaseLoss * vegaNotionalPct_f05;
    const ruin2WithinBudget = ruin2Value <= PARAMS.ruin2CapitalFraction;
    ruin2Results[key] = { windowStart: w.start, windowEnd: w.end, weeksInWindow: idxInWindow.length, cumulativeNetPayoffVolPt: cumulativeNet, worstCaseLossVolPt: worstCaseLoss, ruin2ValueCapitalFraction: ruin2Value, ruin2WithinBudget };
    log(`  RUIN-2 ${key}: weeksInWindow=${idxInWindow.length} cumulativeNet=${cumulativeNet.toFixed(6)} worstCaseLoss=${worstCaseLoss.toFixed(6)} ruin2Value=${ruin2Value.toFixed(6)}`);
  }

  // ---- 7. §4 maxDD（資本equity・global running peak） ----
  log('\n>>> §4 maxDD（vegaNotionalPct適用後の資本equity・global running peak）');
  const equityRows = buildEquitySeries(weeklyDates, netPayoff, vegaNotionalPct_f05);
  const lastConfirmStart = PARAMS.confirmStart;
  const ddFull = maxDdInRange(equityRows, null, null);
  const ddConfirm = maxDdInRange(equityRows, lastConfirmStart, null);
  const ddT2 = maxDdInRange(equityRows, PARAMS.tailWindows.T2.start, PARAMS.tailWindows.T2.end);
  const ddT3 = maxDdInRange(equityRows, PARAMS.tailWindows.T3.start, PARAMS.tailWindows.T3.end);
  log(`  full: compoundMaxDD=${ddFull.maxDdCompoundPct.toFixed(4)}% simpleMaxDD=${ddFull.maxDdSimplePct.toFixed(4)}%`);
  log(`  confirm: compoundMaxDD=${ddConfirm.maxDdCompoundPct.toFixed(4)}% simpleMaxDD=${ddConfirm.maxDdSimplePct.toFixed(4)}%`);
  log(`  T2: compoundMaxDD=${ddT2.maxDdCompoundPct.toFixed(4)}% T3: compoundMaxDD=${ddT3.maxDdCompoundPct.toFixed(4)}%`);

  const ddSanityMet = ddFull.maxDdCompoundPct <= PARAMS.ddSanityMaxDrawdownPct;
  log(`  DD-SANITY: 複利maxDD(全期間)=${ddFull.maxDdCompoundPct.toFixed(4)}% <= ${PARAMS.ddSanityMaxDrawdownPct}% -> ${ddSanityMet}`);

  // ---- 8. 出力 ----
  const output = {
    experiment: 'EXP-OBS000037',
    stage: 'Stage 2',
    scriptPath: 'scripts/vrp-pipeline-accounting.ts',
    specReference: 'research/EXP-OBS000037/00-spec-stage2.md §2, §3, §4',
    executedBy: 'B実装チーム (Quant Researcher)',
    runTimestampUTC: RUN_TIMESTAMP,
    gitCommit,
    nodeVersion: process.version,
    scope: { assets: ['BTC'], note: 'ETH取得禁止（spec §8-2固定）' },
    params: PARAMS,
    inputSources: {
      stage1WeeklyVrp: { path: 'research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json', field: 'mainSeries.weeklyPoints', n: weekly.length, note: 'VRP系列は再構築せずそのまま使用（null vrpの末尾1点は除外）' },
    },
    liveSnapshot: {
      note: '⚠ 代表満期ATMのvega/gamma/delta/premium/spreadは実行時点(runTimestampUTC)の現時点スナップショットであり、過去は取得不可のため全期間に同一値を適用する（spec §2-2の限界・都合よく選ばない=|delta|0.5最近接に一意固定）。日次BTC-PERPETUAL価格系列は各週の実現ΔSを反映するため週次で変動する。',
      selectedExpiryIso: atm.expiryIso,
      residualDaysAtSelection: atm.residualDays,
      selectedStrike: atm.strike,
      indexPriceAtSelection: atm.indexPriceAtSelection,
      atmCandidateDeltaLog: atm.candidateLog,
      call: { instrumentName: atm.callTicker.instrumentName, indexPrice: atm.callTicker.indexPrice, markPriceBtc: atm.callTicker.markPriceBtc, bestBidBtc: atm.callTicker.bestBidBtc, bestAskBtc: atm.callTicker.bestAskBtc, greeks: atm.callTicker.greeks },
      put: { instrumentName: atm.putTicker.instrumentName, indexPrice: atm.putTicker.indexPrice, markPriceBtc: atm.putTicker.markPriceBtc, bestBidBtc: atm.putTicker.bestBidBtc, bestAskBtc: atm.putTicker.bestAskBtc, greeks: atm.putTicker.greeks },
      priceSeries: { source: 'deribit-tradingview BTC-PERPETUAL daily', ticksReturned: price.ticksReturned, rawTickHourUtc: price.rawTickHourUtc, note: 'VRP計算には使用せず、週次ヘッジ名目のΔS近似にのみ使用（VRP再構築ではない）' },
    },
    costAccounting: {
      C_options_volpt: optionsCost.costVolPt,
      C_options_detail: optionsCost.detail,
      C_hedge_volpt_mean: hedgeCost.meanCostVolPt,
      C_hedge_volpt_std: hedgeCost.stdCostVolPt,
      C_hedge_volpt_min: hedgeCost.minCostVolPt,
      C_hedge_volpt_max: hedgeCost.maxCostVolPt,
      C_hedge_validWeeks: hedgeCost.validWeeks,
      C_hedge_skippedWeeks: hedgeCost.skippedWeeks,
      C_hedge_hedgeCostRateFraction: PARAMS.perpTakerCommissionRate + (PARAMS.realSpreadBps / 10000) + (PARAMS.slippageBps / 10000),
      C_hedge_gammaTotal: gammaTotal,
      C_real_volpt: C_real,
      labPlaceholderComparison: { labWeeklyCostVolPt: PARAMS.labWeeklyCostVolPt, C_real_minus_lab: C_real - PARAMS.labWeeklyCostVolPt },
    },
    sc1_netPositiveAfterRealCost: { meanWeeklyNetPayoff_full: sc1_meanFull, meanWeeklyNetPayoff_confirm: sc1_meanConfirm, n_full: netPayoff.length, n_confirm: netPayoffConfirm.length },
    sc2_sharpeAfterRealCost: { sharpeAnnualizedSqrt52_full: sc2_sharpeFull, sharpeAnnualizedSqrt52_confirm: sc2_sharpeConfirm, stdWeeklyNetPayoff_full: stdSample(netPayoff), stdWeeklyNetPayoff_confirm: stdSample(netPayoffConfirm) },
    sc3_doubleCostRobustness: { meanWeeklyNetPayoff2x_full: sc3_mean2xFull, meanWeeklyNetPayoff2x_confirm: sc3_mean2xConfirm },
    cvarSizing: {
      cvarTailFraction: PARAMS.cvarTailFraction,
      populationN: netPayoff.length,
      tailCount: cvar.tailCount,
      esValue_volpt: cvar.esValue,
      absCvar_volpt: cvar.absCvar,
      weeklyRiskBudget: PARAMS.weeklyRiskBudget,
      vegaNotionalPct_f05_main: vegaNotionalPct_f05,
      vegaNotionalPct_f10_reference: vegaNotionalPct_f10,
    },
    ruin1_worstWeeklyLoss: { worstSingleWeeklyLossVolPt: worstSingleWeeklyLoss, ruin1ValueCapitalFraction: ruin1Value, ruin1CapitalFractionThreshold: PARAMS.ruin1CapitalFraction, ruin1WithinBudget },
    ruin2_worstTailWindowCumulativeLoss: ruin2Results,
    maxDrawdown: {
      methodology: 'r_t = vegaNotionalPct(f=0.5) × (VRP_t − C_real)。equityCompound_t=equityCompound_{t-1}×(1+r_t)、equitySimple_t=equitySimple_{t-1}+r_t（equity_0=1.0）。ddPct_t=(peak_t-equity_t)/peak_t×100、peak_tは全期間を通したglobal running peak（区間ごとにリセットしない）。confirm/T2/T3の指標もこのglobal peakを基準に区間内最大値を報告する。',
      full: ddFull,
      confirm: ddConfirm,
      T2: ddT2,
      T3: ddT3,
      ddSanityThresholdPct: PARAMS.ddSanityMaxDrawdownPct,
      ddSanityMet_compoundFull: ddSanityMet,
    },
    weeklyNetPayoffSeries: weeklyDates.map((d, i) => ({ date: d, vrp: vrpSeries[i], netPayoff: netPayoff[i], netPayoff2x: netPayoff2x[i] })),
    hedgeCostPerWeek: hedgeCost.perWeek,
    equitySeries: equityRows,
  };

  const outPath = join(RESULT_DIR, 'stage2-vrp-pipeline-accounting.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  log(`\n>>> 保存: ${outPath}`);

  const paramsPath = join(RESULT_DIR, 'stage2-vrp-pipeline-accounting-params.json');
  writeFileSync(paramsPath, JSON.stringify(PARAMS, null, 2));
  log(`>>> 保存: ${paramsPath}`);

  const runLogPath = join(RESULT_DIR, 'stage2-vrp-run.log');
  const block = [
    '='.repeat(70),
    `=== vrp-pipeline-accounting.ts 実行 ${RUN_TIMESTAMP} ===`,
    `Git commit: ${gitCommit}`,
    `Node version: ${process.version}`,
    '',
    'REPRODUCTION COMMAND:',
    '  node --experimental-strip-types scripts/vrp-pipeline-accounting.ts',
    '  ⚠ 代表満期・ATM選定・vega/gamma/delta/premium/spreadは実行時点のDeribitライブスナップショット依存',
    '  （spec §2-2で明示された限界。再実行すると異なる満期/strike/greeksを選ぶ可能性があり、',
    '   その場合C_options/C_hedge/C_real以降の数値も変わる。VRP系列自体・コスト変換式・CVaR/f/maxDD定義は不変）。',
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
