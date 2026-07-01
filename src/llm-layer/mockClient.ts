/**
 * ③LLM特徴量抽出層 — オフラインテスト用スタブ
 *
 * ANTHROPIC_API_KEY が無い環境（このサンドボックス含む）で配線を検証するための
 * 決定論的な簡易ルールベース実装。実LLMの判断力を代替するものではなく、
 * 「入出力の型・ログ化の配線が正しく動くか」の確認専用。
 */
import type { MarketContextInput, MarketContextOutput, MarketContextLogEntry, RegimeLabel } from './types.ts';

const NEGATIVE_KEYWORDS = ['規制', '禁止', 'ban', 'hack', 'ハッキング', '暴落', 'crash'];
const POSITIVE_KEYWORDS = ['承認', 'approval', 'etf', '上昇', 'rally', '採用'];

function classifyRegime(volatility20d: number, return24h: number): RegimeLabel {
  if (volatility20d > 0.05) return 'high_volatility';
  if (return24h > 0.02) return 'trend_up';
  if (return24h < -0.02) return 'trend_down';
  return 'range';
}

export function mockAnalyzeMarketContext(input: MarketContextInput): MarketContextLogEntry {
  const allText = input.recentNews.join(' ').toLowerCase();
  const negativeHit = NEGATIVE_KEYWORDS.some(kw => allText.includes(kw.toLowerCase()));
  const positiveHit = POSITIVE_KEYWORDS.some(kw => allText.includes(kw.toLowerCase()));

  let eventImpactScore = 0;
  const anomalyFlags: string[] = [];
  if (negativeHit) { eventImpactScore -= 0.6; anomalyFlags.push('negative_news_keyword'); }
  if (positiveHit) { eventImpactScore += 0.6; anomalyFlags.push('positive_news_keyword'); }

  const output: MarketContextOutput = {
    eventImpactScore: Math.max(-1, Math.min(1, eventImpactScore)),
    eventImpactDurationHours: negativeHit || positiveHit ? 24 : 4,
    regimeLabel: classifyRegime(input.priceContext.volatility20d, input.priceContext.return24h),
    anomalyFlags,
    rationale: `[mock] キーワードマッチのみによる簡易判定（negative=${negativeHit}, positive=${positiveHit}）`,
    confidence: negativeHit || positiveHit ? 55 : 30,
  };

  return {
    timestamp: new Date().toISOString(),
    input,
    output,
    model: 'mock-keyword-v1',
    source: 'mock',
  };
}
