/**
 * パイプライン統合 — ②パターン認識層→③LLM特徴量層→④統合判断層→⑤リスク管理層→⑥執行層を
 * 1本につなぎ、実際のポートフォリオ損益（総リターン・最大ドローダウン・シャープレシオ）を測定する。
 *
 * これまでの検証（OBS000005, OBS000006）は②単体の「方向的中率」のみを見ていたが、
 * PJ000001のKPIは方向的中率に加えシャープレシオ0.8以上・最大ドローダウン15%以内も
 * 求めているため、本モジュールで初めてポートフォリオレベルの指標を算出する。
 *
 * 既知の簡略化（TODO）:
 *   - ③LLM層は config.marketContextForDay で事前計算済みの日次特徴量を注入できる（OBS000014）。
 *     未指定の場合はニュースなしのmockで動作し、eventImpactScoreは実質常に0（③なし相当）。
 *   - ⑥執行層は成行注文のみシミュレート（指値注文の約定判定には日中データが必要なため未対応）
 *   - ポジションは非オーバーラップ（horizon日分の保有が終わるまで新規エントリーしない）
 *   - シャープレシオはトレード単位のリターン列から算出し、年間トレード数で年率化する簡易版
 */
import type { OHLCV } from '../types/market.ts';
import { extractFeatureVector, zScoreNormalize, type FeatureVector } from '../pattern-engine/features.ts';
import { findNearestNeighbors } from '../pattern-engine/similarity.ts';
import { predictFromNeighborReturns } from '../pattern-engine/predict.ts';
import { mockAnalyzeMarketContext } from '../llm-layer/mockClient.ts';
import { combineSignals } from '../decision-layer/combineSignals.ts';
import { calculatePositionSize } from '../risk-layer/positionSizing.ts';
import { evaluateCircuitBreaker } from '../risk-layer/circuitBreaker.ts';
import { DEFAULT_RISK_LIMITS, type EquityPoint, type RiskLimits } from '../risk-layer/types.ts';
import { simulateRoundTripExecution } from '../execution-layer/executeOrder.ts';
import { DEFAULT_EXECUTION_COST, type ExecutionCostModel } from '../execution-layer/types.ts';
import type { PipelineConfig, PipelineResult, TradeRecord } from './types.ts';

const pctChange = (from: number, to: number): number => (to - from) / from;

