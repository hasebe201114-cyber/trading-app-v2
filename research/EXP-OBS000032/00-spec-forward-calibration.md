# 実験仕様書（Spec） - EXP-OBS000032 / フォワード較正フェーズ（Bitgetペーパートレード ≥90日・F1〜F4）

> 担当: 設計チーム（strategy-architect）
> 鉄則: **合否基準は「回す前」に数値で確定する**（HARKing防止）。90日回した後に F1〜F4 の閾値・参照値・リスク予算・w*・シグナルを後付けで緩めない。
> 位置づけ: Stage 1（`00-spec-stage1.md`）のバックテスト4ゲート（G1A/G2B/G3C/G4C）を **C品質チームが採用可＝スリーブ候補として前進推薦**で宣告済み（`22-verdict-stage1-final.md`）。**ただしこれはバックテスト（Binance代理）条件付きの推薦であって本番反映（D起動）のGOではない。** spec §8・C条件C のとおり、**本番反映の必須前提＝本specの Bitgetフォワード較正（≥90日・F1〜F4合格）＋司令塔の最終GO**。本specはその「フォワード較正フェーズ」の実験仕様を確定する（Stage 1 spec §8「フォワード較正の設計」を実装可能な粒度まで具体化した確定版）。
> **本specはA設計官が実験仕様を確定するもの。スクリプト実装・実行はB実装チームが行う（A設計官は実装しない）。**

## 対応OBS番号
**OBS000032**（進行中・ACTIVE登録済み。採番はE進行チーム管理）。本フォワード較正は Stage 0（`20-verdict-stage0.md` 総合GO・4条件付き）→ Stage 1（`22-verdict-stage1-final.md` 採用可・バックテスト全ゲート達成）を通過した **第3ゲート（本番反映の最終前提）**。

---

## 0. このフェーズの性質・前提（回す前に固定）

### 0-1. なぜフォワード較正が本番採用の必須前提か（C条件C）
- Stage 0 G0-2 で **Binance⇔Bitget の平時代表性は弱い**ことが実測確定した（符号一致率 BTC 64.68% / ETH 71.75%、Pearson 相関 0.47 / 0.36、重複期間≈90日）。テール時の取引所間乖離は原理的に未観測。
- ゆえに **Binanceバックテストの好成績（スリーブ確認期間Sharpe 4.13・合成 Sharpe+0.864/DD−1.78pt）を本番採用の十分条件にしない**。バックテスト＝「キャリー存在＋テール被害挙動＋清算機構」の**存在検証グレード**、**Bitget実データでのフォワード（ペーパー）較正＝本番採用の確認グレード**（フォワード較正の比重を上げる＝C条件C）。
- **⚠ フォワード較正はテール検証の代替ではない**。Bitget無料funding履歴は≈90日で枯渇（Stage 0・OBS000030実測）＝フォワード期間中に歴史的テール（2020-03/2022-05/2022-11規模）が来る保証はない。テール頑健性は Stage 1 のBinance清算シミュに依存し続ける。フォワード較正が答えるのは **(i) 平時キャリーがBitget実funding/実basis/実清算で実際に収穫できるか (ii) Bitget固有性（代表性・basis暴れ・清算バッファ）がBinance想定と整合するか** の2点に限定する（この限定を成果物に明記させる）。

### 0-2. 実弾を使わない（ペーパートレード）
- **実資金・実発注は一切行わない。** Bitget公開API（認証不要）から日次で価格・fundingを取得し、**仮想的にデルタニュートラル・ポジションを保有していたと仮定**して日次の損益・証拠金・清算を帳簿（ledger）に記録する。APIキー・`.env.local` は読まない。

### 0-3. Stage 1 から引き継ぐ固定パラメータ（本specでも一切変更しない・ハードコード）
Stage 1（`00-spec-stage1.md` §2〜§5・`stage1-params.json`）で事前登録・実測確定した以下を**そのままフォワードに適用**する。フォワードで再最適化・グリッド探索・再選定を**一切行わない**。

