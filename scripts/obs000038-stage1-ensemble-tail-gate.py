#!/usr/bin/env python3
"""
EXP-OBS000038 Stage 1: TSMOMオーバーレイ × VRP+キャリー テールゲート検証
B実装チーム（quant-researcher）生データ出力スクリプト

specに忠実に実装。結果の解釈・採否判断は行わない。

実行コマンド:
  python3 /home/user/trading-app-v2/scripts/obs000038-stage1-ensemble-tail-gate.py

データソース（外部API不可のため既存リポジトリデータを使用）:
  - VRP週次: research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json
    (Deribit DVOLベース・2021-03-24〜2026-07-01・277週)
  - キャリー日次: research/EXP-OBS000032/10-result/{btc,eth}usdt-{spot,perp}-daily.csv +
    {btc,eth}usdt-funding.csv から total_pnl_bps = funding_pnl_bps + basis_pnl_bps を再構成
  - BTC/ETH spot: research/EXP-OBS000032/10-result/{btc,eth}usdt-spot-daily.csv (Binance)
"""

import json
import os
import sys
import numpy as np
import pandas as pd
from datetime import datetime, timedelta

# ============================================================
# 凍結パラメータ（変更禁止）
# ============================================================
C_REAL = 2.8612547352068765           # vol pt/週（OBS000037 meta由来）
VEGA_NOTIONAL_PCT = 0.00020083800084379173  # f=0.5（OBS000037 meta由来）
A_OVERLAY = float(np.sqrt(0.15 / 0.85))    # ≈ 0.4201
VOL_TARGET = 0.10                     # 年率10% vol-target
EXEC_COST_PCT = 0.0010                # 0.10%/片道（decimal）
TSMOM_LOOKBACKS = (30, 60, 90)        # 暦日
SIGMA_WINDOW_DAILY = 60               # 過去60営業日相当
ROLLING_WEEKS = 52                    # book0 vol推定窓
BOOTSTRAP_BLOCK_LEN = 7
BOOTSTRAP_N = 5000
BOOTSTRAP_SEED = 42
STRESS_THRESHOLD = -0.08              # BTC週次≤-8%

# ============================================================
# パス定義
# ============================================================
BASE_DIR = '/home/user/trading-app-v2'
OBS032_DIR = f'{BASE_DIR}/research/EXP-OBS000032/10-result'
OBS037_DIR = f'{BASE_DIR}/research/EXP-OBS000037/10-result'
OUTPUT_DIR = f'{BASE_DIR}/research/EXP-OBS000038/10-result'

# ============================================================
# 1. VRP脚: OBS000037 stage1 weeklyPointsから読み込み
# ============================================================

def load_vrp_weekly():
    """
    OBS000037 stage1 VRP週次データ読み込み。
    net_pnl_pct = (vrp - C_real) × vegaNotionalPct × 100 を計算。
    単位: % of capital per week
    """
    path = f'{OBS037_DIR}/stage1-vrp-prediction-unit.json'
    with open(path) as f:
        data = json.load(f)

    weekly_points = data['mainSeries']['weeklyPoints']
    records = []
    for pt in weekly_points:
        # vrp/rv_forward_pct が None の点はスキップ（forward期間未完了）
        if pt['vrp'] is None or pt['rv_forward_pct'] is None:
            print(f"  [skip] {pt['date']}: vrp=None (forward期間未完了)")
            continue
        vrp_val = float(pt['vrp'])
        net_pnl_pct = (vrp_val - C_REAL) * VEGA_NOTIONAL_PCT * 100
        records.append({
            'date': pd.Timestamp(pt['date']),
            'dvol': float(pt['dvol']),
            'rv_forward_pct': float(pt['rv_forward_pct']),
            'vrp': vrp_val,
            'net_pnl_pct': net_pnl_pct,
        })

    df = pd.DataFrame(records).set_index('date')
    df.index = pd.DatetimeIndex(df.index)
    return df


def check_vrp_alignment(vrp_df):
    """
    OBS000037 forward ledger is_cohort_anchor=1行との整合確認。
    """
    ledger_path = f'{OBS037_DIR}/forward/deribit-vrp-forward-ledger-btc.csv'
    ledger = pd.read_csv(ledger_path)
    anchor_rows = ledger[ledger['is_cohort_anchor'] == 1].copy()
    anchor_rows = anchor_rows.dropna(subset=['net_pnl_pct'])

    n_matched = 0
    max_diff = 0.0
    diffs = []
    for _, row in anchor_rows.iterrows():
        d = pd.Timestamp(row['date'])
        vrp_val = float(row['vrp'])
        expected = float(row['net_pnl_pct'])
        recomputed = (vrp_val - C_REAL) * VEGA_NOTIONAL_PCT * 100
        diff = abs(recomputed - expected)
        diffs.append({
            'date': row['date'],
            'expected': expected,
            'recomputed': recomputed,
            'diff': diff,
        })
        max_diff = max(max_diff, diff)
        n_matched += 1

    return {'n_matched': n_matched, 'max_diff': float(max_diff), 'details': diffs}


# ============================================================
# 2. キャリー脚: raw data から total_pnl_bps = funding + basis 再構成
# ============================================================

