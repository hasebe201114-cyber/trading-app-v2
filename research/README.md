# research/ - エージェント間バケツリレー作業場

このフォルダは、マルチエージェント体制（6体）が実験を手渡しで進めるための**作業場**です。
正式な記録は `obs/trading_app/` 側が「正」であり、ここは結論が出たら破棄してよい**揮発領域**です。

詳細な運営ルールは
`obs/trading_app/00プロジェクト方針/PJ000002-マルチエージェント運営計画書.md`
を参照してください。

## 構成
```
research/
├─ README.md              ← このファイル
├─ ACTIVE.md              ← E管理：進行状況の信号機（誰待ちか）
├─ STRATEGY-BRIEF.md      ← S管理：作戦ブリーフ（勝敗・停滞・次の一手）
├─ portfolio-ledger.md    ← S管理：採用/不採用/保留の台帳
├─ _templates/            ← 各成果物の雛形（ブレ防止）
│  ├─ prescreen.template.md
│  ├─ spec.template.md
│  ├─ result.readme.md
│  ├─ review.template.md
│  └─ decision.template.md
└─ EXP-OBSxxxxx/          ← 実験1件＝フォルダ1つ＝OBS番号と一致
   ├─ 00-prescreen.md     ← S：目利きゲート
   ├─ 00-spec.md          ← A：実験仕様
   ├─ 10-result/          ← B：生データのみ
   ├─ 20-review.md        ← C：採用/不採用判定
   └─ 30-decision.md      ← D/E：反映 or 棚卸し記録
```

## 実験の作り方（新規時）
1. E記録進行官が次のOBS連番を採番し、`EXP-OBSxxxxx/` を作成。
2. `_templates/` の雛形をコピーして各成果物を埋めていく。
3. 結論確定後、Eが要約をOBS件名へ吸い上げ、`EXP-OBSxxxxx/` は破棄してよい。
