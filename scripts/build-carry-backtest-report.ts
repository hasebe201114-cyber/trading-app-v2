/**
 * EXP-OBS000032（デルタニュートラル・ファンディングキャリー）バックテストデータの静的レポートを生成する。
 *
 * 入力（すべてリポジトリ内の生データ・再計算はしない。累積系列のみ日次生値のprefix sumで導出）:
 *   - research/EXP-OBS000032/10-result/stage1-net-expectation-{btc,eth}.json      … Stage1-A 期間別ネットキャリー
 *   - research/EXP-OBS000032/10-result/stage1-carry-daily-returns-{btc,eth}.json  … Stage1-A 日次系列（無レバ）
 *   - research/EXP-OBS000032/10-result/stage1-liquidation-sim-{btc,eth}.json      … Stage1-B（3/5/10倍・清算込み）
 *   - research/EXP-OBS000032/10-result/stage1-composite.json                      … Stage1-C ②モメンタムとの合成
 *   - research/EXP-OBS000032/10-result/stage1-params.json                         … テール窓定義・gitCommit
 *   - public/data/forward/forward-paper-ledger-{btc,eth}.json                     … フォワード較正ledger（接続部）
 *   - scripts/templates/carry-backtest-report.html                                … HTMLテンプレート
 *
 * 出力:
 *   - public/reports/obs000032-carry-backtest.html（Firebase Hostingでそのまま配信される静的ページ）
 *
 * ⚠ 本スクリプトは値の再計算・平滑化・外れ値除去を一切しない。生データの転記と描画のみ。
 *   累積bps系列は日次pnl_bpsの単純な累積和（ledgerのcumulative_net_pnl_bpsと同じ操作）で、
 *   戦略ロジックの再計算ではない。
 *
 * 実行: node --experimental-strip-types scripts/build-carry-backtest-report.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const RESULT_DIR = join(ROOT, 'research/EXP-OBS000032/10-result');
const TEMPLATE = join(ROOT, 'scripts/templates/carry-backtest-report.html');
const OUT = join(ROOT, 'public/reports/obs000032-carry-backtest.html');

const round = (v: number | null, d: number) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf-8'));

interface DailyReturnRow { date: string; pnl_bps: number; returnPct: number }
interface DailyReturns { asset: string; startDate: string; endDate: string; totalDays: number; data: DailyReturnRow[] }
interface PeriodSummary {
  period: string; n: number; cumulativeNetCarry_bps: number; meanDailyNetCarry_bps: number;
  annualizedNetCarryRate_pct: number; bootstrapPValue: number;
}
interface NetExpectation {
  asset: string; startDate: string; endDate: string; totalDays: number; reversalCount: number;
  reversalDates: string[]; periodSummaries: PeriodSummary[];
}
interface LiqPeriod {
  period: string; n: number; liquidationCount: number; liquidationDates: string[];
  cumulativePnl_bps: number; meanDailyNetCarry_bps: number; annualizedNetCarryRate_pct: number;
  maxDrawdown_bps: number; worstDailyLoss_bps: number; cvar97_5_bps: number | null;
}
interface LiqResult {
  leverage: number; imr: number; periods: LiqPeriod[];
  sizing: {
    fullPeriodCvar97_5_bps: number; worstTailWindow: string; worstTailWindowMaxDD_bps: number;
    constraint1_wStar_dailyCvarBudget: number; constraint2_wStar_worstTailWindowBudget: number;
    w_star: number; w_star_annualizedNetCarry_pct: number;
  };
  netAnnualSharpeRatio_fullPeriod: number; grossAnnualSharpeRatio_fullPeriod: number;
}
interface LiqSim { asset: string; results: LiqResult[] }
interface LedgerRow {
  date_utc: string; phase: 'warmup' | 'live'; daily_net_pnl_bps: number; cumulative_net_pnl_bps: number;
  sleeve_cumulative_return_pct: number; liquidation_flag: number; margin_call_flag: number;
}

function buildAsset(assetKey: 'btc' | 'eth', assetLabel: 'BTC' | 'ETH') {
  const netExp: NetExpectation = readJson(join(RESULT_DIR, `stage1-net-expectation-${assetKey}.json`));
  const dailyReturns: DailyReturns = readJson(join(RESULT_DIR, `stage1-carry-daily-returns-${assetKey}.json`));
  const liqSim: LiqSim = readJson(join(RESULT_DIR, `stage1-liquidation-sim-${assetKey}.json`));
  const ledger: LedgerRow[] = readJson(join(ROOT, `public/data/forward/forward-paper-ledger-${assetKey}.json`));

  // Stage1-A 日次系列 + 単純累積和（ledgerのcumulative_net_pnl_bpsと同じ操作）
  let cum = 0;
  const daily = dailyReturns.data.map(r => {
    cum += r.pnl_bps;
    return { d: r.date, pnl: round(r.pnl_bps, 3), cum: round(cum, 2) };
  });

  const periods = netExp.periodSummaries.map(p => ({
    period: p.period,
    n: p.n,
    cumBps: round(p.cumulativeNetCarry_bps, 1),
    meanBps: round(p.meanDailyNetCarry_bps, 3),
    annPct: round(p.annualizedNetCarryRate_pct, 2),
    pValue: p.bootstrapPValue,
  }));

  const leverages: Record<string, unknown> = {};
  for (const r of liqSim.results) {
    const full = r.periods.find(p => p.period === 'FULL')!;
    leverages[String(r.leverage)] = {
      leverage: r.leverage,
      imr: r.imr,
      liquidationCount: full.liquidationCount,
      liquidationDates: full.liquidationDates,
      cumulativePnl_bps: round(full.cumulativePnl_bps, 1),
      annualizedNetCarryRate_pct: round(full.annualizedNetCarryRate_pct, 2),
      maxDrawdown_bps: round(full.maxDrawdown_bps, 1),
      worstDailyLoss_bps: round(full.worstDailyLoss_bps, 2),
      cvar97_5_bps: round(full.cvar97_5_bps, 2),
      wStar: round(r.sizing.w_star, 3),
      wStarAnnualizedNetCarryPct: round(r.sizing.w_star_annualizedNetCarry_pct, 2),
      worstTailWindow: r.sizing.worstTailWindow,
      worstTailWindowMaxDD_bps: round(r.sizing.worstTailWindowMaxDD_bps, 1),
      netSharpe: round(r.netAnnualSharpeRatio_fullPeriod, 3),
      grossSharpe: round(r.grossAnnualSharpeRatio_fullPeriod, 3),
    };
  }

  const liveLedger = ledger.map(r => ({
    d: r.date_utc,
    phase: r.phase,
    net: round(r.daily_net_pnl_bps, 3),
    cum: round(r.cumulative_net_pnl_bps, 2),
    ret: round(r.sleeve_cumulative_return_pct, 4),
    liq: r.liquidation_flag,
    marginCall: r.margin_call_flag,
  }));

  return {
    label: assetLabel,
    dataRange: { start: dailyReturns.startDate, end: dailyReturns.endDate, n: dailyReturns.totalDays },
    reversalCount: netExp.reversalCount,
    daily,
    periods,
    leverages,
    live: liveLedger,
  };
}

function main() {
  const params = readJson(join(RESULT_DIR, 'stage1-params.json'));
  const composite = readJson(join(RESULT_DIR, 'stage1-composite.json'));

  const btc = buildAsset('btc', 'BTC');
  const eth = buildAsset('eth', 'ETH');

  const tailWindows = params.periods.tailWindows_stress;

  const payload = {
    meta: {
      gitCommit: String(params.gitCommit).slice(0, 8),
      specStage1: params.specReference,
      verdictReference: '22-verdict-stage1-final.md',
      nodeVersion: params.nodeVersion,
    },
    tailWindows: {
      T1: { ...tailWindows.T1_coronavirus, label: 'コロナショック' },
      T2: { ...tailWindows.T2_luna, label: 'LUNA崩壊' },
      T3: { ...tailWindows.T3_ftx, label: 'FTX破綻' },
      calm: { ...tailWindows.calm, label: '平時参照' },
    },
    assets: { BTC: btc, ETH: eth },
    composite: {
      wStar: composite.wStar_L3,
      sleeveDateRange: composite.sleeveDateRange,
      selectionPeriod: composite.selectionPeriod,
      confirmationPeriod: composite.confirmationPeriod,
      frozenWeights: composite.frozenWeights_inverseVol,
      naive5050Weights: composite.frozenWeights_naive5050,
      correlation: composite.correlation,
      sleeve: composite.sleeveMetrics_confirmationPeriod,
      momentum: composite.momentumMetrics_confirmationPeriod,
      frozenComposite: composite.compositeFrozenWeight_confirmationPeriod,
      naive5050: composite.composite5050_confirmationPeriod,
      g3c: composite.g3c,
      g4c: composite.g4c,
    },
  };

  const template = readFileSync(TEMPLATE, 'utf-8');
  if (!template.includes('__DATA__') || !template.includes('__GENERATED_AT__')) {
    throw new Error('テンプレートに __DATA__ / __GENERATED_AT__ プレースホルダが見つかりません');
  }

  const generatedAt = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  const html = template
    .replace('__DATA__', JSON.stringify(payload))
    .replace('__GENERATED_AT__', generatedAt);

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html);

  console.log('生成: ' + OUT);
  console.log(`  BTC 日次 ${btc.daily.length}点 (${btc.dataRange.start} → ${btc.dataRange.end})・ライブ ${btc.live.length}点`);
  console.log(`  ETH 日次 ${eth.daily.length}点 (${eth.dataRange.start} → ${eth.dataRange.end})・ライブ ${eth.live.length}点`);
  console.log(`  生成時刻 ${generatedAt} / ${html.length.toLocaleString()} bytes`);
}

main();