| 項目 | 固定値 | 出典 |
|---|---|---|
| 構成 | 現物ロング×perpショート・等ノーション・デルタニュートラル | spec §2 |
| シグナル | **W=7 日**・日次合算funding の SMA_7 の符号でレッグ方向決定（先読み排除＝t−7..t−1のみ）。符号反転日に4レッグ往復コスト控除 | spec §2 |
| 反転ルール | `sign(SMA_7)>0`→現物ロング×perpショート／`<0`→現物ショート×perpロング（反転） | spec §2 |
| レバレッジ（採否判定帯） | **3倍**（IMR=1/3≈0.3333）。ショートperpレッグのみ証拠金差入れ、現物レッグは全額自己資本 | spec §3（採否は3倍のみ） |
| CVaRサイズ w* | **BTC 3.629 / ETH 3.789**（Stage 1-B 実測凍結値。フォワードで再算出しない） | `stage1-liquidation-sim-{btc,eth}.json`・`22-verdict` |
| MMR | **0.5%（=0.005・業界標準の仮置き・Bitget API非配信）** | spec §4-2・C条件D |
| 清算判定 | `margin_t < MMR × 名目` で清算イベント。方式I（分離証拠金・主判定） | spec §4-2/§4-3 |
| 資本コスト | ショートperp証拠金（1/L×名目）× **年率4%** を日次控除 | spec §4-4 |
| 片道コスト | **BTC 6.016bps / ETH 6.056bps**、反転4レッグ **BTC 24.064bps / ETH 24.224bps** | Stage 0 G0-3・`g0-3-cost-model.json` |
| 会計式 | `dailyPnl = spotLegPnl(pos適用) + perpレッグ実現P&L(floor0後増分) − 反転コスト − 資本コスト − (清算日)再構築コスト`。`margin_t = floor(0, margin_{t-1} + pos·perp_short_mtm + pos·funding_flow)`。清算損の二重計上をしない（Stage 1バグF根治版と同一会計） | `stage1-params.json` |

- **⚠ w* をフォワード実測CVaRで再算出してはならない**（フォワード90日ではテールが観測されずCVaRが過小＝過大サイズになる罠）。Stage 1 の凍結値（BTC 3.629 / ETH 3.789）を固定で使う。

---

## 1. 仮説（1文）

**Stage 1 でバックテスト全ゲートを達成したW=7デルタニュートラル・キャリースリーブ（3倍・w*サイズ）は、Bitgetの実funding・実basis・実清算バッファの下で ≥90日ペーパー運用しても、(F1)実現キャリーがバックテスト想定と整合してプラスに残り、(F2)Bitget⇔Binanceの符号代表性が≥80%に回復し、(F3)清算・追証が0件で、(F4)Bitget固有のbasis暴れがバックテストのテール窓水準を平時に超えない——ゆえに本番採用の前提（Bitget実現可能性）が満たされる。**

---

## 2. ペーパートレードの仕組み（B実装官が実装する挙動を固定）

### 2-1. 対象・単位
- **銘柄**: `BTCUSDT` / `ETHUSDT`（Bitget USDT-FUTURES perp ＋ 対応する現物）。両銘柄で独立にledgerを持つ。
- **損益単位**: 名目に対する率＝**bps**（Stage 1 と同一。正規化ノーション1.0）。実額（円/USDT）は不要。

### 2-2. 日次で取得するBitget公開データ（認証不要）
毎日（定期実行時）、以下をBitget公開APIから取得する。実エンドポイント・パラメータ名・レスポンススキーマは **B実装官が着手時に実測で確認**（下記は出発点。既存 `scripts/fetch-bitget-data.ts`／`fetch-bitget-intraday.ts`／`compare-bitget-binance-funding.ts` のページング作法・エンドポイントを流用）。

| データ | 出発点エンドポイント（実測で確認） | 用途 |
|---|---|---|
| 現物 日足終値 | `https://api.bitget.com/api/v2/spot/market/candles`（productType不要・spot） | ベーシス・現物レッグMTM |
| perp last 日足 | `https://api.bitget.com/api/v2/mix/market/candles`（`productType=USDT-FUTURES`） | perpレッグMTM・basis |
| perp mark 価格 | mark系エンドポイント（`.../mix/market/...`のmark系・要実測。取得不可なら **last代用＋「mark非可用のためlast代用（保守側）」と明記**） | 清算トリガー・basis（可用時） |
| funding（確定） | `https://api.bitget.com/api/v2/mix/market/history-fund-rate`（`productType=USDT-FUTURES`・pageSize=100） | シグナル・funding受払 |
| funding（当日/次回） | current-fund-rate 系（要実測） | 当日未確定分の暫定記録（確定はhistoryで上書き） |