def build_carry_daily(asset: str) -> pd.Series:
    """
    total_pnl_bps = funding_pnl_bps + basis_pnl_bps の日次系列構築。
    basis_pnl_bps = spot_return_bps - perp_return_bps（基差MTM）
    funding_pnl_bps = 日次funding合計 × 10000
    単位: bps per day
    資本コスト・反転コスト・方向シグナルは含まない（total_pnl_bps定義準拠）。
    """
    asset_lc = asset.lower()
    spot = pd.read_csv(
        f'{OBS032_DIR}/{asset_lc}usdt-spot-daily.csv',
        parse_dates=['date'], index_col='date'
    )['close']
    perp = pd.read_csv(
        f'{OBS032_DIR}/{asset_lc}usdt-perp-last-daily.csv',
        parse_dates=['date'], index_col='date'
    )['close']

    # 日次funding合算 (8h×3)
    # datetime列は 'YYYY-MM-DDTHH:MM:SS.sssZ' 形式（UTC-aware）。
    # 先頭10文字('YYYY-MM-DD')を切り出してtz-naiveなDatetimeIndexを作る。
    funding_raw = pd.read_csv(f'{OBS032_DIR}/{asset_lc}usdt-funding.csv')
    funding_raw['date'] = pd.to_datetime(funding_raw['datetime'].str[:10])
    funding_daily_rate = funding_raw.groupby('date')['funding_rate'].sum()
    funding_daily_rate.index = pd.DatetimeIndex(funding_daily_rate.index)
    funding_pnl_bps = funding_daily_rate * 10000  # decimal → bps

    # 日次リターン (bps)
    spot_ret_bps = spot.pct_change() * 10000
    perp_ret_bps = perp.pct_change() * 10000
    basis_pnl_bps = spot_ret_bps - perp_ret_bps

    # 共通日付で統合
    all_dates = spot_ret_bps.dropna().index.intersection(perp_ret_bps.dropna().index)
    total_pnl_bps = (
        funding_pnl_bps.reindex(all_dates).fillna(0)
        + basis_pnl_bps.reindex(all_dates).fillna(0)
    )
    return total_pnl_bps


def carry_weekly_from_anchors(
    carry_daily_bps: pd.Series, anchor_dates: pd.DatetimeIndex
) -> pd.Series:
    """
    VRPアンカー日 t から翌日 [t+1, t+7] の7日間を複利集計。
    weekly_return = Π(1 + daily_bps/10000) - 1 (decimal)
    """
    weekly_rets = {}
    for t in anchor_dates:
        start = t + pd.Timedelta(days=1)
        end = t + pd.Timedelta(days=7)
        window = carry_daily_bps.loc[start:end]
        if len(window) >= 5:  # 最低5日は必要
            weekly_rets[t] = float((1 + window / 10000).prod() - 1)
        else:
            weekly_rets[t] = np.nan
    return pd.Series(weekly_rets, dtype=float)


# ============================================================
# 3. TSMOMオーバーレイ
# ============================================================

def load_spot(asset: str) -> pd.Series:
    asset_lc = asset.lower()
    s = pd.read_csv(
        f'{OBS032_DIR}/{asset_lc}usdt-spot-daily.csv',
        parse_dates=['date'], index_col='date'
    )['close']
    return s.sort_index()


def tsmom_signal(prices: pd.Series, t: pd.Timestamp,
                 lookbacks=TSMOM_LOOKBACKS) -> float:
    """
    TSMOM signal at t. 暦日ベースルックバック (30/60/90日)。
    t の価格を含む (PIT: positions entered at t+1)。
    """
    if t not in prices.index:
        return 0.0
    p_t = prices.loc[t]
    total = 0.0
    for L in lookbacks:
        t_L = t - pd.Timedelta(days=L)
        # 最寄りの利用可能日を使用
        avail = prices.index[prices.index <= t_L]
        if len(avail) == 0:
            return 0.0
        p_tL = prices.loc[avail[-1]]
        total += float(np.sign(p_t - p_tL))
    return total / len(lookbacks)


def compute_overlay_weekly(
    btc_spot: pd.Series, eth_spot: pd.Series,
    anchor_dates: pd.DatetimeIndex
) -> pd.Series:
    """
    BTC/ETH TSMOM overlay の週次リターン (decimal)。
    w_i = signal_i × (vol_target / sigma_annual)  (shift済み)
    execution cost = EXEC_COST_PCT/片道 × |w| を往復分控除
    BTC/ETH の等加重平均。
    """
    btc_daily_ret = btc_spot.pct_change()
    eth_daily_ret = eth_spot.pct_change()

    overlay_rets = {}

    for t in anchor_dates:
        # BTCとETH両方にデータが必要
        if t not in btc_spot.index or t not in eth_spot.index:
            overlay_rets[t] = np.nan
            continue

        # 90暦日以上の履歴が必要
        min_hist_start = t - pd.Timedelta(days=100)
        if btc_spot.index[0] > min_hist_start or eth_spot.index[0] > min_hist_start:
            overlay_rets[t] = np.nan
            continue

        # シグナル計算 (t時点のPIT)
        sig_btc = tsmom_signal(btc_spot, t)
        sig_eth = tsmom_signal(eth_spot, t)

        # vol-target: 過去60日相当の日次リターン (t を含まない, shift済み)
        hist_end = t - pd.Timedelta(days=1)
        hist_start = t - pd.Timedelta(days=90)  # 60営業日≈84暦日 + バッファ
        btc_hist = btc_daily_ret.loc[hist_start:hist_end].dropna().tail(SIGMA_WINDOW_DAILY)
        eth_hist = eth_daily_ret.loc[hist_start:hist_end].dropna().tail(SIGMA_WINDOW_DAILY)

        if len(btc_hist) < 20 or len(eth_hist) < 20:
            overlay_rets[t] = np.nan
            continue

        sigma_btc_annual = btc_hist.std() * np.sqrt(365)
        sigma_eth_annual = eth_hist.std() * np.sqrt(365)

        if sigma_btc_annual < 1e-6 or sigma_eth_annual < 1e-6:
            overlay_rets[t] = np.nan
            continue

        w_btc = sig_btc * (VOL_TARGET / sigma_btc_annual)
        w_eth = sig_eth * (VOL_TARGET / sigma_eth_annual)

        # 翌週 [t+1, t+7] の実現リターン
        start = t + pd.Timedelta(days=1)
        end = t + pd.Timedelta(days=7)
        btc_week = btc_daily_ret.loc[start:end]
        eth_week = eth_daily_ret.loc[start:end]

        if len(btc_week) < 5 or len(eth_week) < 5:
            overlay_rets[t] = np.nan
            continue

        btc_weekly_ret = float((1 + btc_week).prod() - 1)
        eth_weekly_ret = float((1 + eth_week).prod() - 1)

        # P&L = position × asset_return (decimal)
        btc_pnl = w_btc * btc_weekly_ret
        eth_pnl = w_eth * eth_weekly_ret

        # 執行コスト: 片道 0.10% × |position| × 2 (往復)
        exec_cost = EXEC_COST_PCT * (abs(w_btc) + abs(w_eth)) * 2

        # 等加重平均 (BTC/ETH)
        combined = (btc_pnl + eth_pnl) / 2.0 - exec_cost / 2.0
        overlay_rets[t] = float(combined)

    return pd.Series(overlay_rets, dtype=float)


