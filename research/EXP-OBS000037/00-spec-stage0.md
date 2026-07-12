# 実験仕様書（Spec） - EXP-OBS000037 / Stage 0（Deribitデータ実現可能性＋実コスト実測手段＋フォワード較正ハーネス feasibility）

> 担当: 設計チーム（strategy-architect）
> 鉄則: **合否基準は「回す前」に数値・基準で確定する**（HARKing防止）。実測結果を見てから基準を緩めない。
> 前提: 戦略チーム prescreen＝**段階的・条件付きGO**（`research/EXP-OBS000037/00-prescreen.md`）。テーマ＝SYS-001 BTC Variance Risk Premium（VRP）＝デルタニュートラル・ショートボラティリティ。DeribitのImplied Vol（DVOL指数）が事後Realized Vol（自前計算）を構造的に上回る差を、バリアンススワップ近似ペイオフで**非方向的に**収穫する。crypto-strategy-lab 第1系統（`crypto-strategy-lab/research/EXP-OBS000001/`）からの引き継ぎ。SのPOC計画書＝`obs/trading_app/02対応検討中/2026-07-12/OBS000037-SYS-001ボラティリティリスクプレミアム戦略のPOC計画書.md`。
> **本specのスコープ＝Stage 0のみ。** Stage 1（予測単位のlab独立再現・実コスト置換後会計・②/OBS000032とのテール相関ゲート・フォワード較正F判定）のspecは本書に含めない（別途、Stage 0通過後・司令塔GO後に作成する）。
> 直系の前例（書式・粒度・分岐設計の参照元）: `research/EXP-OBS000032/00-spec-stage0.md`（G0-1〜G0-4の書きぶり・総合判定分岐・ページングバグ非再発チェックリスト・B実装官への指示の雛形）／`research/EXP-OBS000032/20-verdict-stage0.md`（同種の監査を本Stage 0もいずれ受ける前提で、Cが何を突くかを見据えて設計）。
> lab側の存在検証グレード情報（無条件に信用しない・trading-app-v2側で独立に再確認する立場＝prescreen必須条件B）: lab `probe-deribit-vol-data.ts`/`probe-deribit-dvol-coverage.ts` の生データ（`stage0-data-probe.json`／`stage0-dvol-coverage.json`）＝DVOLはBTC/ETH双方で2021-04以降に存在しLUNA(2022-05)/FTX(2022-11)窓をカバー、2020-03コロナ窓は非カバー（DVOL導入前）、`get_historical_volatility`はローリング約15〜16日のみで長期RV取得不可＝RVは価格履歴から自前計算に切替、という報告がある。**ただしこれはlab環境での結果であり、trading-app-v2の実行環境（GitHub Actions＝米国IP）でのアクセス性・履歴深度・エンドポイント挙動は本Stage 0で独立に再実測する。**

## 対応OBS番号
**OBS000037**（進行中・ACTIVE登録済み。採番はE進行チーム管理）。本Stage 0はOBS000037の第1ゲート（Stage 1シグナル/会計/フォワード検証の前提条件）。

---

## 0. この実験の性質（最重要・冒頭明記）

**Stage 0 は「VRPシグナルの良し悪し・利回りの採否」を一切判定しない。** VRPが年率何%残るか、②/OBS000032合成でSharpeが改善するか、テール相関で分散価値が目減りするか等は**すべてStage 1以降で測る**ものであり、本Stage 0では**採否の文脈で測定も言及もしない**。

Stage 0 が答える問いは4つ（純粋な**データ調達可否・コスト実測手段の構築可否・フォワード較正基盤の構築可否**の技術調査）:
> **(問1・最優先) trading-app-v2の実行環境＝GitHub Actions（米国IP）から、Deribit公開API（DVOL指数・BTC価格履歴・板/手数料）に実際にアクセスできるか。** 地理ブロック（403/451/CloudFront遮断等）を返さないか。（G0-1）
> **(問2) DVOL指数を日次で、LUNA(T2)/FTX(T3)窓を連続でカバーする履歴深度まで取得でき、価格履歴からRVを整合的な年率ボラ%基準で自前計算して VRP_t = DVOL_t − RV_t を構築できるか。DVOL履歴の実際の起点はいつで、2020-03コロナ窓が窓外である事実を確認できるか。**（G0-2）
> **(問3) lab仮置きコスト（往復1.5＋デルタヘッジ0.3 vol pt/週）を"実測/実仕様由来の数値"へ置換する手段（Deribitオプション手数料表・実スプレッド・perpデルタヘッジコスト）を構築できるか。**（G0-3）
> **(問4) OBS000032の `bitget-carry-forward-paper.ts` を雛形に `deribit-vrp-forward-paper.ts` を新設し、日次冪等追記型ledgerで前向き蓄積できるか（warmup back-fill＋go-live確定＋ライブ≥90暦日設計・back-fillで90日を一括生成しない）。**（G0-4）

**判定（達成/部分達成/未達・分岐GO/保留(a)/限定GO(b)/差し戻し）はC品質チームが行う。** B実装チームは**事実・実測値・生ログのみ**を報告し、判定語（達成/未達/十分/不十分/go/no-go/取れる/取れない/問題ない/難しい/有望/割に合う 等）を使わない（後述「9. B実装官への指示」）。

**この性質の含意**: 本テーマは027/029/030/031（予測単位で最初から無エッジ）と質的に異なり、lab側で予測単位（BTC平均VRP+10.91 vol pt・block-bootstrap p=0）×会計（Sharpe 2.94）まで通過している（存在検証グレード）。ゆえにCが壊しにいく主戦場は「無エッジか」ではなく **「テール込みでも純プラスか／OBS000032とテール独立か／実コストで崩れないか」** であり、その真贋を問う前提となる**データ土俵・コスト実測手段・フォワード基盤がそもそも組めるか**を本Stage 0で先に潰す。