export function simulatePortfolio(
  candles: OHLCV[],
  config: PipelineConfig,
  riskLimits: RiskLimits = DEFAULT_RISK_LIMITS,
  executionCost: ExecutionCostModel = DEFAULT_EXECUTION_COST,
): PipelineResult {
  const { horizon, k, testRatio, testEndFraction = 1, initialEquity, marketContextForDay } = config;
  const n = candles.length;

  const minIndex = 20;
  const maxIndex = n - horizon - 1;
  const validIndices: number[] = [];
  const rawVectors: FeatureVector[] = [];

  for (let i = minIndex; i <= maxIndex; i++) {
    const vec = extractFeatureVector(candles, i);
    if (vec) {
      validIndices.push(i);
      rawVectors.push(vec);
    }
  }

  const testStart = Math.floor(validIndices.length * (1 - testRatio));
  const testEnd = Math.floor(validIndices.length * testEndFraction);

  const emptyResult: PipelineResult = {
    trades: [], equityCurve: [], finalEquity: initialEquity, totalReturn: 0,
    maxDrawdown: 0, sharpeRatio: 0, winRate: 0, haltedByDrawdown: false, skippedByCircuitBreaker: 0,
  };
  if (testStart < 10 || testStart >= validIndices.length || testEnd <= testStart) return emptyResult;

  const trainVectors = rawVectors.slice(0, testStart);
  const normalizedAll = zScoreNormalize([...trainVectors, ...rawVectors.slice(testStart)]);

  let equity = initialEquity;
  const equityCurve: EquityPoint[] = [{ timestamp: candles[validIndices[testStart]].time, equity }];
  const trades: TradeRecord[] = [];
  let nextAvailableIndex = validIndices[testStart];
  let haltedByDrawdown = false;
  let skippedByCircuitBreaker = 0;

  for (let t = testStart; t < testEnd; t++) {
    if (haltedByDrawdown) break; // 最大DD到達後は全面停止（PJ000001方針）

    const currentCandleIndex = validIndices[t];
    if (currentCandleIndex < nextAvailableIndex) continue; // 前のポジション保有中はスキップ

    // サーキットブレーカー確認
    const cbStatus = evaluateCircuitBreaker(equityCurve, riskLimits);
    if (cbStatus.halted) {
      skippedByCircuitBreaker++;
      if (cbStatus.currentDrawdown >= riskLimits.maxDrawdownRatio) {
        haltedByDrawdown = true;
        break;
      }
      continue; // 日次損失による一時停止 → この足は見送り、次の足で再評価
    }

    // ② パターン認識層
    const targetVector = normalizedAll[t];
    const candidates = validIndices
      .map((idx, pos) => ({ index: idx, vector: normalizedAll[pos] }))
      .filter(c => c.index + horizon <= currentCandleIndex);
    if (candidates.length < k) continue;

    const neighbors = findNearestNeighbors(targetVector, candidates, k);
    const forwardReturns = neighbors.map(nb => pctChange(candles[nb.index].close, candles[nb.index + horizon].close));
    const patternPrediction = predictFromNeighborReturns(forwardReturns);
    if (patternPrediction.direction === 'neutral') continue;

    // ③ LLM特徴量層
    // marketContextForDay が与えられていれば事前計算済みの実LLM/mock特徴量を使用（OBS000014）。
    // 無ければ従来どおりニュースなしのmock（eventImpactScoreは実質0＝③なし相当）。
    const return24h = pctChange(candles[currentCandleIndex - 1].close, candles[currentCandleIndex].close);
    const volatility20d = rawVectors[t][5]; // features.ts: volatility20
    const utcDate = new Date(candles[currentCandleIndex].time).toISOString().slice(0, 10);
    const llmContext = marketContextForDay?.(utcDate)
      ?? mockAnalyzeMarketContext({ recentNews: [], priceContext: { return24h, volatility20d } }).output;

    // ④ 統合判断層
    const finalSignal = combineSignals(patternPrediction, llmContext);
    if (finalSignal.action === 'skip' || finalSignal.direction === 'neutral') continue;

    // ⑤ リスク管理層
    const sizeResult = calculatePositionSize(
      { accountEquity: equity, confidence: finalSignal.confidence, sizeMultiplier: finalSignal.sizeMultiplier },
      riskLimits,
    );
    if (sizeResult.positionSizeRatio <= 0) continue;

    // ⑥ 執行層: 成行注文の約定シミュレーション（スリッページ・手数料を織り込む）
    const exitIndex = currentCandleIndex + horizon;
    const priceReturn = pctChange(candles[currentCandleIndex].close, candles[exitIndex].close);
    const execution = simulateRoundTripExecution(
      candles[currentCandleIndex].close,
      candles[exitIndex].close,
      finalSignal.direction,
      executionCost,
    );
    const directionalReturn = execution.netReturn;
    const pnl = equity * sizeResult.positionSizeRatio * directionalReturn;
    equity += pnl;

    trades.push({
      entryIndex: currentCandleIndex,
      entryTime: candles[currentCandleIndex].time,
      exitTime: candles[exitIndex].time,
      direction: finalSignal.direction,
      action: finalSignal.action,
      positionSizeRatio: sizeResult.positionSizeRatio,
      priceReturn,
      directionalReturn,
      pnl,
      equityAfter: equity,
    });
    equityCurve.push({ timestamp: candles[exitIndex].time, equity });
    nextAvailableIndex = exitIndex;
  }

  const finalEquity = equity;
  const totalReturn = (finalEquity - initialEquity) / initialEquity;

  let peak = initialEquity;
  let maxDrawdown = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - p.equity) / peak);
  }

  const winRate = trades.length > 0 ? trades.filter(t => t.pnl > 0).length / trades.length : 0;

  // シャープレシオ（トレード単位のリターン列を年率化する簡易版。TODO参照）
  let sharpeRatio = 0;
  if (trades.length >= 2) {
    const returns = trades.map(t => t.directionalReturn * t.positionSizeRatio);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const std = Math.sqrt(variance);
    const spanMs = trades[trades.length - 1].exitTime - trades[0].entryTime;
    const spanDays = spanMs / (24 * 60 * 60 * 1000);
    const periodsPerYear = spanDays > 0 ? trades.length / (spanDays / 365) : 0;
    sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(periodsPerYear) : 0;
  }

  return {
    trades, equityCurve, finalEquity, totalReturn, maxDrawdown, sharpeRatio, winRate,
    haltedByDrawdown, skippedByCircuitBreaker,
  };
}
