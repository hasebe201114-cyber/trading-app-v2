# C品質チーム — Day9中間監査レポート（EXP-OBS000032）

**実施日**: 2026-07-13  
**対象**: forward-interim-metrics.json / forward-paper-ledger-{btc,eth}.json / forward-f2-event-pairs-{btc,eth}.json  
**liveDays**: 9（2026-07-04〜2026-07-12）  
**監査種別**: 試験値中間監査（本番採否宣告ではない）

---

## 総合宣告

| 項目 | 宣告 |
|------|------|
| Day9データ完全性・整合性 | **採用可**（全9日完全・数値再現確認） |
| F1b False転落 | **試験値として許容・緊急アラート不要**（レジーム差相当・司令塔上申推奨） |
| F2 True復活 | **信頼できる（条件付き）**（プロキシ修正による正当復活・低funding交絡あり） |
| Actions失敗 | **データ影響なし**（冪等設計が吸収。CI衛生改善を推奨） |

> **注記**: liveDays=9（sufficientSampleFor90dGate=false）のため、これは試験値の中間確認であり90日ゲートの採否宣告ではない。

---

## チェックリスト（6項目）

### 1. 予測単位×パイプライン整合 — **合格**
- BTC live: F1a累積 +4.856bps（正）、margin_ratio 0.322〜0.350（MMR 0.005の64〜70倍バッファ）
- ETH live: F1a累積 +5.495bps（正）、margin_ratio 0.365〜0.401
- 清算・追証ゼロ。OBS000025型乖離（予測↔パイプライン不整合）は**検出されず**。

### 2. 非単調性（過最適） — **合格（F1b境界上昇は正常）**
- W=7・3倍・w*固定遵守。グリッド探索禁止守守。
- F1b下側境界の上昇（Day6: −0.23 → Day9: +1.24 bps）は**サンプル増加による単調収束であり過最適ではない**。block-bootstrap窓平均がliveDays増加とともにcalm平均へ集中→第10パーセンタイル上昇は仕様どおり。OBS000018型蜃気楼に**非該当**。

### 3. クロス資産再現 — **合格**
- F1a（正）・F3（清算0）・F4（basis≤T1）はBTC・ETH両方で成立。
- F1b未達も**両銘柄同方向**（BTC live 0.54 / ETH 0.61 bps）。OBS000019型片銘柄過学習は**検出されず**。

### 4. 統計的頑健性 — **薄いが仕様準拠（合格）**
- BTC live平均再現: (0.253+0.204−1.004+2.522+1.934+0.112−1.640+1.367+1.109)/9 = **0.5397 ≈ 0.5395** ✓
- ETH live平均再現: **0.6107 ≈ 0.6106** ✓
- F2再現: BTC 23/28=82.14% ✓、ETH 25/28=89.29% ✓
- n=9日・28ペアは**薄い**。現時点で採否判断できる統計的基盤は存在しない。

### 5. リーク/バイアス — **合格**
- anchor=today-1で当日部分足先読み排除。SMA_7はt−7..t−1のみ。
- mark_source全行"mark"（実mark値取得）。
- warmup 30日はphase=warmupでF1〜F4評価外に正しく除外。生存バイアスなし。

### 6. 基準逸脱 — **合格**
- F1〜F4閾値・参照値・w*・シグナルはすべてspec §4固定値どおり。事後緩和・HARKingは**検出されず**。

---

## 個別論点への定量回答

### F1b急落（True→False）— 正当・モデル欠陥ではない

**原因**: F1b境界 = calm日次系列（BTC 11.62bps平均）から作るライブ同一日数窓平均分布の第10パーセンタイル。liveDays増加→分布がcalm平均へ集中→境界が上昇するのは**仕様どおりの正常動作**。

**実態**: live BTC net平均 ≈ 0.54 bps/日 vs calm 11.62 bps/日 = **約10倍のfunding水準差**。低fundingレジームにおける正直な収穫であり、モデル欠陥ではない。

