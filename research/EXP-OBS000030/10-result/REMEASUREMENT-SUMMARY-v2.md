# 再測定結果総括（修正版） - EXP-OBS000030 Stage 0

**実行日時**: 2026-07-05  
**対象**: `scripts/fetch-bitget-data.ts` 修正版（バグ修正後）

---

## 実装修正内容

### 1. history-candles ページング修正（主因バグ）

**問題**:
- L211条件 `if (candles.length < pageSize)` が毎回発火し、1ページ目（90本）で即breakしていた
- Bitgetは1D粒度で最大約90本しか返さないため、limit=200でも超過分はキャップされる

**修正**:
- 終了条件を「空応答（0件）で終端」に変更
- 最古タイムスタンプの前進がない場合も終了

**結果**: BTC 2523日/2019-07-09起点、ETH 2493日/2019-08-09起点

---

### 2. endTime カーソル計算修正（副次バグ）

**問題**:
- L206-207で `candles[candles.length - 1]` を「最古」と誤認
- Bitgetは昇順（古い→新しい）で返すため、これは実際には最新

**修正**:
- 正しく `candles[0]`（配列先頭＝最古）のタイムスタンプを endTime に使用
- 次ページへは「oldestTs - 1」をカーソルとして渡す

---

### 3. Funding Rate ページング修正

**問題**:
- `pageSize=500` 指定だが実上限は100（超過分は黙ってキャップ）
- L282条件 `if (fundRates.length < pageSize)` で1ページ目で即break

**修正**:
- `pageSize=100` に是正
- pageNoを逐次進行

**結果**: Funding履歴は平均72日、最大90日で枯渇（真の制約、バグではない）

---

### 4. G0-2 死銘柄テスト修正

**問題**:
- テストシンボル LUNA2USDT/TERRUSDT は架空/誤綴り（code 40034）
- 実在した廃止銘柄（code 40309）との区別ができていない

**修正**:
- テストシンボルを実廃止銘柄に変更（SRMUSDT など）
- code 40034（不存在）vs 40309（廃止済）の識別ロジック追加

**テスト結果**:
- SRMUSDT: HTTP 400 / code 40309 "The symbol has been removed" → removed
- LUNA2USDT: HTTP 400 / code 40034 "Parameter ... does not exist" → nonexistent
- TERRUSDT: HTTP 400 / code 40034 "Parameter ... does not exist" → nonexistent

---

## 再測定結果

### G0-1: 日足履歴深度分析（修正後）

#### 上位50銘柄の統計（最古日付でソート）

| メトリック | N=20 | N=30 | N=50 |
|-----------|------|------|------|
| 3年ライン(2022-07-05以前)カバー | 14本 | 14本 | 14本 |
| 2022通年カバー | 14本 | 14本 | 14本 |

#### 主要銘柄の深度サンプル

| Symbol | 最古日 | 最新日 | 本数 | 日数カバー | 2022年カバー |
|--------|--------|--------|------|----------|-------------|
| BTCUSDT | 2019-07-09 | 2026-07-02 | 2523 | 2551日 | YES |
| ETHUSDT | 2019-08-09 | 2026-07-02 | 2493 | 2520日 | YES |
| BNBUSDT | 2019-07-08 | 2026-07-02 | 2524 | 2552日 | YES |
| XRPUSDT | 2019-08-27 | 2026-07-02 | 2475 | 2513日 | YES |
| BCHUSDT | 2019-09-23 | 2026-07-03 | 2449 | 2496日 | YES |
| ADAUSDT | 2020-08-18 | 2026-07-02 | 2122 | 2149日 | YES |
| LINKUSDT | 2020-08-04 | 2026-07-02 | 2136 | 2164日 | YES |
| AAVEUSDT | 2021-03-15 | 2026-07-02 | 1915 | 1938日 | YES |

（他45銘柄は各history-v2ファイルに記載）

**修正前との対比**:
- 修正前: N=50 で 3年カバー=0本, 2022通年=0本（偽陰性）
- 修正後: N=50 で 3年カバー=14本, 2022通年=14本（真値）

---

### G0-1: Funding Rate履歴深度分析（修正後）

#### Funding深度統計

| メトリック | 値 |
|-----------|-----|
| 全シンボル | 50個 |
| 平均深度 | 72日 |
| 最大深度 | 90日 |
| 最小深度 | 10日 |

#### シンボル別深度サンプル

| Symbol | 件数 | 深度 | 最古日 | 最新日 |
|--------|------|------|--------|--------|
| LABUSDT | 836 | 90日 | 2026-04-05 | 2026-07-04 |
| BTCUSDT | 270 | 90日 | 2026-04-05 | 2026-07-04 |
| 10000NEXUSDT | 271 | 45日 | 2026-05-20 | 2026-07-04 |
| BASUSDT | 100 | 17日 | 2026-06-18 | 2026-07-04 |