- **⚠ ページングバグ非再発**: Bitget funding は空応答（返却0件）で終了。`length < pageSize で break` を終了条件に使わない（既存 `compare-bitget-binance-funding.ts` L95 が該当パターン＝流用時に修正すること）。カーソル前進・返却件数を生ログに残す。

### 2-3. 仮想ポジションの日次更新（Stage 1-B 方式I と同一会計）
各銘柄・**3倍・w* サイズ**で、日次に以下を更新する（Stage 1 `carry-liquidation-sim.ts` の会計をそのまま踏襲。**新しい会計を発明しない**）:

1. **シグナル**: 日次合算funding（Bitget実funding、1日3イベント＝8h×3の合算）の `SMA_7`（t−7..t−1、先読み排除）の符号で `pos ∈ {+1(順キャリー), −1(反転)}` を決定。前日から符号反転した日は `reversal_flag=1`。
2. **証拠金更新**: `margin_t = floor(0, margin_{t-1} + pos·perp_short_mtm_t + pos·funding_flow_t)`。
   - `perp_short_mtm_t = −(perp_t/perp_{t-1} − 1)`（mark可用時はmark基準、非可用時はlast＋注記）。
   - `funding_flow_t = ±funding_daily_t`（順キャリーでショートが受取＝＋、負転で払う＝−）。
3. **日次純P&L**: `dailyPnl_bps = spotLegPnl(pos適用) + perpレッグ実現P&L(floor0後増分) − 反転コスト(反転日のみ 4レッグ) − 資本コスト(日次) − 再構築コスト(清算日のみ 4レッグ)`。
   - 現物レッグは毎日そのまま計上＝清算で消えない（Stage 1バグF根治版と同一）。
4. **清算判定**: `margin_t < MMR × 名目` を清算イベントとし `liquidation_flag=1`。清算後は margin を IMR にリセットし当日 4レッグ再構築コストを控除（方式I）。
5. **累積**: `cumulative_net_pnl_bps += dailyPnl_bps`。

- **サイズ適用**: w* は「配分資本に対するグロス名目倍率」。日次bps系列に w* を乗じてスリーブ資本ベースの日次リターンも併記（Stage 1-B と同一の位置づけ）。清算・basis統計は名目基準bps（w*非乗算）でも記録する。

### 2-4. F2用のBinance同時取得（ライブ重複ペア）
- 同一実行日に、**Binance の同期間funding**（`https://fapi.binance.com/fapi/v1/fundingRate`・認証不要）も取得し、Bitget funding とタイムスタンプでペア化して符号一致・相関を**ライブで**蓄積する（G0-2 の90日重複を、フォワード期間の新鮮なライブ重複で置き換え・延長する）。

---

## 3. 記録すべき項目（ledgerのデータ形式・固定）

`research/EXP-OBS000032/10-result/forward/` 配下に、**追記型**で以下を出力する（毎回の実行で当日行を1行追記・冪等）。

### 3-1. 日次ledger（`forward-paper-ledger-{btc,eth}.csv` ＋ 同名 `.json`）
1行＝1 UTC日。カラム（固定・順序厳守）:

```
date_utc, phase, spot_close, perp_last, perp_mark, mark_source,
basis_bps, funding_rate_daily_bps, sma7_funding_bps, signal_pos, reversal_flag,
perp_short_mtm_bps, funding_flow_bps, spot_leg_pnl_bps, reversal_cost_bps,
capital_cost_bps, reconstruction_cost_bps, daily_net_pnl_bps, cumulative_net_pnl_bps,
margin_ratio, imr, mmr, liquidation_flag, margin_call_flag,
sleeve_daily_return_pct, sleeve_cumulative_return_pct,
binance_funding_daily_bps, f2_pair_sign_match, data_gap_flag
```

