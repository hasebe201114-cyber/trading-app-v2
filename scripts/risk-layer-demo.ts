/**
 * ⑤リスク管理層の配線確認デモ。
 * 実行: node --experimental-strip-types scripts/risk-layer-demo.ts
 */
import { calculatePositionSize } from '../src/risk-layer/positionSizing.ts';
import { evaluateCircuitBreaker } from '../src/risk-layer/circuitBreaker.ts';
import type { EquityPoint } from '../src/risk-layer/types.ts';

console.log('=== ポジションサイジング（Kelly基準） ===\n');
const sizingScenarios = [
  { label: '確信度50%(最低ライン、Kelly=0)', confidence: 50, sizeMultiplier: 1 },
  { label: '確信度65%(通常)', confidence: 65, sizeMultiplier: 1 },
  { label: '確信度80%(高確信度)', confidence: 80, sizeMultiplier: 1 },
  { label: '確信度80%+④のsizeMultiplier=0.5(高ボラ縮小)', confidence: 80, sizeMultiplier: 0.5 },
  { label: '確信度95%(極端に高い、上限キャップ期待)', confidence: 95, sizeMultiplier: 1 },
  { label: '確信度40%(最低ライン未満、見送り期待)', confidence: 40, sizeMultiplier: 1 },
];

for (const s of sizingScenarios) {
  const result = calculatePositionSize({ accountEquity: 1_000_000, confidence: s.confidence, sizeMultiplier: s.sizeMultiplier });
  console.log(`--- ${s.label} ---`);
  console.log(`  positionSizeRatio=${(result.positionSizeRatio * 100).toFixed(1)}%, amount=${result.positionSizeAmount.toFixed(0)}円, capped=${result.capped}`);
  console.log(`  ${result.rationale.join(' / ')}\n`);
}

console.log('=== サーキットブレーカー ===\n');

const now = Date.now();
const day = 24 * 60 * 60 * 1000;

const normalCurve: EquityPoint[] = [
  { timestamp: now - 3 * day, equity: 1_000_000 },
  { timestamp: now - 2 * day, equity: 1_020_000 },
  { timestamp: now - 1 * day, equity: 1_010_000 },
  { timestamp: now, equity: 1_005_000 },
];

const bigDrawdownCurve: EquityPoint[] = [
  { timestamp: now - 3 * day, equity: 1_000_000 },
  { timestamp: now - 2 * day, equity: 1_200_000 }, // ピーク
  { timestamp: now - 1 * day, equity: 1_050_000 },
  { timestamp: now, equity: 1_000_000 }, // ピークから16.7%下落
];

const dailyLossCurve: EquityPoint[] = [
  { timestamp: now - day, equity: 1_000_000 },
  { timestamp: startOfDay(now), equity: 1_000_000 }, // 当日始値
  { timestamp: now, equity: 940_000 }, // 当日-6%
];

function startOfDay(ts: number): number {
  return Math.floor(ts / day) * day;
}

for (const [label, curve] of [
  ['通常の値動き（正常）', normalCurve],
  ['ピークから16.7%下落（最大DD上限15%超過、全面停止期待）', bigDrawdownCurve],
  ['当日-6%（日次損失上限5%超過、新規停止期待）', dailyLossCurve],
] as const) {
  const status = evaluateCircuitBreaker(curve);
  console.log(`--- ${label} ---`);
  console.log(`  halted=${status.halted}, currentDrawdown=${(status.currentDrawdown * 100).toFixed(1)}%, dailyLoss=${(status.dailyLoss * 100).toFixed(1)}%`);
  if (status.reason) console.log(`  理由: ${status.reason}`);
  console.log();
}
