# 再検証書（F2ゲート修正・差し戻し対応版） - EXP-OBS000032

> 担当: 品質チーム（adversarial-reviewer / Red Team）＝独立再検証
> 対象コミット: `7bbd0fb`「F2ゲート粒度修正のスコープバグを修正」
> 前提: 前回監査 `20-audit-forward-calibration.md` C-1（F2粒度整合＋イベント単位の全90日永続化）を必須是正として差し戻した件への対応再検証。
> 裏取り方法: コード読解（`scripts/bitget-carry-forward-paper.ts`）＋ `npx tsc --noEmit`（型チェック）＋ spec §4-F2/§3-1 逐条比較。E2E実行はサンドボックスegress未許可のため未実施（生データ存在確認は日次実行環境に委ねる）。

## 総合判定

- [ ] 採用可
- [x] **差し戻し（実装チーム B / 設計チーム A へ）**
- [ ] 保留（実行確認待ち）

**理由（一文）**: TS スコープバグ（バグ1・2）は正しく解消されたが、**コミットの主目的であるバグ3「F2の8hイベント単位・全ペアの永続化」が実際には達成されておらず、日次実行のたびに直近フェッチ窓（append≈8日／noop＝1日）で `forward-f2-event-pairs-{asset}.{csv,json}` が上書き truncate され、ライブ全90日のイベントペアが失われる**。これは差し戻しの直接原因だった前回監査C-1の**根本（全90日窓の非永続化）が未解決**であり、コミットメッセージの主張「go-live以降を毎回全量再構築」はコードのフェッチ窓ロジックと矛盾する。

---

## チェックリスト（検証ポイント別・明示的合否）

| # | 検証ポイント | 合否 | 根拠 |
|---|---|---|---|
| 1 | 型安全性（`eventPairsRecent` スコープ解決・strict） | ✅ **合格** | `npx tsc --noEmit` = EXIT 0。`computeInterimMetricsForAsset`（L572）・`computeCheckpoints`（L650）ともに `eventPairsRecent: F2EventPair[]` を引数化。`F2EventPair` 型（L695-701）新設。未定義変数参照（TS2304）は解消。 |
| 2 | パラメータ渡し（呼び出しで正しく渡すか） | ✅ **合格** | `main()` L929 `computeInterimMetricsForAsset(..., r.eventPairsRecent)`、L930 `computeCheckpoints(..., r.eventPairsRecent)`。`AssetProcessResult.eventPairsRecent`（L756）は `processAsset` L840/L800 で `pairEventsForSignCheck(...)` 生成値を格納。呼び出し経路は一貫。 |
| 3 | spec §4整合（F2ゲートが「8hイベント単位・全ペア」に合致） | ❌ **不合格（差し戻し理由）** | 下記「1.」で詳述。**永続化ファイルは直近フェッチ窓のみで毎回上書き**され、ライブ≥90日の全ペアを保持しない。spec §4-F2「ライブ≥90日の Bitget/Binance 8hイベント符号一致率」を90日到達時に算出できない。 |
| 4 | Ledgerスキーマ分離（日次ledgerとイベントペアledgerの意図的分離） | ⚠ **合格（意図・文書化は妥当。ただし#3の欠陥により実効性なし）** | 日次ledger（spec §3-1・1行=1UTC日）の `f2_pair_sign_match` を「日次合算の参考値・F2ゲート非使用」と明記（L323-327・L426-428）、`forward-meta.json` の `ledgerGranularityNote`（L916）で粒度の使い分けを明記。分離設計自体は spec §3-1（会計）と §4-F2（8hイベント）の粒度差を正しく反映しており妥当。ただし分離先ファイルが#3の欠陥で機能しない。 |

---

## 1. 差し戻し核心：永続化ファイルが「直近フェッチ窓のみ」で上書きされ、全90日を保持しない

### 1-1. 事実（コード上の経路）

