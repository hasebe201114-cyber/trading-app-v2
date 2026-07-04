# 実験仕様書（Spec） - EXP-OBS000028

> 担当: 戦略設計官（strategy-architect）
> 鉄則: **成功基準は「回す前」に数値で確定する**（HARKing防止）。結果を見てから基準・重み・時間軸セットを後付けで変えない。
> 前提: 参謀官 prescreen＝GO（テーマ②「生シグナル天井Sharpe0.40の底上げ」第一仮説＝マルチ時間軸モメンタム合成）。親（②の系譜）= OBS000020 / OBS000023 / OBS000024。

## 対応OBS番号
**OBS000028（暫定・E記録進行官の採番で確定）**。現行最新はOBS000027。親（②系譜）: OBS000020（モメンタム単体頑健性）/ OBS000023（②k-NN→モメンタム差替採用）/ OBS000024（確信度z値動的化 scale=30）。

## 仮説（1文・falsifiable）
「②の生シグナルを **複数ホライズンのモメンタム合成**（事前登録した離散候補から選定→凍結した単一構成）に置き換えると、**単一 L=30・scale=30（現行②）** に対し、**未見データ（BTC直近＋ETH全期間）**で「予測単位の方向エッジ（permutation p<0.05 かつ 生シグナルSharpe≥ベースライン）」と「パイプライン純Sharpe改善（confirmation平均で +0.15 以上、ETHで非劣化）」の**両方**を同時に達成する」。
→ どちらか一方でも未達なら仮説は棄却（合成は単一L=30を超えない）。

## 合成方式の設計（固定するもの / 可変にするもの）

### 固定するもの（可変にしない＝自由度を作らない）
- ベースライン②: `momentumLookback = 30`, `momentumConfidenceScale = 30`（＝現行本番②。比較の唯一の基準）。
- 共通パラメータ: `horizon = 10`, `k = 30`, `initialEquity = 1_000_000`。
- ④統合（`src/decision-layer/combineSignals.ts`）・⑤Kelly・⑥コスト: **main のまま完全無改変**（今回いじるのは②の生シグナル生成のみ）。③LLM層は不使用（OBS000027で打ち切り確定）。
- 合成の**重みは等加重で固定**（＝各ホライズンの重み最適化は行わない）。重みチューニングは prescreen 点1が指す最大の過学習源のため、**自由度として一切導入しない**。
- 確信度スケール: 合成版も `momentumConfidenceScale = 30` に固定（新たなチューニング自由度を作らない）。
- neutral判定・permutation seed・N_PERM・フォールド境界: 既存スクリプト定義を踏襲し固定（下記）。

### 可変にするもの（＝選定で1つに絞る唯一の自由度。離散・列挙可能）
2軸の直積 = **8候補**を事前登録する。選定フェーズでこの8つから**単一構成を1つだけ**選び、以降は凍結。
- **時間軸セット（4通り, ホライズン群 L）**:
  - S1 = {10, 30, 90}
  - S2 = {20, 60, 120}
  - S3 = {15, 30, 60}
  - S4 = {30, 90, 180}
- **合成ルール（2通り）**:
  - **R-vote（符号多数決）**: 各 L_i で `s_i = sign(pctChange(close[t-L_i], close[t]))`（`NEUTRAL_THRESHOLD=0.0005` バンドで {-1,0,+1}）。`V = Σ s_i`。`direction = V>0?up : V<0?down : neutral`。確信度 = `clamp(50 + 30 × (|V|/|set|) × zbar, 50, 95)`（zbar = 多数派方向のホライズンの `z_i = |momRet_i|/(vol20·√L_i)` の平均）。
  - **R-zsum（符号付きz和）**: 各 L_i で `z_i = pctChange(close[t-L_i], close[t]) / (vol20·√L_i)`（符号付き）。`composite = mean_i(z_i)`。`direction = composite>Z_NEUTRAL?up : composite<-Z_NEUTRAL?down : neutral`（`Z_NEUTRAL = 0.10` 固定）。確信度 = `clamp(50 + 30 × |composite|, 50, 95)`。
- **選定される自由度の総数 = 8（4×2）のみ**。多重検定はこの8択に限定され、未見データでの単一凍結構成の確認で偽陽性を炙り出す（下記）。

## 選定 / 確認プロトコル（過学習の炙り出し）

### 選定（探索）— BTCのみ。8候補から単一構成を1つ選ぶ
- **選定データ**: BTC `scripts/data/btc-daily-2010-2026.csv`、期間 **2011-01-01 〜 2022-12-31**（生シグナル＝予測単位ベース）。
- **選定メトリクス（事前確定・決定的）**: 上記選定期間で、各候補の**生シグナルの方向調整リターンのSharpe**（`momentum-robustness.ts` と同じ算出：horizon=10, stepping=HORIZON, 年率化）を計算し、**最大のものを選ぶ**。同点は**hit-rate**の高い方を採用。この選定は完全に決定的で、予測単位スクリプトとパイプラインスクリプトが**同一アルゴリズムで同一構成に収束**する（手動介入なし）。
- **確認データを選定に一切使わない**（BTC 2023以降・ETHは選定で参照禁止）。

