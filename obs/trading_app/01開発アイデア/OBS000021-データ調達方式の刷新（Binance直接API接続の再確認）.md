# OBS000021 - データ調達方式の刷新（Binance直接API接続の再確認）

## 変更履歴
- 2026-07-04: 起票。ネットワークポリシーによりブロックされているとされていた取引所API（Binance/CoinGecko）に、実際には直接アクセス可能であることを確認。連続・高品質なBTC/ETH日足データとFunding Rate履歴を取得しGitに保存した

## 関連ドキュメント
- [OBS000014-LLM特徴量抽出層の実LLM化.md](../80実装中/2026-07-02/OBS000014-LLM特徴量抽出層の実LLM化.md)（「取引所API・CoinGeckoはネットワークポリシーでブロック」と記載していた前提）
- [obs/current-situation-review.md](../../current-situation-review.md)（「リアルタイムデータ調達の課題」を構造的リスクとして挙げていた）
- [OBS000019-②のETHクロス検証（BTC以外での再現性）.md](OBS000019-②のETHクロス検証（BTC以外での再現性）.md)（GitHub由来ETHデータに9ヶ月の欠落があった問題）
- [obs/trading_app/レビュー/20260704-マルチストラテジー化改善提案(第三者レビュー原本).md](../レビュー/20260704-マルチストラテジー化改善提案(第三者レビュー原本).md)（Funding Rateキャリー戦略の提案。本件のデータ基盤がこれを実データで検証可能にした）

## 背景
OBS000014で「Binance等取引所API・CoinGeckoは開発サンドボックスのネットワークポリシーでブロックされている」と記録し、以後GitHub raw経由のコミュニティデータセット（`btc-daily-2010-2026.csv`等）で検証を続けてきた。2026-07-04、モメンタム戦略検証（OBS000020）に続きFunding Rateキャリー戦略を検証する必要が生じたため再確認したところ、**以下のエンドポイントに直接アクセス可能**であることが判明した:

```
https://api.binance.com/api/v3/klines          … spot日足OHLCV（200,OK）
https://fapi.binance.com/fapi/v1/fundingRate   … USDT-M無期限先物 Funding Rate履歴（200,OK）
https://api.coingecko.com/api/v3/ping          … CoinGecko（200,OK）
```

いずれも認証不要の公開APIのみ使用。ネットワークポリシーが変更されたのか、以前の判定が誤りだったのかは不明だが、**現時点では利用可能**。

## 取得したデータ（`scripts/fetch-binance-data.ts`）
| ファイル | 内容 | 期間 | 件数 |
|---|---|---|---|
| `btc-daily-binance-2017-2026.csv` | BTCUSDT spot日足OHLCV | 2017-08-17〜2026-07-03 | 3,243本 |
| `eth-daily-binance-2017-2026.csv` | ETHUSDT spot日足OHLCV | 2017-08-17〜2026-07-03 | 3,243本 |
| `btc-funding-2019-2026.csv` | BTCUSDT Funding Rate（8時間おき） | 2019-09-19〜2026-07-03 | 7,440件 |
| `eth-funding-2019-2026.csv` | ETHUSDT Funding Rate（8時間おき） | 2019-11-27〜2026-07-03 | 7,232件 |

GitHub由来の既存データ（`btc-daily-2010-2026.csv`, `eth-daily-2020-2023.csv`, `eth-daily-2024-2025.csv`）と比べた優位点:
- **連続的で欠落がない**（既存ETHデータには2023-04〜2024-01の約9ヶ月の欠落があった）
- 取引所直接データのため出典・粒度が明確
- Funding Rateという新しい情報源を初めて利用可能に

## 今後の対応
- 既存のGitHub由来CSVは検証済みの過去結果（OBS000016〜020）の再現性のため残すが、**今後の新規検証はBinance直接データを優先**する
- 「①データ層」の設計・`obs/current-situation-review.md`記載の「リアルタイムデータ調達の課題」を見直す。Phase 4（フォワードテスト）以降もこの経路が使える場合、本番データパイプライン構築の前提が変わる可能性がある（要継続確認: ネットワークポリシーが今後も安定して利用可能か）
- `scripts/data/README.md` に出典・取得方法を記録済み

## ステータス
データ取得完了。このデータ基盤を用いてFunding Rateキャリー戦略の検証を実施（[OBS000022](OBS000022-Funding-Rateキャリー戦略の検証（第三者レビュー提案1）.md)）。