- `phase` ∈ {`warmup`（初回back-fill・F1〜F4評価対象外）, `live`（go-live以降・F1〜F4評価対象）}。
- `mark_source` ∈ {`mark`, `last-substitute`}（mark非可用時は `last-substitute` と明記＝C条件D）。
- `margin_call_flag`: `margin_t < MMR×名目` を追証相当イベントとして1（方式I分離証拠金では清算と同時。定義を meta に明記）。
- `data_gap_flag`: 当日データ取得失敗・欠損なら1（後述チェックポイントの監視対象）。

### 3-2. メタ情報（`forward-meta.json`）
- go-liveの UTC日付、経過ライブ日数、warmup back-fill期間、銘柄別 w*（BTC 3.629 / ETH 3.789）、固定パラメータ一覧（§0-3の表）、Bitget/Binance実エンドポイント・パラメータ・1リクエスト上限・レート制限待機、mark系列の可用性（mark/last代用の別）、git commit hash・nodeバージョン・各実行のUTC時刻。

### 3-3. 中間メトリクス（`forward-interim-metrics.json`）＋ 警告ログ（`forward-alerts.log`）＋ 実行ログ（`forward-run.log`）
- 毎回の実行で F1〜F4 の暫定集計（ライブ分のみ）と §6 の中間チェックポイント判定を再計算して上書き。**判定語（合格/不合格等）は使わず、実測値＋閾値との大小の真偽値のみ**（採否宣告はC・最終GOは司令塔）。

---

## 4. F1〜F4 の合否基準（回す前に数値で確定・後から緩めない）

**評価対象＝`phase=live` の連続 ≥90暦日**（warmup back-fill 分は除外）。両銘柄それぞれで算出し、**BTC・ETH 両方で成立して初めて F を満たす**（片銘柄のみ成立は「単一資産の偶然」として不成立・Stage 1 §7 と同一の両成立要件）。**判定はC品質チームが本specの基準に当てはめて行う。B実装官は実測値と閾値の真偽値のみ出力。**

### F1 — 実現キャリー整合（バックテスト想定と実収穫額が整合するか）
以下 **F1a・F1b の両方**を満たすとき F1 成立:
- **(F1a) 累積プラス**: ライブ ≥90日の **累積ネットキャリー（全コスト控除後・bps）> 0**。
- **(F1b) 水準整合（下方乖離しない）**: ライブ期間の **日次平均ネットキャリー(bps) ≥ バックテストcalm窓 日次ネットキャリーの片側90%下側境界**。
  - 片側90%下側境界＝Stage 1-A の **calm窓（2021-01-01〜2021-06-30）日次ネットキャリー系列**（BTC 平均 11.62bps・ETH 平均 14.40bps／出典 `stage1-net-expectation-{btc,eth}.json` calm）に対し、**block-bootstrap（ブロック長7・N=5000・seed=20260705）で「ライブと同一日数の窓平均」の分布**を作り、その **第10パーセンタイル**を下側境界とする（B実装官が calm 日次系列から算出・値をログに出す）。
  - ライブ日次平均が下側境界以上なら F1b 成立。
  - **⚠ calmは高funding基準の参照窓**である。ライブ期間の funding 水準がバックテストcalmより構造的に低い場合、F1b はモデル欠陥でなくレジーム差で未達しうる。**F1b 未達は自動不採用にせず §5 の未達扱い（S/司令塔へ上申）に回す**（フォワード延長 or 不採用の人間判断）。参照の補助として、Stage 1-A **FULL期間**日次平均（BTC 1.586bps・ETH 2.368bps）との比較も**併記（ゲートではない・文脈提供）**。

