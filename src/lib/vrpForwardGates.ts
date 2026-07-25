import type { VrpLedgerRow, VrpForwardMeta } from '../hooks/useVrpForwardData';

/**
 * EXP-OBS000037（SYS-001 VRP）フォワード較正の「断面表示用」暫定集計。
 *
 * ⚠ 位置づけ（極めて重要）
 * - ここで算出する値は **表示用の試験値** であり、F1〜F4の正式判定ではない。
 *   正式判定はライブ90日到達後（2026-10-09予定）にC品質チームが
 *   `research/EXP-OBS000037/00-spec-stage2.md` §7-1 に基づいて宣告する。
 * - spec §7-1のうち、ledger単独で一義に算出できるもの（F1a・F2・F3）だけを計算し、
 *   外部系列や事前登録seedのbootstrapを要するもの（F1bの下側境界・F4の相関）は
 *   `null`（UI未算出）として返す。**UI側で代替値を推定して埋めることはしない**（HARKing防止）。
 *
 * ⚠ 会計上の厳命（meta.sleeveReturnJoinNote / accountingNote）
 * - 累積損益は `is_cohort_anchor === 1` の行のみを週次非重複サンプリングして合算する。
 *   ledger全行のΣは約7倍の過大計上になるため厳禁。
 */

/** F2の合格ライン: 実現VRP>0の週比率（spec §7-1） */
export const F2_POSITIVE_WEEK_RATIO_PCT = 60;
/** F3の破産サニティ RUIN-1: 単一週次実現損失が資本25%を超えた週は0件であること（spec §3/§7-1） */
export const RUIN1_WEEKLY_LOSS_PCT_OF_CAPITAL = 25;
/** F4の相関上限（spec §7-1・UIでは未算出） */
export const F4_ABS_CORR_MAX = 0.6;

export interface VrpGateSnapshot {
  /** ライブ期の全行 */
  liveRows: VrpLedgerRow[];
  /** ライブ期の週次アンカー行（F1/F3の判定母集団） */
  weeklyAnchors: VrpLedgerRow[];
  /** うち rv_forward_7d が確定して net_pnl_pct が入った行 */
  weeklySettled: VrpLedgerRow[];
  /** rv_forward_7d 待ち（=まだ確定していない）ライブ日数 */
  pendingRvDays: number;
  /** VRPが確定している最終行（ライブ期・断面サマリ用） */
  latestSettled: VrpLedgerRow | null;
  /** ledger最終行（VRP未確定でもDVOLは入っている） */
  latestRow: VrpLedgerRow | null;

  f1: {
    /** 週次アンカーの純益合計（資本比%） */
    cumulativeWeeklyNetPct: number | null;
    /** F1a: 累積ネットがプラスか。確定週が0件の間は null（判定不能） */
    f1a_cumulativePositive: boolean | null;
    /** 週次ネット平均（資本比%） */
    weeklyMeanNetPct: number | null;
    /** F1b: 確認期間90%下側境界との比較。UIでは未算出（C監査で算出） */
    f1b_lowerBoundPct: null;
  };
  f2: {
    settledWeeks: number;
    positiveWeeks: number;
    positiveWeekRatioPct: number | null;
    f2_gte60pct: boolean | null;
  };
  f3: {
    settledWeeks: number;
    ruin1BreachWeeks: number;
    worstWeeklyNetPct: number | null;
    f3_zeroRuin1Breach: boolean | null;
  };
  f4: {
    /** ライブ期にDVOLスパイク（前日比+5 vol pt超）が立った日数 */
    spikeDays: number;
    spikeDates: string[];
    /** F4: スパイク窓での②/キャリーとの|ρ|。UIでは未算出（C監査で算出） */
    absCorrelation: null;
  };
}

export function deriveVrpGateSnapshot(rows: VrpLedgerRow[]): VrpGateSnapshot {
  const liveRows = rows.filter(r => r.phase === 'live');
  const weeklyAnchors = liveRows.filter(r => r.is_cohort_anchor === 1);
  const weeklySettled = weeklyAnchors.filter(r => r.net_pnl_pct != null && r.vrp != null);

  const pendingRvDays = liveRows.filter(r => r.rv_forward_7d == null).length;
  const settledLive = liveRows.filter(r => r.vrp != null);
  const latestSettled = settledLive.length > 0 ? settledLive[settledLive.length - 1] : null;
  const latestRow = rows.length > 0 ? rows[rows.length - 1] : null;

  // ── F1: 週次非重複サンプリングでの累積ネット ──────────────
  const cumulativeWeeklyNetPct = weeklySettled.length > 0
    ? weeklySettled.reduce((s, r) => s + (r.net_pnl_pct as number), 0)
    : null;
  const weeklyMeanNetPct = cumulativeWeeklyNetPct != null && weeklySettled.length > 0
    ? cumulativeWeeklyNetPct / weeklySettled.length
    : null;

  // ── F2: 実現VRP>0の週比率 ───────────────────────────────
  const positiveWeeks = weeklySettled.filter(r => (r.vrp as number) > 0).length;
  const positiveWeekRatioPct = weeklySettled.length > 0
    ? (positiveWeeks / weeklySettled.length) * 100
    : null;

  // ── F3: RUIN-1（週次損失が資本25%超）の超過件数 ───────────
  const ruin1BreachWeeks = weeklySettled
    .filter(r => (r.net_pnl_pct as number) <= -RUIN1_WEEKLY_LOSS_PCT_OF_CAPITAL).length;
  const worstWeeklyNetPct = weeklySettled.length > 0
    ? Math.min(...weeklySettled.map(r => r.net_pnl_pct as number))
    : null;

  // ── F4: DVOLスパイク発生の前向き蓄積（相関はUI未算出） ─────
  const spikeRows = liveRows.filter(r => r.dvol_spike_marker === 1);

  return {
    liveRows,
    weeklyAnchors,
    weeklySettled,
    pendingRvDays,
    latestSettled,
    latestRow,
    f1: {
      cumulativeWeeklyNetPct,
      f1a_cumulativePositive: cumulativeWeeklyNetPct == null ? null : cumulativeWeeklyNetPct > 0,
      weeklyMeanNetPct,
      f1b_lowerBoundPct: null,
    },
    f2: {
      settledWeeks: weeklySettled.length,
      positiveWeeks,
      positiveWeekRatioPct,
      f2_gte60pct: positiveWeekRatioPct == null ? null : positiveWeekRatioPct >= F2_POSITIVE_WEEK_RATIO_PCT,
    },
    f3: {
      settledWeeks: weeklySettled.length,
      ruin1BreachWeeks,
      worstWeeklyNetPct,
      f3_zeroRuin1Breach: weeklySettled.length === 0 ? null : ruin1BreachWeeks === 0,
    },
    f4: {
      spikeDays: spikeRows.length,
      spikeDates: spikeRows.map(r => r.date),
      absCorrelation: null,
    },
  };
}

/** goLiveDateUTC（YYYY-MM-DD）から n日後の日付文字列を返す（マイルストーン表示用） */
export function addDaysUTC(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** meta.runHistory の最終実行時刻（ISO UTC）。無ければ null */
export function latestRunTimestamp(meta: VrpForwardMeta): string | null {
  const h = meta.runHistory;
  return Array.isArray(h) && h.length > 0 ? h[h.length - 1].runTimestampUTC : null;
}