1. **書き込みは全上書き・マージなし・既存再読込なし**
   - `writeF2EventPairs`（L740-744）は `writeFileSync` で CSV/JSON を**丸ごと上書き**。既存 `forward-f2-event-pairs-*` を `readFileSync` する箇所は存在しない（grep 確認：当該ファイルは write のみ、read 0件）。
   - `main()` L929-930 のループはモードに関わらず毎回 `writeF2EventPairs(assetLower, r.eventPairsRecent)` を実行。

2. **`eventPairsRecent` は「直近フェッチ窓」のイベントしか含まない**
   - `eventPairsRecent = pairEventsForSignCheck(marketData.fundingBitgetEvents, marketData.fundingBinanceEvents, liveStartDate)`（L840・L800）。
   - `pairEventsForSignCheck` は `e.date >= liveStartDate` でフィルタするが、**フィルタ元の `marketData.funding*Events` 自体がフェッチ窓 `[windowStart, windowEnd]` の分しか存在しない**：
     - Bitget: `fetchBitgetFundingHistoryUntil(symbol, windowStartKey)`（L266）は `windowStart` まで遡って終了。
     - Binance: `binanceStartMs = keyToDate(windowStartKey).getTime()`（L268）＝ `windowStart` 始点。
   - `windowStart` の値：
     - **append モード（定常運用）**: `windowStart = addDays(datesToProcess[0], -SMA_WINDOW - 1)` = 前回最終日+1 − 8 ≈ **直近約8日**（L791）。
     - **noop モード（同日再実行）**: `windowStart = anchor`（L786）＝ **1日**。
     - initial モードのみ warmup 起点まで遡るが、go-live 当日は1日分。

3. **帰結**: 定常運用の各日次実行で、`forward-f2-event-pairs-{asset}` は**直近約8日（noop時は1日）のペアだけで上書き**される。ライブ15日目以降、それより前のライブ日のイベントペアは**毎回のフェッチ窓から外れ、ファイルからも恒久的に消える**。day90到達時、当該ファイルには約8日分（直前実行がnoopなら1日分）しか残らず、**spec §4-F2 の「ライブ≥90日 符号一致率」を算出する母集団が存在しない**。

4. **暫定メトリクスも直近窓のみ**: `computeInterimMetricsForAsset` の F2（`eventSignAgreementPct`, `f2_gte80pct`, L599-609）は `eventPairsRecent`（＝直近窓）を母集団に計算する。変数名 `eventPairsRecent`（recent）自体が全ライブ窓でないことを示している。

### 1-2. コミットの主張との矛盾

コミットメッセージおよびコード注記（L688-691）は「**8hイベント単位・全ペア・go-live以降を毎回全量再構築**（Bitget history-fund-rate が liveStartDate 以降を再取得可能な限り）」と主張する。しかし実際のフェッチ窓は `windowStart`（append≈8日／noop＝1日）であって `liveStartDate` ではない。`maxPages=10`（≈333日）で Bitget funding は90日超遡及可能なため技術的には liveStart まで取れるはずだが、**append/noop の `windowStart` 設計が liveStart まで遡らない**ため、主張は実装で裏付けられていない。

### 1-3. これは前回C-1の未解決＋悪化

前回監査C-1の指摘は2点：(a) F2ゲート指標をイベント単位に、(b) **日次のイベント単位ペアをledgerに永続化し、90日窓の再構築を単発フェッチに依存させない**。
- (a) は達成（F2ゲートは `eventPairsRecent`＝イベント単位を参照するようになった）。
- (b) は**未達**。新規ファイルを追加したが「都度上書き」設計のため、C-1が危険視した「ライブ全90日のイベント単位一致はどこにも永続化されない」状態が**そのまま残存**する。むしろ、ファイルが存在することで「永続化された」と誤認させるぶん、偽陽性リスクとしては悪化しうる。

---

## 2. 罠チェック（本プロジェクト既往罠に照らして）