**⚠ lab結果の蒸し返し・コピペ流用の禁止（prescreen必須条件Bの起点）**: lab側の予測単位・会計の"結論の再現"（`vrp-prediction-unit.ts`／`vrp-pipeline-accounting.ts` の独立書き直し）は **Stage 1の職務であって本Stage 0では行わない**（本Stage 0でVRPの検定・会計・Sharpe算出をしない）。lab スクリプトのコードをコピペ流用しない（labのバグごと輸入する030/031型power0リスク）。本Stage 0の実質は **(1) 米国IPアクセス性 (2) DVOL深度＋RV自前計算 feasibility (3) 実コスト実測手段の構築 (4) フォワード較正ハーネス feasibility** の4点に限定する。

---

## 1. 対象銘柄の定義（固定）

### 1-1. 対象＝BTC のみに固定
- prescreen前提に従い、**BTC 1銘柄のみ**を全ゲート（G0-1〜G0-4）の対象とする。
- **ETHは対象外**: lab側で確認期間にSharpe 2.17→0.67へ崩壊・コストx2で0.187まで悪化したため、`SYS-001-ETH` として分離・本POC対象外（POC計画書 §2-1）。**Stage 0でETHを取得・測定しないこと**（スコープ拡大禁止）。ETHはBTC POC合格後に別件で再評価。
- BTCに固定する理由: (i) BTCは廃止されずサバイバーシップ・バイアス非該当。(ii) VRPは横断（クロスセクション）を要しない構造的プレミアム収穫であり単一銘柄で成立する。

---

## 2. 固定窓・アンカーの定義（回す前に日付で確定）

G0-2（DVOL履歴深度・カバレッジ）で使う窓を以下に固定する（**B実装官はこの日付範囲を勝手に動かさない**。都合よくデータのある窓だけを選ぶHARKingを封じる）。基準日（アンカー）＝ **2026-07-12（UTC）**。

| 窓ID | イベント | 固定期間（UTC・両端含む） | Stage 0での役割 |
|---|---|---|---|
| **T1** | 2020-03 コロナ暴落 | **2020-02-20 〜 2020-04-30** | **窓外であることの確認対象**（DVOL導入前で構造的に非カバーのはず。DVOLがこの窓に届かない事実を実測で記録する。届いた場合はlab前提が覆るので事実を明記） |
| **T2** | 2022-05 LUNA/UST崩壊 | **2022-05-01 〜 2022-06-30** | **DVOLカバー必須窓**（lab: BTC DVOLカバー可・LUNA窓VRP+10.44） |
| **T3** | 2022-11 FTX破綻 | **2022-10-25 〜 2022-12-15** | **DVOLカバー必須窓**（lab: BTC DVOLカバー可・FTX窓VRP+3.61） |
| **INC** | DVOL起点探索窓 | **2021-01-01 〜 2021-06-30** | DVOL BTC履歴の**実際の起点タイムスタンプ**を実測で特定する窓（lab: 2021-01は空・2021-04はデータあり＝この間に起点） |
| **calm** | 平穏参照窓 | **2021-07-01 〜 2021-12-31** | RV自前計算 feasibility・VRP構築 feasibility の平穏期サンプル（DVOL起点より後で安全にカバーされる想定） |

- 各窓の日次系列本数の期待値（欠損率の分母）: T2=61日、T3=52日、calm=184日（B実装官は実カレンダーで厳密本数を再計算してよい。欠損＝連続UTC日付列の抜けとして定義し、欠損本数・欠損率を実測値として報告する）。

---

## 3. Stage 0 の合否ゲート（G0-1〜G0-4・回す前に基準を固定）

各ゲートについて「**達成 / 部分達成 / 未達**」の境界を数値・基準で定義する。**判定はCが下す**。B実装官は各基準に対応する**実測値・生データ・実レスポンスを揃えるだけ**。

### G0-1: Deribit米国IPアクセス性（＝最優先・単独の生死ゲート）

**位置づけ**: OBS000032でBinanceがGitHub Actions（米国IP）から **HTTP 451** を返しF2ゲートが恒常null化した前例と**同型リスク**。DeribitがCloudFront等で米国IPをジオブロックする可能性を、**本番運用と同じ実行環境（GitHub Actions・米国IP）で先に潰す**。ローカル（日本IP）で通ることは何の保証にもならない（OBS000032の451はローカルでは再現せずGitHub Actionsでのみ顕在化した）。

**測定対象（BTC・Deribit本番 `https://www.deribit.com/api/v2`・認証不要の public エンドポイントのみ）**:
- **(a) DVOL指数**: `GET /public/get_volatility_index_data?currency=BTC&start_timestamp={ms}&end_timestamp={ms}&resolution=86400`
- **(b) BTC価格履歴（RV自前計算用）**: `GET /public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp={ms}&end_timestamp={ms}&resolution=1D`
- **(c) 板/ティッカー（コスト用）**: `GET /public/get_order_book?instrument_name=BTC-PERPETUAL&depth=5` および `GET /public/ticker?instrument_name=BTC-PERPETUAL`

**実行環境の必須要件（Cが最も突く点）**:
- 上記3エンドポイントへのリクエストを、**(i) GitHub Actions 実行環境（米国IP）** と **(ii) ローカル環境（参考）** の**両方**で実行し、**HTTPステータスコード・レスポンスボディ先頭・成功可否を環境別に記録する**。G0-1の合否判定に使うのは **(i) GitHub Actions（米国IP）の結果**（本番運用環境）であり、ローカルの成功は判定に使わない（参考記録のみ）。
- GitHub Actions実行は、既存 `.github/workflows/forward-calibration.yml` に相乗り or 同型の新規ワークフローで `probe-deribit-vrp-data.ts` を走らせ、その標準出力・HTTPステータスをArtifactまたはログで回収する。**環境変数・Secretsは使わない**（Deribit publicエンドポイントは認証不要。`.env.local`・APIキーは読まない）。