### 確認（未見・凍結構成をそのまま適用）
選定で凍結した**単一構成**を、以下の未見データにそのまま適用（時間軸セット・ルールの再選択は禁止）。
- **BTC直近（同一資産・時間一般化）**: 2023-01-01 〜 末尾。
- **ETH全期間（別資産・最強ゲート）**: OBS000019でk-NNがBTCで良くETH再現せず不採用になった前例への防御。ETHは選定に一度も使わない完全未見。
  - 予測単位: ETH `eth-daily-2020-2023.csv`（全期間）＋ `eth-daily-2024-2025.csv`（全期間）。
  - パイプライン: ETH `eth-daily-binance-2017-2026.csv`。

## 成功 / 不採用の数値基準（回す前に確定）

### パイプライン統合（主ゲート＝採否はここで決まる。凍結構成 vs ベースラインL=30）
確認ウィンドウ（5枠）: **W1=BTC 2023年, W2=BTC 2024年, W3=BTC 2025年（2025-01-01〜末尾）, W4=ETH 2021-2026連続, W5=ETH 2023-2026直近**。各枠で `simulatePortfolio` を「ベースライン（momentumLookback=30, scale=30）」と「凍結合成構成」で回し純Sharpe/DDを比較。

**採用（P1〜P4を全て満たす）:**
- **P1（平均改善）**: 5枠の平均 `Sharpe(合成) − Sharpe(ベースライン)` **≥ +0.15**（BTC②単体の現状平均≈0.665→PJ000001目標0.8のギャップ≈0.135を埋める水準）。
- **P2（広がり・チェリーピック排除）**: `Sharpe(合成) ≥ Sharpe(ベースライン)` の枠が **≥ 3/5**。
- **P3（最悪フォールド下限・大崩れ防止）**: 5枠の `Sharpe(合成) − Sharpe(ベースライン)` の**最小 ≥ −0.15** かつ **全枠で Sharpe(合成) ≥ 0**（負Sharpe暴発なし）かつ **全枠で 合成の最大DD がベースライン比 +3pt を超えて悪化しない**。
- **P4（ETH必須ゲート）**: ETH枠（W4, W5）の平均 `Sharpe(合成) − Sharpe(ベースライン)` **≥ 0**（未見の別資産で合成が単一L=30を下回らないこと）。

### 予測単位（診断ではなく採用の必須構成要件。パイプラインと両方満たして初めて採用）
凍結合成構成の**生シグナル単独**が、②④⑤⑥を通さずhorizon=10日先リターンに方向エッジを持つか。
- **Q1（方向エッジ・ETH未見）**: ETH確認（2020-2023 と 2024-2025 をプール）で、合成生シグナルの **hit-rate > 50% かつ permutation p < 0.05**（N_PERM=5000, seed固定）。
- **Q2（単一比較・ETH未見）**: 同ETH確認プールで、**合成生シグナルの方向調整Sharpe ≥ ベースラインL=30の方向調整Sharpe**（単一に対し信号レベルで勝つ／少なくとも劣らない）。
- BTC直近（2023-末尾）は**副次確認**として同指標を必ず併記（参考）。

### 不採用（下記いずれか）
- パイプライン P1〜P4 のいずれか未達。
- 予測単位 Q1 または Q2 未達（ETH未見で方向エッジが再現しない／単一に勝てない）。
- 選定フェーズで、8候補のいずれも選定期間でベースラインL=30の生シグナルSharpeを上回れない場合 → **合成は増分価値なしとして即不採用・停止**。

### kill基準（HARKing・チューニング逃避の禁止）
事前登録した8候補・選定メトリクス・確認ウィンドウ・P1〜P4/Q1/Q2 の下で未達なら、**仮説を棄却して不採用で停止する**。確認結果を見てから **時間軸セット/ルール/重み/scale/neutral閾値/フォールド境界を調整して再測定してはならない**。別セット案（例: 4時間軸化、重み付け）を試したい場合は本実験のリスコープではなく、選定/確認分離を備えた**別OBSの新規起票**でのみ許可する。

## 測定範囲
- **期間**: 選定=2011-2022（予測単位BTC）。確認=BTC 2023-末尾（≈2026上期含む・結果に明記）＋ETH全期間。
- **資産**: **BTC＋ETH 必須**（ETHは確認の必須ゲート＝P4／Q1/Q2）。
- **レジーム別分解**: **要**。パイプライン確認は年次枠（W1-W3）＝実質レジーム分解、資産枠（W4-W5）＝別資産。各枠を個別に生出力（集約はCが行う）。
- **予測単位 と パイプライン統合 の両方を測定する**（片方だけは禁止）。同一spec内で並記出力。