**⚠ 司令塔への論点**:
- liveのnet carryはFULL期間平均（BTC 1.586 / ETH 2.368 bps）をも下回っている（9日試験値）。
- warmup期間でSMA_7がゼロ近傍でwhipsawし反転コスト24bps×4回 = 累積−85bps（BTC）のドラッグが発生した。live期間は幸運にも反転ゼロだが**低fundingでのwhipsawリスクは潜在**。
- spec §5-3 / PJ000004#9の反転レッグ借入コスト（未計上）を計上すれば収益はさらに悪化。
- → **F1bは高funding強気相場以外では構造的に達成困難な基準**。Day90到達時に「基準の現実性」自体を司令塔で再検討する必要がある。**今から可視化すべき論点として先出し記録**。

### F2復活（null→28ペア）— 信頼できる（低funding交絡あり）

**復活理由**: commit `7b22f99 fix(forward): F2のBinance地理ブロックをCloud Functionsプロキシで解消`。run.log・meta `binanceFundingViaProxy:true` で確認。**データ捏造ではなくインフラ修正による正当な復活**。

**28 > 27（9日×3）の懸念**: 生ペアはBTC全28件が07-04T00〜07-13T00の範囲。07-04〜07-12の27イベント + **当日07-13T00の1イベント**。**warmup混入はゼロ**。懸念は**棄却**。

**⚠ 割引要因**: 多数のペアがノイズ床（0.5bps/8h）以下の低funding近ゼロ値。「コイン投げ縮退」で符号一致が水増しされている可能性。90日・ノイズ床超フィルタ後の一致率で再確認まで確定視しない。

### cumulative負（BTC −80.554/ETH −50.753）— 正しい理解

warmup最終日07-03の累積 + live累積 = 最終値と一致。負の主因は**warmup whipsaw（F1評価対象外）**。live専用 `cumulativeLivePnlBps`（BTC +4.86/ETH +5.50）がF1a評価対象。正しく分離されている。

### Actions連続失敗 — データ欠損なし

07-04〜07-12の9日データは連続完全（data_gap_flag全0）。07-09実行がnewRowsCount=4で07-05〜08を一括バックフィル。**anchor=today-1+Bitget90日履歴フェッチ設計の冪等性が実証された**。

---

## 実装チームへの差し戻し（軽微・ブロッキングなし）

1. **日次ledger `binance_funding_daily_bps` の07-05〜09 stale=0をf2-event-pairs実値で遡及整合**  
   F2ゲートにはevent-pairsファイルを使用するため影響なし。参考列の健全性のための修正。

2. **Actions push rejection（非fast-forward）のCI冪等化**  
   `.github/workflows/forward-calibration.yml` に `git pull --rebase` は実装済み。carry-executorとのstatus同期コミット競合の根本対処を推奨（専用ブランチ分離 or commitステップの条件制御）。

---

## 罠チェック結論

| トラップ | 結果 |
|----------|------|
| OBS000025型（予測↔パイプライン乖離） | **検出されず** |
| OBS000018型（境界値蜃気楼・非単調） | **検出されず**（F1b境界上昇はサンプル収束・正常） |
| OBS000019型（クロス資産過学習） | **検出されず**（BTC/ETH同方向） |
| **新規記録論点** | F1bは高funding calm以外で構造的に達成困難な可能性。Day90に「基準の現実性」を司令塔再検討 |

---

## 参照ファイル

- `research/EXP-OBS000032/10-result/forward/forward-interim-metrics.json`
- `research/EXP-OBS000032/10-result/forward/forward-paper-ledger-{btc,eth}.json`
- `research/EXP-OBS000032/10-result/forward/forward-f2-event-pairs-{btc,eth}.json`
- `research/EXP-OBS000032/10-result/forward/forward-meta.json`
- `research/EXP-OBS000032/00-spec-forward-calibration.md`
- `obs/trading_app/00プロジェクト方針/PJ000005-90日フォワード評価基準と対策方針.md`