### F2 — 取引所代表性の再検証（G0-2の弱テストを新鮮なライブ重複で補う）
- ライブ ≥90日の **Bitget funding と 同期間Binance funding の符号一致率 ≥ 80%**（両銘柄）で F2 成立。
- **粒度**: G0-2と同じ **8hイベント単位**で符号判定（日次合算ではなく、Bitget・Binance両取引所の8hイベント（3イベント/日）を1対1でペア化・符号比較し、一致率を算出）。これにより日次合算のノイズ均し（偽陽性化）を回避し、G0-2の基準（64.68% / 71.75%）との粒度を統一。
- 基準比較: G0-2 の直近90日は BTC 64.68% / ETH 71.75%（`g0-2-exchange-representativeness.json`）。フォワードの新鮮な重複で 80% 以上に回復するかを測る（粒度統一後）。
- **併記（ゲートではない・文脈提供）**: Pearson/Spearman 相関、ペア数N、`|funding| がノイズ床（例: 0.5bps/8h）を超えるイベントに限定した符号一致率**（低fundingコイン投げ縮退の交絡を切り分けるための参考。閾値0.5bpsは参考値・ゲートに使わない）。

### F3 — 清算・追証ゼロ（サイジングが実運用で保守的に効いているか）
- ライブ ≥90日で、**3倍・w* サイズにおいて 清算イベント（`liquidation_flag=1`）0件 かつ 追証イベント（`margin_call_flag=1`）0件**（両銘柄）で F3 成立。
- **⚠ 早期警告**: 清算・追証は90日を待たず、**発生した時点で即座に §6 の警告を発火**（F3方向の逸脱）。

### F4 — ベーシス挙動整合（Bitget固有のbasis暴れがBinance想定を超えないか）
- ライブ ≥90日の **Bitget実basis の 日次変化std(bps) ≤ バックテストのテール窓T1 basis daily_delta_std**（BTC **12.14bps** / ETH **19.47bps**・出典 `g0-1-tail-reachability.json` T1_basis daily_delta_std_bps）で F4 成立（両銘柄）。
  - ＝平時のBitget basis暴れが、バックテストで観測した最悪テール窓（コロナ）水準を超えないこと。
- **併記（ゲートではない・文脈提供）**: バックテスト calm窓 basis daily_delta_std（BTC 5.08bps・ETH 8.70bps）との比較。ライブが calm水準に近いか T1水準に近いかを可視化。

### 総合（回す前に確定）
- **本番採用の前提が整う＝F1 かつ F2 かつ F3 かつ F4 を、BTC・ETH 両方で満たす**（ライブ ≥90日）。
- **上記が揃っても本番反映は自動化しない**。C品質チームの較正監査 ＋ **司令塔の最終GO** で初めて D統合反映（PJ000002鉄則）。
- **F1〜F4 のいずれか未達＝本番採用の前提未成立**＝基準を自分で緩めず、S/司令塔へ上申（**フォワード延長 or 不採用**の判断。F1b はレジーム差での未達を特に上申対象とする）。

---

## 5. 実行方式（日次追記型・1回で完結しない設計）

**⚠ これは「1回実行すれば90日分完成する」スクリプトではない。「毎日（または定期的に）実行することでライブデータが1日ずつ蓄積される」設計にする。**

### 5-1. 初回実行（go-liveセットアップ）
初回実行時に以下を行う:
1. **シグナル・ウォームアップ back-fill**: W=7 SMA に最低7日、頑健性のため **直近30日**の Bitget funding（history-fund-rate は≈90日遡れる）＋現物/perp日足を back-fill して SMA_7 を立ち上げ、初期ポジション `pos_0` と初期証拠金 `margin_0=IMR` を確定。この back-fill 分は ledger に `phase=warmup` で記録し、**F1〜F4 の評価対象から除外**する（＝弱代表な過去データで90日を水増ししない・ライブOOS性を守る）。
2. **go-live日を確定**: 初回実行日（UTC）を go-live とし `forward-meta.json` に記録。F1〜F4 の評価窓＝go-live以降の `phase=live` 日のみ。
3. ledger・meta・interim-metrics・run.log を新規生成。

- **⚠ 90日を back-fill で即席に埋めない**: Bitget funding履歴は≈90日遡れるが、それを使って90日ledgerを一括生成するのは「Binance弱代表性の外に出る」というフォワードの目的（C条件C）を無効化する（同じ弱代表・非ライブデータの焼き直しになる）。back-fill はシグナル立ち上げの warmup ≤30日に限定し、F1〜F4 は **go-live以降のライブ蓄積 ≥90暦日**で評価する。

### 5-2. 2回目以降（日次追記）
定期実行（毎日・cron相当。手動でもよい）で毎回:
1. 既存 ledger・meta をロード（無ければ 5-1 の初回セットアップ）。
2. **冪等性**: ledger 最終日と当日を比較。同一日が既にあれば追記しない（当日funding未確定分のみ暫定→確定で上書き可）。欠損日があれば取得を試み、取れなければ `data_gap_flag=1` で記録。
3. 当日の Bitget 現物/perp/mark/funding ＋ Binance funding を取得。
4. §2-3 の会計で当日行を算出し **1行追記**。
5. §4 の F1〜F4 暫定集計（ライブ分）＋ §6 の中間チェックポイント判定を再計算して `forward-interim-metrics.json`・`forward-alerts.log` を更新。
6. run.log に当日の実行メタ（UTC時刻・取得件数・カーソル・エラー有無）を追記。

### 5-3. ≥90ライブ日到達後
- ライブ日数が 90 を超えたら、`forward-f1f4-verdict-inputs.json`（F1〜F4 の最終実測値＋各閾値＋真偽値・両銘柄）を出力し、**C品質チームの較正監査に引き渡す**。B実装官は判定語を使わず実測値と真偽値のみ。
- **⚠ 追加検証項目（2026-07-12追加・司令塔指示・PJ000004課題#9関連）**: C較正監査時に以下を分解分析すること。既存のF1〜F4基準・閾値を変更・緩和するものではなく、その解釈に文脈を与える追加分析。
  - **順キャリー/反転局面の収益分解**: ledgerの`signal_pos`（+1=順キャリー／−1=反転・逆キャリー）と`reversal_flag`を用いて、順キャリー局面のみの累積収益と、反転（逆キャリー）局面のみの累積収益を分離集計する。
  - **反転局面の借入コスト後日再計算**: 本specの会計モデル（§0-3・§2-3）は、反転時の「現物ショート×perpロング」構成における現物ショートの借入コスト（Bitgetスポットマージンのborrow rate）を計上していない（資本コストはperpショート証拠金のみに課される）。ライブ90日間の実際のborrow rate水準をBitget公開API等で確認し、反転局面の収益から後日控除して再計算すること。
  - **実運用（btc-carry-executor）との整合確認**: 実行層は反転構成（現物ショート×perpロング）を実装しておらず「順キャリーのみ・逆局面はフラット化」で稼働する設計（2026-07-12時点）。ゆえに、F1参照値との比較は「順キャリーのみの収益」を主指標とし、「両方向合算（本specの生値）」は参考値として併記すること。実行層側で反転ロジックを追加実装する場合は、その時点で本specの会計モデルにも借入コストを追加し再検証すること。

### 5-4. スクリプト
- **新規 `scripts/bitget-carry-forward-paper.ts`**（Stage 1 spec §10-4 で設計固定済みのハーネスを本specの記録形式・F1〜F4基準で実装）。
  - 公開API・認証不要のみ。APIキー・`.env.local` を読まない。
  - Bitgetページング作法（空応答終了・カーソル前進・返却件数実測）を `fetch-bitget-data.ts` から流用（`length<pageSize break` を使わない）。
  - 会計は `carry-liquidation-sim.ts`（Stage 1バグF/G根治版・方式I）の日次会計を流用（新会計を発明しない）。
  - 実行: `node --experimental-strip-types scripts/bitget-carry-forward-paper.ts`（引数なしで冪等日次実行）。

---

## 6. 中間チェックポイント（90日を待たず早期に司令塔へ警告）

毎回の実行で、以下のいずれかを検知したら **`forward-alerts.log` に警告行を追記し、`forward-interim-metrics.json` の `alert_active=true` を立てる**（司令塔が `research/ACTIVE.md`／interim-metrics を見て早期判断できるように）。**B実装官は警告条件の真偽のみ立てる。緩和・停止判断はしない。**

| チェックポイント | 発火条件（早期警告） | 対応するF |
|---|---|---|
| **清算/追証発生（即時）** | `liquidation_flag=1` または `margin_call_flag=1` が1件でも出た日 | F3（90日を待たず即上申） |
| **符号一致急落** | 直近30ペアのローリング符号一致率 < 70%（G0-2水準を下回る） | F2 |
| **キャリー持続マイナス** | 累積ネットキャリーが負、かつ 直近10営業日連続で日次ネットがマイナス | F1 |
| **basis暴れ超過** | 直近30日のBitget basis 日次変化std が バックテストT1水準（BTC12.14/ETH19.47bps）を超過 | F4 |
| **データ欠損** | `data_gap_flag=1` が 2日以上連続、またはカーソル非前進・取得エラー継続 | データ健全性 |

- **マイルストーン中間サマリ**: ライブ **30日・60日** 到達時点で `forward-interim-metrics.json` に中間集計スナップショット（F1〜F4 暫定値・警告履歴）を残す（**採否宣告ではない・進捗と早期異常の可視化のみ**）。

---

## 7. 測定範囲（まとめ）

- **期間**: フォワードライブ ≥90暦日（go-live以降・warmup back-fill ≤30日は評価対象外）。中間 30/60日スナップショット。
- **資産**: **BTCUSDT・ETHUSDT 両方**（Bitget現物×perp）。**両成立で初めてF成立**（片銘柄のみは不成立）。
- **取引所**: Bitget（実運用取引所）を主。Binance funding はF2ライブ重複ペアのため同時取得。
- **レジーム別分解**: フォワードは平時中心（テール到来は保証されない）。**フォワード期間の funding水準・basis水準を実測記録し、バックテストcalm/FULL/T1水準と対比**（F1b・F4の文脈提供）。テール頑健性はStage 1清算シミュに依存＝本フェーズで代替しない旨を明記。
- **予測単位とパイプライン統合の両方**: F1（キャリー実現＝予測単位相当のネット期待値がライブで実現するか）と F3/F4（清算・basis＝パイプライン統合のテール/証拠金挙動）を**同一ledgerで並記**（片方だけの検証にしない）。F2は代表性の較正。

---

## 8. 使用スクリプト / 再現方法（想定）

- **新規 `scripts/bitget-carry-forward-paper.ts`**（§5-4）。日次冪等実行でledgerを追記蓄積。
- 流用: `fetch-bitget-data.ts`（ページング作法）・`compare-bitget-binance-funding.ts`（Bitget/Binance funding取得・ペア化。ただし `length<pageSize break` は修正）・`carry-liquidation-sim.ts`（方式I日次会計）。
- 入力データ: フォワードは**ライブ取得**（既存CSV流用は warmup 立ち上げの補助のみ）。バックテスト参照値（calm/FULL/T1）は `stage1-net-expectation-{btc,eth}.json`・`g0-1-tail-reachability.json` から読み込むかハードコード（BTC calm 11.62/FULL 1.586/T1 basisΔstd 12.14bps、ETH calm 14.40/FULL 2.368/T1 basisΔstd 19.47bps、w* BTC3.629/ETH3.789、コスト・MMR・資本コストは §0-3表）。
- 成果物: `research/EXP-OBS000032/10-result/forward/` に `forward-paper-ledger-{btc,eth}.{csv,json}`・`forward-meta.json`・`forward-interim-metrics.json`・`forward-alerts.log`・`forward-run.log`・（≥90日後）`forward-f1f4-verdict-inputs.json`。

---

## 9. B実装チームへの指示（実装・実行・生データ出力のみ。解釈・チューニング禁止）

1. **実装**: `scripts/bitget-carry-forward-paper.ts` を新規作成。§0-3 の固定パラメータ（W=7・3倍・w* BTC3.629/ETH3.789・MMR0.5%仮置き・資本コスト4%・片道/反転コスト・方式I会計）を**本specの値でハードコード**（可変にしない・グリッド探索禁止・w*をフォワードCVaRで再算出しない）。会計はStage 1バグF/G根治版の `carry-liquidation-sim.ts` を流用（新会計を発明しない）。公開API・認証不要のみ・APIキー/`.env.local`を読まない。
2. **実行方式**: **日次冪等追記**（§5）。初回はwarmup back-fill≤30日でシグナル立ち上げ＋go-live確定、F1〜F4評価はライブ≥90日。**90日をback-fillで一括生成しない**（C条件Cのライブ性を守る）。
3. **記録**: §3 のledger形式で毎回1行追記。mark非可用時は `last-substitute` 明記（C条件D）。MMR0.5%は「業界標準の仮置き（Bitget API非配信）」と明記（「Bitget API取得」と表記しない）。
4. **F1〜F4・中間チェックポイント**: §4 の閾値・§6 の警告条件を実測値と閾値の**真偽値**で出力。**判定語（合格/不合格/整合/達成/採用/十分 等の結論）を使わない**。採否宣告はC・最終GOは司令塔。
5. **禁止**:
   - F1〜F4の閾値・参照値（calm片側90%下側境界・符号80%・清算0・T1 basisΔstd）・w*・シグナル・リスク予算を結果を見て変える。
   - warmup back-fill でライブ90日を水増しする／弱代表な過去データでF1〜F4を満たしたことにする。
   - ページングバグ（`length<pageSize break`）の再発。カーソル前進・返却件数を生ログに残す。
   - **完了報告の前に成果物ファイルが実在し中身が空でないことを自分で確認**（030/031の「実行完了を自己確認せず完了報告する癖」を再発させない）。B自身が採否判定文書を発行しない。
6. **上申**: 実測でBitget mark系列が一切取れずlast代用も乖離過大／current-fund-rate/history-fund-rateのスキーマがspec想定と異なる／ライブ期間中に清算が発生／F1bがレジーム差で未達 等、本specの前提が崩れる場合は、**基準を自分で緩めず**事実を明記してA設計官・Sに差し戻す（§4総合の未達扱いに従い司令塔上申）。

---

## 変更履歴
- 2026-07-12: 司令塔とのセッションで、フォワード較正の会計モデル（§2-3）が反転（逆キャリー）局面の借入コストを計上していないこと、および実運用`btc-carry-executor`がこの反転構成自体を実装していないことが判明（PJ000004課題#9）。既存のF1〜F4基準・閾値は変更しないが、§5-3「≥90ライブ日到達後」に追加検証項目（順キャリー/反転局面の収益分解・借入コスト後日再計算・実運用との整合確認）を追記。Day90のC較正監査で対応する。
- 2026-07-05: 初版作成（A設計チーム）。EXP-OBS000032 フォワード較正フェーズ（Bitgetペーパートレード ≥90日・F1〜F4）specを確定。Stage 1（`22-verdict-stage1-final.md` 採用可・バックテスト全ゲート達成＝スリーブ候補推薦）を受け、C条件C・Stage 1 spec §8 を実装可能粒度まで具体化。**ペーパートレード機構**＝Bitget公開API日次取得（現物/perp last/perp mark/funding）＋Binance funding同時取得で、W=7・3倍・w*(BTC3.629/ETH3.789)のデルタニュートラル仮想ポジションをStage 1バグF/G根治版方式I会計（`margin_t=floor(0,margin_{t-1}+pos·perp_mtm+pos·funding_flow)`・清算損二重計上なし）で日次評価。**記録項目**＝29カラムの追記型ledger（basis/funding/signal/pnl/margin/清算/追証/F2ペア符号/phase warmup|live 等）＋meta＋interim-metrics＋alerts＋run.log。**F1〜F4合否基準を数値固定**：F1=累積>0 かつ ライブ日次平均≥calm窓(BTC11.62/ETH14.40bps)block-bootstrap片側90%下側境界（未達はレジーム差ゆえ司令塔上申・FULL 1.586/2.368bps併記）／F2=Bitget⇔Binance符号一致≥80%（G0-2基準64.68/71.75%・ライブ重複で再測）／F3=清算・追証0件（発生即警告）／F4=Bitget basis日次変化std≤T1水準(BTC12.14/ETH19.47bps)。**両銘柄成立で初めてF成立**。**実行方式＝日次冪等追記**（初回warmup back-fill≤30日でシグナル立ち上げ＋go-live確定、F1〜F4はライブ≥90暦日・90日をback-fillで一括生成しない＝C条件Cのライブ性厳守）。**中間チェックポイント**＝清算/追証即時・符号一致<70%・キャリー10日連続マイナス・basis T1超過・データ欠損2日連続で早期警告＋30/60日スナップショット。使用スクリプト＝新規`bitget-carry-forward-paper.ts`（fetch-bitget-data.ts/compare-bitget-binance-funding.ts[length<pageSize break修正]/carry-liquidation-sim.ts流用）。本番反映はF1〜F4両銘柄合格＋C較正監査＋司令塔最終GOの3点必須。B実装官に判定語禁止・生データのみ・w*フォワード再算出禁止・warmup水増し禁止・ページングバグ非再発・成果物実在確認後の完了報告・MMR仮置き明示を指示。担当をB実装チーム（フォワード較正ハーネス実装・日次ライブ蓄積待ち）に更新（A設計チーム）。