**合否基準（判定はC。米国IP＝GitHub Actionsの結果で評価）**:
- **達成**: (a)(b)(c) の3エンドポイントすべてが GitHub Actions（米国IP）から **HTTP 200 かつ 正常JSON**（`result` フィールドを持つ）を返す。＝データ土俵が米国IPで立つ。
- **部分達成**: 一部エンドポイントのみ米国IPから 200 を返し、他がジオブロック/エラー（例: DVOLは取れるが板が取れない）、**または** レート制限で断続的に失敗するが待機挿入で回避できる兆候がある。
- **未達**: (a)DVOL または (b)価格履歴 が GitHub Actions（米国IP）から **403/451/CloudFront遮断/接続不可**（＝OBS000032のBinance 451と同型）。ローカルで通っても米国IPで主要データが取れなければ未達。

### G0-2: DVOL履歴深度・RV自前計算の実現可能性

**位置づけ**: DVOL指数を日次でT2/T3窓を連続カバーする深度まで取得でき、価格履歴からRVを整合的な年率ボラ%基準で自前計算して VRP_t = DVOL_t − RV_t を構築できるかを実測する。**VRPの値・符号・有意性は判定しない**（Stage 1）。ここで測るのは「土俵として最低限のデータが日次で組めるか」の技術確認のみ。

**調査手順（B実装官が実施。すべて実測・実レスポンスを正とする）**:

1. **DVOL履歴の実起点特定**: `get_volatility_index_data`（currency=BTC・resolution=86400＝日次）を、INC窓（2021-01-01〜2021-06-30）を含めて過去方向に遡り、**BTC DVOL日次データの実際の最古タイムスタンプ（UTC）を特定**する。lab報告（2021-01は空・2021-04はデータあり）を鵜呑みにせず独立に実測。resolution=86400 の1リクエスト最大返却件数・ページング挙動（`continuation`フィールド or 時間窓分割）を実測しログに残す。
2. **T2/T3カバレッジの実測**: T2(LUNA)・T3(FTX)各窓で、日次DVOLが**1日も飛ばさず連続で存在するか**を実測し、各窓の実本数・欠損本数・欠損率・欠損日リストを出力。
3. **T1窓外の確認**: T1(コロナ)窓でDVOLが**取得できない（空応答/count=0）**ことを実測で確認・記録（届いた場合はlab前提が覆るので事実を明記）。
4. **RV自前計算 feasibility**: (b)価格履歴（`get_tradingview_chart_data` BTC-PERPETUAL日次OHLC）から、**日次対数リターンの年率化標準偏差（年率ボラ%）としてRVを計算**できるか（DVOLと同じ年率ボラ%基準に揃うか＝単位整合）を確認する。calm窓・T2・T3で RV_t が計算できる日数・欠損日数を実測。**VRP_t = DVOL_t − RV_t が同一UTC日付で構築できる日数**を各窓で実測（値そのものの評価はしない・構築可否のみ）。
   - 参考: Deribit価格履歴が米国IPで取れない/薄い場合、既存 `scripts/data/btc-daily-binance-2017-2026.csv` をRV計算のフォールバック源として使ってよい（ただし出典を明記し「Deribit価格でなくBinance価格由来のRV」と区別）。どちらを採用したかを明記。
5. **`get_historical_volatility` の限界確認（参考）**: `GET /public/get_historical_volatility?currency=BTC` の返却範囲（lab報告＝ローリング約15〜16日）を実測し、長期RV取得に使えない事実を記録（RVは自前計算に依存する根拠）。

**合否基準（判定はC）**:
- **達成**: BTC DVOL日次が **T2・T3の両窓を連続カバー**（各窓の欠損率 < 5%）**かつ** DVOL実起点タイムスタンプが特定でき **かつ** 価格履歴からRVを年率ボラ%基準で自前計算でき、calm/T2/T3で VRP_t = DVOL_t − RV_t が同一UTC日付で構築できる（構築可能日数を実測）。T1(コロナ)窓外を確認済み。
- **部分達成**: DVOLが **T2・T3の片方のみ**連続カバー（他窓は欠損率≥5%）、**または** RVは自前計算できるが単位整合/日付アラインメントに注記を要する、**または** Deribit価格履歴が取れずBinance CSV代用でのみRV構築可能。
- **未達**: DVOLが直近の短期窓しか取れずT2/T3に**一切届かない**、**または** 価格履歴が取れずRVを整合的な年率基準で構築できない（＝VRP系列が原理的に組めない）。

**⚠ ページングバグ再発防止（B実装官への必須チェックリスト・030/031/032の教訓）**
既存 `scripts/fetch-*-data.ts` 群には終了条件に **`if (data.length < limit) break;`（返却件数 < limit で終了）** の同型バグ前例がある（030 Stage0を偽陰性で殺した）。DVOLの疎な区間・起点付近の薄い区間で早期打ち切りし、T2/T3に届く前にページングを止める危険がある。以下を実装前に固定し生ログで自己点検すること:
1. **【終了条件】** ページング終了は「空応答（返却0件）」または「`continuation`が返らない／カーソルが要求範囲を越えた」のみで判定する。「返却件数 < 期待件数で終了」は**禁止**。
2. **【カーソル前進】** 時間窓分割 or `continuation` を正しく前進させ、同一窓の反復・最新足が更新されない兆候を検知したら基準を緩めず事実を明記してA/Sへ差し戻す。
3. **【1リクエスト上限の実測】** `get_volatility_index_data`・`get_tradingview_chart_data` の1リクエスト最大返却件数・レート制限を実測し生ログに記録。リクエスト間に待機を挟む。
4. **【窓連続性の直接確認】** T2/T3各窓についてDVOLが1日も飛ばさず連続かをB実装官自身がログで確認し、欠損日リストを出力する。

