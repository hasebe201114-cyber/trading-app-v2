/**
 * ④統合判断層の配線確認デモ。②の予測(Prediction)と③の出力(MarketContextOutput)の
 * 組み合わせパターンをいくつか用意し、combineSignalsの挙動を確認する。
 * 実行: node --experimental-strip-types scripts/decision-layer-demo.ts
 */
import type { Prediction } from '../src/pattern-engine/predict.ts';
import type { MarketContextOutput } from '../src/llm-layer/types.ts';
import { combineSignals } from '../src/decision-layer/combineSignals.ts';

const patternUp: Prediction = { direction: 'up', strength: 0.02, confidence: 65, neighborCount: 30 };
const patternDown: Prediction = { direction: 'down', strength: 0.018, confidence: 60, neighborCount: 30 };

const scenarios: { label: string; pattern: Prediction; llm: MarketContextOutput }[] = [
  {
    label: '②up + ③材料なし（通常ケース）',
    pattern: patternUp,
    llm: { eventImpactScore: 0, eventImpactDurationHours: 4, regimeLabel: 'range', anomalyFlags: [], rationale: '', confidence: 30 },
  },
  {
    label: '②up + ③同方向の好材料（確信度ブースト期待）',
    pattern: patternUp,
    llm: { eventImpactScore: 0.6, eventImpactDurationHours: 24, regimeLabel: 'trend_up', anomalyFlags: ['positive_news_keyword'], rationale: '', confidence: 55 },
  },
  {
    label: '②up + ③逆方向の重大悪材料（veto期待）',
    pattern: patternUp,
    llm: { eventImpactScore: -0.7, eventImpactDurationHours: 24, regimeLabel: 'trend_down', anomalyFlags: ['negative_news_keyword'], rationale: '', confidence: 55 },
  },
  {
    label: '②down + ③軽微な逆方向材料（veto閾値未満、無視される想定）',
    pattern: patternDown,
    llm: { eventImpactScore: 0.2, eventImpactDurationHours: 4, regimeLabel: 'range', anomalyFlags: [], rationale: '', confidence: 40 },
  },
  {
    label: '②up + ③高ボラティリティレジーム（サイズ縮小期待）',
    pattern: patternUp,
    llm: { eventImpactScore: 0, eventImpactDurationHours: 4, regimeLabel: 'high_volatility', anomalyFlags: [], rationale: '', confidence: 35 },
  },
];

console.log('=== ④統合判断層 配線確認 ===\n');
for (const { label, pattern, llm } of scenarios) {
  const result = combineSignals(pattern, llm);
  console.log(`--- ${label} ---`);
  console.log(`  action=${result.action}, direction=${result.direction}, confidence=${result.confidence.toFixed(1)}, sizeMultiplier=${result.sizeMultiplier}`);
  console.log(`  rationale: ${result.rationale.join(' / ')}`);
  console.log();
}
