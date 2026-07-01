/**
 * Phase 1 PoC 動作確認スクリプト。
 * 実相場データではなく合成データで、パターン認識ロジック（feature抽出→k近傍探索→予測）の
 * 配線が正しく動作し、注入した規則性を検出できるかを確認する。
 *
 * 実行: node --experimental-strip-types scripts/poc-backtest.ts
 */
import { generateMomentumSyntheticSeries, generateRandomWalkSeries } from '../src/pattern-engine/syntheticData.ts';
import { walkForwardBacktest } from '../src/pattern-engine/backtest.ts';

const config = { horizon: 3, k: 15, testRatio: 0.5 };

console.log('=== モメンタム持続性を注入した系列（規則性あり） ===');
const momentumSeries = generateMomentumSyntheticSeries(1500, 42, 0.35);
const momentumResult = walkForwardBacktest(momentumSeries, config);
console.log(JSON.stringify(momentumResult, null, 2));

console.log('\n=== 純粋ランダムウォーク（規則性なし・比較対照） ===');
const randomSeries = generateRandomWalkSeries(1500, 7);
const randomResult = walkForwardBacktest(randomSeries, config);
console.log(JSON.stringify(randomResult, null, 2));

console.log('\n=== 判定 ===');
console.log(`モメンタム系列の方向的中率: ${(momentumResult.directionAccuracy * 100).toFixed(1)}% (目標55%以上)`);
console.log(`ランダム系列の方向的中率:   ${(randomResult.directionAccuracy * 100).toFixed(1)}% (50%前後が期待値)`);
if (momentumResult.directionAccuracy > randomResult.directionAccuracy + 0.03) {
  console.log('→ アルゴリズムは注入した規則性を検出できている（配線は正常）');
} else {
  console.log('→ 規則性を検出できていない可能性。ロジックの見直しが必要');
}
