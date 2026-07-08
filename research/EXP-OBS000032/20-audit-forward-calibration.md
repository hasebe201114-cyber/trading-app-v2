# 監査書（Audit） - EXP-OBS000032 / フォワード較正ハーネス（Bitgetペーパートレード基盤の技術監査）

> 担当: 懐疑検証官（adversarial-reviewer / Red Team）＝**独立監査**
> 位置づけ: これは **F1〜F4の正式な採否判定ではない**（ライブ≥90日未達）。本監査は「今後90日間、`scripts/bitget-carry-forward-paper.ts` を日次で継続実行していく**基盤として実装が信頼できるか**」の技術監査。
> 裏取り方法: コード読解（forward vs `carry-liquidation-sim.ts` 会計逐条照合）＋ledger生値のBitget公開API独立再取得突き合わせ＋会計の手計算再現＋F1bブートストラップ参照系列の独立検算＋F4/F2参照算式の産出スクリプト（`fetch-binance-carry-data.ts`・`compare-bitget-binance-funding.ts`）読解。

## 総合判定

- [x] **採用可（技術基盤として信頼できる＝日次運用の開始を推薦）**
- [ ] 不採用
- [ ] 差し戻し

**ただし条件付き。** 会計中核（F1/F3/F4・データ整合・冪等性・ページング）は**信頼できる状態に到達**しており、**本日から日次蓄積を開始してよい**。一方で **F2の計測方式に統計的欠陥（後述C-1）** があり、これは日次蓄積を止める理由にはならないが、**ライブ90日到達後のF2正式判定より前に必ず是正する**こと（＋中間チェックポイントの軽微是正2件）。これらは「採用可」の一部としての必須申し送りであり、放置すればF2で偽陽性を通す経路になる。

---

## チェックリスト（各項目に明示的合否）

| # | チェック項目 | 合否 | 根拠 |
|---|---|---|---|
| 1 | 会計ロジックのStage1同一性（清算損二重計上排除・現物益連続計上・W=7シグナル適用） | ✅ **合格** | 下記「1.」で逐条照合。`processDay`（L349-468）は`carry-liquidation-sim.ts`の`runSimulation`（L195-268）と**式が一致**。二重計上排除（floor(0)一本会計・`actualPerpContribution`のみ計上・清算日は再構築コストのみ実控除）・現物益は前日比で毎日計上（清算で消えない）・W=7 SMA符号を`pos`化してmargin更新とdailyPnlの両方に適用。BTC 07-04を手計算再現し`daily_net_pnl_bps`＝0.2531を独立に再現（ledger 0.2530583）。 |
| 2 | Bitget実データの妥当性（生ログ突き合わせ） | ✅ **合格** | Bitget公開APIをC独立に叩き、**全記録値が完全一致**：funding 07-04=−0.64bps／07-03=2.06bps、spot 07-04=63145.07／07-03=62581.26、mark 07-04=63110.5／07-03=62554.8。markは`history-mark-candles`で**実mark取得成功**（`mark_source=mark`・last代用ではない＝Stage1バックテストのlast代用より改善・spec §2-3準拠）。 |
| 3 | 冪等性（同日2回実行で重複追記しない） | ✅ **合格** | `anchorDateKey=today−1`（部分足混入排除）を基準に、既存最終日≥anchorで`mode=noop`・追記0件（`forward-meta.json` runHistoryの2回目実行がnewRowsCount=0を実証）。append modeは`dateRange(lastDate+1, anchor)`で欠損日補完。**清算後のmargin繰越が正しい**＝ledgerの`margin_ratio`は清算日に**リセット前**の枯渇値を格納するが、append復元（L769）は`liquidation_flag===1?IMR:margin_ratio`の三項でIMR繰越を保証（この三項は必須かつ正しい）。 |
| 4 | F1〜F4判定式のspec整合 | ✅ **合格（式は正しい・値は暫定）** | F1a=ライブ累積>0（live行のみ集計・warmupの−85bpsは混入しない＝独立検算で確認）。F1b=block-bootstrap（ブロック7/N5000/seed20260705/第10%ile）。参照calm系列を独立検算し**calm平均がBTC11.6245/ETH14.3977で参照値と完全一致**（正しい系列を使用）。F3=live清算・追証件数0（live行のみ）。F4=RMS(\|Δbasis\|)・perp_last基準で、産出元`fetch-binance-carry-data.ts` L348-352の`daily_delta_std_bps`算式と**完全一致**（apples-to-apples）。 |
| 5 | 中間チェックポイントの実装 | ⚠ **合格（ただし軽微欠陥2件・C-2/C-3）** | 清算/追証即時・符号一致ローリング<70%・キャリー10日連続マイナス・basis T1超過・データ欠損2日連続を実装。ただしローリング符号に**最小サンプルガードなし**（day1に3ペアで66.7%<70%のスプリアスalert発火＝C-2）、キャリー持続マイナス判定が**warmup込み累積**を参照（C-3）。いずれも「より多く警告する保守側」で危険側ではないが是正推奨。 |
| 6 | リーク/バイアス・基準逸脱 | ✅ **合格** | W=7 SMAは`date−1..date−7`厳密過去参照（`computeSma7FundingBps` L340-342）＝先読みなし。warmup30日は`phase=warmup`でF1〜F4評価対象外（90日をback-fillで水増ししない＝spec §5-1厳守）。w*・MMR0.5%仮置き・コスト・seed全てspec固定値をハードコード（フォワード再算出なし）。B出力は判定語不使用・真偽値のみ（spec §9遵守）。 |

