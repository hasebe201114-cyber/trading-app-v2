/**
 * ③LLM特徴量抽出層 — 実LLM呼び出しクライアント
 *
 * 実行には ANTHROPIC_API_KEY 環境変数が必要（Cloud Functions等、サーバーサイドでのみ
 * 実行すること。ブラウザに鍵を露出させない）。未設定の場合は呼び出し時にエラーを投げる。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MarketContextInput, MarketContextOutput, MarketContextLogEntry } from './types.ts';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.ts';

// 構造化抽出タスクのため、低レイテンシ・低コストなモデルを使用する
const MODEL = 'claude-haiku-4-5-20251001';

function isValidOutput(value: unknown): value is MarketContextOutput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.eventImpactScore === 'number' &&
    typeof v.eventImpactDurationHours === 'number' &&
    typeof v.regimeLabel === 'string' &&
    ['trend_up', 'trend_down', 'range', 'high_volatility', 'unknown'].includes(v.regimeLabel as string) &&
    Array.isArray(v.anomalyFlags) &&
    typeof v.rationale === 'string' &&
    typeof v.confidence === 'number'
  );
}

export async function analyzeMarketContext(input: MarketContextInput): Promise<MarketContextLogEntry> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY が設定されていません（サーバーサイド専用の環境変数）');
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
  });

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
    output: parsed,
    model: MODEL,
    source: 'live',
  };
}