### G0-3: 実コスト実測手段の構築（lab仮置きコストの置換手段）

**位置づけ**: lab Stage 2の会計は「往復1.5 vol pt/週＋デルタヘッジ0.3 vol pt/週」の**仮置き**。本Stage 0では、この仮置きを**"実測/実仕様由来の数値"へ置換する手段を構築できるか**（Deribitオプション手数料表・実スプレッド・perpデルタヘッジコストを実データ/公式仕様から数値化できるか）を確認する。**"できる/できない"でなく、コスト各項を実データ/実仕様から数値で組めるか**で評価する。

**⚠ スコープ境界の明示（Cが突く点・HARKing防止）**: prescreen G0-3の後半「実コスト置換後もネットプラス・年率Sharpe≥1.0、コストx2でも正」は、**会計パイプラインの独立再現（必須条件B）を要する＝Stage 1のゲート**である。本G0-3で測るのは**その入力となるコスト数値を構築する手段の feasibility のみ**。Sharpe≥1.0の合否判定は本Stage 0では**行わない**（Stage 1へ申し送り＝§8）。

**調査手順（B実装官が実施。すべて実測・実レスポンス/公式仕様を正とする）**:
1. **(a) オプション/バリアンスレッグの手数料**: Deribitのオプション取引手数料を、**公式手数料表（出典URL付き）** および `GET /public/get_instruments?currency=BTC&kind=option`（contract仕様）から取得。手数料体系（例: 原資産の0.03%・オプション価格の一定%上限・block trade条件等）を実測記録し、**バリアンススワップ近似での週次往復コスト（vol pt/週換算）への変換方法を明記**（lab仮置き1.5 vol pt/週の置換手段）。API非配信の項目は「公式表由来・API非配信」と明記（OBS000032のG0-3で証拠金率をAPI/公式併記して誤認を招いたC指摘を踏まえ、**API非配信なら必ず「仮置き/公式表由来」と区別表記**）。
2. **(b) 実スプレッド**: BTC ATM近傍オプション（複数銘柄）および `BTC-PERPETUAL` について `get_order_book`（depth=5）／`ticker` から **現時点の bid/ask スプレッド（bps）を実スナップショット**取得。過去スプレッドは取れない旨を明記（現時点スナップショットである限界を事実記録）。
3. **(c) perpデルタヘッジコスト**: `BTC-PERPETUAL` のテイカー/メイカー手数料（公式手数料表・出典URL）＋ `get_order_book` depth から想定ヘッジ名目（例: $100k）での板厚スリッページを見積もり、**デルタヘッジ1回あたりコスト（bps）を構築**（lab仮置き0.3 vol pt/週の置換手段）。
4. **統合**: (a)(b)(c)から「実測/実仕様由来の週次コスト（vol pt/週 または bps/週）」を1つの数値セットとして構築し、lab仮置き（往復1.5＋ヘッジ0.3）と**並置**して出力（差分の評価・採否判定はしない＝Stage 1）。

**合否基準（判定はC）**:
- **達成**: (a)オプション手数料表（出典明記）＋変換方法・(b)実スプレッド スナップショット・(c)perpヘッジコスト、の**3項すべてが実データ/実仕様から数値で構築できている**（生データから再現可能）。lab仮置きの置換手段が揃う。
- **部分達成**: (a)(c)は構築できたが、(b)スプレッドが現時点スナップショットのみ（過去不可）で限定的、**または** 一部項目がAPI非配信で公式表の仮置き値でしか置けない（出典・仮置きを明記した場合）。
- **未達**: (a)オプション手数料が公式表・APIとも取得できない、**または** (c)perpヘッジコストが組めない（板/手数料とも取れない）＝コストモデルの根幹が原理的に組めない。

### G0-4: フォワード較正ハーネスの実現可能性

**位置づけ**: 本テーマの生死＝テール被害幅がDVOL 2021起点で最大級テール（2020-03コロナ）を観測できないため、**改竄不能な前向き蓄積（フォワード較正）でテール込み挙動を積む**設計が必須（OBS000032と同型）。本G0-4では、その基盤＝日次冪等追記型ledgerハーネスを構築でき、初回セットアップが健全に動くかを確認する。**F1〜F4の正式判定・利回りの採否はしない**（Stage 1／ライブ90日後）。

**調査手順（B実装官が実施）**:
1. **ハーネス新設**: OBS000032の `scripts/bitget-carry-forward-paper.ts` を**雛形として書き直し**（コピペでなく構造流用）、`scripts/deribit-vrp-forward-paper.ts` を新設。日次冪等追記型ledgerを `research/EXP-OBS000037/10-result/forward/` に出力。
2. **記録項目（最低限・追記型ledger）**: `date`（対象UTC日＝最終完全経過UTC日 today−1）／`dvol`（当日DVOL値）／`rv_forward_7d`（7日後に遡って計算される実現RV＝当日時点はnull・7日経過後に埋まる）／`vrp`（`dvol − rv_forward_7d`・rv埋まった時点で計算）／`net_pnl_pct`（G0-3のコスト構造を適用した資本比%のnet payoff＝Stage 0では仮置き/実測コストいずれを使ったか明記）／`sleeve_return`（②/OBS000032ledgerとの突合用・後述§8必須条件A）／`phase`（`warmup`（最初の7日・シグナル未確定）or `live`）。
3. **日付アンカー設計**: OBS000032同様「今日」でなく「最終完全経過UTC日（today−1）」を処理対象とし当日部分足の混入を排除（metaに明記）。
4. **冪等性の自己検証**: 同日に2回実行し、2回目の追記対象が0件・ledger行数不変であることを実測（date をユニークキーとする重複防止）。
5. **warmup/ライブ設計の実装**: 初回はwarmup back-fill（VRPは7日後方RVを要するためgo-live直後は未確定）＋go-live日確定、F1〜F4評価対象は `phase=live` の**ライブ≥90暦日のみ**。**back-fillで90日を一括生成しない**（ライブ性厳守＝弱代表な過去データで水増ししない）。
6. **データ取得はG0-1のDeribit publicエンドポイント経由**（DVOL＋価格）。GitHub Actions（米国IP）で実行できるか（G0-1に依存）を確認。

