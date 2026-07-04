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
import { predictFromNeighborReturns, type Prediction } from '../pattern-engine/predict.ts';
import { mockAnalyzeMarketContext } from '../llm-layer/mockClient.ts';
import { combineSignals } from '../decision-layer/combineSignals.ts';
import { calculatePositionSize } from '../risk-layer/positionSizing.ts';
import { evaluateCircuitBreaker } from '../risk-layer/circuitBreaker.ts';
import { DEFAULT_RISK_LIMITS, type EquityPoint, type RiskLimits } from '../risk-layer/types.ts';
import { simulateRoundTripExecution } from '../execution-layer/executeOrder.ts';
import { DEFAULT_EXECUTION_COST, type ExecutionCostModel } from '../execution-layer/types.ts';
import type { PipelineConfig, PipelineResult, TradeRecord } from './types.ts';

const pctChange = (from: number, to: number): number => (to - from) / from;
const EFFICIENCY_RATIO_INDEX = 9; // features.ts FEATURE_NAMES: efficiencyRatio20
const RSI_INDEX = 7; // features.ts FEATURE_NAMES: rsi14
const NEUTRAL_THRESHOLD = 0.0005;
const Z_NEUTRAL = 0.10; // OBS000028: モメンタム合成・R-zsumの neutral判定閾値
const MEAN_REVERSION_CONFIDENCE = 55; // OBS000025: RSI逆張りの暫定固定確信度
const MOMENTUM_CONFIDENCE = 60; // OBS000020: k-NNの近傍合意率に相当する概念がないため固定値を用いる（confidenceScale未指定時のフォールバック）
const MIN_MOMENTUM_CONFIDENCE = 50; // risk-layerのminConfidenceToEnter(50)と整合させる下限
const MAX_MOMENTUM_CONFIDENCE = 95;

/**
 * ②パターン認識層をモメンタムに置き換える場合の予測（OBS000020/OBS000024）。
 * confidenceScale指定時は、モメンタムの強さをその期間のボラティリティで正規化した
 * z値（＝ランダムウォーク仮定下でのその値動きの標準偏差換算の大きさ）に基づき
 * 確信度を動的に算出する（強いトレンドほどKellyサイジングを積み増す）。
 * 未指定時は固定値60（OBS000020/023で検証した挙動と完全互換）。
 */
function predictFromMomentum(
  candles: OHLCV[],
  currentCandleIndex: number,
  lookback: number,
  volatility20: number,
  confidenceScale?: number,
): Prediction {
  if (currentCandleIndex - lookback < 0) return { direction: 'neutral', strength: 0, confidence: 0, neighborCount: 0 };
  const momRet = pctChange(candles[currentCandleIndex - lookback].close, candles[currentCandleIndex].close);
  const direction = momRet > NEUTRAL_THRESHOLD ? 'up' : momRet < -NEUTRAL_THRESHOLD ? 'down' : 'neutral';

  let confidence = MOMENTUM_CONFIDENCE;
  if (confidenceScale !== undefined && volatility20 > 0) {
    const expectedMoveStd = volatility20 * Math.sqrt(lookback); // ランダムウォーク仮定下のlookback日リターンの標準偏差
    const z = Math.abs(momRet) / expectedMoveStd;
    confidence = Math.min(MAX_MOMENTUM_CONFIDENCE, Math.max(MIN_MOMENTUM_CONFIDENCE, 50 + confidenceScale * z));
  }

  return { direction, strength: Math.abs(momRet), confidence, neighborCount: 1 };
}

/**
 * 複数ホライズンのモメンタム合成（OBS000028）。
 * ルール'vote'（符号多数決）または'zsum'（符号付きz和）で方向を決定。
 * 等加重固定、confidenceScale=30固定、Z_NEUTRAL=0.10固定。
 */
function predictFromMomentumComposite(
  candles: OHLCV[],
  currentCandleIndex: number,
  lookbackSet: number[],
  rule: 'vote' | 'zsum',
  volatility20: number,
  confidenceScale: number,
): Prediction {
  if (lookbackSet.length === 0 || !lookbackSet.every(L => currentCandleIndex - L >= 0)) {
    return { direction: 'neutral', strength: 0, confidence: 0, neighborCount: 0 };
  }

  const currentClose = candles[currentCandleIndex].close;
  const momRets = lookbackSet.map(L => pctChange(candles[currentCandleIndex - L].close, currentClose));
  const zValues = lookbackSet.map((L, idx) => {
    const expectedMoveStd = volatility20 * Math.sqrt(L);
    return expectedMoveStd > 0 ? momRets[idx] / expectedMoveStd : 0;
  });

  let direction: 'up' | 'down' | 'neutral';
  let confidence = MIN_MOMENTUM_CONFIDENCE;

  if (rule === 'vote') {
    // R-vote: 符号多数決
    const signs = momRets.map(r => (r > NEUTRAL_THRESHOLD ? 1 : r < -NEUTRAL_THRESHOLD ? -1 : 0));
    const V = signs.reduce((a, b) => a + b, 0 as number);
    direction = V > 0 ? 'up' : V < 0 ? 'down' : 'neutral';

    if (direction !== 'neutral') {
      // zbarを計算：多数派方向の z値 の平均
      const majoritySign = direction === 'up' ? 1 : -1;
      const majorityZs = signs
        .map((s, i) => (s === majoritySign ? zValues[i] : null))
        .filter((z): z is number => z !== null);
      const zbar = majorityZs.length > 0 ? majorityZs.reduce((a, b) => a + b, 0) / majorityZs.length : 0;
      confidence = Math.min(
        MAX_MOMENTUM_CONFIDENCE,
        Math.max(MIN_MOMENTUM_CONFIDENCE, 50 + confidenceScale * (Math.abs(V) / lookbackSet.length) * zbar),
      );
    }
  } else {
    // R-zsum: 符号付きz和の平均
    const composite = zValues.reduce((a, b) => a + b, 0) / zValues.length;
    direction = composite > Z_NEUTRAL ? 'up' : composite < -Z_NEUTRAL ? 'down' : 'neutral';

    if (direction !== 'neutral') {
      confidence = Math.min(
        MAX_MOMENTUM_CONFIDENCE,
        Math.max(MIN_MOMENTUM_CONFIDENCE, 50 + confidenceScale * Math.abs(composite)),
      );
    }
  }

  return {
    direction,
    strength: Math.max(...momRets.map(Math.abs)),
    confidence,
    neighborCount: lookbackSet.length,
  };
}