def compute_btc_weekly_ret(
    btc_spot: pd.Series, anchor_dates: pd.DatetimeIndex
) -> pd.Series:
    """BTC週次スポットリターン（stress検出用）"""
    btc_daily_ret = btc_spot.pct_change()
    weekly_rets = {}
    for t in anchor_dates:
        start = t + pd.Timedelta(days=1)
        end = t + pd.Timedelta(days=7)
        window = btc_daily_ret.loc[start:end].dropna()
        if len(window) >= 5:
            weekly_rets[t] = float((1 + window).prod() - 1)
        else:
            weekly_rets[t] = np.nan
    return pd.Series(weekly_rets, dtype=float)


# ============================================================
# 4. book0 / book1 構築
# ============================================================

def build_book0(
    vrp_weekly_pct: pd.Series,
    carry_weekly_pct: pd.Series,
    rolling_weeks: int = ROLLING_WEEKS
):
    """
    book0 = VRP + carry の逆ボラ加重、年率10%スケール済み。
    単位: % of capital per week
    先読み禁止: vol推定は shift(1) 済み。
    """
    # Rolling vol (min_periods=20)
    vrp_vol = vrp_weekly_pct.rolling(rolling_weeks, min_periods=20).std()
    carry_vol = carry_weekly_pct.rolling(rolling_weeks, min_periods=20).std()

    # 逆ボラ加重 (shift済み)
    inv_vrp = (1.0 / vrp_vol).shift(1)
    inv_carry = (1.0 / carry_vol).shift(1)
    denom = inv_vrp + inv_carry
    w_vrp = inv_vrp / denom
    w_carry = inv_carry / denom

    book0_raw = w_vrp * vrp_weekly_pct + w_carry * carry_weekly_pct

    # 年率10%スケール (shift済み)
    book0_vol_annual = book0_raw.rolling(rolling_weeks, min_periods=20).std() * np.sqrt(52)
    scale = (VOL_TARGET * 100) / book0_vol_annual
    scale = scale.shift(1)  # lookahead禁止
    book0 = book0_raw * scale

    return book0, w_vrp, w_carry


def scale_to_vol10(series_pct: pd.Series, rolling_weeks: int = ROLLING_WEEKS) -> pd.Series:
    """年率10%になるようローリングスケール (shift済み)"""
    vol_annual = series_pct.rolling(rolling_weeks, min_periods=20).std() * np.sqrt(52)
    scale = (VOL_TARGET * 100) / vol_annual
    scale = scale.shift(1)
    return series_pct * scale


# ============================================================
# 5. テールリスク指標
# ============================================================

def max_drawdown(returns_pct: pd.Series) -> float:
    """週次リターン(%)からピーク→トラフ最大DD。負値で返す。"""
    rets = returns_pct / 100.0
    cum = (1 + rets).cumprod()
    rolling_max = cum.cummax()
    dd = (cum / rolling_max) - 1.0
    return float(dd.min())


def cvar95(returns_pct: pd.Series) -> float:
    """週次リターン(%)の下位5%平均（CVaR95）。負値で返す。"""
    rets = returns_pct / 100.0
    threshold = rets.quantile(0.05)
    tail = rets[rets <= threshold]
    return float(tail.mean())


# ============================================================
# 6. Block-bootstrap
# ============================================================

def block_bootstrap_corr(
    x: pd.Series, y: pd.Series,
    block_len: int = BOOTSTRAP_BLOCK_LEN,
    n_iter: int = BOOTSTRAP_N,
    seed: int = BOOTSTRAP_SEED
) -> np.ndarray:
    """
    Block-bootstrap for correlation between x and y.
    x, y: aligned Series
    """
    rng = np.random.default_rng(seed)
    n = len(x)
    x_arr = x.values.copy()
    y_arr = y.values.copy()

    if n < block_len:
        return np.full(n_iter, np.corrcoef(x_arr, y_arr)[0, 1])

    corrs = np.empty(n_iter)
    for i in range(n_iter):
        n_blocks = n // block_len + 2
        starts = rng.integers(0, n - block_len + 1, size=n_blocks)
        idx_list = []
        for s in starts:
            idx_list.append(np.arange(s, s + block_len))
        idx = np.concatenate(idx_list)[:n]
        xi = x_arr[idx]
        yi = y_arr[idx]
        c = np.corrcoef(xi, yi)[0, 1]
        corrs[i] = c if np.isfinite(c) else 0.0

    return corrs


