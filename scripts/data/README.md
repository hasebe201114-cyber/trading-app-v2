# scripts/data

バックテスト・検証用の暫定データセットを配置している。

## btc-daily-2010-2020.csv（旧・Phase 1 PoC用）

- 出典: GitHub `MainakRepositor/Datasets` リポジトリで公開されている `Bitcoin Historical Data.csv`
  （investing.com エクスポート形式。元データの一次情報源・ライセンスは未確認）
- 期間: 2010-07-18 〜 2020-08-02（日足）
- 用途: Phase 1 PoCの実データ検証専用。以後の検証は btc-daily-2010-2026.csv を使用すること
- 既知の欠損: `Vol.` カラムに6件の欠損値（`-`）あり。パーサー側で除外している

## btc-daily-2010-2026.csv（現行・Phase 2以降の検証用）

- 出典: GitHub `mouadja02/bitcoin-technical-indicators-dataset`（**MITライセンス**）の
  時間足OHLCV（`bitcoin-hourly-ohlcv.csv`、Git LFS配布）をUTC日次に集約して生成
- 期間: 2010-07-18 〜 2026-07-01（日足、UTC基準）
- カラム: `date,open,high,low,close,volume_usd`
- ローダー: `scripts/loadCsvData.ts` の `loadOhlcvFromDailyCsv()`
- 検証済み: 旧CSVとの重複期間で終値が概ね一致（取引所間差異レベル）することを確認

## btc-news-2017-2026.csv.gz（③LLM特徴量抽出用ニュース）

- 出典: GitHub `soheilrahsaz/cryptoNewsDataset`（**CC0-1.0ライセンス**）。
  CryptoPanic.com のニュースアーカイブ約248,000件からBTC関連（currenciesタグにBTCを含む）を抽出
- 期間: 2017-09-23 〜 2025-12（約31,000件）。**2021年以降が高密度**（年2,000〜12,500件）、2017〜2020年は疎（計約330件）
- カラム: `datetime,title,important,positive,negative,sourceDomain`（datetimeはUTC）
- 用途: ③LLM特徴量抽出層の実LLM検証（OBS000014）。ニュース密度の関係で増分効果検証は2021年以降の期間で行う
- ローダー: `scripts/loadNewsData.ts`

## eth-daily-2020-2023.csv（ETHクロス検証用・OBS000019）

- 出典: GitHub `StephanAkkerman/crypto-forecasting-benchmark`（**MITライセンス**）のBinance ETHUSDT日足OHLCV
- 期間: 2020-07-20 〜 2023-04-15（日足999本）
- カラム: `date,open,high,low,close,volume_usd`（元データの追加列（quote volume等）は除外）
- 用途: ②パターン認識層のBTC以外での再現性検証（OBS000019）。BTCの高ボラ大相場期(2020-2023)に相当する期間として選定

## eth-daily-2024-2025.csv（ETHクロス検証用・OBS000019）

- 出典: GitHub `whchien/ai-trader`（GPL-3.0ライセンス。データ自体はYahoo Finance由来）のETH-USD日足
- 期間: 2024-01-01 〜 2025-12-14（日足713本）
- カラム: `date,open,high,low,close,volume_usd`（元データの`adj close`列は除外、日時のタイムゾーン部分は切り落として日付のみ抽出）
- 用途: ②パターン認識層のBTC以外・直近期間での再現性検証（OBS000019）
- 既知の制約: eth-daily-2020-2023.csv とは2023-04〜2024-01の約9ヶ月の欠落があり連続していない。2つの独立した検証期間として扱うこと

## btc-daily-binance-2017-2026.csv / eth-daily-binance-2017-2026.csv（OBS000021・直接API取得）

- 出典: Binance spot公開API `GET /api/v3/klines`（認証不要、直接アクセス可能と2026-07-04に再確認）
- 期間: 2017-08-17 〜 2026-07-03（日足、両銘柄とも3,243本）
- カラム: `date,open,high,low,close,volume_usd`
- 取得スクリプト: `scripts/fetch-binance-data.ts`
- 既存のGitHub由来CSVより連続的（欠落なし）。**今後の新規検証はこちらを優先使用**する

## btc-funding-2019-2026.csv / eth-funding-2019-2026.csv（OBS000021・OBS000022用）

- 出典: Binance USDT-M無期限先物公開API `GET /fapi/v1/fundingRate`（認証不要）
- 期間: BTCは2019-09-19〜、ETHは2019-11-27〜、いずれも2026-07-03まで（8時間おきイベント単位）
- カラム: `datetime,funding_rate`
- ローダー: `scripts/loadFundingRateData.ts`（UTC日次に集約）
- 用途: Funding Rateキャリー戦略の検証（OBS000022）

## 今後の対応
- Phase 4（フォワードテスト）以降は、このCSVではなく実際のAPIクライアント層から取得した
  データに切り替える
- 2026-07-04時点、Binance spot/先物公開API・CoinGeckoへの直接アクセスが可能であることを
  再確認した（OBS000021）。以前は「ネットワークポリシーでブロックされている」としていたが、
  現状は利用可能。ただし将来変わる可能性もあるため、都度確認すること

## 変更履歴
- 2026-07-02: btc-daily-2010-2026.csv / btc-news-2017-2026.csv.gz を追加（OBS000014）
- 2026-07-04: eth-daily-2020-2023.csv / eth-daily-2024-2025.csv を追加（OBS000019・②のETHクロス検証用）
- 2026-07-04: Binance直接API接続を再確認し btc/eth-daily-binance-2017-2026.csv・btc/eth-funding-2019-2026.csv を追加（OBS000021・OBS000022）
