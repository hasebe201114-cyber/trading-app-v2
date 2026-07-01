/**
 * ②パターン認識層 — 市場レジーム測定（統計的な簡易版）
 *
 * PJ000001の③LLM特徴量層が本来担う「市場レジーム分類（トレンド/レンジ）」を、
 * まず統計指標だけで先取りする。OBS000005で確認した「特定レジームでのみ効く」
 * 問題に対応するため、Kaufmanの効率比（Efficiency Ratio）を特徴量に加え、
 * 類似度探索が「似た値動きのレジーム」同士を優先的に比較するようにする。
 *
 * ER = |直近N期間の正味の値動き| / (直近N期間の値動きの絶対値の合計)
 * 1に近いほど一方向への強いトレンド、0に近いほどレンジ・往復相場。
 */

export function calculateEfficiencyRatio(closes: number[], period: number = 20): number {
  if (closes.length < period + 1) return 0.5; // データ不足時は中立値

  const window = closes.slice(-(period + 1));
  const netChange = Math.abs(window[window.length - 1] - window[0]);

  let sumAbsChange = 0;
  for (let i = 1; i < window.length; i++) {
    sumAbsChange += Math.abs(window[i] - window[i - 1]);
  }

  return sumAbsChange === 0 ? 0 : netChange / sumAbsChange;
}
