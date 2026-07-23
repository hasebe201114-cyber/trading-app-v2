# EXP-OBS000038 引き継ぎ記録（crypto-strategy-lab → trading-app-v2）

> 系統: SYS-012（テール独立・危機コンベクシティ・オーバーレイ系 / 12a TSMOMオーバーレイ）
> 引き継ぎ元: crypto-strategy-lab EXP-OBS000014（Stage 0通過）
> 司令塔GO: 2026-07-22
> 担当: E進行チーム（archivist-pm）

## 位置づけ
単体で稼ぐ戦略ではない。VRP（SYS-001・EXP-OBS000037フォワード較正中）＋キャリー（EXP-OBS000032フォワード較正中）が危機で同時被弾する「共有テール」を打ち消す**第3スリーブ**。書物の結合テールCVaR・最大DDの低減が唯一の採用根拠。

## crypto-strategy-lab Stage 0 サマリ
| ゲート | 判定 | 備考 |
|--------|------|------|
| G-データ | ✅ | Binance S3 spot（BTC/ETH）＋実VRP週次系列 |
| G-tail（核心命題） | ✅ | stress窓ρ(VRP)=−0.331 / ρ(carry)=−0.238（両負・bootstrap頑健・OOS確認済） |
| G-timing | ✅/⚠ | slow下落は捕捉・速いV字gap（FTX/SVB）は非ヘッジ |
| G-drag | ✅ | 単体+5.1%/年・Sharpe0.51 |
| G-ensemble | ✗→Stage 1 | 改善7.7%/6.5%（閾値10%未達）。lab側カレーが基差MTM欠如の近似 |

**C品質チーム宣告: 採用可＝Stage 1条件付き申し送り**

## Stage 1 キルゲート（本系統の生死はここで決する）
1. 基差MTM＋清算損込み実カレーP&L再構成（OBS000032データ活用）
2. G-ensemble再判定: **最大DD改善≥10% かつ CVaR95改善≥10%**（満たさなければSTOP）
3. carry脚テール独立の再検証（bootstrap CIがゼロ跨ぎ・最大の残存リスク）
4. VRP帰属タイミング整合（OBS000037 vrp系列との最大1週オフセット確認）
5. timing弱点の織り込み（速いV字gapは別手段で補う設計検討）

## オーバーレイ仕様（事前登録・変更不可）
- ユニバース: BTC, ETH
- シグナル: TSMOM = mean_{L∈{30,60,90}} sign(P_t − P_{t-L}) ∈ [−1,+1]
- リバランス: 週次（金曜終値PIT）
- 執行コスト: 0.10%/片道
- 単体サイジング: vol-target年率10%（過去60営業日実現ボラ・shift済）
- 書物配分: 分散ベースリスク寄与15%（a≈0.4201）

## 参照
- 引き継ぎ元詳細: `crypto-strategy-lab/research/EXP-OBS000014/30-handoff-to-trading-app-v2.md`
- Stage 1 spec（作成予定）: `research/EXP-OBS000038/01-spec-stage1.md`

## 変更履歴
- 2026-07-22: 初版作成（E進行チーム）。EXP-OBS000038起票。
