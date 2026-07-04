# 生結果（Result）の置き方 - 10-result/

> 担当: 検証実装官（quant-researcher）
> 鉄則: **生データのみ。解釈・採否は書かない**（C懐疑検証官が独立に再判定するため）。

このフォルダ `10-result/` に以下を保存する：

| ファイル | 内容 |
|---|---|
| `prediction-unit.json` | 予測単位の結果。非重複サンプル、permutation p値、有効n を含む |
| `pipeline.json` | パイプライン統合（simulatePortfolio）の結果。Sharpe / 最大DD / 期間別・レジーム別 |
| `params.json` | 使用した全パラメータ（バージョン管理） |
| `run.log` | 実行ログ。**再現用の実行コマンドを必ず含める** |

## ルール
- 数字の良し悪しのコメントを書かない。
- specが要求した測定を**両方（予測単位＋パイプライン）**揃える。
- 決定的であること（同じコマンドで同じ結果）。
- 実行: `node --experimental-strip-types scripts/xxx.ts`
