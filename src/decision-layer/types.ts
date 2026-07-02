import type { Direction } from '../pattern-engine/predict.ts';

export type SignalAction = 'enter' | 'skip' | 'reduce';

export interface FinalSignal {
  direction: Direction;
  strength: number;
  /** ②③を合成した最終確信度 0-100 */
  confidence: number;
  action: SignalAction;
  /** ②のベースポジションサイズに対する倍率（0=見送り, 1=通常サイズ） */
  sizeMultiplier: number;
  /** 判断根拠（トレーサビリティ確保のため、適用したルールを列挙） */
  rationale: string[];
}