---

## 1. 会計ロジックのStage1同一性（逐条照合＋手計算再現）

`carry-liquidation-sim.ts`（方式I・バグF/G根治版）との式対応：

| 項目 | Stage1 (`runSimulation`) | forward (`processDay`) | 一致 |
|---|---|---|---|
| シグナル | `sign(Σ_{i-7..i-1} funding)`→`pos=signal===-1?-1:1` | `sign(SMA7)`→`pos=rawSignal===-1?-1:1`（符号は同一・meanとsumで不変） | ✅ |
| 現物レッグ | `pos·spotReturn·10000` | `pos·spotReturn·10000` | ✅ |
| perp MTM | `pos·(−perpReturn·10000)`（last） | `pos·(−perpMarkReturn·10000)`（**mark可用時mark**） | ✅（spec §2-3で改善） |
| funding | `pos·funding·10000` | `pos·fundingDailyBps` | ✅ |
| margin更新 | `floor(0, margin+perpMtm+funding)`・`actualContribution=floored−margin` | 同一（L399-402） | ✅ |
| dailyPnl | `spotLeg+actualContribution−反転−資本` | 同一（L405） | ✅ |
| 清算 | `margin<MMR·名目`→再構築コスト実控除・margin=IMR | 同一（L410-415） | ✅ |
| 資本コスト | `(0.04/L/365)·10000`=0.36530bps/日 | 同一（L360） | ✅ |
| 二重計上 | `discreteLoss`は参考記録のみ・dailyPnl非控除 | forwardは`discreteLoss`自体を持たず（さらに単純）＝二重計上の芽なし | ✅ |

**手計算再現（BTC live 2026-07-04）**: spotReturn=63145.07/62581.26−1=+90.093bps、perpMarkReturn=63110.5/62554.8−1=+88.834bps→perpLegMtm=−88.834bps、funding=−0.64bps、marginΔ=−89.474bps（floorに掛からず）、dailyPnl=90.093−89.474−0−0.36530=**+0.2531bps**（ledger 0.2530583・一致）。margin_ratio=0.33632（ledger一致）。清算なし（0.336≫0.005）。**会計は物理的に正しく再現。**

