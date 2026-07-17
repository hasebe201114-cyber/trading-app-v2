# 実験仕様書（Spec） - EXP-OBS000009

> 担当: 設計チーム（strategy-architect）
> 鉄則: **成功基準は「回す前」に数値で確定する**（HARKing防止）。結果を見てから基準を緩めない。

## 対応OBS番号
OBS000009（SYS-008 1a・確定満期先物ベーシス）

## 仮説（1文）
Binanceの確定満期先物（quarterly futures）のロールサイクル（≥8日）を通じて、基準物（spot BTC）とのベーシスが平均回帰的に推移し、roll timing最適化により系統的な利益機会を抽出できる。

## 成功 / 不採用の数値基準（回す前に確定）
- 採用条件: 
  - Pipeline Sharpe（確認期・複利リターンの日次√252） ≥ 1.0 **かつ**
  - 予測単位の permutation test p-value < 0.05 **かつ**
  - 実装コストを想定した後ネット正（実際のroll成約スプレッド・交換手数料を控除）
- 不採用条件: 上記を満たさない、または確認資産で再現しない

## 選定 / 確認プロトコル（過学習の炙り出し）
- 選定（探索）データ: Binance S3 quarterly futuresアーカイブ（BTC perpetual→quarter rollサイクル≥8日単位）
- 確認（未見）データ: 選定期と異なる quarter サイクル、または別資産（ETH等）
- 期待する再現条件: roll期間前後のベーシス凹凸パターンが消えない（構造的シグナル）

## 測定範囲
- 期間: Binance S3 quarterly futuresアーカイブ利用可能範囲（最短8日×複数rollサイクル）
- 資産: BTC/USDT（S3 quarterly）・必要に応じてETH等確認
- レジーム別分解: 要（ボラティリティ体制別のベーシス挙動分離）
- **予測単位 と パイプライン統合 の両方を測定する**（片方だけは禁止）

## ゲート・データ検証（A設計チーム昇格項目）
**G-データ＝最初・最強ゲート（stage 0 実行前に完全pass必須）**
- G1: Binance S3 futuresアーカイブの壁警告確認（データ可用性・欠損・ロール日時の正確性）
- G2: 恒等式ガード（2種）
  - ①Basis≡Future_Price−Spot_Price の数学的恒等式検証
  - ②Roll手続き前後での equityバランス一貫性（注文構成と実現p&l の照合）

## 使用スクリプト / 再現方法（想定）
- 新規スクリプト: `scripts/obs000009-stage0-futures-basis-probe.py`
- 実行想定: `python scripts/obs000009-stage0-futures-basis-probe.py --archive binance-s3-quarterly --asset BTC --window 8`
- データ入力: Binance S3 quarterly futuresアーカイブCSV（OHLCV + settlement ）

## 変更履歴
- 2026-07-17: 初版作成（A設計チーム）。SYS-008 1a軸足転換・司令塔GO。EXP-OBS000008（SYS-008 1b）の wBTC-BTC Stage 0 STOP・API制約保留を受けて、確定満期先物ベーシスへのシフト決定。