/** 低ER(レンジ)局面向けの平均回帰予測（OBS000025）: RSI14が極値のときだけ逆張りする */
function predictFromMeanReversion(rsi14: number): Prediction {
  const direction = rsi14 < 30 ? 'up' : rsi14 > 70 ? 'down' : 'neutral';
  return { direction, strength: Math.abs(rsi14 - 50) / 50, confidence: MEAN_REVERSION_CONFIDENCE, neighborCount: 1 };
}

function median(sortedInput: number[]): number {
  if (sortedInput.length === 0) return 0;
  const s = [...sortedInput].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function simulatePortfolio(
  candles: OHLCV[],
  config: PipelineConfig,
  riskLimits: RiskLimits = DEFAULT_RISK_LIMITS,
  executionCost: ExecutionCostModel = DEFAULT_EXECUTION_COST,
): PipelineResult {
  const { horizon, k, testRatio, testEndFraction = 1, initialEquity, marketContextForDay, minEfficiencyRatio, adaptiveErGateWarmup, momentumLookback, momentumConfidenceScale, regimeSwitchErGateWarmup, momentumLookbackSet, momentumCompositeRule } = config;
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
  const pastErValues: number[] = []; // 適応的ERゲート用：過去に評価した局面の効率比（先読み防止のため現局面は含めない）

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

    // ② パターン認識層（momentumLookbackSet指定時は合成、momentumLookback指定時は単一モメンタム、いずれもなければk-NN。OBS000020/OBS000028）
    let patternPrediction: Prediction;
    if (momentumLookbackSet !== undefined && momentumCompositeRule !== undefined) {
      patternPrediction = predictFromMomentumComposite(candles, currentCandleIndex, momentumLookbackSet, momentumCompositeRule, rawVectors[t][5], momentumConfidenceScale ?? 30);
    } else if (momentumLookback !== undefined) {
      patternPrediction = predictFromMomentum(candles, currentCandleIndex, momentumLookback, rawVectors[t][5], momentumConfidenceScale);
    } else {
      const targetVector = normalizedAll[t];
      const candidates = validIndices
        .map((idx, pos) => ({ index: idx, vector: normalizedAll[pos] }))
        .filter(c => c.index + horizon <= currentCandleIndex);
      if (candidates.length < k) continue;

      const neighbors = findNearestNeighbors(targetVector, candidates, k);
      const forwardReturns = neighbors.map(nb => pctChange(candles[nb.index].close, candles[nb.index + horizon].close));
      patternPrediction = predictFromNeighborReturns(forwardReturns);
    }

    // ②レジームゲート／スイッチ（OBS000018/OBS000025）: 効率比が低い＝レンジ局面では
    // ②(モメンタム/k-NN)のエッジが消えるため、見送る(ゲート)か平均回帰に切り替える(スイッチ)
    const efficiencyRatio = rawVectors[t][EFFICIENCY_RATIO_INDEX];
    if (regimeSwitchErGateWarmup !== undefined && momentumLookback !== undefined) {
      // レジームスイッチ方式（OBS000025）: 低ER局面ではモメンタムの代わりにRSI逆張りを使う
      const gatePassed = pastErValues.length >= regimeSwitchErGateWarmup && efficiencyRatio >= median(pastErValues);
      pastErValues.push(efficiencyRatio);
      if (!gatePassed) {
        patternPrediction = predictFromMeanReversion(rawVectors[t][RSI_INDEX]);
      }
    } else if (adaptiveErGateWarmup !== undefined) {
      // 適応的中央値方式（推奨）: 過去の効率比の中央値を自己校正の閾値にする
      const gatePassed = pastErValues.length >= adaptiveErGateWarmup && efficiencyRatio >= median(pastErValues);
      pastErValues.push(efficiencyRatio); // 現局面は判定後に記録（先読み防止）
      if (!gatePassed) continue;
    } else if (minEfficiencyRatio !== undefined && efficiencyRatio < minEfficiencyRatio) {
      // 固定閾値方式（検証用・過最適傾向）
      continue;
    }
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
