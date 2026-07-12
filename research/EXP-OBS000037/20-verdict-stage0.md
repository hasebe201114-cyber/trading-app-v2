# 判定書（Verdict） - EXP-OBS000037 / Stage 0（Deribitデータ実現可能性＋実コスト実測手段＋フォワード較正ハーネス feasibility）

> 担当: 品質チーム（adversarial-reviewer / Red Team）
> 役割: 好結果を積極的に棄却しにいく。偽陽性の最終防波堤。
> 対象: `research/EXP-OBS000037/10-result/` 全生データ（deribit-probe-github-actions.json・deribit-cost-model.json・forward/*・各run.log）＋スクリプト3本のコード読解＋生値/API独立裏取り＋冪等性の自己再実行＋GitHub Actions実行ログの直接確認。
> 監査日: 2026-07-12（UTC）。監査者環境: ローカル（日本IP）＋ `gh run view 29183055306`（GHA実行ログ）＋ `curl` によるDeribit API独立再取得。
> 前例参照: `research/EXP-OBS000032/20-verdict-stage0.md`（同種Stage 0監査の書式・分岐当てはめ・ページングバグ非再発チェックの雛形）。

## 総合判定
- [x] **採用可（＝Stage 1へ GO・条件付き）**（推薦。最終GOは司令塔が出す）
- [ ] 不採用
- [ ] 保留（分岐(a)）
- [ ] 限定GO（分岐(b)）
- [ ] 差し戻し

**総合＝GO（Stage 1へ）。** spec §4の事前登録分岐表に実測を当てはめると **G0-1=達成 × G0-2=達成 × G0-4=達成 × G0-3=達成** ＝「GO（Stage 1へ）」に一意に写る。最優先規則（G0-1未達なら他ゲート問わず分岐(a)）は**発動しない**（G0-1は達成）。分岐(a)（G0-4未達）・分岐(b)（G0-2部分達成）・差し戻し（G0-3未達）のいずれのトリガーにも該当しない。

**ただしCとして、このGOは「Deribitデータ土俵が米国IP＝GitHub Actionsで立ち、DVOL/RV/VRPが日次で組め、実コスト実測手段が構築でき、改竄不能なフォワード基盤が回る」というfeasibilityの確認に限る。** VRPシグナルの利回り・Sharpe・テール込み純プラス・OBS000032とのテール独立性は**一切含意しない**（すべてStage 1以降）。むしろ本Stage 0で確認された前提（DVOL 2021-03-24起点＝2020-03コロナ級テールは構造的に窓外・実コスト統合数値は未構築・会計はプレースホルダ）を、Stage 1が必ず閉じることをGOの必須条件とする（§末尾）。

---

## 各ゲートの合否（spec §3 の事前登録基準に実測を当てはめ）

### G0-1（Deribit米国IPアクセス性＝最優先・単独生死ゲート）＝**達成**

- **判定材料はGitHub Actions（米国IP）版が正**（spec §3 G0-1・ローカル成功は判定に使わない）。`deribit-probe-github-actions.json` の4リクエスト（get_volatility_index_data / get_tradingview_chart_data / get_order_book / ticker）が**全て HTTP 200 かつ `result` フィールドを持つ正常JSON**。spec達成基準「(a)(b)(c)の3エンドポイントすべてが米国IPから200＋正常JSON」を満たす（(c)は板+ticker両方200）。
- **GHA実行の真正性をC独立裏取り（オーケストレーター検証依頼2への回答）**: `gh run view 29183055306 --log` を直接確認。
  - ランナーIP＝**172.172.157.3**（Azure/米国レンジ。ワークフロー `Show runner IP` ステップの生出力）。
  - `RUN_ENV=github-actions（process.env.GITHUB_ACTIONS=true）`・`Git commit: a765773...`・`Node version: v22.23.1` がJSONの `runEnv`/`gitCommit`/`nodeVersion` と一致。
  - 4エンドポイントとも `status=200 ok=true hasResultField=true` をGHAログ内で確認。ジョブは18秒で成功（`✓ probe in 18s`）。
  - 結果コミット `bda99b6` の作者は **`github-actions[bot]`**（2026-07-12T06:42:40Z・Linux runner path `/home/runner/work/...`）＝人間の手動貼付けでなくGHA botによる自動コミット。**捏造の余地なし。**
- レスポンス内容の妥当性: `usIn/usOut/usDiff`（マイクロ秒）・`jsonrpc:"2.0"`・`testnet:false`・DVOL配列 `[timestamp, o,h,l,c]`・板 `bids/asks`・`index_price` 等、いずれもDeribit JSON-RPC v2の実形式として整合。タイムスタンプ（ミリ秒UNIX）も実時刻と一致。
- **403/451/CloudFront遮断は観測されず**（OBS000032のBinance 451と同型リスクは顕在化しなかった）。→ 分岐(a)の最優先規則は不発動。

### G0-2（DVOL履歴深度・RV自前計算の実現可能性）＝**達成**

- **DVOL実起点＝2021-03-24T00:00:00.000Z をC独立裏取り**（オーケストレーター検証依頼3・最重要）。`curl` で `start=2015-01-01` の1リクエストを再取得したところ **rows=1000・continuation=1697414400000** をこの目で確認＝B生データ `pageLog request#1（rowsReturned=1000 continuation=1697414400000）` と完全一致。Deribitは最新側1000件を返し `continuation` で過去へ遡らせる仕様で、request#2（end=1697414400000）が937件を返し continuation=null で終端＝総1937件・最古2021-03-24。**ページングは正しく前進しており、起点特定は本物。**
- **T2(LUNA)/T3(FTX)＝欠損率0.00%**（T2: 61/61日・T3: 52/52日・missingDates空）。spec達成基準「T2・T3両窓を連続カバー（欠損率<5%）」を満たす。
- **T1(コロナ)＝欠損率100%（rawRowCount=0・empty_response）は真の窓外であり、ページングバグによる偽陰性ではない**（030がこの型で死んだ前例の慎重検証）。根拠: (i) DVOL起点2021-03-24はT1窓（2020-02-20〜04-30）より**約11か月後**＝原理的に存在しない。(ii) 起点探索は空応答/continuation=nullで正しく終端し、2021-03-24より古い足は存在しないことを実測で確定済み。(iii) 禁止パターン `length<limit break` はコードに不在（後述チェック）。→ **T1のゼロは「DVOL導入前」という物理的事実であり、早期打ち切りの偽陰性ではない。** 届いていればlab前提が覆るところだが、届かない事実が正しく記録された。
- **INC窓の欠損率45.30%も起点で完全説明**（欠損日リスト＝2021-01-01〜03-23の82日＝起点2021-03-24より前）。ページングの取りこぼしではない。
- **RV自前計算 feasibility**: 全窓（T1/T2/T3/INC/calm）でDeribit BTC-PERPETUAL日足から日次対数リターンの年率化標準偏差（年率ボラ%）を算出済み（例 T2=82.97%・T3=51.13%・calm=67.55%）。DVOLと同じ年率ボラ%基準に揃い、VRP_t=DVOL_t−RV_t が同一UTC日付で構築可能な日数を各窓で実測（T2=61・T3=52・calm=184）。価格源はDeribit-tradingview（Binance CSVフォールバックは発動せず＝Deribit価格が米国IPで取れた）。
- **単位整合の注記（結論非依存・Stage 1申し送り）**: `get_tradingview_chart_data resolution=1D` のローソク足は実測で **08:00:00 UTC アンカー**（DVOLは00:00:00 UTC）。B は時刻オフセット補正をせずカレンダー日付文字列一致のみで突合している旨を明記。Stage 1の日次ローリングVRP設計では、この8時間オフセットがVRP_t=DVOL_t−RV_t の厳密な同日対応にズレを生みうるため、アラインメント方針の確定を要する（feasibility判定には影響しない＝spec部分達成の「日付アラインメントに注記を要する」に該当しうるが、両窓カバー・RV算出・VRP構築可がすべて成立するため総合は達成側）。
- `get_historical_volatility` は約16日ローリング（count=384時間足・oldest 2026-06-26）で長期RV取得不可＝RVは自前計算依存、というspec前提を実測で確認。

### G0-3（実コスト実測手段の構築）＝**達成**（統合数値の未構築を注記・Stage 1申し送り）

- **(a) オプション手数料＝APIから数値取得＋公式表URL到達をC独立裏取り**。`curl get_instruments kind=option` を再取得し **872銘柄すべて maker=taker=0.0003（単一値）** をこの目で確認＝B生データと一致。公式手数料表 `https://www.deribit.com/kb/fees` は status=200 で到達。0.0003＝原資産建て0.03%はDeribit公開仕様として妥当（BTCオプション標準手数料）。バリアンススワップ近似での vol pt/週換算方法（vega経由）は明記されている。
- **(c) perpデルタヘッジコスト＝数値構築済み**。`curl get_instruments kind=future` で **BTC-PERPETUAL maker=0・taker=0.0005** をC独立裏取り（0.05%＝Deribit公開仕様として妥当）。$100k名目の板厚スリッページ0.039bps（depth=50実データから算出）も再現可能。
- **(b) 実スプレッド＝現時点スナップショットで数値取得済み**（perp 0.078bps・ATM近傍オプション3銘柄 4657/12000/9090bps）。過去スプレッドはAPI非配信＝取得不可の事実を明記。オプションのbpsが極端に広いのは同日満期(12JUL26)の薄いプレミアム銘柄ゆえで、スナップショットの事実記録としては健全（数値としての採否はStage 1）。
- **達成と判定する根拠**: spec達成基準の「3項（手数料・スプレッド・ヘッジコスト）すべてが実データ/実仕様から数値で構築できている（生データから再現可能）」を、上記3項の数値存在＋C独立再取得一致で満たす。API非配信項目（過去スプレッド）は「取得不可」と正しく区別表記され、OBS000032のG0-3で問題化した「API非配信を配信のように併記」する誤認表記はない。
- **⚠ Stage 1必須申し送り（結論非依存の実質的ギャップ・Cが突く点）**: spec §3 G0-3 step4「実測由来の統合週次コスト（vol pt/週 or bps/週）を1つの数値セットとして構築しlab仮置き(1.8)と並置」について、B は **実測側の統合数値を構築せず**、`d_integratedWeeklyCost` に lab仮置きのみを記載（片側並置）。理由注記は「vega非取得または変換式未確定」とあるが、**vega は実際には取得済み**（optionGreeksSnapshotsに vega=2.00781 等）＝注記の「vega非取得」は不正確で、少なくともbps/週ベースの統合数値は構築可能だった。ただし spec §3 G0-3の位置づけ・スコープ境界が「実数値の確定・Sharpe≥1.0ネット判定はStage 1」と明示的に切り出しているため、統合数値未構築は**feasibility判定を未達に落とさない**（手段の構成要素は全て揃っている）。→ Stage 1は実測コストの vol pt/週（またはbps/週）への統合数値を必ず構築し、lab仮置き1.8と実数で並置してネット期待値を再構成すること。「vega非取得」の不正確注記は是正のこと。

### G0-4（フォワード較正ハーネスの実現可能性）＝**達成**

- **ハーネス初回稼働**: `deribit-vrp-forward-paper.ts` が初回セットアップで **warmup 7日（2026-07-04〜07-10）＋go-live 1日（07-11）＝計8行** を生成。Deribit publicからDVOL＋価格を取得し追記型ledger（JSON+CSV）を出力。
- **冪等性をC自身の再実行で独立確認（オーケストレーター検証依頼5・自己申告を鵜呑みにしない）**: 監査者がローカルで `node deribit-vrp-forward-paper.ts` を再実行 → **mode=noop・newRowsAppended=0・rowCountBefore=8・rowCountAfter=8**（既存最終日=anchor=2026-07-11でnoop）。ledger行数8のまま不変・lastDate=2026-07-11不変をこの目で確認。date をユニークキーとする重複防止が機能。meta.runHistory にもB実行3回（initial→noop→noop、うち3回目は `/home/runner` パス＝GHA実行）が記録され、GHAでも同一冪等挙動を確認。
- **必須条件A（テール相関測定基盤の準備）＝準備済み**（オーケストレーター検証依頼6への回答）: ledger全行に **`sleeve_return` 列**（OBS000032ledgerとdate＝UTC日キーで突合可能な資本比%形式）と **`dvol_spike_marker` 列**（前日比≥5 vol ptで1＝candidate tail marker）が実在（`hasSleeveReturn=true hasSpikeMarker=true` をC確認）。相関・同時DDの算出はStage 1（spec §8通り本Stage 0では形式準備のみ）。
- **ライブ性厳守**: back-fillは warmup 7日のみで **90日一括生成をしていない**（`currentLiveDaysCount=1`）。F1〜F4評価対象は phase=live のライブ≥90暦日設計。日付アンカーは today−1（当日部分足の混入排除）。
- **先読み(look-ahead)なし**: `rv_forward_7d` は対象日Dの**7日後**の価格D..D+7から算出＝当日時点はnull・7日経過後に後埋め（07-04行はvrp=25.999が埋まり、live 07-11行はrv7=null）。将来実現ボラを事後に埋める正しいフォワード構造で、シグナル時点への未来情報リークはない。net_pnl_pct/sleeve_return はStage 0プレースホルダ会計（1 vol pt=資本1%の恣意的仮定・lab仮置きコスト日割り）である旨がmetaに明記され、Sharpe算出等のスコープ拡大はない。

---

## チェックリスト（各項目に合否）

| # | チェック項目 | 合否 | 根拠 |
|---|---|---|---|
| 1 | 予測単位×パイプライン整合（OBS000025型乖離） | ✅ | Stage 0は利回り採否・シグナル検証を測らないデータ/コスト/基盤feasibility調査。予測単位/パイプライン乖離の検出対象外（spec §0明記）。VRP値の評価はStage 1。 |
| 2 | 非単調性＝過最適（OBS000018型） | ✅ | パラメータ探索・グリッド最適化なし（spec §7厳守）。窓は§2で日付固定、DVOLスパイク閾値5・warmup7日・rv後方7日は事前固定の記録用定義。境界最良化の蜃気楼なし（コードにグリッド探索不在をC確認）。 |
| 3 | クロス資産再現（BTC→ETH、OBS000019型） | ✅（該当外） | spec §1-1でBTC 1銘柄固定・ETH取得禁止。ETHデータ取得の混入なし（grep確認: ETHは「取得禁止」注記のみ）。VRPは横断不要の構造的プレミアムで単一銘柄成立。クロス資産再現はStage 1/別件の職務。 |
| 4 | 統計的頑健性（perm p値・多重検定・n） | ✅（該当外） | Stage 0はシグナル有意性検定の段階でない（spec §7）。到達性・欠損率・コストは事実計測でn＝各窓実日数（T2=61/T3=52/calm=184）を明示。permは非該当。lab結論のp=0再現はStage 1。 |
| 5 | リーク/バイアス（先読み・データリーク・生存バイアス） | ✅ | BTCは廃止されず生存バイアス非該当。rv_forward_7dは対象日の7日後価格で算出＝後埋めフォワード構造で未来情報リークなし。ページング健全（空応答/continuation終了）。GHA実行はbot自動コミットで捏造なし。 |
| 6 | 基準の逸脱（specの成功基準を事後に緩めていないか） | ✅ | 各ゲートをspec §3の事前登録境界にそのまま当てはめ緩めていない。総合はspec §4分岐表にG0-1達成×G0-2達成×G0-4達成×G0-3達成で一意にGO。事後緩和なし。 |
| 7 | 禁止事項遵守（判定語混入・ETH取得・labコピペ・ページングバグ） | ✅ | 判定語（達成/未達/有望等）はscripts/生JSONに不在（grep確認・コメントの「length<limit終了は禁止」等は禁止事項の明記であり判定語でない）。ETH取得なし。禁止パターン`length<limit break`不在（終了は空応答/continuation=nullのみ）。 |

**labコピペ非該当の確認（限界付き）**: `crypto-strategy-lab/research/EXP-OBS000001/scripts/` は本ワークスペースに存在せず**直接diff比較は不可**。ただし3スクリプトは独立実装の構造（Deribit v2固有のcontinuationページング・08:00UTCアンカー実測対応・OBS000032作法流用の明記）を持ち、labバグ輸入（030/031型power0）の兆候は読解上見られない。念のためStage 1でlab `vrp-prediction-unit.ts`/`vrp-pipeline-accounting.ts` の独立書き直し時に、コピペでないことを再確認する（必須条件B）。

---

## GO の必須条件（Stage 1へ持ち越す・偽陽性の芽の封鎖）

本Stage 0はfeasibilityのみを確認した。Stage 1 spec（A設計官）で以下を必須化し、平時の綺麗なVRP曲線が偽陽性採用を生む前に封じる。

- **条件A（テール観測不能の明示的較正）**: DVOL起点2021-03-24＝**2020-03コロナ級テールは構造的に窓外**（本Stage 0でT1=0件を実証）。最大級テール被害幅はバックテストで原理的に測れない。Stage 1はLUNA(T2)/FTX(T3)のカバー窓＋フォワード較正でテール込み挙動を積む設計を必須とし、「観測できないテール窓」をテール頑健性評価の空白として明記する（prescreen最重要リスク）。
- **条件B（実コスト統合数値の構築）**: G0-3で実測側の統合週次コスト数値が未構築（片側並置）。Stage 1は手数料0.0003/perp taker0.0005/実スプレッド/板スリッページ/vega を統合し、実測 vol pt/週（またはbps/週）を数値化してlab仮置き1.8と実数で並置。実コスト置換後に年率Sharpe≥1.0・コストx2で正を検証（本POC最大の検証点）。「vega非取得」の不正確注記を是正。
- **条件C（OBS000032とのテール同時DD）**: 必須条件Aの測定基盤（sleeve_return・dvol_spike_marker）はStage 0で準備済み。Stage 1はテール窓での VRPスリーブ×②モメンタム×OBS000032キャリーの同時ドローダウンを数値固定ゲート化（平時|ρ|<0.3だけでなくテール時同時DD）。同族ショートリスクプレミアムゆえ危機時に相関1へ収束する疑いを本命リスクとして扱う。
- **条件D（記録衛生・非ブロッキング）**: (i) `get_tradingview_chart_data` の08:00UTCアンカーとDVOL 00:00UTCの8時間オフセットのアラインメント方針をStage 1のローリングVRP設計で確定。(ii) G0-3 `d_integratedWeeklyCost` の「vega非取得」注記を是正。いずれも結論非依存の記録品質。

---

## B実装チームの信頼性ノート（030/031/032からの継続監視）

- **今回は虚偽報告なし・数値は生データ/コード/API独立再取得と整合。** DVOL起点2021-03-24・ページング（1000件→continuation→937件）・option手数料0.0003・perp taker0.0005・冪等性noop はいずれもCの独立裏取り（curl/gh run/自己再実行）で一致。031までの「実行完了を自己確認せず完了報告」の癖は再発せず（全成果物ファイル実在・非空・GHA bot自動コミット確認）。
- **ページングバグ非再発をC確認**: 終了条件は空応答（data.length===0）または continuation===null/undefined のみ。禁止パターン `length<limit break` はコード・コメント上も不在（コメントは禁止の明記）。T1=0件は真の窓外でありページング偽陰性ではない（030の轍を踏まず）。
- **軽微な自己申告のブレ（判定非依存）**: オーケストレーターへのB報告では ATMオプションスプレッドを「4657〜9090bps」としたが、生JSONは最大12000bps（BTC-12JUL26-64000-C）を含む。生データが正で判定に影響しないが、報告時の範囲丸めは記録しておく。

---

## 変更履歴
- 2026-07-12: 初版作成（C品質チーム）。EXP-OBS000037 Stage 0を独立監査。GitHub Actions run 29183055306（IP 172.172.157.3・4エンドポイント200）・github-actions[bot]コミットbda99b6・DVOL起点2021-03-24・option手数料0.0003/perp taker0.0005・冪等性noopをcurl/gh/自己再実行で独立裏取り。**総合＝GO（Stage 1へ）＝G0-1達成×G0-2達成×G0-3達成×G0-4達成**をspec §4分岐表に一意当てはめで宣告。G0-1の最優先規則は不発動（達成）。T1コロナ窓0件は真の窓外でページング偽陰性でないことを起点特定の独立再取得で確定。実コスト統合数値未構築（片側並置）・「vega非取得」不正確注記・08:00UTCオフセットをStage 1必須申し送り条件A〜Dとして登録。B虚偽報告なし・ページングバグ非再発をC確認。