**合否基準（判定はC）**:
- **達成**: `deribit-vrp-forward-paper.ts` が構築され、初回セットアップ実行で **(i) Deribit publicからDVOL＋価格を取得し (ii) warmup back-fill＋go-live確定を記録し (iii) 追記型ledger（上記項目）を出力し (iv) 同日2回目実行で追記0件＝冪等性を自己検証** できている。＝日次前向き蓄積の基盤が立つ。
- **部分達成**: ハーネスは動くが、**一部記録項目が未実装**（例: `sleeve_return` 突合フィールド欠落）、**または** DVOL取得がローカルで動くがGitHub Actions（米国IP）での成功が未確認（G0-1に依存）、**または** rv_forward_7d の後埋めロジックは実装済みだが7日未経過でライブ検証不能。
- **未達**: ハーネスがデータを取得できない（G0-1未達依存）、**または** ledgerが冪等でない（再実行で重複追記）、**または** 追記型構造が組めない。

---

## 4. Stage 0 総合判定と分岐（判定はC・基準はここで固定）

**Cは G0-1〜G0-4 の各達成度から、次のいずれかを宣告する（A設計官が回す前に分岐ルールを固定）。**

**⚠ 最優先の優先順位規則（prescreen通り・厳守）: G0-1が未達なら、G0-2〜G0-4の結果によらず総合＝「分岐(a) 保留・司令塔上申（インフラ投資判断）」とする。** Deribit publicが米国IP（GitHub Actions）から取れない限り、フォワード較正が本番運用環境で回らず、テール込み挙動を前向きに積む設計が成立しないため（OBS000032のBinance 451と同型）。ローカルで通ってもこの規則は変わらない。

| 総合判定 | 条件 | 次アクション |
|---|---|---|
| **GO（Stage 1へ）** | **G0-1=達成**（米国IPでDVOL/価格/板が200）**かつ G0-2=達成**（DVOLがT2/T3連続カバー＋RV自前計算でVRP構築可）**かつ G0-4=達成**（冪等追記ハーネスが健全に初回稼働）**かつ G0-3=達成 または部分達成**（実コスト実測手段が構築できる。部分達成は仮置き箇所を明記）。 | Deribitデータ土俵が米国IPで立ち、VRP系列が組め、フォワード基盤が回る。**Stage 1 spec作成へ**（別途A設計官・要司令塔GO）＝(1) lab予測単位/会計の独立再現（必須条件B・§8）(2) G0-3実コスト置換後の会計（年率Sharpe≥1.0・コストx2で正）(3) ②/OBS000032とのテール相関の第一級ゲート化（必須条件A・§8）(4) F1〜F4をA設計が数値固定→ライブ≥90暦日フォワード較正。 |
| **分岐(a) 保留・司令塔上申** | **G0-1=未達**（米国IPでDVOLまたは価格がブロック）＝**最優先規則により他ゲート結果を問わず(a)**。**または** G0-1=達成でも **G0-4=未達**（前向き蓄積の基盤が組めない）。 | OBS000032のBinance 451→Cloud Functionsプロキシ（asia-northeast1中継）と同型のインフラ投資判断をS経由で司令塔に上申（Deribit用中継プロキシの要否・コスト）。G0-4未達なら基盤課題を上申。フォワード単独はテール検証の代替にならない旨も併記。 |
| **分岐(b) 限定GO** | **G0-1=達成 かつ G0-2=部分達成**（DVOLがT2/T3の片方のみカバー・またはRV/VRP構築に注記）**かつ G0-3/G0-4=達成 または部分達成**。 | カバーできた窓に**限定してStage 1へ**（観測できないテール窓はStage 1のテール頑健性評価の空白として明記し、フォワード較正で補う判断をSへ）。 |
| **差し戻し（G0-3不成立）** | **G0-1=達成 かつ G0-3=未達**（実コスト実測手段が原理的に組めない） | 実コスト置換手段の根幹が組めず、Stage 1でネット期待値を構築できない。コスト取得手段の再検討（別ソース）の是非をS/司令塔へ。※G0-1達成でもG0-3未達なら差し戻し（lab仮置きのままStage 1に進めない＝本POC最大の検証点＝実コスト置換ができないと土台が崩れる）。 |

**Cが分岐を切り分けるための必須材料**（B実装官が必ず出力）:
- G0-1: 3エンドポイント × (GitHub Actions米国IP／ローカル) の HTTPステータス・レスポンスボディ先頭・成功可否・レート制限挙動。使用した実URL・パラメータ。
- G0-2: DVOL実起点タイムスタンプ、T1/T2/T3/calm各窓のDVOL実本数・欠損本数・欠損率・欠損日リスト、resolution=86400の1リクエスト上限・ページ遷移ログ、RV自前計算の採用価格源（Deribit or Binance CSV）とVRP構築可能日数、`get_historical_volatility`の返却範囲。
- G0-3: (a)オプション手数料体系（出典URL・API配信有無・vol pt/週変換方法）、(b)実スプレッド スナップショット（bps・取得UTC時刻）、(c)perpヘッジコスト内訳（手数料＋板スリッページ）、統合週次コストとlab仮置き（1.5＋0.3）の並置。
- G0-4: ハーネス初回実行の meta（anchor日・warmup/live行数）、記録項目一覧、冪等性の2回実行証跡（追記0件）、DVOL/価格取得の実行環境（米国IP成否）。