- **F2蜃気楼（偽陽性経路）**: 該当。day90でF2を評価する際、母集団が直近≈8日（またはnoopなら1日）に縮退。少数サンプルで一致率が偶然80%を跨げば「F2回復」を偽って通す経路になる。これはプロジェクトが繰り返した偽陽性の型（ERゲート蜃気楼・Funding方向性版）と同種。**この一点で差し戻し相当。**
- 会計中核（F1/F3/F4）: 本コミットは会計・日次ledgerに変更なし。前回監査で採用可とした部分は毀損していない（日次蓄積の継続自体は無害）。

---

## 3. 差し戻し指摘（B実装チーム／必要ならA設計チーム宛て）

**必須是正（day90 F2正式判定より十分前・できれば次実行前）**: `forward-f2-event-pairs-{asset}` が**ライブ全期間（go-live〜anchor）の8hイベント全ペアを保持**するようにする。いずれかを実装：

- **推奨(a) 増分マージ方式**: `writeF2EventPairs` の前に既存ファイルを読み込み、新規ペアを `event_hour_utc` でユニーク結合（重複排除）してから書き出す。単発フェッチの遡及可能性に依存せず、前回監査C-1(b)の趣旨に合致。
- (b) フェッチ窓拡張方式: F2ペア生成に限り funding フェッチ窓を `liveStartDate` 起点にする。ただし Bitget無料funding≈90日枯渇（Stage0/OBS000030実測）で day90 近辺は綱渡り。(a)より脆弱。

**併せて確認すべき点**:
- 是正後、`computeInterimMetricsForAsset` の F2 が**全ライブ窓ペア**を母集団に一致率を計算すること（現状は直近窓 `eventPairsRecent` を参照）。変数名も実体に合わせる（`eventPairsAllLive` 等）と誤読が減る。
- noop モードでも既存ファイルを truncate しないこと（現状 noop でも `writeF2EventPairs` が1日窓で上書きする）。
- **完了報告前に、複数日ぶんを模した連続実行（またはfixture）で `forward-f2-event-pairs-*` の行数がライブ日数に応じて単調増加し、過去日が消えないことを自分で確認**（030/031の「自己確認せず完了報告」癖の再発防止）。

---

## 4. 判定と申し送り

**差し戻し。** 型スコープバグ（バグ1・2）の修正は正しいが、**コミット7bbd0fbの主目的だったバグ3（F2の8hイベント単位・全ペア永続化）は達成されていない**。永続化ファイルは直近フェッチ窓で毎回上書きされ、ライブ全90日のイベントペアを保持しない＝spec §4-F2 を day90 で満たせず、少数サンプルでF2偽陽性を通す経路になる。

- **日次会計・ledger蓄積の継続は妨げない**（F1/F3/F4は無害）。差し戻しは F2 永続化ロジックに限定した実装是正要求であり、既存の日次運用そのものの停止要求ではない。
- 本再検証はコード読解＋型チェックに基づく。是正後は**連続日次実行での `forward-f2-event-pairs-*` 行数単調増加・過去日非消失**の実挙動確認（保留→採用可の条件）を要する。
- 本番反映の可否は依然範囲外＝F1〜F4両銘柄合格（ライブ≥90日・**修正後の正しいF2母集団で**）＋C較正監査（正式）＋司令塔最終GOの3点必須。

---

## 変更履歴
- 2026-07-08: 初版（C品質チーム・独立再検証）。コミット7bbd0fbのF2スコープバグ修正を再検証。型安全性（tsc EXIT0）・パラメータ渡し・スキーマ分離の文書化は合格。ただし**バグ3（8hイベント全ペア永続化）が未達**＝`writeF2EventPairs` が直近フェッチ窓（append≈8日/noop=1日）で毎回上書きしライブ全90日を保持しない、コミット主張「go-live以降を全量再構築」がフェッチ窓ロジック（`windowStart`≠`liveStartDate`）と矛盾、前回監査C-1(b)の根本未解決を検出し**差し戻し**。是正案＝(a)増分マージ推奨/(b)フェッチ窓liveStart起点、＋連続実行での行数単調増加の自己確認を要求。
</content>
</invoke>