## 使用スクリプト / 再現方法（想定）
### 1. 予測単位: 新規 `scripts/momentum-composite-robustness.ts`
- `momentum-robustness.ts` の構造を踏襲。8候補（S1-S4 × R-vote/R-zsum）の生シグナルを実装（上記式のとおり、等加重固定・scale=30固定・Z_NEUTRAL=0.10固定）。
- BTC 2011-2022 で8候補の生シグナルSharpe/hit-rateを走査し、選定メトリクスで**単一構成を決定的に選ぶ**（選ばれた `(set, rule)` を明示出力）。
- 凍結構成をETH確認（2020-2023＋2024-2025プール）とBTC直近（2023-末尾）に適用し、hit-rate・方向調整Sharpe・permutation p（N_PERM=5000, seed=20260704固定）を算出。ベースラインL=30も同確認データで同時算出し併記。
- 実行: `node --experimental-strip-types scripts/momentum-composite-robustness.ts`

### 2. パイプライン: 新規 `scripts/pipeline-backtest-momentum-composite.ts` ＋ `simulatePortfolio` の②合成パス追加
- **`src/pipeline/simulatePortfolio.ts` / `types.ts` の最小拡張（②のみ・④⑤⑥不変）**:
  - `PipelineConfig` に `momentumLookbackSet?: number[]` と `momentumCompositeRule?: 'vote' | 'zsum'` を追加。
  - `predictFromMomentumComposite(candles, idx, lookbackSet, rule, vol20, confidenceScale)` を新設（上記R-vote/R-zsumの式そのまま）。既存 `predictFromMomentum`（単一L）は**一切変更しない**（ベースライン互換維持）。②の分岐で `momentumLookbackSet` 指定時は合成、それ以外は従来どおり。
  - ④以降のシグナル統合・Kelly・コストは無改変。
- スクリプトは `momentum-composite-robustness.ts` と**同一の選定アルゴリズム**（BTC 2011-2022 生シグナルSharpe）で `(set, rule)` を決定的に選び（btc-daily-2010-2026 を読んで選定）、凍結構成でパイプライン確認W1-W5を実行。
- パイプライン用データ: `btc-daily-binance-2017-2026.csv` / `eth-daily-binance-2017-2026.csv`。ウィンドウ切り出しは `pipeline-backtest-momentum.ts` の `runWindow`/`candleIndexAtOrAfter` 方式を踏襲。
- 各枠で ベースライン(momentumLookback=30, scale=30) と 合成(momentumLookbackSet, rule, scale=30) を出力（T件数・勝率・Ret・DD・Sharpe）、枠ごと差分、サマリー（平均Sharpe差分・P2枠数・P3最悪/DD・P4 ETH平均）。
- 実行: `node --experimental-strip-types scripts/pipeline-backtest-momentum-composite.ts`

## B検証実装官への指示（実装・実行・生データ出力のみ。解釈・チューニング禁止）
1. **実装**:
   - `simulatePortfolio.ts`/`types.ts` に②合成パス（`momentumLookbackSet` / `momentumCompositeRule` / `predictFromMomentumComposite`）を追加。式は本spec「合成方式の設計」のとおり厳密に。**既存単一Lパス・④⑤⑥は無改変**。
   - `scripts/momentum-composite-robustness.ts`（予測単位）と `scripts/pipeline-backtest-momentum-composite.ts`（パイプライン）を新規作成。8候補・選定メトリクス・確認ウィンドウ・permutation設定は本specの値をハードコード（可変にしない）。
   - 選定アルゴリズムは両スクリプトで同一（BTC 2011-2022 生シグナルSharpe、同点hit-rate）とし、選ばれた `(set, rule)` を両出力に明記。
2. **実行**（BTC＋ETH、③・mockは不使用）:
   - 予測単位: 8候補の選定期間スコア一覧（生数値）、選定された `(set, rule)`、ETH確認プール＋BTC直近での 合成/ベースライン の hit-rate・方向調整Sharpe・permutation p、を**スクリプト出力そのまま**貼る。
   - パイプライン: W1-W5 の ベースライン/合成（T・勝率・Ret・DD・Sharpe）、枠差分、サマリー（平均Sharpe差分／P2枠数／P3最悪差分・全枠DD・全枠Sharpe符号／P4 ETH平均差分）を生出力で貼る。
3. **再現メタ情報**: git commit hash、node バージョン、使用データ（ファイル名・本数・期間・可能ならハッシュ/バイトサイズ）、permutation seed を併記。
4. **禁止**: 良し悪しの判定語（「改善/悪化」等）、閾値・時間軸セット・重み・scale・neutralの調整、確認結果を見ての選定やり直し。P1〜P4/Q1/Q2を満たさなくても勝手に振らない。判定はCが行う。生データのみを `research/EXP-OBS000028/10-result/` に出す。

## 変更履歴
- 2026-07-04: 初版作成（A戦略設計官）。マルチ時間軸モメンタム合成。可変自由度=時間軸セット4×ルール2の8択のみ（重み等加重固定・scale=30固定）。選定=BTC 2011-2022 生シグナルSharpeで単一凍結、確認=BTC直近＋ETH未見。採用=パイプラインP1〜P4 かつ 予測単位Q1/Q2。kill/HARKing禁止を数値固定。OBS番号は暫定OBS000028（E採番待ち、親OBS000020/023/024）。