補足: warmup累積がBTC−85.16bps／ETH−55.35bpsと負なのは、choppyなfundingでSMA7符号反転が**BTC4回（06-12/06-20/06-21/06-23）・ETH2回**発生し反転コスト24bps×回数を計上したため＝バグでなくレジーム（この期間の高頻度符号反転）の反映。**warmupの負はF1（live累積）に一切混入しない**ことをコードとledger両面で確認（F1はlive行のみを新規に0から集計）。

---

## 2. 検出した論点（採用可の申し送り・是正順）

### C-1【要是正・F2正式判定前まで／MODERATE】F2ゲートの符号一致粒度がG0-2ベースラインと不整合＋イベント単位が永続化されない
- **事実**: G0-2ベースライン（BTC64.68%/ETH71.75%）と閾値80%は、`compare-bitget-binance-funding.ts` L147で**8hイベント単位**（`slice(0,13)`で時丸めペア化）で算出されている。一方forwardの**F2ゲート指標**（`computeInterimMetricsForAsset` f2）は**日次合算funding符号**の一致率を使う。日次合算は3イベントを平均してノイズ起因の符号反転を均すため、**イベント単位より一致率が高く出る（＝F2を甘くする側の偏り）**。80%閾値・64.68%ベースラインとの比較が apples-to-apples でない。
- **さらに**: イベント単位ペア化（`pairEventsForSignCheck`）は存在するが**中間チェックポイントのローリング30専用**で、F2ゲートには使われない。かつappend時は`windowStart`が直近≈8日しか遡らないため、**ライブ全90日のイベント単位一致はどこにも永続化されない**（ledgerに残るのは日次`f2_pair_sign_match`のみ）。Bitget無料fundingは≈90日で枯渇するため、day90に一括再取得での復元は綱渡り。
- **なぜ危険か**: F2は4ゲートの1つ。甘い粒度＋非永続化のまま90日判定に入ると、「F2回復」を偽って通す経路になる（本プロジェクトが繰り返した偽陽性の型）。
- **是正（A/B宛て・day90より十分前に）**: (a) F2ゲート指標をG0-2と同一のイベント単位で算出する（またはA設計官がF2の粒度を日次と明記し、ベースライン側もイベント→日次で再測して整合させる）。(b) 日次のイベント単位ペア数・一致数をledgerに永続化し、90日窓の再構築を単発フェッチに依存させない。
- **本日蓄積を止めない理由**: 生funding（Bitget/Binance）は日次で取得・記録されており、会計と他ゲートには無害。是正は最初の数日以内に入れれば90日判定に十分間に合う。

### C-2【要是正・軽微／MINOR】ローリング符号一致チェックポイントに最小サンプルガードがない
- day1に**3ペアで66.7%**を計算し「<70%」alertを発火（`forward-alerts.log`に2行既出）。90日運用でノイズalertを撒く。`signAgreementRolling30`を`pairsAvailable≥30`（または妥当な最小数）で初めて評価するようガードすること。危険側ではない（過剰警告）。

### C-3【要是正・軽微／MINOR】キャリー持続マイナス判定がwarmup込み累積を参照
- `computeCheckpoints`の`cumulativeNegative`は`rows[last].cumulative_net_pnl_bps`（warmupの−85bpsを含む全期間累積）を見る。warmupの負で長期間trivially trueになり、alertが実質「live10日連続マイナス」に縮退する。spec §6の趣旨（ライブ累積が負）に合わせ**live限定累積**を使うべき。保守側（過剰警告）だが意味論の逸脱。

### C-4【記録のみ・実害ほぼ無／NEGLIGIBLE】append復元のprevSignalがrawSignalでなくpos
- ledgerは`signal_pos`（=pos∈{−1,+1}、0を持たない）のみ保存。append時の反転検出はこれをprevSignalに使うため、**前日の真のrawSignalが厳密0（SMA=0）だった測度ゼロのケース**でのみ、run境界で反転コストを誤計上/取りこぼす可能性。実funding下でSMA=0はほぼ発生せず実害なし。厳密性のため`rawSignal`のledger保存を推奨。