**日足との非対称**:
- 日足: 最大7年、主力銘柄2500日以上
- Funding: 最大90日で枯渇（≒270件）

---

### G0-2: 死銘柄検出の改善

#### エラーコード識別

| コード | メッセージ | 解釈 | 履歴データ取得可否 |
|--------|-----------|------|-----------------|
| 40309 | "The symbol has been removed" | 廃止済み（実存） | 不可（0件） |
| 40034 | "Parameter ... does not exist" | 不存在（架空） | 不可（0件） |

#### テスト結果

- SRMUSDT (廃止済): code 40309 検出
- LUNA2USDT (架空): code 40034 検出
- TERRUSDT (誤綴り): code 40034 検出

---

### G0-3: PIT Universe再実行結果（修正後データ）

#### 月次リバランス時のユニバース構成可能性

| リバランス日 | 利用可能シンボル | 最大深度 | 最古日 |
|------------|---------------|---------| ------|
| 2025-07-01 | 25 | BNBUSDT(2162本) | 2019-07 |
| 2025-08-01 | 26 | BNBUSDT(2192本) | 2019-07 |
| 2025-09-01 | 28 | BNBUSDT(2223本) | 2019-07 |
| 2025-10-01 | 28 | BNBUSDT(2253本) | 2019-07 |
| 2025-11-01 | 30 | BNBUSDT(2283本) | 2019-07 |
| 2025-12-01 | 31 | BNBUSDT(2313本) | 2019-07 |
| 2026-01-01 | 33 | BNBUSDT(2344本) | 2019-07 |
| 2026-02-01 | 33 | BNBUSDT(2374本) | 2019-07 |
| 2026-03-01 | 34 | BNBUSDT(2402本) | 2019-07 |
| 2026-04-01 | 35 | BNBUSDT(2433本) | 2019-07 |
| 2026-05-01 | 44 | BNBUSDT(2462本) | 2019-07 |
| 2026-06-01 | 47 | BNBUSDT(2493本) | 2019-07 |
| 2026-07-01 | 50 | BNBUSDT(2523本) | 2019-07 |

**統計**:
- 総リバランス日数: 13月
- 平均利用可能シンボル数: 34個
- 最小/最大: 25/50個

**修正前との対比**:
- 修正前: 各月ユニバース0件（G0-3実行不可）
- 修正後: 各月 25-50 シンボルで正常構成

---

## 出力ファイル一覧（修正版）

`research/EXP-OBS000030/10-result/` 配下:

- `G0-1-history-depth-analysis-v2.json` — 日足深度集計（全50銘柄）
- `G0-1-history-depth-analysis-v2.csv` — 日足深度詳細（CSV形式）
- `G0-1-funding-depth-analysis-v2.json` — Funding深度集計（全50銘柄）
- `G0-1-funding-depth-analysis-v2.csv` — Funding深度詳細（CSV形式）
- `G0-2-dead-symbol-test-results-v2.json` — 死銘柄テスト結果（code 40034/40309識別）
- `G0-3-pit-universe-prototype-v2.json` — PIT月次ユニバース構成検証

---

## 修正スクリプト

- `scripts/fetch-bitget-data.ts` — 修正版データ取得（ページング修正含む）
- `scripts/recalculate-depth-analysis-v2.ts` — 日足深度統計計算
- `scripts/analyze-funding-depth-v2.ts` — Funding深度分析
- `scripts/test-dead-symbols-v2.ts` — 死銘柄テスト（code識別）
- `scripts/pit-universe-prototype-v2.ts` — PIT再実行

---

## 再現コマンド

```bash
# 修正版データ取得（初回のみ）
node --experimental-strip-types scripts/fetch-bitget-data.ts

# 統計再計算
node --experimental-strip-types scripts/recalculate-depth-analysis-v2.ts
node --experimental-strip-types scripts/analyze-funding-depth-v2.ts
node --experimental-strip-types scripts/test-dead-symbols-v2.ts
node --experimental-strip-types scripts/pit-universe-prototype-v2.ts
```

---

## 結論（事実のみ）

1. **日足深度**: Bitget公開APIから最大約7年（BTC 2019-07-09起点、2523日）の連続履歴を取得可能
2. **Funding深度**: 約90日（270件）で枯渇（公開API固有の真の制約）
3. **死銘柄検出**: code 40309で廃止済み、40034で不存在の区別が可能
4. **PIT構成**: 修正後データで月次ユニバースが各時点で25-50シンボルで正常構成される
