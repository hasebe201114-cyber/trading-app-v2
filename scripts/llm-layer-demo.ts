/**
 * ③LLM特徴量抽出層の配線確認デモ。
 * ANTHROPIC_API_KEY が無い環境（このサンドボックス含む）では mockClient を使う。
 * 実行: node --experimental-strip-types scripts/llm-layer-demo.ts
 */
import { mockAnalyzeMarketContext } from '../src/llm-layer/mockClient.ts';
import type { MarketContextInput } from '../src/llm-layer/types.ts';

const scenarios: { label: string; input: MarketContextInput }[] = [
  {
    label: '規制強化ニュースあり',
    input: {
      recentNews: ['当局が暗号資産取引所への規制を強化する方針を発表', '大手取引所が対象国からの撤退を検討'],
      priceContext: { return24h: -0.03, volatility20d: 0.04 },
    },
  },
  {
    label: 'ETF承認ニュースあり',
    input: {
      recentNews: ['現物ビットコインETFが正式承認されたと報じられる'],
      priceContext: { return24h: 0.05, volatility20d: 0.03 },
    },
  },
  {
    label: '静かな相場（ニュースなし）',
    input: {
      recentNews: [],
      priceContext: { return24h: 0.001, volatility20d: 0.015 },
    },
  },
  {
    label: '高ボラティリティのみ（ニュースなし）',
    input: {
      recentNews: [],
      priceContext: { return24h: -0.01, volatility20d: 0.08 },
    },
  },
];

console.log('=== ③LLM特徴量抽出層 配線確認（mockClient使用） ===\n');
for (const { label, input } of scenarios) {
  const logEntry = mockAnalyzeMarketContext(input);
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(logEntry, null, 2));
  console.log();
}

console.log('注: 上記はキーワードマッチのみの簡易スタブによる結果。実LLM判断ではない。');
console.log('実LLM(client.ts)を使うには ANTHROPIC_API_KEY をサーバーサイド環境変数として設定すること。');