---

## 5. 成果物（B実装チームが実装・報告するもの）

すべて `research/EXP-OBS000037/10-result/` 配下に生データとして出力。**判定語なし・事実と実測値のみ。**

1. **Deribitデータプローブ**: `scripts/probe-deribit-vrp-data.ts`（新規）。G0-1（米国IPアクセス性＝3エンドポイントのHTTPステータスを環境別に記録）＋G0-2（DVOL起点・T2/T3カバレッジ・RV自前計算 feasibility・VRP構築可否）を実測。lab `probe-deribit-vol-data.ts`/`probe-deribit-dvol-coverage.ts` は**参考のみ・コピペ禁止**（独立に書き直す）。ページング作法＝空応答/continuation終了（length<limit終了禁止）。認証不要の public エンドポイントのみ（APIキー・`.env.local` は読まない）。
2. **GitHub Actionsワークフロー（米国IP検証）**: 既存 `.github/workflows/forward-calibration.yml` への相乗り or 同型の新規ワークフローで `probe-deribit-vrp-data.ts` を米国IPから実行し、標準出力・HTTPステータスをArtifact/ログで回収（G0-1の判定材料＝米国IP結果）。
3. **Deribitコストモデルプローブ**: `scripts/probe-deribit-cost-model.ts`（新規）。G0-3の(a)オプション手数料表（公式URL＋`get_instruments`）(b)実スプレッド（`get_order_book`/`ticker`スナップショット）(c)perpヘッジコスト（手数料＋板スリッページ）を実データ/実仕様から構築し、lab仮置きと並置。API非配信項目は「仮置き/公式表由来」と明示。
4. **フォワード較正ハーネス**: `scripts/deribit-vrp-forward-paper.ts`（新規）。OBS000032の `bitget-carry-forward-paper.ts` を雛形に書き直し、日次冪等追記型ledger（§3 G0-4記録項目）を `research/EXP-OBS000037/10-result/forward/` に出力。初回セットアップ実行＋同日2回目実行で冪等性を自己検証。
5. **調査レポート**（生データ集約・Markdown可・判定語なし）:
   - **G0-1 アクセス性表**: 3エンドポイント × (米国IP/ローカル) のHTTPステータス・成否・レスポンス先頭・レート制限。
   - **G0-2 到達性表**: DVOL実起点、T1/T2/T3/calm各窓のDVOL実本数・欠損率・欠損日リスト、resolution/1リクエスト上限、RV採用価格源・VRP構築可能日数、`get_historical_volatility`返却範囲。
   - **G0-3 コスト表**: (a)手数料体系（出典・変換方法）(b)実スプレッド スナップショット(c)perpヘッジコスト内訳、統合週次コスト vs lab仮置き並置。
   - **G0-4 ハーネス表**: 初回実行meta（anchor/warmup/live行数）、記録項目、冪等性2回実行証跡、実行環境成否。
   - **エンドポイント実測メモ**: 実URL・パラメータ名・レスポンススキーマ・1リクエスト上限・レート制限・遡及可能な最深時点。
6. **再現メタ情報**: git commit hash、nodeバージョン、取得UTC時刻、使用エンドポイント一覧、取得件数、レート制限対応の待機設定、GitHub Actions実行のrun URL/ログ、再現コマンド、（新規取得CSVを保存する場合は）保存ファイル名。

---

## 6. データソース・一般知識のメモ（B実装官の出発点。**すべて実測で裏取り必須**）

以下はA設計官が把握する範囲の一般知識であり、**B実装官は着手時に実エンドポイント・パラメータ名・履歴深度・1リクエスト上限を必ず実測で確認**すること（下記が古い/誤っている可能性を前提に、実レスポンスを正とする）。

- **Deribit本番 public API（認証不要）**: base `https://www.deribit.com/api/v2`。JSON-RPC over HTTPS（GETクエリ形式も可）。
  - DVOL指数: `/public/get_volatility_index_data?currency=BTC&start_timestamp={ms}&end_timestamp={ms}&resolution={sec}`（resolution: 60/3600/86400秒。**日次=86400**。返却は `result.data`＝`[timestamp, open, high, low, close]` 配列＋`result.continuation`）。lab報告＝BTC DVOLは2021-04以降存在・LUNA/FTX窓カバー・2020-03非カバー（要独立実測）。
  - BTC価格履歴（RV用）: `/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&start_timestamp={ms}&end_timestamp={ms}&resolution=1D`（OHLC返却）。
  - RV短期（参考・長期不可）: `/public/get_historical_volatility?currency=BTC`（lab報告＝ローリング約15〜16日のみ＝長期RVはこのエンドポイントに依存せず価格から自前計算）。
  - 板/ティッカー: `/public/get_order_book?instrument_name={inst}&depth=5`、`/public/ticker?instrument_name={inst}`。
  - オプション銘柄/仕様: `/public/get_instruments?currency=BTC&kind=option`（手数料・contract仕様の該当フィールドを実測。非配信なら公式手数料表URLを出典に）。
  - **タイムスタンプはミリ秒UNIX**（要実測確認）。
  - 既存資産（RV計算フォールバック）: `scripts/data/btc-daily-binance-2017-2026.csv`（BTC現物日足）。採用時は出典を明記し「Binance価格由来RV」と区別。
- **OBS000032のフォワード較正基盤（G0-4の雛形）**: `scripts/bitget-carry-forward-paper.ts`（日付アンカー＝today−1・warmup back-fill＋go-live・日次冪等追記・冪等性自己検証・ページング空応答終了）。`research/EXP-OBS000032/10-result/forward/forward-paper-ledger-btc.json`（②/OBS000032との突合対象＝§8必須条件A）。
- **OBS000032の451対処前例（G0-1未達時の上申先）**: Firebase Blazeプラン＋asia-northeast1にCloud Functions中継プロキシ（共有トークン保護・環境変数経由）を新設しBinance 451を解消（ACTIVE 2026-07-11記録）。DeribitがG0-1未達なら同型対処の要否を上申。
- **不明点はすべて「B実装官が実測で確認すること」**。本specは推測を確定事実として扱わない。

