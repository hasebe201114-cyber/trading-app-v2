/**
 * ③LLM特徴量抽出層 — 実LLM呼び出しクライアント
 *
 * 実行には ANTHROPIC_API_KEY（または ANTHROPIC_AUTH_TOKEN）環境変数が必要。
 * サーバーサイド専用（Cloud Functions・バッチスクリプト等）。ブラウザに鍵を露出させない。
 *
 * 構造化出力（output_config.format, json_schema）でスキーマ準拠のJSONを取得する。
 * スキーマで表現できない値域（-1〜1等）はコード側で検証・クランプする。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MarketContextInput, MarketContextOutput, MarketContextLogEntry, RegimeLabel } from './types.ts';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.ts';

// 構造化抽出タスクのため、低レイテンシ・低コストなモデルを既定とする（OBS000007の選定を踏襲）。
// 効果検証後にモデル格上げのA/Bを行う場合は環境変数 LLM_MODEL で上書きする。
const DEFAULT_MODEL = 'claude-haiku-4-5';

const REGIME_LABELS: RegimeLabel[] = ['trend_up', 'trend_down', 'range', 'high_volatility', 'unknown'];

/** 構造化出力用JSONスキーマ（structured outputs は additionalProperties: false と required 全指定が必須） */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    eventImpactScore: {
      type: 'number',
      description: 'ニュース・イベントのインパクト評価。-1(強い悪材料)〜+1(強い好材料)',
    },
    eventImpactDurationHours: {
      type: 'number',
      description: 'イベントの影響が持続すると推定される時間（時間単位）',
    },
    regimeLabel: { type: 'string', enum: REGIME_LABELS },
    anomalyFlags: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string', description: '判断根拠の要約（日本語、100文字程度）' },
    confidence: { type: 'number', description: 'LLM自身の判定確信度 0-100' },
  },
  required: [
    'eventImpactScore',
    'eventImpactDurationHours',
    'regimeLabel',
    'anomalyFlags',
    'rationale',
    'confidence',
  ],
  additionalProperties: false,
} as const;

function isValidOutput(value: unknown): value is MarketContextOutput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.eventImpactScore === 'number' &&
    typeof v.eventImpactDurationHours === 'number' &&
    typeof v.regimeLabel === 'string' &&
    REGIME_LABELS.includes(v.regimeLabel as RegimeLabel) &&
    Array.isArray(v.anomalyFlags) &&
    typeof v.rationale === 'string' &&
    typeof v.confidence === 'number'
  );
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** スキーマでは表現できない値域制約をコード側で正規化する */
function normalizeOutput(output: MarketContextOutput): MarketContextOutput {
  return {
    ...output,
    eventImpactScore: clamp(output.eventImpactScore, -1, 1),
    eventImpactDurationHours: Math.max(0, output.eventImpactDurationHours),
    confidence: clamp(output.confidence, 0, 100),
  };
}

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません（サーバーサイド専用の環境変数）');
  }
  cachedClient ??= new Anthropic();
  return cachedClient;
}

export function getConfiguredModel(): string {
  return process.env.LLM_MODEL || DEFAULT_MODEL;
}

export async function analyzeMarketContext(input: MarketContextInput): Promise<MarketContextLogEntry> {
  const client = getClient();
  const model = getConfiguredModel();

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: {
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('LLMがリクエストを拒否しました（stop_reason=refusal）');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('LLM応答がmax_tokensで途切れました');
  }

  const textBlock = response.content.find(block => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('LLM応答にテキストブロックが含まれていません');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error(`LLM応答のJSONパースに失敗しました: ${textBlock.text.slice(0, 200)}`);
  }

  if (!isValidOutput(parsed)) {
    throw new Error(`LLM応答のスキーマが不正です: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  return {
    timestamp: new Date().toISOString(),
    input,
    output: normalizeOutput(parsed),
    model,
    source: 'live',
  };
}
