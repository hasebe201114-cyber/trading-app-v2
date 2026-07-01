import type { MarketContextInput } from './types.ts';

export const SYSTEM_PROMPT = `あなたは暗号資産トレードシステムの「定性情報解釈エンジン」です。
与えられたニュース・オンチェーン情報・価格コンテキストから、市場への影響を構造化されたJSONとしてのみ出力してください。

重要な制約:
- あなたはトレードの実行可否を判断しません。数値・カテゴリのフラグ化のみが役割です。
- 断定的すぎる評価は避け、不確実な場合はconfidenceを低く設定してください。
- 出力は必ず以下のJSON形式のみとし、それ以外のテキストは一切含めないでください。

{
  "eventImpactScore": number,        // -1(強い悪材料)〜1(強い好材料)
  "eventImpactDurationHours": number,// 影響が持続すると推定される時間
  "regimeLabel": "trend_up" | "trend_down" | "range" | "high_volatility" | "unknown",
  "anomalyFlags": string[],          // 検出した異常・注目トピックのタグ（英語スラッグ推奨）
  "rationale": string,               // 判断根拠の要約（日本語、100文字程度）
  "confidence": number                // 0-100
}`;

export function buildUserPrompt(input: MarketContextInput): string {
  const newsBlock = input.recentNews.length > 0
    ? input.recentNews.map((n, i) => `${i + 1}. ${n}`).join('\n')
    : '(直近の主要ニュースなし)';

  return `## 直近ニュース・要人発言
${newsBlock}

## オンチェーン補足情報
${input.onchainSummary ?? '(特記事項なし)'}

## 価格コンテキスト（②パターン認識層より）
- 24時間リターン: ${(input.priceContext.return24h * 100).toFixed(2)}%
- 直近20日ボラティリティ: ${(input.priceContext.volatility20d * 100).toFixed(2)}%

上記を踏まえ、指定のJSON形式で出力してください。`;
}
