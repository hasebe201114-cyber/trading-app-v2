# OBS000001 - btc-strategyからの再利用コンポーネント整備

## 変更履歴
- 2026-07-01: 起票・実装。btc-strategyの調査結果を基に、汎用性の高いコンポーネント・フック・ユーティリティを移植

## 関連ドキュメント
- [D001-開発計画.md](../../../../docs/D-開発者向けシステム仕様編/D001-開発計画.md) Phase 0 作業項目 0-1

## 内容
btc-strategy（`/home/user/btc-strategy`）のコードベースを調査し、特定のトレード戦略ロジックに依存しない汎用コンポーネントを移植した。

### 移植したファイル
- `src/shared/indicators.ts`: EMA/RSI/MACD/BB/Stochastic/ATR/フィボナッチ/サポレジ計算（フレームワーク非依存の純粋関数群、最重要）
- `src/ui/utils/formatters.ts`: 価格フォーマット（`getDaysTrend`は演出用のため除外）
- `src/ui/components/{HelpButton,InfoRow,MetricCard,SectionBox}.tsx`: 汎用UI部品
- `src/components/HelpModal.tsx`: 汎用モーダル
- `src/components/atoms/{ConfRing,Sparkline}.tsx`: 信頼度スコアリング表示・ミニグラフ（②パターン認識層の確度表示にそのまま活用予定）
- `src/hooks/{useWindowSize,useTouchSwipe,useFontSize}.ts`: レスポンシブ判定・スワイプ検知・文字サイズ設定

### 移植しなかったもの（参考にして作り直し／不要）
- APIクライアント層（binance.ts, bitget.ts, coinGecko.ts）: fetch/リトライのパターンのみ参考にし、返却型は独自設計する（Phase 1で着手）
- 戦略・分析ロジック（strategyEngine.ts, aiSignalEngine.ts, divergenceEngine.ts等）: PJ000001の②③④層として作り直す対象のため移植しない
- Firestoreスキーマ依存のユーティリティ: 別Firebaseプロジェクトのため作り直し必須

## ステータス
初回移植は完了。今後、②パターン認識層やAPIクライアント層の実装が進むにつれて追加移植が発生する見込み。