---

## 7. 選定/確認・多重検定に関する注記（Stage 0の性質に合わせて）

- Stage 0 は**シグナル検証ではない**ため、選定/確認データ分割による signal 判定は**適用しない**（該当なし）。データ到達性・アクセス性・コスト実測手段・フォワード基盤 feasibility は事実計測であり、探索・最適化の対象ではない。選定/確認プロトコルはStage 1（lab予測単位再現＝選定BTC探索でなく"再現"／フォワード較正＝未見の前向きライブが確認データ）で適用する。
- **Stage 0でVRPの検定・会計・Sharpe算出・パラメータ探索（RV窓・vega notional・サイジング等）を一切行わない。** これらの事前登録・独立再現はStage 1のspecで行う（prescreen必須条件B）。
- §2の窓は**固定**（都合よくデータのある窓だけを選ぶHARKing防止）。G0-2のカバレッジは「BTC・T1/T2/T3/calm・DVOL日次・自前RV」という**限定条件の実測値**として記録し、VRP一般化には使わない。

---

## 8. 必須条件A・Bの実装への落とし込み

### 必須条件A（テール相関の第一級ゲート化）＝Stage 0では"測定基盤の準備"のみ
- **本測定（テール窓での②主軸＋OBS000032キャリーとの同時ドローダウン判定）はStage 1以降の職務**だが、Stage 0の段階で**後続で突合できる形にデータを準備**する。具体的には:
  - G0-4のフォワードledgerに **`date`（UTC日）をユニークキーとする `sleeve_return`（日次VRPスリーブ収益・資本比）列を必須で持たせる**。これは OBS000032のフォワードledger（`research/EXP-OBS000032/10-result/forward/forward-paper-ledger-btc.json`）と**同一UTC日付で join できる形式**とし、後日 Stage 1 で「テール窓（LUNA/FTX＋フォワードで観測される任意のボラ・スパイク）での VRPスリーブ × ②モメンタム × OBS000032キャリーの同時ドローダウン」を算出できるようにする。
  - G0-4のledgerに **DVOLスパイク（前日比大幅上昇）を candidate tail marker として記録**（後日テール窓の起点特定に使う）。
- **Stage 0ではこの相関・同時DDを計算・判定しない**（データ形式を揃えるのみ）。相関ゲートの数値固定はStage 1 specで行う（平時|ρ|<0.3だけでなくテール時同時DDで判定＝prescreen必須条件A）。

### 必須条件B（lab結果の独立再現）＝Stage 0では直接関係なし・Stage 1申し送り
- **Stage 0では扱わない**（本Stage 0でVRP検定・会計を再現しない）。**Stage 1 specへの申し送り事項として記録**:
  - Stage 1でB実装が `scripts/vrp-prediction-unit.ts`／`scripts/vrp-pipeline-accounting.ts` を**独立に書き直し**（lab `crypto-strategy-lab/research/EXP-OBS000001/` のスクリプトをコピペせず）、lab結論（**BTC平均VRP +10.91 vol pt・block-bootstrap p=0・n=275週・選定+15.07→確認+7.79・年率Sharpe 2.94・maxDD 9.7%**）を**再現**すること。
  - **新規パラメータ探索は禁止**（labで確認済みの結論の"再現"に徹する＝多重検定・HARKing回避）。再現できなければそこがバグの在処。

---

## 9. B実装チームへの指示（実装・調査・生データ出力のみ。解釈・判定・チューニング禁止）

1. **実装**: `scripts/probe-deribit-vrp-data.ts` / `scripts/probe-deribit-cost-model.ts` / `scripts/deribit-vrp-forward-paper.ts` を新規作成（公開API・認証不要のみ）。lab `probe-deribit-*.ts` は**参考のみ・コピペ禁止**（独立に書き直す＝labのバグ輸入回避）。OBS000032の `bitget-carry-forward-paper.ts` の**作法/構造**（日付アンカー・warmup/live・冪等追記・ページング）を起点に流用してよい。履歴深度・1リクエスト上限・手数料フィールドは**実測で確認**し実レスポンスをログに残す。APIキー・`.env.local` は読まない。
2. **G0-1の米国IP検証は必ずGitHub Actions（米国IP）で実行**し、HTTPステータスを回収すること（ローカル成功のみで完了報告しない＝OBS000032の451はローカルで再現しなかった教訓）。
3. **調査・実行**（mock不使用・実データ・BTCのみ・ETH取得禁止）:
   - G0-1: 3エンドポイントを米国IP（GitHub Actions）＋ローカルで叩き、HTTPステータス・成否を環境別に記録。
   - G0-2: DVOL実起点特定・T2/T3連続カバレッジ・T1窓外確認・RV自前計算 feasibility・VRP構築可否・欠損日リスト。**空応答/continuation終了・カーソル前進を生ログで自己点検**（§3チェックリスト厳守）。
   - G0-3: (a)オプション手数料表(b)実スプレッド スナップショット(c)perpヘッジコストを実データ/実仕様から構築し、lab仮置き（1.5＋0.3）と並置。API非配信は「仮置き/公式表由来」と明示。
   - G0-4: `deribit-vrp-forward-paper.ts` 初回セットアップ＋同日2回目で冪等性自己検証。ledgerに §8必須条件A の `sleeve_return`（OBS000032ledger突合形式）・DVOLスパイクmarkerを含める。