---

## 3. 罠チェック（本プロジェクトの既往罠に照らして）
- **OBS000025型（予測単位×パイプライン乖離）**: 会計はStage1と同一戦略・同一シグナルで、F1（キャリー実現＝予測単位）とF3/F4（清算・basis＝パイプライン）を同一ledgerで並記＝乖離の芽なし。✅
- **OBS000018型（非単調＝蜃気楼）**: 本フェーズはパラメータ探索を一切しない（w*・W・レバ・MMR全固定ハードコード＝spec §0-3）。境界最良化の余地なし。✅
- **OBS000019型（クロス資産過学習）**: BTC/ETH独立ledger・両成立要件をコード（`overall_allFourBothAssets`が両資産flat）で担保。✅
- **030/031型（power0の無効検定）**: F1bのblock-bootstrapは平均を動かす健全実装（リサンプルの窓平均分布から第10%ile）＝shuffleでの平均不変バグではない。参照系列も正しい。✅
- **warmup水増し**: warmup30日はF1〜F4評価対象外・90日をback-fillで一括生成しない設計を確認。✅

---

## 4. 判定（監査グレード）

**採用可＝この実装は「今後90日、日次で継続実行していく技術基盤」として信頼できる。日次運用の開始を推薦する。** 会計の中核（Stage1同一性・二重計上排除・現物益連続計上・W=7適用）、Bitget実データ整合、冪等性、F1/F3/F4判定式、リーク非該当を独立に裏取りし、偽陽性として棄却すべき技術的欠陥は**中核には検出されなかった**。Sonnetモデル実装は前段Stage1に続き非物理バグを混入させていない。

**ただし本採用可は以下を必須申し送りとする（放置＝F2偽陽性経路）:**
1. **C-1（F2粒度整合＋イベント単位永続化）をライブ90日到達より十分前に是正**。これはF2正式判定のブロッキング条件（日次蓄積のブロッキングではない）。
2. C-2・C-3（チェックポイントの最小サンプルガード／live限定累積）を是正。
3. C-4は記録のみ（実害ほぼ無）。

**本番反映の可否は依然として本監査の範囲外**＝F1〜F4両銘柄合格（ライブ≥90日）＋C較正監査（正式）＋司令塔最終GOの3点が揃って初めてD統合反映（PJ000002鉄則・spec §4総合）。本監査は「基盤の信頼性」のみを保証し、キャリーが実現するか・F2が80%へ回復するかは**今後90日のライブ実測が答える**。

---

## 変更履歴
- 2026-07-06: 初版（C懐疑検証官・独立監査）。フォワード較正ハーネス`bitget-carry-forward-paper.ts`初回セットアップ（warmup30日+go-live 1日）の技術監査。会計をStage1 `carry-liquidation-sim.ts`と逐条照合し同一性確認（二重計上排除・現物益連続計上・W=7適用）＋BTC 07-04を手計算再現。Bitget公開API独立再取得で全記録値一致（funding/spot/mark）・mark実取得を確認。冪等性（noop/append・清算後margin繰越の三項）を確認。F1b参照calm系列の平均が参照値と完全一致・F4算式がg0-1産出式と完全一致を検算。**採用可（日次運用開始を推薦）**。ただし**C-1＝F2ゲートの符号一致粒度がG0-2イベント単位ベースラインと不整合（日次合算は甘い側の偏り）＋イベント単位が全90日窓で永続化されない**をF2正式判定前の必須是正として指摘（日次蓄積のブロッキングではない）。C-2（ローリング符号の最小サンプルガード欠如でday1スプリアスalert）・C-3（キャリー持続マイナスがwarmup込み累積参照）を軽微是正として指摘（いずれも過剰警告＝保守側）。C-4（append復元prevSignalがpos・SMA=0測度ゼロケース）は記録のみ。本番反映はF1〜F4両銘柄合格＋C較正監査＋司令塔最終GOの3点必須（範囲外）。