# ============================================================
# 7. ±1週シフト感度
# ============================================================

def sensitivity_shift(
    vrp_shifted: pd.Series,
    carry_pct: pd.Series,
    overlay_pct: pd.Series,
    rolling_weeks: int = ROLLING_WEEKS
) -> dict:
    """VRP を ±1週シフトしたときの book1 テール指標"""
    df = pd.DataFrame({
        'vrp': vrp_shifted,
        'carry': carry_pct,
        'overlay': overlay_pct,
    }).dropna()

    if len(df) < rolling_weeks + 10:
        return {'maxDD': np.nan, 'cvar95': np.nan}

    book0_s, _, _ = build_book0(df['vrp'], df['carry'])
    overlay_vol10_s = scale_to_vol10(df['overlay'])
    book1_s = book0_s + A_OVERLAY * overlay_vol10_s
    book_s_df = pd.DataFrame({'b0': book0_s, 'b1': book1_s}).dropna()

    if len(book_s_df) < 20:
        return {'maxDD': np.nan, 'cvar95': np.nan}

    return {
        'maxDD': max_drawdown(book_s_df['b1']),
        'cvar95': cvar95(book_s_df['b1']),
    }


# ============================================================
# Main
# ============================================================

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    run_ts = datetime.utcnow().isoformat() + 'Z'
    print(f"EXP-OBS000038 Stage 1 実行開始: {run_ts}")

    # ------ 1. VRP 週次データ ------
    print("\n[1] VRP週次データ読み込み...")
    vrp_df = load_vrp_weekly()
    anchor_dates = vrp_df.index
    vrp_weekly_pct = vrp_df['net_pnl_pct']  # 単位: %
    print(f"  VRP: {anchor_dates[0].date()} 〜 {anchor_dates[-1].date()}, n={len(vrp_df)}")

    # VRP整合確認
    print("[2] VRPフォワードledger整合確認...")
    alignment = check_vrp_alignment(vrp_df)
    print(f"  マッチ件数: {alignment['n_matched']}, 最大乖離: {alignment['max_diff']:.8f}%")
    for d in alignment['details']:
        print(f"    {d['date']}: expected={d['expected']:.6f}%, recomputed={d['recomputed']:.6f}%, diff={d['diff']:.8f}%")

    # ------ 2. キャリー脚 ------
    print("\n[3] キャリー日次系列構築 (BTC/ETH)...")
    btc_carry_daily = build_carry_daily('BTC')
    eth_carry_daily = build_carry_daily('ETH')
    print(f"  BTC carry: {btc_carry_daily.index[0].date()} 〜 {btc_carry_daily.index[-1].date()}, n={len(btc_carry_daily)}")
    print(f"  ETH carry: {eth_carry_daily.index[0].date()} 〜 {eth_carry_daily.index[-1].date()}, n={len(eth_carry_daily)}")

    # T1/T2/T3/calm交差確認 (sanity anchor)
    t1_start, t1_end = '2020-02-20', '2020-04-30'
    btc_t1_pnl = btc_carry_daily.loc[t1_start:t1_end]
    print(f"  [sanity] BTC T1期間 ({t1_start}〜{t1_end}): n={len(btc_t1_pnl)}")
    # T1 CSV先頭との比較
    import csv
    t1_csv_rows = {}
    with open(f'{OBS032_DIR}/daily-pnl-btcusdt-T1.csv') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if row['date']:
                t1_csv_rows[row['date']] = float(row['total_pnl_bps'])
    # 2020-02-21の比較
    d_check = '2020-02-21'
    raw_val = float(btc_carry_daily.loc[d_check]) if d_check in btc_carry_daily.index else None
    csv_val = t1_csv_rows.get(d_check)
    if raw_val is not None and csv_val is not None:
        print(f"  [sanity] {d_check}: raw={raw_val:.4f} bps, T1 CSV={csv_val:.4f} bps, match={abs(raw_val-csv_val)<0.01}")

    # 週次集計
    print("[4] キャリー週次リターン集計...")
    btc_carry_weekly = carry_weekly_from_anchors(btc_carry_daily, anchor_dates)
    eth_carry_weekly = carry_weekly_from_anchors(eth_carry_daily, anchor_dates)
    # BTC+ETH 等加重平均 (decimal → %)
    carry_weekly_pct = ((btc_carry_weekly + eth_carry_weekly) / 2.0) * 100.0
    carry_weekly_pct.index = anchor_dates
    print(f"  carry_weekly_pct: n={carry_weekly_pct.notna().sum()}, mean={carry_weekly_pct.mean():.4f}%/week")

    # ------ 3. TSMOMオーバーレイ ------
    print("\n[5] BTC/ETH spot読み込み...")
    btc_spot = load_spot('BTC')
    eth_spot = load_spot('ETH')
    print(f"  BTC spot: {btc_spot.index[0].date()} 〜 {btc_spot.index[-1].date()}")
    print(f"  ETH spot: {eth_spot.index[0].date()} 〜 {eth_spot.index[-1].date()}")

    print("[6] TSMOMオーバーレイ週次リターン計算...")
    overlay_weekly_raw = compute_overlay_weekly(btc_spot, eth_spot, anchor_dates)
    overlay_weekly_pct = overlay_weekly_raw * 100.0  # decimal → %
    overlay_weekly_pct.index = anchor_dates
    print(f"  overlay_weekly_pct: n={overlay_weekly_pct.notna().sum()}, std={overlay_weekly_pct.std():.4f}%/week")

    # BTC週次リターン（stress検出用）
    print("[7] BTC週次リターン計算（stress検出）...")
    btc_weekly_ret = compute_btc_weekly_ret(btc_spot, anchor_dates)
    btc_weekly_ret.index = anchor_dates

    # ------ 4. 共通窓確定 ------
    print("\n[8] 共通窓確定...")
    base_df = pd.DataFrame({
        'vrp_net_pct': vrp_weekly_pct,
        'carry_weekly_pct': carry_weekly_pct,
        'overlay_weekly_pct': overlay_weekly_pct,
        'btc_weekly_ret': btc_weekly_ret,
    }, index=anchor_dates)
    base_df = base_df.dropna()
    print(f"  共通窓: {base_df.index[0].date()} 〜 {base_df.index[-1].date()}, n={len(base_df)}")

    # Stress週
    stress_mask = base_df['btc_weekly_ret'] <= STRESS_THRESHOLD
    n_stress = int(stress_mask.sum())
    base_df['is_stress'] = stress_mask.astype(int)
    print(f"  Stress週 (BTC≤-8%): {n_stress}週")

    # ------ 5. book0, book1 構築 ------
    print("\n[9] book0/book1 構築...")
    book0, w_vrp, w_carry = build_book0(base_df['vrp_net_pct'], base_df['carry_weekly_pct'])

    overlay_vol10 = scale_to_vol10(base_df['overlay_weekly_pct'])
    book1 = book0 + A_OVERLAY * overlay_vol10

    base_df['book0_pct'] = book0
    base_df['book1_pct'] = book1
    base_df['overlay_vol10_pct'] = overlay_vol10

    # warmup除去
    book_df = base_df.dropna(subset=['book0_pct', 'book1_pct'])
    print(f"  book系列（warmup後）: {book_df.index[0].date()} 〜 {book_df.index[-1].date()}, n={len(book_df)}")

    stress_in_book = book_df['is_stress'].astype(bool)
    n_stress_book = int(stress_in_book.sum())
    print(f"  book期間のstress週: {n_stress_book}週")

    # ------ 6. G-ensemble指標 ------
    print("\n[10] G-ensemble指標計算...")
    maxdd_b0 = max_drawdown(book_df['book0_pct'])
    maxdd_b1 = max_drawdown(book_df['book1_pct'])
    cvar_b0 = cvar95(book_df['book0_pct'])
    cvar_b1 = cvar95(book_df['book1_pct'])

    if abs(maxdd_b0) > 1e-9:
        maxdd_impr = 1.0 - abs(maxdd_b1) / abs(maxdd_b0)
    else:
        maxdd_impr = np.nan
    if abs(cvar_b0) > 1e-9:
        cvar_impr = 1.0 - abs(cvar_b1) / abs(cvar_b0)
    else:
        cvar_impr = np.nan

    print(f"  maxDD(book0): {maxdd_b0*100:.2f}%  maxDD(book1): {maxdd_b1*100:.2f}%")
    print(f"  CVaR95(book0): {cvar_b0*100:.2f}%  CVaR95(book1): {cvar_b1*100:.2f}%")
    print(f"  maxDD改善率: {maxdd_impr*100:.1f}%")
    print(f"  CVaR95改善率: {cvar_impr*100:.1f}%")

    # ------ 7. 条件付き相関（stress窓） ------
    print("\n[11] 条件付き相関 (stress窓)...")
    vrp_stress_s = book_df.loc[stress_in_book, 'vrp_net_pct']
    carry_stress_s = book_df.loc[stress_in_book, 'carry_weekly_pct']
    overlay_vol10_stress = book_df.loc[stress_in_book, 'overlay_vol10_pct']

    rho_ov_vrp = float(overlay_vol10_stress.corr(vrp_stress_s)) if n_stress_book >= 3 else np.nan
    rho_ov_carry = float(overlay_vol10_stress.corr(carry_stress_s)) if n_stress_book >= 3 else np.nan

    print(f"  ρ(overlay_vol10, VRP): {rho_ov_vrp:.3f}  (Stage0参照値: -0.331)")
    print(f"  ρ(overlay_vol10, carry_basisMTM): {rho_ov_carry:.3f}  (Stage0参照値: -0.238)")

    # BTC/ETH分解 (§3-5 選定/確認プロトコル)
    btc_ov_stress = []
    eth_ov_stress = []
    for t in book_df.index[stress_in_book]:
        if t not in btc_spot.index:
            continue
        sig_b = tsmom_signal(btc_spot, t)
        sig_e = tsmom_signal(eth_spot, t)
        hist_end = t - pd.Timedelta(days=1)
        hist_start = t - pd.Timedelta(days=90)
        btc_h = btc_spot.pct_change().loc[hist_start:hist_end].dropna().tail(SIGMA_WINDOW_DAILY)
        eth_h = eth_spot.pct_change().loc[hist_start:hist_end].dropna().tail(SIGMA_WINDOW_DAILY)
        if len(btc_h) < 10 or len(eth_h) < 10:
            continue
        s_b = btc_h.std() * np.sqrt(365)
        s_e = eth_h.std() * np.sqrt(365)
        start = t + pd.Timedelta(days=1)
        end = t + pd.Timedelta(days=7)
        r_b = float((1 + btc_spot.pct_change().loc[start:end]).prod() - 1)
        r_e = float((1 + eth_spot.pct_change().loc[start:end]).prod() - 1)
        w_b = sig_b * VOL_TARGET / s_b if s_b > 1e-6 else 0
        w_e = sig_e * VOL_TARGET / s_e if s_e > 1e-6 else 0
        btc_ov_stress.append(w_b * r_b)
        eth_ov_stress.append(w_e * r_e)

    btc_ov_s = pd.Series(btc_ov_stress)
    eth_ov_s = pd.Series(eth_ov_stress)
    vrp_s_aligned = vrp_stress_s.values[:len(btc_ov_s)] if len(btc_ov_s) > 0 else np.array([])
    carry_s_aligned = carry_stress_s.values[:len(btc_ov_s)] if len(btc_ov_s) > 0 else np.array([])

    rho_btc_vrp = float(btc_ov_s.corr(pd.Series(vrp_s_aligned))) if len(btc_ov_s) >= 3 else np.nan
    rho_eth_vrp = float(eth_ov_s.corr(pd.Series(vrp_s_aligned))) if len(eth_ov_s) >= 3 else np.nan
    rho_btc_carry = float(btc_ov_s.corr(pd.Series(carry_s_aligned))) if len(btc_ov_s) >= 3 else np.nan
    rho_eth_carry = float(eth_ov_s.corr(pd.Series(carry_s_aligned))) if len(eth_ov_s) >= 3 else np.nan

    print(f"  [BTC寄与] ρ(btc_overlay, VRP)={rho_btc_vrp:.3f}, ρ(btc_overlay, carry)={rho_btc_carry:.3f}")
    print(f"  [ETH寄与] ρ(eth_overlay, VRP)={rho_eth_vrp:.3f}, ρ(eth_overlay, carry)={rho_eth_carry:.3f}")

    # ------ 8. block-bootstrap (carry stress) ------
    print("\n[12] block-bootstrap (carry stress相関)...")
    if n_stress_book >= BOOTSTRAP_BLOCK_LEN:
        carry_s_arr = carry_stress_s.reset_index(drop=True)
        overlay_s_arr = overlay_vol10_stress.reset_index(drop=True)
        # 長さを揃える
        min_len = min(len(carry_s_arr), len(overlay_s_arr))
        carry_s_arr = carry_s_arr.iloc[:min_len]
        overlay_s_arr = overlay_s_arr.iloc[:min_len]
        boot_corrs = block_bootstrap_corr(carry_s_arr, overlay_s_arr)
        frac_le0 = float((boot_corrs <= 0).mean())
        ci_lo = float(np.percentile(boot_corrs, 2.5))
        ci_hi = float(np.percentile(boot_corrs, 97.5))
        point_est = float(carry_s_arr.corr(overlay_s_arr))
        print(f"  point_est={point_est:.3f}, frac_le0={frac_le0:.3f}, CI=[{ci_lo:.3f}, {ci_hi:.3f}]")
    else:
        frac_le0 = np.nan
        ci_lo = np.nan
        ci_hi = np.nan
        point_est = np.nan
        boot_corrs = np.array([np.nan])
        print(f"  stress週数不足({n_stress_book} < {BOOTSTRAP_BLOCK_LEN})、bootstrap省略")

    # ------ 9. ±1週シフト感度 ------
    print("\n[13] ±1週シフト感度...")
    vrp_plus1 = base_df['vrp_net_pct'].shift(1)
    vrp_minus1 = base_df['vrp_net_pct'].shift(-1)

    sens_plus = sensitivity_shift(vrp_plus1, base_df['carry_weekly_pct'], base_df['overlay_weekly_pct'])
    sens_minus = sensitivity_shift(vrp_minus1, base_df['carry_weekly_pct'], base_df['overlay_weekly_pct'])
    print(f"  +1週シフト: maxDD={sens_plus['maxDD']*100:.2f}%, CVaR95={sens_plus['cvar95']*100:.2f}%")
    print(f"  -1週シフト: maxDD={sens_minus['maxDD']*100:.2f}%, CVaR95={sens_minus['cvar95']*100:.2f}%")

    # ------ 10. book0構成確認 ------
    w_vrp_mean = float(w_vrp.dropna().mean())
    w_carry_mean = float(w_carry.dropna().mean())

    # 実達成 overlay リスク寄与 rc = a²×var(overlay) / var(book1)
    b0_std = book_df['book0_pct'].std()
    ov10_std = book_df['overlay_vol10_pct'].std()
    b1_std = book_df['book1_pct'].std()
    if b1_std > 1e-6:
        realized_rc = float((A_OVERLAY**2 * ov10_std**2) / b1_std**2)
    else:
        realized_rc = np.nan

    print(f"\n  w_vrp_mean={w_vrp_mean:.3f}, w_carry_mean={w_carry_mean:.3f}")
    print(f"  realized overlay rc={realized_rc:.3f} (target=0.15)")

    # ------ 11. 出力ファイル ------
    print("\n[14] 出力ファイル書き込み...")

    # stage1-raw.json
    stage1_raw = {
        "common_window": {
            "start": book_df.index[0].strftime('%Y-%m-%d'),
            "end": book_df.index[-1].strftime('%Y-%m-%d'),
            "n_weeks": int(len(book_df)),
            "stress_weeks": n_stress_book
        },
        "book0": {
            "maxDD": float(maxdd_b0),
            "cvar95": float(cvar_b0)
        },
        "book1": {
            "maxDD": float(maxdd_b1),
            "cvar95": float(cvar_b1)
        },
        "improvement": {
            "maxDD_pct": float(maxdd_impr),
            "cvar95_pct": float(cvar_impr)
        },
        "vrp_alignment_check": {
            "n_matched": alignment['n_matched'],
            "max_diff": alignment['max_diff'],
            "details": alignment['details']
        },
        "conditional_corr_stress": {
            "rho_overlay_vrp": float(rho_ov_vrp) if not np.isnan(rho_ov_vrp) else None,
            "rho_overlay_carry_basisMTM": float(rho_ov_carry) if not np.isnan(rho_ov_carry) else None,
            "stress_weeks": n_stress_book,
            "btc_eth_decomposition": {
                "rho_btc_overlay_vrp": float(rho_btc_vrp) if not np.isnan(rho_btc_vrp) else None,
                "rho_eth_overlay_vrp": float(rho_eth_vrp) if not np.isnan(rho_eth_vrp) else None,
                "rho_btc_overlay_carry": float(rho_btc_carry) if not np.isnan(rho_btc_carry) else None,
                "rho_eth_overlay_carry": float(rho_eth_carry) if not np.isnan(rho_eth_carry) else None,
            }
        },
        "bootstrap_carry": {
            "frac_le0": float(frac_le0) if not np.isnan(frac_le0) else None,
            "ci_lo": float(ci_lo) if not np.isnan(ci_lo) else None,
            "ci_hi": float(ci_hi) if not np.isnan(ci_hi) else None,
            "point_est": float(point_est) if not np.isnan(point_est) else None
        },
        "sensitivity_plus1w": {
            "maxDD": float(sens_plus['maxDD']) if not np.isnan(sens_plus['maxDD']) else None,
            "cvar95": float(sens_plus['cvar95']) if not np.isnan(sens_plus['cvar95']) else None
        },
        "sensitivity_minus1w": {
            "maxDD": float(sens_minus['maxDD']) if not np.isnan(sens_minus['maxDD']) else None,
            "cvar95": float(sens_minus['cvar95']) if not np.isnan(sens_minus['cvar95']) else None
        },
        "book0_composition": {
            "w_vrp_mean": w_vrp_mean,
            "w_carry_mean": w_carry_mean,
            "realized_rc_overlay": float(realized_rc) if not np.isnan(realized_rc) else None
        },
        "params_used": {
            "C_real": C_REAL,
            "vegaNotionalPct": VEGA_NOTIONAL_PCT,
            "a": float(A_OVERLAY),
            "vol_target": VOL_TARGET,
            "exec_cost_pct": float(EXEC_COST_PCT)
        },
        "data_notes": {
            "vrp_source": "OBS000037 stage1-vrp-prediction-unit.json weeklyPoints (n=277, 2021-03-24~2026-07-01, Deribit DVOL由来)",
            "carry_source": "raw spot/perp/funding CSV → total_pnl_bps = funding_pnl_bps + basis_pnl_bps (no capital cost, no reversal cost, no signal flip)",
            "overlay_source": "btcusdt/ethusdt-spot-daily.csv (Binance S3由来)",
            "alignment_note": "VRPアンカーtの carry = [t+1, t+7]の7日間複利集計"
        }
    }

    with open(f'{OUTPUT_DIR}/stage1-raw.json', 'w') as f:
        json.dump(stage1_raw, f, indent=2, ensure_ascii=False)
    print(f"  → {OUTPUT_DIR}/stage1-raw.json")

    # stage1-weekly-series.csv (全期間、warmup含む)
    series_out = pd.DataFrame({
        'date': base_df.index.strftime('%Y-%m-%d'),
        'vrp_net_pct': base_df['vrp_net_pct'],
        'carry_weekly_pct': base_df['carry_weekly_pct'],
        'overlay_weekly_pct': base_df['overlay_weekly_pct'],
        'book0_pct': base_df.get('book0_pct', pd.Series(np.nan, index=base_df.index)),
        'book1_pct': base_df.get('book1_pct', pd.Series(np.nan, index=base_df.index)),
        'btc_weekly_ret': base_df['btc_weekly_ret'],
        'is_stress': base_df['is_stress'],
    })
    series_out.to_csv(f'{OUTPUT_DIR}/stage1-weekly-series.csv', index=False)
    print(f"  → {OUTPUT_DIR}/stage1-weekly-series.csv")

    # params.json
    params_out = {
        "C_real": C_REAL,
        "vegaNotionalPct": VEGA_NOTIONAL_PCT,
        "a_overlay": float(A_OVERLAY),
        "vol_target_annual": VOL_TARGET,
        "exec_cost_pct_one_side": float(EXEC_COST_PCT),
        "tsmom_lookbacks_calendar_days": list(TSMOM_LOOKBACKS),
        "sigma_window_daily": SIGMA_WINDOW_DAILY,
        "rolling_weeks_for_vol_scaling": ROLLING_WEEKS,
        "bootstrap_block_len": BOOTSTRAP_BLOCK_LEN,
        "bootstrap_N": BOOTSTRAP_N,
        "bootstrap_seed": BOOTSTRAP_SEED,
        "stress_threshold_btc_weekly_return": STRESS_THRESHOLD,
        "carry_equal_weight": "btc 50% + eth 50%",
        "overlay_equal_weight": "btc 50% + eth 50%",
        "book0_internal_weight": "inverse_vol_rolling52w (shift済み)",
        "book0_vol_scaling": "10pct_annual_rolling52w (shift済み)",
        "overlay_vol_scaling": "10pct_annual_rolling52w (shift済み)",
    }
    with open(f'{OUTPUT_DIR}/params.json', 'w') as f:
        json.dump(params_out, f, indent=2)
    print(f"  → {OUTPUT_DIR}/params.json")

    # stage1-run-meta.json
    meta = {
        "experiment": "EXP-OBS000038",
        "script": "scripts/obs000038-stage1-ensemble-tail-gate.py",
        "run_timestamp_utc": run_ts,
        "spec_reference": "research/EXP-OBS000038/01-spec-stage1.md",
        "data_sources": [
            "deribit-api (indirect via OBS000037 stage1-vrp-prediction-unit.json)",
            "obs000032-daily-pnl reconstructed from btcusdt/ethusdt-spot/perp/funding csv",
            "binance-s3 (indirect via obs000032 btcusdt/ethusdt-spot-daily.csv)"
        ],
        "external_api_access": "deribit.com/data.binance.vision blocked by proxy policy; using pre-existing data in repository",
        "known_limitations": [
            "速いV字gapは非ヘッジ（FTX/SVB型）",
            "carry脚テール独立のbootstrap CI：stress週数少なく検出力に限界",
            "VRP/carry長期系列はバックテスト再構成。フォワード整合は重複期間のみ",
            "Deribit APIおよびBinance S3にプロキシブロックのため、VRP系列はOBS000037 stage1 weeklyPointsを使用（Deribit/Binanceデータ由来の既存値）",
            "carry total_pnl_bps = funding_pnl_bps + basis_pnl_bps のみ（資本コスト・反転コスト・方向シグナルを除く）。T1/T2/T3/calm CSVのtotal_pnl_bps定義に準拠",
            "TSMOM overlayのsigma推定は暦日ベース60日ウィンドウ末尾を60営業日相当として近似"
        ]
    }
    with open(f'{OUTPUT_DIR}/stage1-run-meta.json', 'w') as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)
    print(f"  → {OUTPUT_DIR}/stage1-run-meta.json")

    # run.log
    run_log = f"""=== EXP-OBS000038 Stage 1 実行ログ ===
実行日時(UTC): {run_ts}
spec参照: research/EXP-OBS000038/01-spec-stage1.md

--- 再現コマンド ---
python3 /home/user/trading-app-v2/scripts/obs000038-stage1-ensemble-tail-gate.py

--- 使用ファイル ---
VRP:    research/EXP-OBS000037/10-result/stage1-vrp-prediction-unit.json
Carry:  research/EXP-OBS000032/10-result/{{btc,eth}}usdt-{{spot,perp-last}}-daily.csv
        research/EXP-OBS000032/10-result/{{btc,eth}}usdt-funding.csv
Spot:   research/EXP-OBS000032/10-result/{{btc,eth}}usdt-spot-daily.csv
VRP forward: research/EXP-OBS000037/10-result/forward/deribit-vrp-forward-ledger-btc.csv

--- 凍結パラメータ ---
C_real             = {C_REAL}
vegaNotionalPct    = {VEGA_NOTIONAL_PCT}
a_overlay          = {float(A_OVERLAY):.6f}
vol_target_annual  = {VOL_TARGET}
exec_cost_pct      = {float(EXEC_COST_PCT)}
bootstrap_seed     = {BOOTSTRAP_SEED}
bootstrap_N        = {BOOTSTRAP_N}
bootstrap_block_len= {BOOTSTRAP_BLOCK_LEN}

--- 結果サマリ ---
共通窓: {book_df.index[0].date()} 〜 {book_df.index[-1].date()} (n={len(book_df)}週)
stress週数: {n_stress_book}

maxDD(book0): {maxdd_b0*100:.2f}%
maxDD(book1): {maxdd_b1*100:.2f}%
CVaR95(book0): {cvar_b0*100:.2f}%
CVaR95(book1): {cvar_b1*100:.2f}%
maxDD改善率:   {maxdd_impr*100:.1f}%
CVaR95改善率:  {cvar_impr*100:.1f}%

ρ(overlay_vol10, VRP) [stress]:   {rho_ov_vrp:.3f}
ρ(overlay_vol10, carry) [stress]:  {rho_ov_carry:.3f}

bootstrap carry: point_est={point_est:.3f}, frac_le0={frac_le0:.3f}, CI=[{ci_lo:.3f},{ci_hi:.3f}]

+1週シフト: maxDD={sens_plus['maxDD']*100:.2f}%, CVaR95={sens_plus['cvar95']*100:.2f}%
-1週シフト: maxDD={sens_minus['maxDD']*100:.2f}%, CVaR95={sens_minus['cvar95']*100:.2f}%

VRP整合: n_matched={alignment['n_matched']}, max_diff={alignment['max_diff']:.8f}%

--- 出力ファイル ---
research/EXP-OBS000038/10-result/stage1-raw.json
research/EXP-OBS000038/10-result/stage1-weekly-series.csv
research/EXP-OBS000038/10-result/params.json
research/EXP-OBS000038/10-result/stage1-run-meta.json
research/EXP-OBS000038/10-result/run.log
"""
    with open(f'{OUTPUT_DIR}/run.log', 'w') as f:
        f.write(run_log)
    print(f"  → {OUTPUT_DIR}/run.log")

    print(f"\n完了: {OUTPUT_DIR}")
    print("\n=== G-ensemble 成否判定に必要な数値（C品質チームへ） ===")
    print(f"maxDD改善率:  {maxdd_impr*100:.1f}% (成功閾値: ≥10%)")
    print(f"CVaR95改善率: {cvar_impr*100:.1f}% (成功閾値: ≥10%)")
    print(f"ρ(overlay, carry_basisMTM) stress: {rho_ov_carry:.3f} (§5-3 エスカレーション: >0なら要確認)")


if __name__ == '__main__':
    main()