4. **報告**: §5 の成果物を `research/EXP-OBS000037/10-result/` に生データで出力。実測値・レスポンス原文・実URLをそのまま貼る。**完了報告の前に、生成した成果物ファイル（JSON/CSV/log）が実在し中身が空でないことを自分で確認してから報告すること**（031で3回連続発生した「実行完了を自己確認せず完了報告する癖」＝JSON未生成のまま完了報告・空JSONを成功報告、を繰り返さない）。
5. **禁止事項**:
   - 判定語（達成/未達/部分達成/十分/不十分/go/no-go/取れる/取れない/問題ない/難しい/有望/割に合う 等の**評価・結論**）を使わないこと。事実（「BTC DVOL日次の最古タイムスタンプは2021-03-24T00:00:00Z」「T2窓のDVOL欠損率は0%」「GitHub Actions実行でget_volatility_index_dataはHTTP 200」「BTC-PERPETUALテイカー手数料は公式表で0.05%」等）のみ。**達成/未達の当てはめと分岐(a)/(b)/差し戻しの宣告はC品質チームが行う。**
   - Stage 0のスコープ拡大（VRPシグナル検証・予測単位/会計の再現・Sharpe算出・パラメータ探索・**ETH取得**・窓の変更）をしないこと。対象は BTC 1銘柄・窓は§2固定・resolution=86400日次＝本specの固定値に従う。
   - **lab スクリプトのコピペ流用をしないこと**（独立書き直し＝必須条件Bの精神・030/031型バグ輸入回避）。
   - **ページングバグを再発させないこと**（空応答/continuation終了・length<limit終了禁止）。窓連続性の欠損日を必ず出力。本specにない測定条件を足さない。
6. **上申**: 実測の結果、本specの前提（例: DeribitがGitHub Actions米国IPから451/CloudFront遮断／DVOLがT2/T3に届かない／価格履歴が取れずRV構築不可／オプション手数料が公開手段で取れない等）が崩れる場合は、**基準を自分で緩めず**、事実を明記してA設計官・Sに差し戻す。カーソル非前進などページングバグの兆候を検知した場合も同様（030/031の偽陰性・虚偽報告の再来を防ぐ）。

---

## 変更履歴
- 2026-07-12: 初版作成（A設計チーム）。EXP-OBS000037（SYS-001 VRP＝BTCデルタニュートラル・ショートボラ）のStage 0 spec確定。**VRPシグナル採否でなく、Deribitデータ実現可能性・米国IPアクセス性・実コスト実測手段・フォワード較正ハーネス feasibility の技術調査**であることを冒頭明記。対象＝**BTCのみ**（ETHは`SYS-001-ETH`分離・取得禁止）。窓を日付固定（T1コロナ=窓外確認対象／T2 LUNA・T3 FTX=DVOLカバー必須／INC=DVOL起点探索／calm=2021H2）してHARKing封じ。**G0-1（Deribit米国IPアクセス性＝最優先・単独生死ゲート）**＝DVOL/価格/板の3エンドポイントを**GitHub Actions（米国IP）**から叩きHTTP 200＋正常JSONで達成／一部ブロックで部分／DVOL・価格が403/451/遮断で未達（OBS000032のBinance 451と同型・ローカル成功は判定に使わない）。**G0-2（DVOL深度・RV自前計算）**＝DVOL日次がT2/T3連続カバー（欠損率<5%）＋実起点特定＋価格からRVを年率ボラ%で自前計算しVRP_t=DVOL_t−RV_t構築可で達成／片窓・注記で部分／T2/T3非到達・RV構築不可で未達（`get_historical_volatility`はローリング15-16日で長期不可＝自前計算依存）。**G0-3（実コスト実測手段）**＝(a)Deribitオプション手数料表(vol pt/週変換)(b)実スプレッド スナップショット(c)perpヘッジコストを実データ/実仕様で構築しlab仮置き(1.5+0.3)と並置で達成／スナップショット限定・仮置き併記で部分／手数料・ヘッジ組めずで未達。**Sharpe≥1.0のネット判定はStage 1へ明示的に申し送り（会計独立再現=必須条件B依存）**。**G0-4（フォワード較正ハーネス feasibility）**＝`deribit-vrp-forward-paper.ts`が初回稼働しDVOL/価格取得・warmup/go-live記録・追記型ledger出力・同日2回実行で冪等性自己検証で達成／項目欠落・米国IP未確認・7日未経過で部分／取得不可・非冪等で未達。**総合判定＝GO(G0-1達成×G0-2達成×G0-4達成×G0-3達成/部分)／分岐(a)保留・司令塔上申(G0-1未達は最優先規則で他ゲート問わず(a)・またはG0-4未達→OBS000032のCloud Functionsプロキシと同型のインフラ投資判断を上申)／分岐(b)限定GO(G0-2部分達成)／差し戻し(G0-1達成×G0-3未達)**をCが宣告する形で基準固定。**必須条件A**＝Stage 0では測定基盤準備のみ（G0-4 ledgerに`sleeve_return`をOBS000032 ledger突合形式で持たせ後日テール同時DD算出可に・DVOLスパイクmarker記録・相関計算/判定はStage 1）。**必須条件B**＝Stage 0対象外・Stage 1申し送り（`vrp-prediction-unit.ts`/`vrp-pipeline-accounting.ts`を独立書き直しでlab結論[平均VRP+10.91/p=0/Sharpe2.94/maxDD9.7%]再現・新規探索禁止）。使用スクリプト＝新規 probe-deribit-vrp-data.ts / probe-deribit-cost-model.ts / deribit-vrp-forward-paper.ts＋GitHub Actions米国IP検証ワークフロー（lab probe-deribit-*はコピペ禁止・参考のみ・bitget-carry-forward-paper.tsの作法流用可）。B実装官には判定語禁止・生データのみ・米国IP検証はGitHub Actions必須・lab コピペ禁止・ETH取得禁止・ページングバグ非再発・成果物実在確認後の完了報告（031の虚偽報告癖の再発防止）を指示。
