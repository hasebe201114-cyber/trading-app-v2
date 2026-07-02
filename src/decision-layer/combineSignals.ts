/**
 * ④統合判断層 — ②パターン認識層の予測と③LLM特徴量層の出力を合成する
 *
 * PJ000001の設計方針: 初期はルールベース（veto方式）から始め、
 * 将来的にはこの統合ロジック自体もバックテストで検証・チューニングする。
 * 現時点ではルールの閾値は初期仮説であり、③の実データが揃い次第、
 * 統合後 vs ②単体の成績差分（PJ000001 4.1節KPI）で妥当性を検証すること。
 */
import type { Prediction } from '../pattern-engine/predict.ts';
import type { MarketContextOutput } from '../llm-layer/types.ts';
import type { FinalSignal, SignalAction } from './types.ts';

/** ③のイベント評価が②の予測方向と逆で、これ以上の強さなら見送り（重大逆行イベントveto） */
const VETO_EVENT_IMPACT_THRESHOLD = 0.5;
/** ③のイベント評価が②の予測方向と一致し、これ以上の強さなら確信度を加点 */
const CONFIRM_EVENT_IMPACT_THRESHOLD = 0.3;
const CONFIDENCE_BOOST = 10;
const HIGH_VOLATILITY_SIZE_MULTIPLIER = 0.5;

function eventDirectionSign(eventImpactScore: number): 1 | -1 | 0 {
  if (eventImpactScore > 0) return 1;
  if (eventImpactScore < 0) return -1;
  return 0;
}

function predictionDirectionSign(direction: Prediction['direction']): 1 | -1 | 0 {
  if (direction === 'up') return 1;
  if (direction === 'down') return -1;
  return 0;
}

export function combineSignals(pattern: Prediction, llmContext: MarketContextOutput): FinalSignal {
  const rationale: string[] = [];

  if (pattern.direction === 'neutral' || pattern.neighborCount === 0) {
    return {
      direction: 'neutral',
      strength: 0,
      confidence: 0,
      action: 'skip',
      sizeMultiplier: 0,
      rationale: ['②パターン認識層がneutralまたは近傍不足のため見送り'],
    };
  }

  let action: SignalAction = 'enter';
  let sizeMultiplier = 1;
  let confidence = pattern.confidence;

  const patternSign = predictionDirectionSign(pattern.direction);
  const eventSign = eventDirectionSign(llmContext.eventImpactScore);
  const eventMagnitude = Math.abs(llmContext.eventImpactScore);

  // ルール1: ③が②と逆方向の重大イベントを検知 → veto（見送り）
  if (eventSign !== 0 && eventSign !== patternSign && eventMagnitude >= VETO_EVENT_IMPACT_THRESHOLD) {
    action = 'skip';
    sizeMultiplier = 0;
    rationale.push(
      `③が②と逆方向の重大イベントを検知(eventImpactScore=${llmContext.eventImpactScore.toFixed(2)})のためveto`
    );
  }
  // ルール2: ③が②と同方向の重大イベントを検知 → 確信度を加点
  else if (eventSign !== 0 && eventSign === patternSign && eventMagnitude >= CONFIRM_EVENT_IMPACT_THRESHOLD) {
    confidence = Math.min(100, confidence + CONFIDENCE_BOOST);
    rationale.push(
      `③が②と同方向のイベントを検知(eventImpactScore=${llmContext.eventImpactScore.toFixed(2)})のため確信度+${CONFIDENCE_BOOST}`
    );
  } else {
    rationale.push('③から②の判定を覆す材料なし');
  }

  // ルール3: ③が高ボラティリティレジームと判定 → サイズ縮小（vetoされていなければ）
  if (action !== 'skip' && llmContext.regimeLabel === 'high_volatility') {
    sizeMultiplier *= HIGH_VOLATILITY_SIZE_MULTIPLIER;
    action = 'reduce';
    rationale.push(`③が高ボラティリティレジームと判定したためサイズを${HIGH_VOLATILITY_SIZE_MULTIPLIER}倍に縮小`);
  }

  return {
    direction: pattern.direction,
    strength: pattern.strength,
    confidence,
    action,
    sizeMultiplier,
    rationale,
  };
}
