/**
 * ③LLM特徴量抽出層 — 型定義
 * PJ000001参照。LLMの出力は「数値・カテゴリのフラグ」に限定し、
 * そのままトレード可否を判断させない。②パターン認識層・④統合判断層の
 * 入力（特徴量・フィルタ）として使う。
 */

export interface MarketContextInput {
  /** 直近のニュース見出し・要人発言等（生テキスト、複数件） */
  recentNews: string[];
  /** オンチェーン異常などの補足情報（あれば） */
  onchainSummary?: string;
  /** ②パターン認識層側の直近の値動きサマリー（数値コンテキストとしてLLMに渡す） */
  priceContext: {
    return24h: number;
    volatility20d: number;
  };
}

export type RegimeLabel = 'trend_up' | 'trend_down' | 'range' | 'high_volatility' | 'unknown';

export interface MarketContextOutput {
  /** ニュース・イベントのインパクト評価。-1(強い悪材料)〜+1(強い好材料) */
  eventImpactScore: number;
  /** イベントの影響が持続すると推定される時間（時間単位） */
  eventImpactDurationHours: number;
  /** 市場レジーム分類（②の近傍探索の絞り込みに使う想定） */
  regimeLabel: RegimeLabel;
  /** 検出した異常・注目トピックのタグ */
  anomalyFlags: string[];
  /** 判断根拠の要約（トレーサビリティ確保のため必須） */
  rationale: string;
  /** LLM自身の判定確信度 0-100 */
  confidence: number;
}

/** ログ化のためのラッパー。入力・出力・メタ情報を1レコードとして保存する想定 */
export interface MarketContextLogEntry {
  timestamp: string;
  input: MarketContextInput;
  output: MarketContextOutput;
  model: string;
  /** 'live' = 実LLM呼び出し, 'mock' = オフラインテスト用スタブ */
  source: 'live' | 'mock';
}
